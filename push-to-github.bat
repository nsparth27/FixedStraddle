@echo off
title Push to GitHub (nsparth27/FixedStraddle)
color 0B
cd /d "%~dp0"

echo ========================================================
echo   Connecting and Pushing to GitHub...
echo   Target: https://github.com/nsparth27/FixedStraddle
echo ========================================================
echo.

node push.js

echo.
pause
