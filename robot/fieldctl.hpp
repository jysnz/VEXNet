#pragma once
// Portable scrimmage field control -- drop into any PROS project.
// Speaks the same protocol as tools/field_relay.py ("FC ..." in, "FCS|..." out).
//
//   fieldctl::init(stopAll, autonomous);   // first thing in initialize()
//   ...
//   if (!fieldctl::driverAllowed()) { pros::delay(10); continue; }  // top of the driver loop
//
// init() starts its own stdin reader and supervisor task, so it works no
// matter what the rest of the program does.
#include <functional>

namespace fieldctl {
// stopAll:    stop every motor/actuator (called on disable, repeatedly while disabled)
// autonomous: the autonomous routine; runs in its own task and is killed on disable
void init(std::function<void()> stopAll, std::function<void()> autonomous);

bool engaged();        // the gamemaster has taken over
bool driverAllowed();  // true when joystick control is allowed (not engaged, or enabled DRIVER)
} // namespace fieldctl
