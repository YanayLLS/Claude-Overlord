@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Download it from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install --no-save
    if !errorlevel! neq 0 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo Starting Overlord...
rem Same steps as "npm start", but Electron is started detached so this console closes at once
rem instead of sitting on screen for the app's whole life (the app logs to overlord.log anyway).
call node scripts/bundle-xterm.js && call node scripts/bundle-three.js && call node scripts/bundle-md.js
if %errorlevel% neq 0 (
    echo [ERROR] Bundling failed.
    pause
    exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" .
exit
