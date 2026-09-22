@echo off
cd /d "%~dp0"
call npm run app
if errorlevel 1 (
  echo The dashboard exited with an error.
  pause
  exit /b 1
)
