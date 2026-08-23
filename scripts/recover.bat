@echo off
REM Double-click this from Explorer (NOT from a terminal inside Overlord — Electron
REM puts its children in a job object that dies with the app). Waits for Overlord to
REM close, rebuilds the agent list from Claude's transcripts, then starts Overlord.
REM Optional arg: how many days back to scan (default 2).
cd /d "%~dp0.."

echo.
echo === Overlord state recovery ===
echo Close Overlord now if it is still open.
echo.

:wait
tasklist /fi "imagename eq electron.exe" 2>nul | find /i "electron.exe" >nul
if not errorlevel 1 (
  echo   waiting for Overlord to close...
  timeout /t 2 /nobreak >nul
  goto wait
)

timeout /t 2 /nobreak >nul
node scripts\recover-state.js %1
if errorlevel 1 (
  echo.
  echo Recovery FAILED - state left untouched.
  pause
  exit /b 1
)

echo.
echo Starting Overlord...
start "" "%~dp0..\start.bat"
timeout /t 3 /nobreak >nul
