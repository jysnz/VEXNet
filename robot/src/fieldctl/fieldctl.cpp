#include "fieldctl/fieldctl.hpp"
#include "main.h"
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>

// The kernel's own dispatcher: runs the program's autonomous() (see PROS user_functions.c).
extern "C" void user_autonomous(void);

namespace fieldctl {

static const uint32_t kHeartbeatTimeoutMs = 2000; // no FC line this long -> disabled
static const uint32_t kStatusIntervalMs = 500;
static const char *kOpcontrolTask = "User Operator Control (PROS)"; // the kernel's opcontrol() task

struct State {
  bool engaged = false;
  bool autoPeriod = false;
  bool enabled = false;
  int secsLeft = 0;
  int runId = 0;
  uint32_t lastMsgMs = 0;
};
static State state;
static pros::Mutex mtx;
static std::function<void()> stopAll;  // set by init(); empty = brake every motor
static std::function<void()> autonFn;  // set by init(); empty = the program's autonomous()
// On = the robot is held disabled until a match runs it; off = field control does nothing.
// Set from the terminal with the vexnet command (vexnet.cmd on|off writes include/fieldctl/config.h),
// or from code with setVexnet(). On unless config.h says otherwise.
#if __has_include("fieldctl/config.h")
#include "fieldctl/config.h"
#endif
#ifndef FIELDCTL_VEXNET
#define FIELDCTL_VEXNET 1
#endif
static std::atomic<bool> vexnetOn{FIELDCTL_VEXNET != 0};

static State snapshot() {
  mtx.take();
  State s = state;
  mtx.give();
  return s;
}
static bool signalLost(const State &s) { return pros::millis() - s.lastMsgMs > kHeartbeatTimeoutMs; }

void setVexnet(bool on) { vexnetOn = on; }
bool vexnet() { return vexnetOn; }

bool engaged() { return vexnetOn && snapshot().engaged; }

bool driverAllowed() {
  if (!vexnetOn)
    return true;
  State s = snapshot();
  if (!s.engaged)
    return false; // VEXNET on: no driving until a match starts
  return s.enabled && !s.autoPeriod && !signalLost(s);
}

// "FC <A|D> <0|1> <secsLeft> <runId>"  or  "FC OFF"
static void handleLine(const char *line) {
  if (!vexnetOn || strncmp(line, "FC ", 3) != 0)
    return;
  char period;
  int en, secs, run;
  if (strncmp(line + 3, "OFF", 3) == 0) {
    mtx.take();
    state.engaged = false;
    state.enabled = false;
    mtx.give();
  } else if (sscanf(line + 3, "%c %d %d %d", &period, &en, &secs, &run) == 4 &&
             (period == 'A' || period == 'D')) {
    mtx.take();
    state.engaged = true;
    state.autoPeriod = period == 'A';
    state.enabled = en != 0;
    state.secsLeft = secs;
    state.runId = run;
    state.lastMsgMs = pros::millis();
    mtx.give();
  }
}

static void listenerTask(void *) {
  char line[160];
  while (true) {
    if (!vexnetOn) { // off: leave the terminal input to the program
      pros::delay(50);
      continue;
    }
    if (fgets(line, sizeof(line), stdin))
      handleLine(line);
    else
      pros::delay(10);
  }
}

// Without init(): every motor port braked (each motor's own brake mode, so HOLD lifts stay up).
static void stopMotors() {
  if (stopAll) {
    stopAll();
    return;
  }
  for (uint8_t port = 1; port <= 21; port++)
    pros::c::motor_brake(port); // ports without a motor just return an error
}

// The program's opcontrol() task is paused while the field doesn't allow driving, so the
// driver loop needs no changes. Resumed exactly where it stopped.
static pros::task_t pausedDriver = nullptr;

static void pauseDriver() {
  if (pausedDriver)
    return;
  pros::task_t t = pros::c::task_get_by_name(kOpcontrolTask);
  if (t && t != pros::c::task_get_current()) {
    pros::c::task_suspend(t);
    pausedDriver = t;
    stopMotors(); // whatever the driver loop last set
  }
}

static void resumeDriver() {
  if (!pausedDriver)
    return;
  // Only if it is still the opcontrol task (the kernel replaces it if the competition state changes).
  if (pros::c::task_get_by_name(kOpcontrolTask) == pausedDriver)
    pros::c::task_resume(pausedDriver);
  pausedDriver = nullptr;
}

static std::unique_ptr<pros::Task> autonTask;
static std::atomic<bool> autonRunning{false};
static int autonRunId = -1;

static void startAuton(int runId) {
  autonRunId = runId;
  autonRunning = true;
  printf("FIELD: autonomous start (run %d)\n", runId);
  autonTask = std::make_unique<pros::Task>(
      []() {
        if (autonFn)
          autonFn();
        else
          user_autonomous();
        autonRunning = false;
      },
      "fc auton");
}

static void killAuton() {
  if (autonRunning) {
    autonTask->remove();
    autonRunning = false;
    printf("FIELD: autonomous killed\n");
  }
  autonTask.reset();
  pros::delay(20);
  stopMotors();
}

static void describe(const State &s, bool on, char *out, size_t n) {
  if (!on)
    snprintf(out, n, "VEXNET OFF        ");
  else if (!s.engaged)
    snprintf(out, n, "WAITING FOR MATCH ");
  else if (signalLost(s))
    snprintf(out, n, "NO FIELD SIGNAL   ");
  else
    snprintf(out, n, "%-6s %d:%02d %-3s    ", s.autoPeriod ? "AUTO" : "DRIVER", s.secsLeft / 60,
             s.secsLeft % 60, s.enabled ? "ON" : "OFF");
}

static void supervisorTask(void *) {
  bool wasLive = false, wasEngaged = false;
  char shown[24] = "";
  uint32_t lastStatusMs = 0;
  pros::Controller controller(pros::E_CONTROLLER_MASTER);

  while (true) {
    bool on = vexnetOn;
    State s = on ? snapshot() : State{}; // off: as if no match ever had the robot
    bool waiting = on && !s.engaged;     // on, no match running it: held disabled
    bool live = s.engaged && s.enabled && !signalLost(s);
    bool wantAuton = live && s.autoPeriod;
    bool wantDriver = live && !s.autoPeriod;

    // driver control: only in an enabled driver period, or always with VEXNET off
    if (on && !wantDriver)
      pauseDriver();
    else
      resumeDriver();

    // autonomous: kill when it shouldn't run, start once per runId
    if (autonTask && (!wantAuton || s.runId != autonRunId))
      killAuton();
    if (wantAuton && !autonTask && s.runId != autonRunId)
      startAuton(s.runId);

    // losing the right to move: stop once, then keep holding everything off
    if ((wasLive && !live) || (wasEngaged && !s.engaged) || (!wasEngaged && s.engaged && !live)) {
      if (autonTask)
        killAuton();
      stopMotors();
      printf("FIELD: %s\n", s.engaged ? "disabled" : on ? "match over, waiting for the next" : "released");
    }
    if (s.engaged && !live)
      stopMotors();
    wasLive = live;
    wasEngaged = s.engaged;

    if (s.engaged || waiting || shown[0]) {
      char text[24];
      describe(s, on, text, sizeof(text));
      if (strcmp(text, shown) != 0 && controller.print(0, 0, "%s", text) == 1)
        snprintf(shown, sizeof(shown), "%s", text);
    }

    uint32_t now = pros::millis();
    if (on && now - lastStatusMs >= kStatusIntervalMs) { // off: no replies, the website shows no robot
      lastStatusMs = now;
      if (s.engaged)
        printf("FCS|%c|%d|%d|%d\n", s.autoPeriod ? 'A' : 'D', live ? 1 : 0, autonRunning ? 1 : 0,
               s.runId);
      else
        printf("FCS|P|0|0|0\n");
    }
    pros::delay(10);
  }
}

static std::atomic<bool> started{false};

static void startTasks() {
  if (started.exchange(true))
    return;
  pros::c::task_create(listenerTask, nullptr, TASK_PRIORITY_DEFAULT, TASK_STACK_DEPTH_DEFAULT, "fc listener");
  // Above the program's tasks, so a pause / brake can't be starved by a busy driver loop.
  pros::c::task_create(supervisorTask, nullptr, TASK_PRIORITY_DEFAULT + 2, TASK_STACK_DEPTH_DEFAULT,
                       "fc supervisor");
}

// The kernel's tasks for the program's own functions: once one exists, PROS (serial, devices) is up.
static bool programStarted() {
  for (const char *name : {"User Initialization (PROS)", "User Operator Control (PROS)", "User Autonomous (PROS)",
                           "User Disabled (PROS)", "User Comp. Init. (PROS)"})
    if (pros::c::task_get_by_name(name))
      return true;
  return false;
}

static void bootTask(void *) {
  while (!programStarted())
    pros::delay(10);
  startTasks();
}

// Plug and play: no code needed in the program. This runs while the program loads, before PROS has
// finished starting, so it only leaves a small task behind that starts field control once the
// program's own initialize() has begun.
__attribute__((constructor)) static void autoStart() {
  pros::c::task_create(bootTask, nullptr, TASK_PRIORITY_DEFAULT, TASK_STACK_DEPTH_MIN, "fc boot");
}

void init(std::function<void()> stop, std::function<void()> autonomous) {
  mtx.take();
  stopAll = std::move(stop);
  autonFn = std::move(autonomous);
  mtx.give();
  startTasks();
}

} // namespace fieldctl
