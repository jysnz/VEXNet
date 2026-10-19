// USB relay in the browser: what relay/relay.py does, without installing anything.
// Chrome / Edge on a laptop talk to the V5 controllers plugged into it over Web Serial, forward the
// match to each robot (USB -> controller -> radio -> brain) and report the robots back to the website.
//
// The controller is spoken to directly (no vexcom): VEX "CDC2" extended packets. 0x10 switches its radio
// to the download channel (program I/O only crosses the radio there), 0x27 reads / writes the robot's
// user FIFO. Packets: C9 36 B8 47 56 <cmd> <len> <payload> <crc16>, replies: AA 55 56 <len> <cmd> <ack> ...
"use strict";

const UsbRelay = (() => {
  const VEX_VID = 0x2888, CONTROLLER_PID = 0x0503;
  const ACK = 0x76, DOWNLOAD = 1, PIT = 0;
  const POLL_MS = 250;            // ask the website for the state this often
  const REPORT_MS = 500;          // tell the website how the robots are doing this often
  const SEND_MS = 250;            // FC line to each robot this often (robot times out at 2 s)
  const SITE_STALE_MS = 1500;     // website silent this long -> tell robots DISABLED
  const RELEASE_MS = 3000;        // a controller dropped from its match hears "FC OFF" this long
  const REPLY_MS = 300;           // a controller that doesn't answer a packet this fast missed it
  const REQUEST_MS = 1000;        // a website request slower than this is dropped and retried (robots stay on the last line)

  // Timers in a worker: a background tab's own timers get throttled to once a minute, robots time out at 2 s.
  const ticker = new Worker(URL.createObjectURL(new Blob(
    ["onmessage = (e) => setTimeout(() => postMessage(e.data.id), e.data.ms);"], { type: "text/javascript" })));
  const waiting = new Map();
  let nextId = 0;
  ticker.onmessage = (e) => { const f = waiting.get(e.data); waiting.delete(e.data); if (f) f(); };
  const sleep = (ms) => new Promise((res) => { const id = nextId++; waiting.set(id, res); ticker.postMessage({ id, ms }); });

  // ─── Packets ──────────────────────────────────────────────────────────────
  const CRC = new Uint16Array(256).map((_, i) => {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    return c & 0xffff;
  });
  const crc16 = (bytes) => bytes.reduce((c, b) => ((c << 8) ^ CRC[((c >> 8) ^ b) & 0xff]) & 0xffff, 0);

  function packet(cmd, payload) {
    const n = payload.length;
    const body = [0xc9, 0x36, 0xb8, 0x47, 0x56, cmd, ...(n > 0x7f ? [(n >> 8) | 0x80, n & 0xff] : [n]), ...payload];
    const c = crc16(body);
    return new Uint8Array([...body, c >> 8, c & 0xff]);
  }

  // Pulls complete replies out of the bytes read so far: [{cmd, ack, data}], CRC-checked.
  function takeReplies(buf) {
    const out = [];
    for (;;) {
      let i = 0;
      while (i + 1 < buf.length && !(buf[i] === 0xaa && buf[i + 1] === 0x55)) i++;
      buf.splice(0, i);
      if (buf.length < 4) return out;
      let len = buf[3], hdr = 4;
      if (buf[2] === 0x56 && len & 0x80) {
        if (buf.length < 5) return out;
        len = ((len & 0x7f) << 8) | buf[4]; hdr = 5;
      }
      if (buf.length < hdr + len) return out;
      const pkt = buf.splice(0, hdr + len);
      if (pkt[2] !== 0x56 || crc16(pkt) !== 0 || len < 4) continue;
      out.push({ cmd: pkt[hdr], ack: pkt[hdr + 1], data: pkt.slice(hdr + 2, -2) });
    }
  }

  // The brain's stdout as text lines. PROS wraps every write as <4-byte stream id><payload>, COBS-encodes
  // it and ends it with 0x00; anything else is passed through as text (same as relay.py's PacketStream).
  function cobsDecode(p) {
    const out = [];
    for (let i = 0; i < p.length;) {
      const code = p[i];
      if (code === 0 || i + code > p.length + 1) return null;
      out.push(...p.slice(i + 1, i + code));
      i += code;
      if (code < 0xff && i < p.length) out.push(0);
    }
    return out;
  }
  const ascii = (bytes) => String.fromCharCode(...bytes.filter((b) => b === 10 || (b >= 32 && b < 127)));
  class LineStream {
    constructor() { this.buf = []; this.text = ""; }
    feed(bytes) {
      this.buf.push(...bytes);
      for (let zero; (zero = this.buf.indexOf(0)) !== -1;) {
        const p = this.buf.splice(0, zero + 1).slice(0, -1);
        if (!p.length) continue;
        const d = cobsDecode(p);
        const id = d && ascii(d.slice(0, 4));
        this.text += d && ["sout", "serr", "kdbg"].includes(id) ? ascii(d.slice(4)) : ascii(p);
      }
      if (this.buf.includes(10) && this.buf.every((b) => b >= 9 && b < 127)) this.text += ascii(this.buf.splice(0));
      if (this.text.length > 4096) this.text = this.text.slice(-1024);
      const lines = this.text.split("\n");
      this.text = lines.pop();
      return lines;
    }
  }

  // ─── One controller ───────────────────────────────────────────────────────
  class Controller {
    constructor(port, name, onGone) {
      this.port = port; this.name = name; this.onGone = onGone;
      this.line = null;       // FC line to keep sending; null = send nothing
      this.fcs = null; this.fcsAt = 0;
      this.answerAt = 0;      // last time the controller itself answered
      this.error = null;
      this.closed = false;
      this.rx = []; this.pending = null;
    }

    async open() {
      await this.port.open({ baudRate: 115200 });
      this.writer = this.port.writable.getWriter();
      this.readLoop();
      this.runLoop();
    }

    async readLoop() {
      try {
        this.reader = this.port.readable.getReader();
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.rx.push(...value);
          for (const r of takeReplies(this.rx)) if (this.pending && r.cmd === this.pending.cmd) this.pending.resolve(r);
        }
      } catch (e) { /* unplugged */ }
      if (!this.closed) this.close("unplugged");
    }

    // One packet out, its reply back (or null after a timeout). One at a time per controller.
    async txrx(cmd, payload, ms = REPLY_MS) {
      if (this.closed) return null;
      const reply = new Promise((resolve) => { this.pending = { cmd, resolve }; });
      try { await this.writer.write(packet(cmd, payload)); } catch (e) { this.close("unplugged"); return null; }
      const r = await Promise.race([reply, sleep(ms).then(() => null)]);
      this.pending = null;
      if (r && r.ack === ACK) { this.answerAt = Date.now(); return r; }
      return null;
    }

    async runLoop() {
      let channelAt = 0, channelOk = false, sentAt = 0;
      const enc = new TextEncoder();
      while (!this.closed) {
        const now = Date.now();
        // The radio goes quiet for a few seconds after a channel switch, so keep asking until it says yes.
        if (!channelOk && now - channelAt > 3000) {
          channelAt = now;
          channelOk = Boolean(await this.txrx(0x10, [1, DOWNLOAD], 1500));
        }
        if (this.line && now - sentAt >= SEND_MS) {
          const bytes = [...enc.encode(this.line + "\n")];
          await this.txrx(0x27, [DOWNLOAD, bytes.length, ...bytes]);
          sentAt = now;
        }
        const r = await this.txrx(0x27, [DOWNLOAD, 0x40]);
        if (r && r.data.length > 1) {
          for (const line of (this.stream ||= new LineStream()).feed(r.data.slice(1))) {
            const i = line.indexOf("FCS|");
            if (i !== -1) { this.fcs = line.slice(i + 4).trim(); this.fcsAt = Date.now(); }
          }
        } else await sleep(r ? 50 : 200);
      }
    }

    status() {
      const now = Date.now();
      const error = this.error ?? (this.answerAt && now - this.answerAt > 3000 ? "controller not answering (turned off?)" : null);
      return { port: this.name, fcs: this.fcs, age: this.fcs ? (now - this.fcsAt) / 1000 : null, error };
    }

    async close(why) {
      if (this.closed) return;
      this.closed = true; this.error = why || null;
      try { await this.writer.write(packet(0x10, [1, PIT])); } catch (e) { /* gone already */ }   // back to normal driving
      try { await this.reader?.cancel(); } catch (e) {}
      try { this.writer.releaseLock(); } catch (e) {}
      try { await this.port.close(); } catch (e) {}
      this.onGone(this);
    }
  }

  // ─── The website side ─────────────────────────────────────────────────────
  // getPin: () => the control PIN (the relay endpoint accepts it instead of the relay token).
  // getCode: () => the match this laptop joined as an alliance: lets it speak for itself in that match without the PIN.
  // inMatch: () => this laptop is in a match: keep it online even with no controller connected (yet).
  // onChange: () => called whenever something worth redrawing changed.
  function create({ getPin, getCode = () => "", inMatch = () => false, onChange }) {
    const supported = "serial" in navigator;
    const ctrls = new Map();     // SerialPort -> Controller
    const lastLine = new Map();  // controller name -> last line the website gave it
    const releaseUntil = new Map();
    let name = "";
    try { name = localStorage.getItem("vexnetLaptop") || ""; } catch (e) {}
    if (!name) { name = "LAPTOP-" + Math.random().toString(36).slice(2, 6).toUpperCase(); saveName(); }
    let ports = {}, clock = null, okAt = 0, note = "", running = false;

    function saveName() { try { localStorage.setItem("vexnetLaptop", name); localStorage.setItem("vexnetRelay", name); } catch (e) {} }
    const fresh = () => okAt > 0 && Date.now() - okAt < SITE_STALE_MS;
    const list = () => [...ctrls.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    function freeName() {
      const used = new Set([...ctrls.values()].map((c) => c.name));
      for (let i = 1; ; i++) if (!used.has("CTRL" + i)) return "CTRL" + i;
    }

    async function add(port) {
      if (ctrls.has(port)) return;
      const info = port.getInfo();
      if (info.usbVendorId !== VEX_VID || info.usbProductId !== CONTROLLER_PID) return;
      const c = new Controller(port, freeName(), (gone) => { ctrls.delete(gone.port); onChange(); });
      ctrls.set(port, c);
      try { await c.open(); }
      catch (e) {
        ctrls.delete(port);
        note = `A controller couldn't be opened (${e.message || e}). Is it in use by another program (relay.py, the PROS terminal or another tab)? Close that and reconnect.`;
      }
      onChange();
      start();
    }

    // What this controller's robot should hear right now (null = nothing). Same rules as relay.py.
    function lineFor(c, now) {
      const entry = fresh() ? ports[c.name] : null;
      if (entry && entry.line) { lastLine.set(c.name, entry.line); releaseUntil.delete(c.name); return entry.line; }
      if (!fresh()) {   // the website is gone: whatever it was told, disable it
        const p = (lastLine.get(c.name) || "").split(" ");
        return p.length === 5 && p[0] === "FC" ? (p[2] = "0", p.join(" ")) : null;
      }
      if (lastLine.has(c.name) && !entry) {   // dropped from its match: hand the robot back to practice mode
        if (!releaseUntil.has(c.name)) releaseUntil.set(c.name, now + RELEASE_MS);
        if (now < releaseUntil.get(c.name)) return "FC OFF";
        lastLine.delete(c.name); releaseUntil.delete(c.name);
      }
      return null;
    }

    // One slow request must not hold up the next one: past REQUEST_MS it is abandoned and the loop asks again.
    async function api(path, body) {
      const abort = new AbortController();
      const id = nextId++;
      waiting.set(id, () => abort.abort()); ticker.postMessage({ id, ms: REQUEST_MS });
      let r;
      try {
        r = await fetch(path, {
          method: body ? "POST" : "GET", cache: "no-store", signal: abort.signal,
          headers: { "Content-Type": "application/json", "X-Pin": getPin(), "X-Match-Code": getCode() },
          body: body ? JSON.stringify(body) : undefined,
        });
      } finally { waiting.delete(id); }
      if (r.status === 401) throw Object.assign(new Error("pin"), { pin: true });
      if (!r.ok) throw new Error("website error " + r.status);
      return r.json();
    }

    async function pollLoop() {
      for (;;) {
        if (ctrls.size) {
          try {
            const d = await api("/api/relay?relay=" + encodeURIComponent(name));
            ports = d.ports; clock = d.clock; okAt = Date.now(); note = "";
          } catch (e) {
            note = e.pin ? "Join a match as the red or blue alliance to put this laptop's controllers online."
              : fresh() ? "" : "Can't reach the website - robots told DISABLED.";
          }
          const now = Date.now();
          for (const c of ctrls.values()) c.line = lineFor(c, now);
          onChange();
        }
        await sleep(POLL_MS);
      }
    }

    // Tabs of this site on this laptop: one holding controllers says so, so a tab without any never reports an
    // empty list over its report. With no tab holding any, a laptop that is in a match still reports (no controllers)
    // and stays online: the match shows it as there, not offline.
    let heldElsewhereAt = 0;
    const tabs = "BroadcastChannel" in window ? new BroadcastChannel("vexnet-usb") : null;
    if (tabs) tabs.onmessage = (e) => { if (e.data?.holder === name) heldElsewhereAt = Date.now(); };

    async function reportLoop() {
      for (;;) {
        if (ctrls.size) tabs?.postMessage({ holder: name });
        const speak = ctrls.size || (inMatch() && Date.now() - heldElsewhereAt > 3 * REPORT_MS);
        if (speak && (getPin() || getCode())) {
          try { await api("/api/relay", { relay: name, robots: list().map((c) => c.status()) }); } catch (e) {}
        }
        await sleep(REPORT_MS);
      }
    }

    function start() {
      if (running) return;
      running = true;
      pollLoop(); reportLoop();
    }

    if (supported) {
      start();   // reports start at once: a laptop in a match is online before (or without) any controller
      // Controllers this site was allowed to use before reconnect by themselves, on load and when replugged.
      navigator.serial.getPorts().then((ps) => ps.forEach(add));
      navigator.serial.addEventListener("connect", (e) => add(e.target));
      navigator.serial.addEventListener("disconnect", (e) => ctrls.get(e.target)?.close("unplugged"));
      // Leaving the page: put the controllers back on the normal channel (best effort).
      addEventListener("pagehide", () => ctrls.forEach((c) => c.close()));
    }

    return {
      supported,
      get name() { return name; },
      setName(n) {
        n = String(n || "").trim().replace(/[^\w .-]/g, "").slice(0, 30);
        if (!n || n === name) return;
        name = n; saveName(); okAt = 0; ports = {}; onChange();
      },
      // Opens Chrome's device picker (needs a click). One controller per pick.
      async connect() {
        const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: VEX_VID, usbProductId: CONTROLLER_PID }] });
        // Two controllers look alike in Chrome's list: picking the one already connected would otherwise do nothing.
        const had = ctrls.get(port);
        note = had ? `That one is already connected as ${had.name}. Press Connect controller again and pick the other one (not marked "paired").` : "";
        if (had) onChange(); else await add(port);
      },
      controllers: () => list().map((c) => {
        const s = c.status(), entry = ports[c.name];
        let robot;
        if (s.error) robot = s.error;
        else if (s.age == null || s.age > 2) robot = c.answerAt ? "no reply from robot" : "linking...";
        else robot = s.fcs.startsWith("P|") ? "robot ready" : "robot in field control";
        return { name: c.name, robot, ok: !s.error && s.age != null && s.age <= 2, slot: entry ? `${entry.label} (${entry.code})` : null };
      }),
      // What the controllers report, for joining a match (the website puts the laptop online with it).
      reports: () => list().map((c) => c.status()),
      online: () => fresh(),
      clock: () => clock,
      note: () => note,
    };
  }

  return { create };
})();
