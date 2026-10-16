# Putting VEXNET in a robot program slot

The VEXNET website can only run a match with a robot whose **running program was built with the `fieldctl` library**.
The library lives inside the program, not on the Brain: it works in **any slot (1-8)**, but only for the programs you
build with it. A program uploaded without it never answers the website, whatever slot it is in.

You do this once per robot project. No code changes are needed.

## What you need

- VS Code with the **PROS extension** (its terminal has the `pros` command)
- A **PROS** robot project, kernel **4.2.2 or newer** (`pros c info-project` shows it; `pros c upgrade kernel` updates it).
  VEXcode programs can't use the library.
- The robot's **controller paired to its Brain**, and a USB cable

## 1. Add the VEXNET depot (once per computer)

In the PROS terminal:

```
pros c add-depot VEXNET https://raw.githubusercontent.com/jysnz/VEXNet/master/robot/depot.json
```

## 2. Add the library to the robot project (once per project)

Open the robot project in VS Code, then in its PROS terminal:

```
pros c query-templates fieldctl --force-refresh
pros c apply fieldctl
```

This adds `src/fieldctl/`, `include/fieldctl/`, `firmware/fieldctl.a` and the `vexnet.cmd` command to the project.
Commit them to git, so teammates who clone the project build it the same way.

## 3. Build and upload it to a slot

Close the VEXNET website tab first (only one program can use the controller), plug in the controller or the Brain by
USB, then:

```
.\vexnet on                 VEXNET on, build, upload to the project's usual slot
.\vexnet on --slot 3        ... to slot 3
.\vexnet on --slot 3 --name "Match bot"     ... and give it a name on the Brain
```

`.\vexnet` saves the setting, then runs `pros mu` (build + upload). Anything after `on` / `off` goes to `pros mu`.
If PROS asks to confirm a wireless upload, answer `y`.

Want the same program in several slots (say a match version and a practice version)? Upload it twice:

```
.\vexnet on  --slot 1       slot 1: for matches, waits for the website
.\vexnet off --slot 2       slot 2: practice, drives normally
```

## 4. Check that the website can see it

1. On the Brain, **run the slot** you uploaded to.
   With VEXNET on, the robot doesn't drive and the controller's top line shows `WAITING FOR MATCH`.
2. On the laptop the controller is plugged into, open the VEXNET website in **Chrome or Edge**.
   At the bottom, press **Connect controller**, pick the VEX controller, enter the PIN.
3. The controller shows **robot ready** in green, and in a match lobby its slot says
   *program running - waiting for field control* with a **READY** badge.

From then on the website runs the robot:

| | The robot |
|---|---|
| program running, no match yet (and after a match) | disabled: `opcontrol()` paused, motors braked |
| 3, 2, 1 countdown / match disabled / referee | disabled |
| autonomous | runs the program's own `autonomous()` |
| driver control | drives normally (`opcontrol()` resumes where it was) |

## On or off?

| | `.\vexnet on` | `.\vexnet off` |
|---|---|---|
| use it for | matches with the website | practice without the website |
| when the program starts | disabled, waiting for a match | drives normally |
| answers the website | yes | no |

The setting is saved in `include/fieldctl/config.h` and stays until you change it. `.\vexnet` on its own shows the current one.
A program can also switch it in code: `#include "fieldctl/fieldctl.hpp"`, then `fieldctl::setVexnet(false);` in `initialize()`.

## Updating the library

```
pros c query-templates fieldctl --force-refresh
pros c upgrade fieldctl
.\vexnet on
```

## When it doesn't work

| What you see | What to do |
|---|---|
| The lobby says **no reply from robot** | Run the right slot on the Brain (one uploaded with the library), check the controller is paired to that robot, press Connect controller again. |
| It worked in one slot but not another | Each slot is its own program: upload the library version to that slot too (`.\vexnet on --slot N`). |
| `fieldctl does not support kernel version ...` or the version isn't found | PROS has an old copy of the depot: `pros c query-templates fieldctl --force-refresh`, then try again. |
| `Couldn't find the response header ... expecting aa55` or the upload can't open the port | Something else holds the controller: close the VEXNET website tab and the PROS terminal. If the controller still doesn't answer, unplug it and turn it off and on. |
| The robot drives before the match starts | The program was uploaded with VEXNET off, or before the library was added: `.\vexnet on` and run that slot. |
| Disabled, but one mechanism still moves | It's driven from a task of its own instead of `opcontrol()`: check `fieldctl::driverAllowed()` in that task. |
| `'vexnet' is not recognized` | Type it as `.\vexnet` in the project folder (where `vexnet.cmd` is). If the file is missing, run `pros c apply fieldctl` again. |

## For library maintainers

`robot/` is the library's PROS project. To release a version: change `VERSION` in `Makefile`, run `pros make template`,
move the new `fieldctl@X.Y.Z.zip` into `templates/`, point `depot.json` at it, commit and push.
`src/main.cpp` is only an example program; the library ships as source (`src/fieldctl/fieldctl.cpp`) so it builds into
the program's hot package.
