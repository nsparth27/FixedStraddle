@echo off
setlocal
cd /d "%~dp0"
title Straddle Signal

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js 22 or later from https://nodejs.org/
    pause
    exit /b 1
)

echo ===================================================
echo   Starting Straddle Signal Server...
echo   Dashboard: http://127.0.0.1:3000
echo ===================================================
echo.

:: Automatically open the web browser after a 1-second delay
start "" cmd /c "ping 127.0.0.1 -n 2 >nul & start http://127.0.0.1:3000"

:: Launch the Node.js server
node server.mjs

:: If the server exits with an error, keep the window open to inspect
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Server stopped with exit code %ERRORLEVEL%.
    pause
)
