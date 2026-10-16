# Putting VEXNET in your program slots

The website can only run a robot whose program was built with the `fieldctl` library. It works in any slot (1-8),
but each slot's program has to be uploaded with it.

You need VS Code with the PROS extension and a PROS project (kernel 4.2.2 or newer). Type the commands in the
PROS terminal of the robot project.

## 1. Download the library

Once per computer:

```
pros c add-depot VEXNET https://raw.githubusercontent.com/jysnz/VEXNet/master/robot/depot.json
```

Once per robot project:

```
pros c query-templates fieldctl --force-refresh
pros c apply fieldctl
```

No code changes are needed.

## 2. Upload it to a slot

Close the VEXNET website tab first, then:

```
.\vexnet on --slot 1
```

Change the number for another slot:

```
.\vexnet on --slot 1        slot 1
.\vexnet on --slot 2        slot 2
.\vexnet on --slot 3        slot 3
```

`.\vexnet on` builds and uploads the program with VEXNET on. Run that slot on the Brain and the website can use the robot.

For a practice slot that drives without the website, use `off`:

```
.\vexnet off --slot 4
```

## Updating the library

```
pros c query-templates fieldctl --force-refresh
pros c upgrade fieldctl
.\vexnet on --slot 1
```
