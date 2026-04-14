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

echo Checking build prerequisites...
node scripts\check-prerequisites.js
if %errorlevel% neq 0 (
    echo Refreshing environment...
    for /f "tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYS_PATH=%%B"
    for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USR_PATH=%%B"
    set "PATH=!SYS_PATH!;!USR_PATH!"
)

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
    if !errorlevel! neq 0 (
        echo.
        echo [ERROR] npm install failed. You may need to restart your terminal and try again.
        pause
        exit /b 1
    )
)

echo Starting Overlord...
call npm start
if %errorlevel% neq 0 (
    echo [ERROR] App failed to start.
    pause
    exit /b 1
)
