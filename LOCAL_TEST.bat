@echo off
setlocal
cd /d "%~dp0"
title Landmark Duel V18 - Local Test
color 0B
where node >nul 2>nul || (echo [ERROR] Node.js is missing.& pause& exit /b 1)
if not exist node_modules (
  echo Installing project packages...
  call npm install || (echo [ERROR] npm install failed.& pause& exit /b 1)
)
echo.
echo Starting LOCAL test only: http://localhost:3000
echo This is NOT the public viewer link.
echo Press Ctrl+C to stop.
echo.
set PORT=3000
set PUBLIC_BASE_URL=http://localhost:3000
node server.js
pause
