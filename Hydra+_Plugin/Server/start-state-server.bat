@echo off
REM Hydra+ State Server Launcher (Port 3847)
REM Sets console window to 80 columns x 25 rows

REM Set window size (width x height in characters)
mode con: cols=80 lines=25

REM Set window title
title Hydra+ State Server (Port 3847)

REM Start the state server
node "%~dp0state-server.js"

REM Keep window open if server crashes
if errorlevel 1 (
    echo.
    echo Server crashed! Press any key to close...
    pause >nul
)
