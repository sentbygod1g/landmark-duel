@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title Landmark Duel V18.2 - Upload existing GitHub repo + Render
color 0A

set "REPO=https://github.com/sentbygod1g/landmark-duel.git"

echo ============================================================
echo   LANDMARK DUEL V18.2 - EXISTING GITHUB REPO DEPLOY
echo ============================================================
echo.
echo GitHub repo: %REPO%
echo This file will NOT create or open a new GitHub repository.
echo.
where node >nul 2>nul || (echo [ERROR] Node.js is missing.& pause& exit /b 1)
where git >nul 2>nul || (echo [ERROR] Git for Windows is missing.& pause& exit /b 1)

echo [1/4] Checking game project...
node --check server.js || (echo [ERROR] server.js syntax check failed.& pause& exit /b 1)
node --check public\app.js || (echo [ERROR] public\app.js syntax check failed.& pause& exit /b 1)
node TEST_V18_RENDER.js || (echo [ERROR] Render configuration test failed.& pause& exit /b 1)
echo [OK] Project checks passed.
echo.

echo [2/4] Preparing Git...
if not exist .git (
  git init || goto :gitfail
)
git branch -M main || goto :gitfail
git add . || goto :gitfail
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "Landmark Duel V18.2 Render deploy" || goto :gitfail
) else (
  echo [OK] No new local changes need a commit.
)

echo.
echo [3/4] Connecting to YOUR EXISTING repository...
git remote remove origin >nul 2>nul
git remote add origin "%REPO%" || goto :gitfail
echo Uploading Landmark Duel to GitHub...
git push -u origin main
if errorlevel 1 goto :pushfail

echo.
echo ============================================================
echo   GITHUB UPLOAD: SUCCESS
echo   https://github.com/sentbygod1g/landmark-duel
echo ============================================================
echo.
echo [4/4] Opening Render Blueprint page...
echo Choose New Blueprint / connect repository: sentbygod1g/landmark-duel
echo The included render.yaml supplies the service settings.
echo When Render asks for TWITCH_CLIENT_SECRET, enter it ONLY in Render.
echo.
start "" "https://dashboard.render.com/blueprints"
pause
exit /b 0

:pushfail
echo.
echo [ERROR] GitHub upload did not complete.
echo If a GitHub sign-in window opened, finish the sign-in and run this BAT once more.
echo DO NOT create another repository. The repository already exists:
echo %REPO%
pause
exit /b 1

:gitfail
echo.
echo [ERROR] Local Git step failed. Do NOT create another GitHub repository.
pause
exit /b 1
