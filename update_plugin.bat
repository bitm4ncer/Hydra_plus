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

echo  Removing old plugin installation...
if exist "%PLUGIN_DEST%" (
    rmdir /s /q "%PLUGIN_DEST%" 2>nul
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
    echo  ========================================================================
    echo   NEXT STEPS:
    echo  ========================================================================
    echo.
    echo  1. Restart Nicotine+ to load the updated plugin
    echo  2. Re-enable the plugin in Settings ^> Plugins if needed
    echo  3. The bridge server will start automatically when enabled
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
