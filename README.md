# VEXNET Field Control

Scrimmage field control for VEX V5 robots. The **website** (Vercel) holds the UI and the match clock; a small
**relay** on the laptop with the controllers plugged in by USB passes the match state to the robots; a tiny
**robot module** in each robot program obeys it.

```
 phone / tablet / laptop browser ──► VEXNET website on Vercel ◄── polls over HTTPS ── relay (red laptop)  ─┐
   control page  /                    UI + match clock + PIN     ◄── polls over HTTPS ── relay (blue laptop) ┤
   team pages    /red  /blue          state in Upstash Redis                                                │
                                                       controller USB ► radio ► Brain (robot program) ◄─────┘
```

| Folder | What it is | Runs on |
|---|---|---|
| `public/`, `api/`, `vercel.json` | the website + its API | Vercel |
| `relay/relay.py` | forwards the match state to the robots | each alliance laptop (controllers by USB) |
| `robot/` | `fieldctl` — drop into any PROS robot project | the V5 Brain |
| `test/` | match-logic tests (`npm test`) | anywhere |
| `dev-server.mjs` | run the site locally (`npm run dev`) | your laptop |

Pages
- **`/`** control page: period, START / STOP / RESET, enable / disable each alliance, release, countdown beeps and
  the "Mama!!" sound at GO (on the device that has the page open). Needs the **PIN**.
- **`/red`, `/blue`** team pages: clock, ROBOTS ENABLED / DISABLED banner, robot status. View-only, no PIN.

Match: **Autonomous 0:30** then **Driver Control 1:30**; also Driver Skills 1:00 and Programming Skills 1:00.
START runs a 3-2-1 countdown with the robots disabled, then GO enables every alliance ticked "in this run".
Edit the times in `api/_lib.js` (`PERIODS`).

## 1. Deploy to Vercel

1. Put this folder in a Git repo and push it, or run `vercel` inside it (needs the [Vercel CLI](https://vercel.com/docs/cli)).
2. In the Vercel project → **Storage** → add **Upstash Redis** (Marketplace). It adds the `UPSTASH_REDIS_REST_*`
   (or `KV_REST_API_*`) variables for you. The match state lives there.
3. **Settings → Environment Variables**, add for Production:
   - `CONTROL_PIN` — the PIN typed on the control page.
   - `RELAY_TOKEN` — a long random secret for the relays: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
4. Redeploy. Open the site: the control page asks for the PIN.

There is no build step: Vercel serves `public/` and runs `api/*.js` (Node 20+).
Without Redis the API falls back to memory, which is only reliable on one local process (the page warns you).

## 2. Run the relay (each alliance laptop)

```
pip install pyserial
py -3 relay\relay.py --server https://your-project.vercel.app --alliance red  --token <RELAY_TOKEN>
py -3 relay\relay.py --server https://your-project.vercel.app --alliance blue --token <RELAY_TOKEN>
```
Plug each driver's controller into that laptop by USB. Needs VS Code with the PROS extension (it ships `vexcom.exe`),
or pass `--vexcom <path>`. Close the PROS terminal first. Two controllers on one laptop that should belong to different
alliances: give each relay its own `--ports COM3` / `--ports COM6`.
Set `VEXNET_SERVER` and `VEXNET_TOKEN` as environment variables to shorten the command to `py -3 relay\relay.py --alliance red`.

The relay window shows the clock, ENABLED / DISABLED, and each robot's status. The control page shows the same robot status.

## 3. Put the robot module in your robot programs

Copy `robot/fieldctl.hpp` and `robot/fieldctl.cpp` into a PROS project (`include/` and `src/`), then:

```cpp
#include "fieldctl.hpp"

static void stopEverything() { /* stop every motor / actuator */ }
static void myAutonomous()   { /* your autonomous routine */ }

void initialize() {
  fieldctl::init(stopEverything, myAutonomous);   // first thing: starts its own listener + supervisor
}

void opcontrol() {
  while (true) {
    if (!fieldctl::driverAllowed()) { pros::delay(10); continue; }   // top of the driver loop
    // ... normal driving ...
    pros::delay(10);
  }
}
```
Behaviour: nothing changes until the first message arrives. After that the robot is DISABLED unless the website enables it,
runs `myAutonomous()` once per autonomous run (killed on disable), allows joystick driving in an enabled driver period, shows
`AUTO 0:25 ON` on the controller's top line, and disables itself if it hears nothing for 2 s. It replies `FCS|...` lines the
relay reads. It does not use the real competition state, so it works in any program slot that includes the module.

## Local test (no Vercel, no robots)

```
copy .env.example .env.local        # edit the PIN and token
npm run dev                         # http://localhost:3000   (memory storage)
npm test                            # match-logic tests
```

## Safety notes

- Anyone with the PIN can enable robots, and anyone with the relay token can speak for a relay: use long values, keep the token
  out of screenshots, and rotate both in Vercel if they leak. The team pages are view-only and show only the clock and status.
- A lost website, internet or relay disables the robots (relay: ~1.5 s, robot: 2 s). The extra hop adds a little delay to a
  disable compared with a LAN, so keep the robots off the floor while testing.

## API (for reference)

| Endpoint | Auth | |
|---|---|---|
| `GET /api/state` | none | public snapshot (clock, enables, robot status) |
| `POST /api/cmd` | `x-pin` | `{cmd: select\|start\|stop\|reset\|toggle\|inrun\|release, ...}` |
| `GET /api/relay?alliance=red` | `x-relay-token` | `{fc, clock}` the line for the robots |
| `POST /api/relay` | `x-relay-token` | relay → website robot status |
