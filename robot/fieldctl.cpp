#include "fieldctl.hpp"
#include "main.h"
#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>

namespace fieldctl {

static const uint32_t kHeartbeatTimeoutMs = 2000; // no FC line this long -> disabled
static const uint32_t kStatusIntervalMs = 500;

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
static std::function<void()> stopAll;
static std::function<void()> autonFn;

static State snapshot() {
  mtx.take();
  State s = state;
  mtx.give();
  return s;
}
static bool signalLost(const State &s) { return pros::millis() - s.lastMsgMs > kHeartbeatTimeoutMs; }

bool engaged() { return snapshot().engaged; }

bool driverAllowed() {
  State s = snapshot();
  if (!s.engaged)
    return true;
  return s.enabled && !s.autoPeriod && !signalLost(s);
}

// "FC <A|D> <0|1> <secsLeft> <runId>"  or  "FC OFF"
static void handleLine(const char *line) {
  if (strncmp(line, "FC ", 3) != 0)
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
    if (fgets(line, sizeof(line), stdin))
      handleLine(line);
    else
      pros::delay(10);
  }
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
  stopAll();
}

static void describe(const State &s, char *out, size_t n) {
  if (!s.engaged)
    snprintf(out, n, "PRACTICE          ");
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
    State s = snapshot();
    bool live = s.engaged && s.enabled && !signalLost(s);
    bool wantAuton = live && s.autoPeriod;

    // autonomous: kill when it shouldn't run, start once per runId
    if (autonTask && (!wantAuton || s.runId != autonRunId))
      killAuton();
    if (wantAuton && !autonTask && s.runId != autonRunId)
      startAuton(s.runId);

    // losing the right to move: stop once, then keep holding everything off
    if ((wasLive && !live) || (wasEngaged && !s.engaged) || (!wasEngaged && s.engaged && !live)) {
      if (autonTask)
        killAuton();
      stopAll();
      printf("FIELD: %s\n", s.engaged ? "disabled" : "released");
    }
    if (s.engaged && !live)
      stopAll();
    wasLive = live;
    wasEngaged = s.engaged;

    if (s.engaged || shown[0]) {
      char text[24];
      describe(s, text, sizeof(text));
      if (strcmp(text, shown) != 0 && controller.print(0, 0, "%s", text) == 1)
        snprintf(shown, sizeof(shown), "%s", text);
    }

    uint32_t now = pros::millis();
    if (now - lastStatusMs >= kStatusIntervalMs) {
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

void init(std::function<void()> stop, std::function<void()> autonomous) {
  static bool started = false;
  if (started)
    return;
  started = true;
  stopAll = std::move(stop);
  autonFn = std::move(autonomous);
  pros::Task(listenerTask, nullptr, "fc listener");
  pros::Task(supervisorTask, nullptr, "fc supervisor");
}

} // namespace fieldctl
