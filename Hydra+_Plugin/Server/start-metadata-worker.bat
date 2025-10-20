@echo off
REM Hydra+ Metadata Worker Launcher (Port 3848)
REM Sets console window to 80 columns x 25 rows

REM Set window size (width x height in characters)
mode con: cols=80 lines=25

REM Set window title
title Hydra+ Metadata Worker (Port 3848)

REM Start the metadata worker
node "%~dp0metadata-worker.js"

REM Keep window open if server crashes
if errorlevel 1 (
    echo.
    echo Server crashed! Press any key to close...
    pause >nul
)
