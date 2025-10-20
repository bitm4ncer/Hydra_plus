@echo off
setlocal enabledelayedexpansion
title Hydra+ Quick Installer
color 0A

cls
echo.
echo  ========================================================================
echo.
echo                   H Y D R A +   Q U I C K   I N S T A L L E R
echo                     Nicotine+ Browser Link v0.1.8
echo.
echo  ========================================================================
echo.
echo  This will:
echo   - Kill any running Hydra+ servers
echo   - Install/Update the Nicotine+ plugin
echo   - Install Node.js dependencies
echo   - Setup browser extension
echo.
echo  Press ENTER to start installation or CTRL+C to cancel...
pause >nul

REM ============================================================================
REM Kill existing servers
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   KILLING EXISTING SERVERS
echo  ========================================================================
echo.

taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq *state-server.js*" >nul 2>&1
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq *metadata-worker.js*" >nul 2>&1
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq Hydra+ State Server*" >nul 2>&1
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq Hydra+ Metadata Worker*" >nul 2>&1
taskkill /F /FI "IMAGENAME eq cmd.exe" /FI "WINDOWTITLE eq Hydra+ Debug Console*" >nul 2>&1

echo  [OK] Existing servers terminated
timeout /t 1 >nul

REM ============================================================================
REM Check Node.js
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   CHECKING NODE.JS
echo  ========================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo  [X] ERROR: Node.js is NOT installed!
    echo.
    echo  Please install Node.js from: https://nodejs.org/
    echo.
    start https://nodejs.org/en/download/
    pause
    exit /b 1
)

node --version
echo.
echo  [OK] Node.js is installed
timeout /t 1 >nul

REM ============================================================================
REM Setup directories
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   SETTING UP DIRECTORIES
echo  ========================================================================
echo.

set "NICOTINE_PLUGINS=%APPDATA%\nicotine\plugins"
set "PLUGIN_NAME=Hydra+_Plugin"
set "PLUGIN_DEST=%NICOTINE_PLUGINS%\%PLUGIN_NAME%"
set "EXTENSION_DEST=%LOCALAPPDATA%\Hydra+\Extension"
set "SCRIPT_DIR=%~dp0"

if not exist "%NICOTINE_PLUGINS%" (
    mkdir "%NICOTINE_PLUGINS%" 2>nul
)

echo  [OK] Directories ready
timeout /t 1 >nul

REM ============================================================================
REM Install Plugin
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   INSTALLING PLUGIN
echo  ========================================================================
echo.

if exist "%PLUGIN_DEST%" (
    echo  Removing old installation...
    rmdir /s /q "%PLUGIN_DEST%" 2>nul
)

mkdir "%PLUGIN_DEST%" 2>nul
mkdir "%PLUGIN_DEST%\Server" 2>nul
xcopy /E /I /Y "%SCRIPT_DIR%Hydra+_Plugin" "%PLUGIN_DEST%" >nul 2>&1

if %errorlevel% equ 0 (
    echo  [OK] Plugin installed
) else (
    color 0C
    echo  [X] ERROR: Failed to copy plugin files
    pause
    exit /b 1
)

timeout /t 1 >nul

REM ============================================================================
REM Install Dependencies
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   INSTALLING NODE.JS DEPENDENCIES
echo  ========================================================================
echo.
echo  This may take a moment...
echo.

cd /d "%PLUGIN_DEST%\Server"
if exist "package.json" (
    call npm install >nul 2>&1
    if %errorlevel% equ 0 (
        echo  [OK] express
        echo  [OK] cors
        echo  [OK] node-id3
        echo  [OK] flac-tagger
        echo.
        echo  [OK] Dependencies installed
    ) else (
        color 0C
        echo  [X] ERROR: Failed to install dependencies
        pause
        exit /b 1
    )
)

timeout /t 1 >nul

REM ============================================================================
REM Setup Extension
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   SETTING UP BROWSER EXTENSION
echo  ========================================================================
echo.

if exist "%EXTENSION_DEST%" (
    rmdir /s /q "%EXTENSION_DEST%" 2>nul
)

mkdir "%EXTENSION_DEST%" 2>nul
xcopy /E /I /Y "%SCRIPT_DIR%Hydra+_Extension" "%EXTENSION_DEST%" >nul 2>&1

if %errorlevel% equ 0 (
    echo  [OK] Extension files copied
) else (
    color 0C
    echo  [X] ERROR: Failed to copy extension files
    pause
    exit /b 1
)

timeout /t 1 >nul

REM ============================================================================
REM Success
REM ============================================================================
cls
echo.
echo  ========================================================================
echo.
echo             INSTALLATION COMPLETE!
echo.
echo  ========================================================================
echo.
echo  [OK] Plugin installed: %PLUGIN_DEST%
echo  [OK] Extension copied: %EXTENSION_DEST%
echo.
echo  ========================================================================
echo.
echo  NEXT STEPS:
echo.
echo  1. Load extension in Chrome/Edge:
echo     - Go to: chrome://extensions/
echo     - Enable "Developer mode"
echo     - Click "Load unpacked"
echo     - Paste this path: %EXTENSION_DEST%
echo.
echo  2. Enable plugin in Nicotine+:
echo     - Settings ^> Plugins
echo     - Enable "Hydra+ (Browser Link)"
echo.
echo  3. Start using:
echo     - Go to: open.spotify.com
echo     - Use send buttons to download tracks
echo.
echo  ========================================================================
echo.
pause
