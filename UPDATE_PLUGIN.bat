@echo off
setlocal enabledelayedexpansion
title Hydra+ Plugin Updater
color 0A

cls
echo.
echo  ========================================================================
echo.
echo                   H Y D R A +   P L U G I N   U P D A T E R
echo                          Quick Update v0.1.8
echo.
echo  ========================================================================
echo.
echo  This will:
echo   - Kill any running Hydra+ servers
echo   - Update the Nicotine+ plugin files
echo   - Preserve your settings (credentials, debug settings, etc.)
echo.
echo  Press ENTER to update plugin or CTRL+C to cancel...
pause >nul

REM ============================================================================
REM Kill existing servers
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 1: STOPPING SERVERS
echo  ========================================================================
echo.

echo  Terminating State Server...
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq *state-server.js*" >nul 2>&1
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq Hydra+ State Server*" >nul 2>&1

echo  Terminating Metadata Worker...
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq *metadata-worker.js*" >nul 2>&1
taskkill /F /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq Hydra+ Metadata Worker*" >nul 2>&1

echo  Terminating Debug Console...
taskkill /F /FI "IMAGENAME eq cmd.exe" /FI "WINDOWTITLE eq Hydra+ Debug Console*" >nul 2>&1

echo.
echo  [OK] All servers stopped
timeout /t 2 >nul

REM ============================================================================
REM Backup settings
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 2: BACKING UP SETTINGS
echo  ========================================================================
echo.

set "PLUGIN_DEST=%APPDATA%\nicotine\plugins\Hydra+_Plugin"
set "SERVER_DIR=%PLUGIN_DEST%\Server"
set "BACKUP_DIR=%TEMP%\Hydra+_Backup_%RANDOM%"

if not exist "%PLUGIN_DEST%" (
    color 0C
    echo  [X] ERROR: Plugin not found at %PLUGIN_DEST%
    echo.
    echo  Please run QUICK_INSTALL.bat first to install the plugin.
    pause
    exit /b 1
)

mkdir "%BACKUP_DIR%" 2>nul

echo  Backing up configuration files...

REM Backup important settings files
if exist "%SERVER_DIR%\spotify-credentials.json" (
    copy /Y "%SERVER_DIR%\spotify-credentials.json" "%BACKUP_DIR%\" >nul 2>&1
    echo  [OK] Spotify credentials
)

if exist "%SERVER_DIR%\debug-settings.json" (
    copy /Y "%SERVER_DIR%\debug-settings.json" "%BACKUP_DIR%\" >nul 2>&1
    echo  [OK] Debug settings
)

if exist "%SERVER_DIR%\nicotine-queue.json" (
    copy /Y "%SERVER_DIR%\nicotine-queue.json" "%BACKUP_DIR%\" >nul 2>&1
    echo  [OK] Download queue
)

echo.
echo  [OK] Settings backed up to: %BACKUP_DIR%
timeout /t 1 >nul

REM ============================================================================
REM Update Plugin
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 3: UPDATING PLUGIN FILES
echo  ========================================================================
echo.

set "SCRIPT_DIR=%~dp0"

REM Verify source files exist
if not exist "%SCRIPT_DIR%Hydra+_Plugin\__init__.py" (
    color 0C
    echo  [X] ERROR: Source files not found in %SCRIPT_DIR%Hydra+_Plugin\
    echo.
    echo  Make sure you're running this from the Hydra+ folder.
    pause
    exit /b 1
)

echo  Removing old plugin files...
rmdir /s /q "%PLUGIN_DEST%" 2>nul
timeout /t 1 >nul

echo  Installing updated plugin...
mkdir "%PLUGIN_DEST%" 2>nul
mkdir "%PLUGIN_DEST%\Server" 2>nul
xcopy /E /I /Y "%SCRIPT_DIR%Hydra+_Plugin" "%PLUGIN_DEST%" >nul 2>&1

if %errorlevel% equ 0 (
    echo  [OK] Plugin files updated
) else (
    color 0C
    echo  [X] ERROR: Failed to copy plugin files
    pause
    exit /b 1
)

timeout /t 1 >nul

REM ============================================================================
REM Restore settings
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 4: RESTORING SETTINGS
echo  ========================================================================
echo.

echo  Restoring configuration files...

if exist "%BACKUP_DIR%\spotify-credentials.json" (
    copy /Y "%BACKUP_DIR%\spotify-credentials.json" "%SERVER_DIR%\" >nul 2>&1
    echo  [OK] Spotify credentials restored
)

if exist "%BACKUP_DIR%\debug-settings.json" (
    copy /Y "%BACKUP_DIR%\debug-settings.json" "%SERVER_DIR%\" >nul 2>&1
    echo  [OK] Debug settings restored
)

if exist "%BACKUP_DIR%\nicotine-queue.json" (
    copy /Y "%BACKUP_DIR%\nicotine-queue.json" "%SERVER_DIR%\" >nul 2>&1
    echo  [OK] Download queue restored
)

REM Cleanup backup
rmdir /s /q "%BACKUP_DIR%" 2>nul

echo.
echo  [OK] All settings restored
timeout /t 1 >nul

REM ============================================================================
REM Install/Update Dependencies
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 5: CHECKING DEPENDENCIES
echo  ========================================================================
echo.

cd /d "%SERVER_DIR%"

if exist "package.json" (
    echo  Checking for missing dependencies...
    echo.

    call npm install >nul 2>&1

    if %errorlevel% equ 0 (
        echo  [OK] Dependencies verified
    ) else (
        color 0E
        echo  [!] WARNING: Some dependencies may not have installed correctly
    )
)

timeout /t 1 >nul

REM ============================================================================
REM Success
REM ============================================================================
cls
echo.
echo  ========================================================================
echo.
echo             PLUGIN UPDATE COMPLETE!
echo.
echo  ========================================================================
echo.
echo  [OK] Plugin updated successfully
echo  [OK] All settings preserved
echo  [OK] Dependencies checked
echo.
echo  ========================================================================
echo.
echo  NEXT STEPS:
echo.
echo  1. Restart Nicotine+ to load the updated plugin
echo.
echo  2. The plugin will automatically start the servers
echo.
echo  3. Your settings and credentials are preserved
echo.
echo  ========================================================================
echo.
echo  Plugin location: %PLUGIN_DEST%
echo.
echo  ========================================================================
echo.
pause
