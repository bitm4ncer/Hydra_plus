@echo off
setlocal enabledelayedexpansion
title Update Hydra+ Plugin
color 0E

cls
echo.
echo  ========================================================================
echo.
echo                   UPDATE HYDRA+ PLUGIN
echo.
echo  ========================================================================
echo.
echo  This will copy the current plugin version from the Git folder
echo  to the live Nicotine+ plugins directory.
echo.
echo  Press ENTER to continue or CTRL+C to cancel...
pause >nul

set "NICOTINE_PLUGINS=%APPDATA%\nicotine\plugins"
set "PLUGIN_NAME=Hydra+_Plugin"
set "PLUGIN_DEST=%NICOTINE_PLUGINS%\%PLUGIN_NAME%"
set "SCRIPT_DIR=%~dp0"

echo.
echo  Source:      %SCRIPT_DIR%Hydra+_Plugin
echo  Destination: %PLUGIN_DEST%
echo.

REM Check if source exists
if not exist "%SCRIPT_DIR%Hydra+_Plugin\__init__.py" (
    color 0C
    cls
    echo.
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Source plugin files not found!                           ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Expected: %SCRIPT_DIR%Hydra+_Plugin\
    echo.
    pause
    exit /b 1
)

REM Check if destination directory exists
if not exist "%NICOTINE_PLUGINS%" (
    color 0C
    cls
    echo.
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Nicotine+ plugins directory not found!                   ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Expected: %NICOTINE_PLUGINS%
    echo.
    echo  Make sure Nicotine+ is installed or run INSTALL_WINDOWS.bat first.
    echo.
    pause
    exit /b 1
)

REM Kill bridge server process if running (to release file locks and clear cache)
echo  Checking for running bridge server...
tasklist /FI "IMAGENAME eq node.exe" 2>NUL | find /I /N "node.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo  Stopping bridge server processes...
    for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| findstr /I "PID:"') do (
        REM Check if this is the bridge server by checking command line
        wmic process where "ProcessId=%%a" get Commandline 2>nul | findstr /I "bridge-server.js" >nul
        if !errorlevel! equ 0 (
            echo  Terminating bridge server process %%a...
            taskkill /PID %%a /F >nul 2>&1
        )
    )
    echo  Bridge server stopped.
    timeout /t 2 /nobreak >nul
) else (
    echo  No bridge server running.
)

echo.
echo  Removing old plugin installation...
if exist "%PLUGIN_DEST%" (
    rmdir /s /q "%PLUGIN_DEST%" 2>nul
    if exist "%PLUGIN_DEST%" (
        color 0C
        echo  ERROR: Could not remove old files ^(may be locked^)
        echo  Try closing Nicotine+ and running this script again.
        echo.
        pause
        exit /b 1
    )
    echo  Old files removed.
) else (
    echo  No previous installation found.
)

echo.
echo  Copying new plugin files...
echo.

mkdir "%PLUGIN_DEST%" 2>nul
mkdir "%PLUGIN_DEST%\Server" 2>nul
xcopy /E /I /Y "%SCRIPT_DIR%Hydra+_Plugin" "%PLUGIN_DEST%" >nul 2>&1

echo.
echo  Clearing Node.js module cache...
if exist "%PLUGIN_DEST%\Server\node_modules" (
    rmdir /s /q "%PLUGIN_DEST%\Server\node_modules" >nul 2>&1
    echo  Node modules cache cleared ^(will be reinstalled on next start^).
) else (
    echo  No node_modules cache found.
)

if %errorlevel% equ 0 (
    color 0A
    cls
    echo.
    echo  +-------------------------------------------------------------------+
    echo  ^|  SUCCESS: Plugin updated successfully!                           ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Location: %PLUGIN_DEST%
    echo.

    REM Check if Nicotine+ is running and offer to restart it
    tasklist /FI "IMAGENAME eq nicotine.exe" 2>NUL | find /I /N "nicotine.exe">NUL
    if "%ERRORLEVEL%"=="0" (
        echo  ========================================================================
        echo   NICOTINE+ IS RUNNING
        echo  ========================================================================
        echo.
        echo  For changes to take effect, Nicotine+ needs to be restarted.
        echo.
        echo  Options:
        echo   [Y] - Close Nicotine+ now ^(you'll need to restart it manually^)
        echo   [N] - Keep Nicotine+ running ^(restart manually later^)
        echo.
        set /p RESTART_CHOICE="  Your choice [Y/N]: "

        if /i "!RESTART_CHOICE!"=="Y" (
            echo.
            echo  Closing Nicotine+...
            taskkill /IM nicotine.exe /F >nul 2>&1
            timeout /t 2 /nobreak >nul
            echo  Nicotine+ closed. Please restart it manually to load the updated plugin.
        ) else (
            echo.
            echo  Nicotine+ left running. Remember to restart it to load the updated plugin.
        )
    ) else (
        echo  ========================================================================
        echo   NEXT STEPS:
        echo  ========================================================================
        echo.
        echo  1. Start Nicotine+ to load the updated plugin
        echo  2. Enable the plugin in Settings ^> Plugins if needed
        echo  3. The bridge server will start automatically when enabled
    )
    echo.
) else (
    color 0C
    cls
    echo.
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Failed to copy plugin files                              ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Check if Nicotine+ is running and has the plugin locked.
    echo  Try closing Nicotine+ and running this script again.
    echo.
)

echo  Press any key to exit...
pause >nul
