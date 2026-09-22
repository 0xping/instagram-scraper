@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto install_node
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)"
if errorlevel 1 goto install_node
goto dependencies

:install_node
where winget >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Install it from https://nodejs.org/en/download
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
echo Installing Node.js with winget...
winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
echo Close this window, then double-click Install again so Windows refreshes PATH.
pause
exit /b 1

:dependencies
call npm ci
if errorlevel 1 goto failed
call npx playwright install chromium
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
if not exist .env copy .env.example .env >nul
echo Done. Double-click Start.
pause
exit /b 0

:failed
echo Installation stopped. Read the error above, then run Install again.
pause
exit /b 1
