#pragma once
// VEXNET field control for PROS -- lets the VEXNET website run matches with this robot.
// Install: pros c add-depot VEXNET <depot url>  then  pros c apply fieldctl   (see README)
// Protocol: "FC ..." lines in, "FCS|..." lines out (the website / relay.py speak it).
//
// Plug and play: nothing to add to the program. Once applied, the library starts with the program and,
// while a match has the robot:
//   - disabled:   pauses the program's opcontrol() and brakes every motor
//   - autonomous: runs the program's autonomous(), stopped when the period ends or on disable
//   - driver:     resumes opcontrol() where it was paused
// With no match it does nothing, so practice driving is unchanged.
//
// Optional, for programs that want to control it themselves:
//   #include "fieldctl/fieldctl.hpp"
//   fieldctl::init(stopAll, autonomous);   // own stop routine / autonomous instead of the defaults
//   fieldctl::driverAllowed()              // e.g. for driving done in a task of its own
#include <functional>

namespace fieldctl {
// stopAll:    stop every motor/actuator (called on disable, repeatedly while disabled)
// autonomous: the autonomous routine; runs in its own task and is killed on disable
void init(std::function<void()> stopAll, std::function<void()> autonomous);

bool engaged();        // the gamemaster has taken over
bool driverAllowed();  // true when joystick control is allowed (not engaged, or enabled DRIVER)
} // namespace fieldctl
