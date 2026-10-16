#pragma once
// VEXNET field control for PROS -- lets the VEXNET website run matches with this robot.
// Install: pros c add-depot VEXNET <depot url>  then  pros c apply fieldctl   (see README)
// Protocol: "FC ..." lines in, "FCS|..." lines out (the website / relay.py speak it).
//
// Plug and play: nothing to add to the program. Once applied, the library starts with the program and
// VEXNET is ON:
//   - until a match runs the robot (and again after it): disabled, opcontrol() paused, motors braked
//   - match disabled:   the same
//   - autonomous:       runs the program's autonomous(), stopped when the period ends or on disable
//   - driver control:   resumes opcontrol() where it was paused
//
// To drive without the website (practice), switch VEXNET off -- first line of initialize():
//   #include "fieldctl/fieldctl.hpp"
//   fieldctl::setVexnet(false);   // off: field control does nothing, normal driving and autonomous
//
// Optional, for programs that want to control it themselves:
//   fieldctl::init(stopAll, autonomous);   // own stop routine / autonomous instead of the defaults
//   fieldctl::driverAllowed()              // e.g. for driving done in a task of its own
#include <functional>

namespace fieldctl {
// true (the default): the robot waits disabled until the VEXNET gamemaster starts a match.
// false: field control is off -- the robot drives normally and doesn't answer the website.
void setVexnet(bool on);
bool vexnet();

// stopAll:    stop every motor/actuator (called on disable, repeatedly while disabled)
// autonomous: the autonomous routine; runs in its own task and is killed on disable
void init(std::function<void()> stopAll, std::function<void()> autonomous);

bool engaged();        // a match has the robot
bool driverAllowed();  // true when joystick control is allowed (VEXNET off, or an enabled DRIVER period)
} // namespace fieldctl
