// Example robot program using the fieldctl library. Not part of the library template
// (the Makefile leaves src/main.cpp out), it only shows how a team uses it.
#include "main.h"
#include "fieldctl/fieldctl.hpp"

static pros::Controller master(pros::E_CONTROLLER_MASTER);
static pros::MotorGroup left({1, 2});
static pros::MotorGroup right({-3, -4});

static void stopEverything() {
  left.brake();
  right.brake();
}

static void myAutonomous() {
  left.move(60);
  right.move(60);
  pros::delay(1000);
  stopEverything();
}

void initialize() { fieldctl::init(stopEverything, myAutonomous); }
void disabled() {}
void competition_initialize() {}
void autonomous() { myAutonomous(); }

void opcontrol() {
  while (true) {
    if (!fieldctl::driverAllowed()) {
      pros::delay(10);
      continue;
    }
    left.move(master.get_analog(pros::E_CONTROLLER_ANALOG_LEFT_Y));
    right.move(master.get_analog(pros::E_CONTROLLER_ANALOG_RIGHT_Y));
    pros::delay(10);
  }
}
