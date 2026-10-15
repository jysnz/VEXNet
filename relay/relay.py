"""
relay.py -- VEXNET field control, laptop relay

Runs on every laptop that has V5 controllers plugged in by USB. It registers this laptop with the
VEXNET website, and while a match uses its controllers it forwards the match state to each robot:
USB -> controller -> radio -> brain (the robot program obeys it, see robot/). It also reports each
robot's status back, which is what makes the laptop and its controllers show up in the match lobby.

    py -3 relay.py --server https://your-project.vercel.app --token <RELAY_TOKEN>
    py -3 relay.py ... --name PIT-LAPTOP          how this laptop is shown on the website (default: computer name)
    py -3 relay.py ... --ports COM3 COM6          only these controllers (default: every one plugged in)

The token and server can also come from VEXNET_TOKEN and VEXNET_SERVER, so the command can be just:
    py -3 relay.py

Which controller is which robot (RED 1, BLUE 2, ...) is chosen on the website, in the match lobby.

SETUP (once per laptop)
    - Python 3 with tkinter, and:  pip install pyserial
    - VS Code with the PROS extension (it ships vexcom.exe), or pass --vexcom <path to vexcom.exe>
    - Plug each controller in by USB, paired to its robot as usual.
    - Close the PROS terminal -- only one program can use a controller's port. This closes
      any stray vexcom it finds at startup.
    - Program I/O only crosses the radio on the "download" channel, so each controller is switched to
      it while this runs (same as a wireless upload) and switched back on exit.

SAFETY
    - Lost the website (or the internet)?  This tells its robots DISABLED within ~1.5 s.
    - This window closed or a cable pulled?  The robot disables itself after 2 s of silence.
    - A controller that is no longer part of a match is sent "FC OFF" for a few seconds, which hands
      its robot back to normal practice mode (otherwise it would stay disabled until the program restarts).
"""

import argparse
import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.parse
import urllib.request

try:
    import serial.tools.list_ports
except ImportError:
    print("This needs pyserial. Install it with:\n    pip install pyserial")
    sys.exit(1)

VEX_VID = 0x2888
VEX_PID_CONTROLLER = 0x0503
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

POLL_INTERVAL_S = 0.25         # ask the website for the state this often
REPORT_INTERVAL_S = 0.5        # tell the website how the robots are doing this often
ROBOT_SEND_INTERVAL_S = 0.25   # FC line to each robot this often (robot times out at 2 s)
SERVER_STALE_S = 1.5           # website silent this long -> tell robots DISABLED
ROBOT_STALE_S = 2.0            # a robot silent this long is "no reply"
RESCAN_INTERVAL_S = 3.0        # look for newly plugged-in controllers this often

BG, CARD, DIM, GRAY, WHITE = "#14141a", "#161B22", "#3a3a46", "#777777", "#ffffff"
GREEN, RED, ORANGE, BLUE = "#2ECC71", "#FF3131", "#FF8C00", "#3B8BFF"
ALLIANCE_COLORS = {"red": RED, "blue": BLUE}


# ─── vexcom / controller plumbing ───────────────────────────────────────────
def vex_ports():
    return [p for p in serial.tools.list_ports.comports()
            if p.vid == VEX_VID or "vex" in ((p.description or "") + (p.manufacturer or "")).lower()]


def find_vexcom():
    found = shutil.which("vexcom")
    if found:
        return found
    roots = [os.path.expandvars(r"%APPDATA%\Code\User\globalStorage\sigbots.pros\install"),
             os.path.expanduser("~/.config/Code/User/globalStorage/sigbots.pros/install")]
    for root in roots:
        hits = [h for h in glob.glob(os.path.join(root, "vex-vexcom-*", "vexcom*"))
                if os.path.isfile(h) and not h.endswith(".txt")]
        if hits:
            return hits[0]
    return None


def cobs_decode(packet):
    """One COBS packet (without its 0x00 terminator) -> bytes, or None if malformed."""
    out = bytearray()
    i, n = 0, len(packet)
    while i < n:
        code = packet[i]
        if code == 0 or i + code > n + 1:
            return None
        out += packet[i + 1:i + code]
        i += code
        if code < 0xFF and i < n:
            out.append(0)
    return bytes(out)


class PacketStream:
    """The brain's user port as text lines. PROS wraps every stdout write as <4-byte stream id>
    <payload>, COBS-encodes it and ends it with 0x00; anything else is passed through as text."""
    STREAM_IDS = (b"sout", b"serr", b"kdbg")

    def __init__(self):
        self._buf = bytearray()
        self._text = ""

    def feed(self, raw):
        self._buf += raw
        while True:
            zero = self._buf.find(b"\x00")
            if zero == -1:
                break
            packet = bytes(self._buf[:zero])
            del self._buf[:zero + 1]
            if not packet:
                continue
            decoded = cobs_decode(packet)
            if decoded is not None and decoded[:4] in self.STREAM_IDS:
                self._text += decoded[4:].decode("utf-8", errors="ignore")
            else:
                self._text += packet.decode("utf-8", errors="ignore")
        if self._buf and b"\n" in self._buf and all(9 <= b < 127 for b in self._buf):
            self._text += bytes(self._buf).decode("utf-8", errors="ignore")
            self._buf.clear()
        lines = self._text.split("\n")
        self._text = lines.pop()
        return lines


def vexcomProcesses():
    """[(pid, port, ownedByARelay)] for every running `vexcom --user <port>`. A vexcom whose
    parent is a relay.py is another relay window's link; an orphan (its relay was killed) counts
    as not owned, so it gets cleaned up."""
    if os.name != "nt":
        return []
    script = (
        "$all = Get-CimInstance Win32_Process; "
        "foreach ($p in ($all | Where-Object { $_.Name -eq 'vexcom.exe' -and $_.CommandLine -match '--user' })) { "
        "$par = $all | Where-Object { $_.ProcessId -eq $p.ParentProcessId }; "
        "$isRelay = [bool]($par -and $par.CommandLine -match 'relay\\.py'); "
        "$port = if ($p.CommandLine -match '--user\\s+(\\S+)') { $Matches[1] } else { '' }; "
        "\"$($p.ProcessId),$port,$isRelay\" }")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True,
                             text=True, timeout=20, creationflags=NO_WINDOW).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = []
    for line in out.splitlines():
        parts = line.strip().split(",")
        if len(parts) == 3 and parts[0].isdigit():
            rows.append((int(parts[0]), parts[1], parts[2].lower() == "true"))
    return rows


def closeForeignVexcom():
    killed = [pid for pid, _port, mine in vexcomProcesses() if not mine]
    for pid in killed:
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, timeout=10,
                       creationflags=NO_WINDOW)
    if killed:
        time.sleep(1.0)
        return f"closed {len(killed)} stray vexcom process(es) holding a controller port"
    return None


class ControllerLink:
    """One controller: a `vexcom --user <port>` child process, the only thing that carries
    program I/O over the controller's radio. Sends the latest FC line on a fixed beat (the robot
    only cares about the newest) and remembers the robot's last FCS reply."""

    def __init__(self, port, vexcom):
        self.port, self.vexcom = port, vexcom
        self.line = None          # FC line to keep sending; None = send nothing
        self.fcs = None
        self.fcsAt = 0.0
        self.error = None
        self._stop = False
        self._setChannel(1)
        self.proc = subprocess.Popen([vexcom, "--user", port], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     creationflags=NO_WINDOW)
        threading.Thread(target=self._readLoop, daemon=True).start()
        threading.Thread(target=self._sendLoop, daemon=True).start()

    def alive(self):
        return self.error is None

    def status(self):
        age = time.time() - self.fcsAt if self.fcs else None
        return {"port": self.port, "fcs": self.fcs, "age": age, "error": self.error}

    def _readLoop(self):
        stream = PacketStream()
        while not self._stop:
            raw = self.proc.stdout.read1(4096)
            if not raw:
                break
            for line in stream.feed(raw):
                idx = line.find("FCS|")
                if idx != -1:
                    self.fcs = line[idx + 4:].strip()
                    self.fcsAt = time.time()
        if not self._stop:
            self.error = f"vexcom quit (exit {self.proc.wait()}) - port busy or unplugged?"

    def _sendLoop(self):
        while not self._stop:
            line = self.line
            if line:
                try:
                    self.proc.stdin.write((line + "\n").encode("ascii"))
                    self.proc.stdin.flush()
                except (OSError, ValueError):
                    pass
            time.sleep(ROBOT_SEND_INTERVAL_S)

    def _setChannel(self, chan):
        try:
            subprocess.run([self.vexcom, "--chan", str(chan), self.port], capture_output=True,
                           timeout=15, creationflags=NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def close(self):
        self._stop = True
        try:
            self.proc.kill()
            self.proc.wait(timeout=5)
        except Exception:
            pass
        self._setChannel(0)


def describe_robot(r):
    if r["error"]:
        return "ERROR: " + r["error"]
    if r["age"] is None or r["age"] > ROBOT_STALE_S:
        return "no reply yet (robot on? paired? running a program with the field-control code?)"
    parts = (r["fcs"] or "").split("|")
    if len(parts) < 3:
        return "?"
    if parts[0] == "P":
        return "program running - waiting for field control"
    period = "AUTO" if parts[0] == "A" else "DRIVER"
    if parts[1] != "1":
        return f"{period} - disabled"
    return f"{period} - ENABLED" + (" (auton running)" if parts[2] == "1" else "")


# ─── The website ────────────────────────────────────────────────────────────
class Website:
    """Polls /api/relay for what to send each controller, and posts the controllers' status back."""

    def __init__(self, server, name, token, robotsFn):
        self.server, self.name, self.token, self.robotsFn = server.rstrip("/"), name, token, robotsFn
        self.ports = {}           # port -> {"line", "slot", "label", "code"} from the last good poll
        self.clock = None         # clock summary of the match this laptop is in
        self.okAt = 0.0           # when the last poll succeeded
        self.note = "connecting to the website..."
        threading.Thread(target=self._pollLoop, daemon=True).start()
        threading.Thread(target=self._reportLoop, daemon=True).start()

    def fresh(self):
        return self.okAt > 0 and time.time() - self.okAt < SERVER_STALE_S

    def _request(self, path, body=None):
        req = urllib.request.Request(self.server + path, headers={"X-Relay-Token": self.token,
                                                                  "Content-Type": "application/json",
                                                                  "User-Agent": "vexnet-relay"})
        if body is not None:
            req.data = json.dumps(body).encode()
            req.method = "POST"
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read().decode())

    def _pollLoop(self):
        while True:
            try:
                data = self._request("/api/relay?relay=" + urllib.parse.quote(self.name))
                self.ports, self.clock, self.okAt = data["ports"], data.get("clock"), time.time()
                self.note = f"connected to {self.server} as {self.name}"
            except urllib.error.HTTPError as e:
                self.note = {401: "the website rejected the relay token (check RELAY_TOKEN)",
                             500: "the website is missing RELAY_TOKEN / settings"}.get(e.code, f"website error {e.code}")
            except (urllib.error.URLError, socket.timeout, OSError, ValueError, KeyError) as e:
                self.note = f"can't reach {self.server} ({getattr(e, 'reason', e)}) - robots told DISABLED"
            time.sleep(POLL_INTERVAL_S)

    def _reportLoop(self):
        while True:
            try:
                robots = [{"port": r["port"], "fcs": r["fcs"],
                           "age": None if r["age"] is None else round(r["age"], 2), "error": r["error"]}
                          for r in self.robotsFn()]
                self._request("/api/relay", {"relay": self.name, "robots": robots})
            except Exception:
                pass
            time.sleep(REPORT_INTERVAL_S)


def disabledLine(fc):
    """The same FC line with the enable flag cleared: what a robot hears when the website is gone."""
    parts = (fc or "").split()
    if len(parts) == 5 and parts[0] == "FC":
        parts[2] = "0"
        return " ".join(parts)
    return None   # FC OFF / nothing yet: send nothing (practice mode)


RELEASE_FOR_S = 3.0   # a controller dropped from its match hears "FC OFF" this long


class RelayApp:
    def __init__(self, root, args, vexcom):
        self.root, self.args, self.vexcom = root, args, vexcom
        self.links = {}
        self.lastScan = 0.0
        self.scanning = False
        self.lock = threading.Lock()
        self.lastLine = {}        # port -> last line the website gave it
        self.releaseUntil = {}    # port -> time until which it hears "FC OFF"
        self.site = Website(args.server, args.name, args.token, self.robotStatuses)

        root.title(f"VEXNET Relay - {args.name}")
        root.configure(bg=BG)
        root.geometry("640x520")
        tk.Label(root, text=args.name, bg=BG, fg=GREEN, font=("Segoe UI", 20, "bold")).pack(pady=(14, 0))
        self.periodLabel = tk.Label(root, bg=BG, fg=GRAY, font=("Segoe UI", 15, "bold"))
        self.periodLabel.pack()
        self.clockLabel = tk.Label(root, bg=BG, fg=WHITE, font=("Consolas", 72, "bold"))
        self.clockLabel.pack()
        self.robotsLabel = tk.Label(root, bg=CARD, fg=WHITE, font=("Consolas", 11), justify="left",
                                    anchor="nw", padx=10, pady=8)
        self.robotsLabel.pack(fill="both", expand=True, padx=16, pady=10)
        self.siteLabel = tk.Label(root, bg=BG, fg=GRAY, font=("Segoe UI", 10), wraplength=600, justify="left")
        self.siteLabel.pack(fill="x", padx=16, pady=(0, 10))
        root.protocol("WM_DELETE_WINDOW", self.close)
        self.tick()

    def robotStatuses(self):
        with self.lock:
            return [l.status() for l in self.links.values()]

    def scanControllers(self):
        """Own thread: switching a controller's channel takes seconds. A port another relay window
        already holds is left to it."""
        try:
            wanted = self.args.ports or [p.device for p in vex_ports() if p.pid == VEX_PID_CONTROLLER]
            with self.lock:
                ours = {l.proc.pid for l in self.links.values()}
            taken = {port for pid, port, mine in vexcomProcesses() if mine and pid not in ours}
            wanted = [p for p in wanted if p not in taken]
            with self.lock:
                dead = [self.links.pop(p) for p in [p for p, l in self.links.items() if not l.alive()]]
                new = [p for p in wanted if p not in self.links]
            for l in dead:
                l.close()
            for port in new:
                link = ControllerLink(port, self.vexcom)
                with self.lock:
                    self.links[port] = link
        finally:
            self.scanning = False

    def lineFor(self, port, now):
        """What this controller's robot should hear right now (None = nothing)."""
        fresh = self.site.fresh()
        entry = self.site.ports.get(port) if fresh else None
        if entry and entry.get("line"):
            self.lastLine[port] = entry["line"]
            self.releaseUntil.pop(port, None)
            return entry["line"]
        if not fresh:   # the website is gone: whatever it was told, disable it
            return disabledLine(self.lastLine.get(port))
        # The website is fine but this controller has no line: it was never in a match, the match hasn't
        # started yet, or it was dropped. After a match, hand the robot back to practice mode.
        if port in self.lastLine and entry is None:
            if port not in self.releaseUntil:
                self.releaseUntil[port] = now + RELEASE_FOR_S
            if now < self.releaseUntil[port]:
                return "FC OFF"
            self.lastLine.pop(port, None)
            self.releaseUntil.pop(port, None)
        return None

    def tick(self):
        now = time.time()
        if not self.scanning and now - self.lastScan > RESCAN_INTERVAL_S:
            self.lastScan, self.scanning = now, True
            threading.Thread(target=self.scanControllers, daemon=True).start()

        with self.lock:
            links = list(self.links.values())
        for l in links:
            l.line = self.lineFor(l.port, now)

        c = self.site.clock
        if not self.site.fresh():
            self.periodLabel.configure(text="no website signal - robots disabled")
            self.clockLabel.configure(text="-:--", fg=RED)
        elif not c:
            self.periodLabel.configure(text="waiting for a match to use this laptop's controllers")
            self.clockLabel.configure(text="-:--", fg=GRAY)
        else:
            self.periodLabel.configure(text=f"{c['type']}  -  {c['code']}  -  {c['status']}")
            self.clockLabel.configure(text=c["clockText"], fg=c["clockColor"])

        rows = []
        for s in self.robotStatuses():
            entry = self.site.ports.get(s["port"])
            who = f"{entry['label']} ({entry['code']})" if entry else "not in a match"
            rows.append(f"{s['port']:<6} {who:<22} {describe_robot(s)}")
        self.robotsLabel.configure(text="\n".join(rows) or "no V5 controller plugged in by USB")
        self.siteLabel.configure(text=self.site.note)
        self.root.after(100, self.tick)

    def close(self):
        with self.lock:
            links = list(self.links.values())
            self.links.clear()
        for l in links:
            l.close()
        self.root.destroy()


def main():
    ap = argparse.ArgumentParser(description="VEXNET field control - laptop relay")
    ap.add_argument("--name", default=socket.gethostname(), help="how this laptop is shown on the website (default: computer name)")
    ap.add_argument("--server", default=os.environ.get("VEXNET_SERVER"), help="https://your-project.vercel.app")
    ap.add_argument("--token", default=os.environ.get("VEXNET_TOKEN"), help="the website's RELAY_TOKEN")
    ap.add_argument("--ports", nargs="+", help="controller COM ports (default: all plugged in)")
    ap.add_argument("--vexcom", help="path to vexcom.exe (default: the PROS extension's copy)")
    args = ap.parse_args()
    if not args.server or not args.token:
        ap.error("--server and --token are required (or set VEXNET_SERVER and VEXNET_TOKEN)")
    if not args.server.startswith(("http://", "https://")):
        args.server = "https://" + args.server

    vexcom = args.vexcom or find_vexcom()
    if not vexcom:
        print("Couldn't find vexcom.exe (it ships with the PROS VS Code extension). "
              "Install that, or pass --vexcom PATH\\TO\\vexcom.exe")
        return
    note = closeForeignVexcom()
    if note:
        print(note)

    root = tk.Tk()
    RelayApp(root, args, vexcom)
    root.mainloop()


if __name__ == "__main__":
    main()
