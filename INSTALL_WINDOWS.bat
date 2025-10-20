@echo off
setlocal enabledelayedexpansion
title Hydra+ Installer v0.1.2
color 0A

cls
echo.
echo  ========================================================================
echo.
echo                   H Y D R A +   I N S T A L L E R
echo                     Nicotine+ Browser Link v0.1.2
echo.
echo  ========================================================================
echo.
echo  This installer will guide you through 5 steps:
echo.
echo   [1] Check Node.js installation
echo   [2] Verify Nicotine+ directory
echo   [3] Install Nicotine+ plugin
echo   [4] Install Node.js dependencies
echo   [5] Setup browser extension
echo.
echo  ========================================================================
echo.
echo  Press ENTER to begin installation...
pause >nul

REM ============================================================================
REM STEP 1: Check Node.js
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 1 OF 5: CHECKING NODE.JS
echo  ========================================================================
echo.
echo  Progress: [####....................] 20%%
echo.
echo  Checking if Node.js is installed...
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Node.js is NOT installed!                                ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Please install Node.js first:
    echo   1. Visit: https://nodejs.org/
    echo   2. Download the LTS version
    echo   3. Install with default settings
    echo   4. Restart this installer
    echo.
    echo  Opening Node.js download page in 3 seconds...
    timeout /t 3 >nul
    start https://nodejs.org/en/download/
    echo.
    pause
    exit /b 1
)

node --version
echo.
echo  +-------------------------------------------------------------------+
echo  ^|  SUCCESS: Node.js is installed and ready!                        ^|
echo  +-------------------------------------------------------------------+
echo.
echo  Press ENTER to continue to Step 2...
pause >nul

REM ============================================================================
REM STEP 2: Check Nicotine+ Directory
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 2 OF 5: VERIFYING NICOTINE+ DIRECTORY
echo  ========================================================================
echo.
echo  Progress: [########................] 40%%
echo.

set "NICOTINE_PLUGINS=%APPDATA%\nicotine\plugins"
set "PLUGIN_NAME=Hydra+_Plugin"
set "PLUGIN_DEST=%NICOTINE_PLUGINS%\%PLUGIN_NAME%"
set "EXTENSION_DEST=%LOCALAPPDATA%\Hydra+\Extension"
set "SCRIPT_DIR=%~dp0"

echo  Checking: %NICOTINE_PLUGINS%
echo.

if not exist "%NICOTINE_PLUGINS%" (
    color 0E
    echo  +-------------------------------------------------------------------+
    echo  ^|  WARNING: Nicotine+ plugins directory not found                  ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Creating plugins directory...
    echo  (Nicotine+ will detect it automatically on next start)
    echo.
    mkdir "%NICOTINE_PLUGINS%" 2>nul
    color 0A
)

echo  +-------------------------------------------------------------------+
echo  ^|  SUCCESS: Plugin directory is ready                              ^|
echo  +-------------------------------------------------------------------+
echo.
echo  Press ENTER to continue to Step 3...
pause >nul

REM ============================================================================
REM STEP 3: Install Plugin
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 3 OF 5: INSTALLING NICOTINE+ PLUGIN
echo  ========================================================================
echo.
echo  Progress: [############............] 60%%
echo.

if exist "%PLUGIN_DEST%" (
    echo  Removing old installation...
    rmdir /s /q "%PLUGIN_DEST%" 2>nul
    echo.
)

echo  Copying plugin files...
echo.

if not exist "%SCRIPT_DIR%Hydra+_Extension\popup.js" (
    color 0C
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Source files not found!                                  ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Make sure you're running this from the extracted Hydra+ folder.
    echo.
    pause
    exit /b 1
)

if not exist "%SCRIPT_DIR%Hydra+_Plugin\__init__.py" (
    color 0C
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Plugin files not found!                                  ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Expected: %SCRIPT_DIR%Hydra+_Plugin\
    echo.
    pause
    exit /b 1
)

mkdir "%PLUGIN_DEST%" 2>nul
mkdir "%PLUGIN_DEST%\Server" 2>nul
xcopy /E /I /Y "%SCRIPT_DIR%Hydra+_Plugin" "%PLUGIN_DEST%" >nul 2>&1

if %errorlevel% equ 0 (
    echo  +-------------------------------------------------------------------+
    echo  ^|  SUCCESS: Plugin files installed                                 ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Location: %PLUGIN_DEST%
) else (
    color 0C
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Failed to copy plugin files                              ^|
    echo  +-------------------------------------------------------------------+
    pause
    exit /b 1
)

echo.
echo  Press ENTER to continue to Step 4...
pause >nul

REM ============================================================================
REM STEP 4: Install Dependencies
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 4 OF 5: INSTALLING NODE.JS DEPENDENCIES
echo  ========================================================================
echo.
echo  Progress: [################........] 80%%
echo.
echo  Installing npm packages (express, cors, node-id3, flac-tagger)...
echo  This may take a moment...
echo.

cd /d "%PLUGIN_DEST%\Server"
if exist "package.json" (
    echo  Running: npm install
    echo.
    call npm install
    if %errorlevel% equ 0 (
        echo.
        echo  +-------------------------------------------------------------------+
        echo  ^|  SUCCESS: Dependencies installed                                 ^|
        echo  +-------------------------------------------------------------------+
        echo.
        echo  Verifying packages...
        if exist "node_modules\express" (
            echo  [√] express installed
        ) else (
            echo  [X] express MISSING
        )
        if exist "node_modules\cors" (
            echo  [√] cors installed
        ) else (
            echo  [X] cors MISSING
        )
        if exist "node_modules\node-id3" (
            echo  [√] node-id3 installed
        ) else (
            echo  [X] node-id3 MISSING
        )
        if exist "node_modules\flac-tagger" (
            echo  [√] flac-tagger installed
        ) else (
            echo  [X] flac-tagger MISSING
        )
    ) else (
        color 0C
        echo.
        echo  +-------------------------------------------------------------------+
        echo  ^|  ERROR: Failed to install dependencies                           ^|
        echo  +-------------------------------------------------------------------+
        echo.
        echo  Please check the error above and try again.
        pause
        exit /b 1
    )
) else (
    color 0E
    echo  +-------------------------------------------------------------------+
    echo  ^|  WARNING: package.json not found                                 ^|
    echo  +-------------------------------------------------------------------+
    color 0A
)

echo.
echo  Press ENTER to continue to Step 5...
pause >nul

REM ============================================================================
REM STEP 5: Setup Extension
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   STEP 5 OF 5: SETTING UP BROWSER EXTENSION
echo  ========================================================================
echo.
echo  Progress: [####################] 100%%
echo.

if exist "%EXTENSION_DEST%" (
    echo  Removing old extension...
    rmdir /s /q "%EXTENSION_DEST%" 2>nul
    echo.
)

echo  Copying extension files...
echo.

mkdir "%EXTENSION_DEST%" 2>nul
xcopy /E /I /Y "%SCRIPT_DIR%Hydra+_Extension" "%EXTENSION_DEST%" >nul 2>&1

if %errorlevel% equ 0 (
    echo  +-------------------------------------------------------------------+
    echo  ^|  SUCCESS: Extension files copied                                 ^|
    echo  +-------------------------------------------------------------------+
    echo.
    echo  Location: %EXTENSION_DEST%
) else (
    color 0C
    echo  +-------------------------------------------------------------------+
    echo  ^|  ERROR: Failed to copy extension files                           ^|
    echo  +-------------------------------------------------------------------+
    pause
    exit /b 1
)

echo.
echo  Press ENTER to view setup instructions...
pause >nul

REM ============================================================================
REM Success Screen
REM ============================================================================
cls
echo.
echo  ========================================================================
echo.
echo             INSTALLATION COMPLETE!
echo.
echo  ========================================================================
echo.
echo  FILES INSTALLED:
echo  ------------------------------------------------------------------------
echo.
echo   Plugin:    %PLUGIN_DEST%
echo   Extension: %EXTENSION_DEST%
echo.
echo  ========================================================================
echo.
echo  Press ENTER to see Step 1 (Load Extension)...
pause >nul

REM ============================================================================
REM Step 1: Load Extension
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   SETUP STEP 1: LOAD BROWSER EXTENSION
echo  ========================================================================
echo.
echo  1. Open Chrome or Edge browser
echo  2. Type in address bar: chrome://extensions/
echo  3. Turn ON "Developer mode" (toggle in top-right corner)
echo  4. Click "Load unpacked" button
echo  5. Copy and paste this path into the address bar:
echo.
echo     %EXTENSION_DEST%
echo.
echo  6. Press Enter, then click "Select Folder"
echo.
echo  ========================================================================
echo.
echo  Press ENTER when done to see Step 2 (Enable Plugin)...
pause >nul

REM ============================================================================
REM Step 2: Enable Plugin
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   SETUP STEP 2: ENABLE NICOTINE+ PLUGIN
echo  ========================================================================
echo.
echo  1. Open Nicotine+ application
echo  2. Click menu: Settings ^> Plugins
echo  3. Scroll to find "Hydra+ (Browser Link)"
echo  4. Click the checkbox to enable it
echo  5. Click "OK" button to save and close
echo.
echo  NOTE: The bridge server will start automatically!
echo.
echo  ========================================================================
echo.
echo  Press ENTER when done to see Step 3 (Usage Guide)...
pause >nul

REM ============================================================================
REM Step 3: Usage
REM ============================================================================
cls
echo.
echo  ========================================================================
echo   SETUP STEP 3: START USING HYDRA+
echo  ========================================================================
echo.
echo  1. Go to: open.spotify.com
echo  2. Open any playlist or album
echo  3. You'll see a send button (^>^) next to each track
echo  4. Click the button to send track to Nicotine+
echo.
echo     Orange = Success!
echo     Red = Error (check if plugin is enabled)
echo.
echo  5. Click extension icon (toolbar) to access settings
echo.
echo  ========================================================================
echo   TIP: Configure in extension popup
echo  ========================================================================
echo.
echo    - Auto-download toggle
echo    - Metadata override
echo    - Spotify API credentials (optional - adds Genre and Label)
echo.
echo  ========================================================================
echo.
echo   Need help? Visit: github.com/bitm4ncer/Hydra_plus
echo.
echo  ========================================================================
echo.
echo  Installation complete! Press any key to exit...
pause >nul
