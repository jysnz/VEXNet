# VEXNET Field Control

Scrimmage field control for VEX V5 robots, run from a website. You **create a match** (Skills Challenge,
1v1 or 2v2), other laptops **join it with a code**, the controllers get assigned to robot slots, and **START**
runs the whole match: 3-2-1, autonomous, driver control.

```
 any browser (phone / tablet / laptop) ──► VEXNET website on Vercel ◄── polls over HTTPS ── relay on laptop A ─┐
   create / join / lobby / match screen      matches + clock, PIN                          ── relay on laptop B ─┤
                                             state in Upstash Redis                                              │
                                                       controller USB ► radio ► Brain (robot program) ◄─────────┘
```

| Folder | What it is | Runs on |
|---|---|---|
| `public/`, `api/`, `vercel.json` | the website + its API | Vercel |
| `public/usb-relay.js` | the same job inside Chrome / Edge (Web Serial), no install | every laptop with controllers, in the browser |
| `relay/relay.py` | forwards the match to the robots, reports the laptop's controllers (optional, needs Python + PROS) | every laptop with controllers plugged in (USB) |
| `robot/` | `fieldctl` - PROS library template teams install from the terminal (like LemLib) | the V5 Brain |
| `test/` | match-logic tests (`npm test`) | anywhere |
| `dev-server.mjs` | run the site locally (`npm run dev`) | your laptop |

## How a match goes

1. **Every laptop with controllers** opens the website in Chrome/Edge and presses **Connect controller** (or runs the relay, below). It shows up on the website as an online laptop with its controllers.
2. **Host** opens the website → **Create match** → picks the type → enters the **PIN** → gets a 6-character **match code**.
3. **Second laptop** opens the same website → **Join match** → types the code → taps **This laptop** (it is picked from the laptops that are online).
   The lobby shows it as *joined*.
4. **Host** taps **Auto-assign controllers**: the joined laptops' controllers fill the slots in order (`RED 1, RED 2, BLUE 1, BLUE 2`, laptop A first).
   For a 2v2 with two laptops of two controllers each, laptop A becomes red and laptop B blue. Any slot can be changed by hand with its dropdown.
5. START unlocks when every slot has a controller whose robot is **replying**. The lobby says what is missing.
6. **START MATCH** (host only, PIN): 3-2-1 → **autonomous** → short transition → **driver control** → ended. Everything is disabled at the end.

| Type | Robots | Timeline |
|---|---|---|
| Skills Challenge - Autonomous | 1 | autonomous 60 s |
| Skills Challenge - Driver Control | 1 | driver control 60 s |
| 1 v 1 | 2 (red 1, blue 1) - one laptop with two controllers, or two laptops with one each | autonomous 30 s, 3 s transition, driver control 90 s |
| 2 v 2 | 4 (red 1-2, blue 1-2) - usually two laptops | autonomous 30 s, 3 s transition, driver control 90 s |

During a match the host can **Disable / Enable an alliance** (referee), **STOP** (everything disabled, match over), or **RESET** (back to ready).
The match screen plays countdown beeps, the "Mama!!" sound at GO (`public/sounds/go.mp3`) and a buzzer at the end, on the device that has it open.
Times live in `api/_engine.js` (`TYPES`, `AUTO`, `TRANSITION`, `DRIVER`).

Who can do what: **anyone with the code** can watch a match and join it with a laptop; **only someone with the PIN** can create, assign, start, stop, reset or close.

## 1. Deploy to Vercel

1. Put this folder in a Git repo and push it, or run `vercel` inside it ([Vercel CLI](https://vercel.com/docs/cli)).
2. In the Vercel project → **Storage** → add **Upstash Redis** (Marketplace). It sets the `UPSTASH_REDIS_REST_*`
   (or `KV_REST_API_*`) variables. Matches and laptops live there.
3. **Settings → Environment Variables**, add for Production:
   - `CONTROL_PIN` - the PIN for the host.
   - `RELAY_TOKEN` - a long random secret for the relays: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
4. Redeploy. Open the site.

No build step: Vercel serves `public/` and runs `api/*.js` (Node 20+). Without Redis the API falls back to memory, which only
works on one local process (the page warns you).

## 2. Connect the controllers (every laptop with controllers)

**Easiest - nothing to install:** open the website in **Chrome or Edge** on the laptop the controllers are plugged into.
At the bottom, under *This laptop's controllers*, press **Connect controller** and pick a VEX controller; repeat for the second one.
Enter the PIN when asked. The laptop then shows up as online with its controllers (`CTRL1`, `CTRL2`), and that tab does the relay's job,
so **keep it open** during the match. Chrome remembers the controllers: next time they reconnect by themselves when the page opens.
Give each laptop its own name in the *Laptop name* box. Close the PROS terminal and `relay.py` first (only one program can use a controller).

**Or run the relay** (any browser, or no browser open on that laptop):

```
pip install pyserial
py -3 relay\relay.py --server https://your-project.vercel.app --token <RELAY_TOKEN>
```
- Plug each controller in by USB (paired to its robot as usual). Needs VS Code with the PROS extension (it ships `vexcom.exe`),
  or pass `--vexcom <path>`. Close the PROS terminal first (only one program can use a controller's port).
- `--name PIT-A` changes how the laptop is shown (default: the computer name). Two laptops need different names.
- `--ports COM3 COM6` limits it to those controllers. `VEXNET_SERVER` / `VEXNET_TOKEN` environment variables shorten the command to `py -3 relay\relay.py`.
- The window shows which robot slot each controller is in, the clock, and each robot's status.
- A controller that is no longer in a match is sent `FC OFF` for 3 s, which puts its robot back in normal practice mode.

## 3. Put the field-control library in your robot programs

`fieldctl` is a PROS library, installed the same way as LemLib. In the PROS terminal of the robot project (VS Code with the PROS extension), once:

```
pros c add-depot VEXNET https://raw.githubusercontent.com/jysnz/VEXNet/master/robot/depot.json
pros c apply fieldctl
```
Later updates: `pros c upgrade fieldctl` (or `pros c apply fieldctl@<version>`). (The repo has to be public for the depot link to work.)

That's all: **no code to add.** Build and upload as usual (`pros mu`). The library starts with the program, and while a match has the robot:

| Match says | The robot |
|---|---|
| disabled (before START, transition, after the match, referee) | pauses the program's `opcontrol()` and brakes every motor |
| autonomous | runs the program's own `autonomous()`, stopped when the period ends or on disable |
| driver control | resumes `opcontrol()` where it was paused |
| no match / released | nothing - practice driving works as before |

It also shows `AUTO 0:25 ON` on the controller's top line, disables itself if it hears nothing for 2 s, and replies `FCS|...` status
lines the website reads. It does not use the real competition state, so it works in any program slot.

Limits: driving done somewhere other than `opcontrol()` (a task of its own) keeps running while disabled - such a program can check
`fieldctl::driverAllowed()` itself. A program can also pass its own stop routine / autonomous with `fieldctl::init(stop, auton)`
(`#include "fieldctl/fieldctl.hpp"`); programs written for version 1.0 (which needed both) keep working unchanged.

**Releasing a new version of the library** (in `robot/`, PROS terminal): change `VERSION` in `robot/Makefile`, run `pros make template`,
move the new `fieldctl@X.Y.Z.zip` into `robot/templates/`, add an entry for it to `robot/depot.json`, then commit and push.
`robot/src/main.cpp` is an example program and is not part of the library.
The library ships as source (`src/fieldctl/fieldctl.cpp` in the team's project), not inside `firmware/fieldctl.a`, so it is built into the
program's hot package. Put into the cold package next to LemLib and lvgl, it made programs silently not run at all.

## Local test (no Vercel, no robots)

```
copy .env.example .env.local        # edit the PIN and token
npm run dev                         # http://localhost:3000   (memory storage)
npm test                            # match-logic tests
```

## Safety notes

- Anyone with the PIN can run matches and enable robots, and anyone with the relay token can speak for a relay: use long values, keep the token out of
  screenshots, and rotate both in Vercel if they leak. Match codes only grant viewing and joining.
- A lost website, internet or relay disables the robots (relay: ~1.5 s, robot: 2 s). The extra hop adds a little delay to a disable compared with a LAN,
  so keep the robots off the floor while testing.

## API (for reference)

| Endpoint | Auth | |
|---|---|---|
| `GET /api/relays` | none | laptops online and their controllers |
| `GET /api/match?code=ABC123` | none | the match (clock, slots, readiness, laptops) |
| `POST /api/match` `{action:"join",code,relay}` | none | a laptop joins |
| `POST /api/match` `{action:"create"\|"assign"\|"autoassign"\|"start"\|"stop"\|"reset"\|"toggle"\|"leave"\|"close",...}` | `x-pin` | host actions |
| `GET /api/relay?relay=NAME` | `x-relay-token` | what to send each of that laptop's controllers |
| `POST /api/relay` | `x-relay-token` | the laptop reports its controllers' status |
