@echo off
title Kill Hydra+ Server
color 0C

cls
echo.
echo  ========================================================================
echo.
echo                   KILL HYDRA+ SERVER
echo.
echo  ========================================================================
echo.
echo  This will terminate all Node.js processes, including the bridge server.
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
    echo  The Hydra+ bridge server has been stopped.
    echo  You can now restart it for a clean instance.
) else (
    color 0E
    echo  +-------------------------------------------------------------------+
    echo  ^|  INFO: No Node.js processes were running                         ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  The server was already stopped.
)

echo.
echo  Press any key to exit...
pause >nul
