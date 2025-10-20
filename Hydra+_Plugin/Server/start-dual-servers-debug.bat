@echo off
echo Starting Hydra+ Dual Server Architecture (Debug Mode)
echo ======================================================
echo State Server (Port 3847) - Progress, Events, Queue
echo Metadata Worker (Port 3848) - Spotify, Tags, Covers
echo ======================================================
cd /d "%~dp0"

:: Start State Server in new window
echo Starting State Server...
start "Hydra+ State Server (DEBUG)" node state-server.js

:: Wait 2 seconds for state server to initialize
timeout /t 2 /nobreak >nul

:: Start Metadata Worker in new window
echo Starting Metadata Worker...
start "Hydra+ Metadata Worker (DEBUG)" node metadata-worker.js

echo.
echo Both servers started in separate windows!
echo State Server: http://127.0.0.1:3847/ping
echo Metadata Worker: http://127.0.0.1:3848/ping
echo.
echo Close each server window to stop them individually.
echo Press any key to exit this launcher...
pause
