@echo off
echo Starting Hydra+ Dual Server Architecture
echo ==========================================
echo State Server (Port 3847) - Progress, Events, Queue
echo Metadata Worker (Port 3848) - Spotify, Tags, Covers
echo ==========================================
cd /d "%~dp0"

:: Start State Server in background
echo Starting State Server...
start "Hydra+ State Server" /MIN node state-server.js

:: Wait 2 seconds for state server to initialize
timeout /t 2 /nobreak >nul

:: Start Metadata Worker in background
echo Starting Metadata Worker...
start "Hydra+ Metadata Worker" /MIN node metadata-worker.js

echo.
echo Both servers started!
echo State Server: http://127.0.0.1:3847/ping
echo Metadata Worker: http://127.0.0.1:3848/ping
echo.
echo Press any key to stop all servers...
pause >nul

:: Kill both servers
taskkill /FI "WINDOWTITLE eq Hydra+ State Server*" /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Hydra+ Metadata Worker*" /F >nul 2>&1

echo.
echo All servers stopped.
pause
