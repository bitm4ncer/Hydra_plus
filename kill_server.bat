@echo off
title Kill Hydra+ Servers
color 0C

cls
echo.
echo  ========================================================================
echo.
echo                   KILL HYDRA+ SERVERS
echo.
echo  ========================================================================
echo.
echo  This will terminate all Node.js processes, including:
echo    - State Server (Port 3847)
echo    - Metadata Worker (Port 3848)
echo    - Legacy Bridge Server
echo.
echo  Press ENTER to continue or CTRL+C to cancel...
pause >nul

echo.
echo  Killing all Node.js processes...
echo.

taskkill /F /IM node.exe >nul 2>&1

if %errorlevel% equ 0 (
    color 0A
    echo  +-------------------------------------------------------------------+
    echo  ^|  SUCCESS: All Node.js processes terminated                       ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  All Hydra+ servers have been stopped:
    echo    - State Server (Port 3847) - STOPPED
    echo    - Metadata Worker (Port 3848) - STOPPED
    echo    - All Node.js instances - KILLED
    echo.
    echo  You can now restart the servers for a clean instance.
) else (
    color 0E
    echo  +-------------------------------------------------------------------+
    echo  ^|  INFO: No Node.js processes were running                         ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  All servers were already stopped.
)

echo.
echo  Press any key to exit...
pause >nul
