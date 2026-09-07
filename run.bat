@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-launch.ps1"
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo Agent Stats did not open. Read the messages above.
  pause
)
exit /b %ERR%
