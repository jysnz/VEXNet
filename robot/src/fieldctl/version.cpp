// The only thing compiled into firmware/fieldctl.a. fieldctl itself ships as source
// (src/fieldctl/fieldctl.cpp in the team's project), so it is built into the program's hot
// package: a team's cold package (LemLib, lvgl, ...) is often right at the size the brain
// will still load, and anything added to it can stop the program from running at all.
extern "C" const char fieldctl_version[] = "1.2.0";
