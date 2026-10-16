@echo off
rem VEXNET field control switch, then build and upload.  In the PROS terminal of the robot project:
rem     .\vexnet on       robot waits disabled until the VEXNET gamemaster starts a match
rem     .\vexnet off      field control off: normal driving, no website
rem     .\vexnet off --slot 2     anything after on/off goes to "pros mu"
rem Writes include\fieldctl\config.h, which the fieldctl library reads when it is compiled.
setlocal
if /i "%~1"=="on" (set V=1) else if /i "%~1"=="off" (set V=0) else (
  echo usage: .\vexnet on^|off  [pros mu options, e.g. --slot 2]
  if exist include\fieldctl\config.h (type include\fieldctl\config.h) else (echo currently: on ^(default^))
  exit /b 1
)
if not exist src\fieldctl\fieldctl.cpp (
  echo Run this in a robot project that has the fieldctl library:  pros c apply fieldctl
  exit /b 1
)
> include\fieldctl\config.h (
  echo // Written by vexnet.cmd: 1 = VEXNET on, 0 = off. Change it with  .\vexnet on  /  .\vexnet off
  echo #define FIELDCTL_VEXNET %V%
)
rem make the library rebuild with the new setting
copy /b src\fieldctl\fieldctl.cpp +,, src\fieldctl\fieldctl.cpp >nul
echo VEXNET %~1 - building and uploading...
shift
pros mu %1 %2 %3 %4 %5 %6
