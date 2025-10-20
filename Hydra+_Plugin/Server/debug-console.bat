@echo off
title Hydra+ Debug Console
color 07

cls
echo.
echo  ========================================================================
echo.
echo    HYDRA+ DEBUG CONSOLE
echo.
echo  ========================================================================
echo.
echo    [STATE SERVER]     Port 3847
echo    [METADATA WORKER]  Port 3848
echo.
echo  ------------------------------------------------------------------------
echo.

cd /d "%~dp0"

:: Start both servers and pipe their output with color coding
powershell -Command "$host.UI.RawUI.ForegroundColor='Gray'; Write-Host '  Starting servers...'; Write-Host ''"

:: Start both servers - output will appear below
start /B node state-server.js 2^>^&1 ^| powershell -Command "$input | ForEach-Object { if ($_ -match 'error|Error|ERROR|✗|failed|Failed') { $host.UI.RawUI.ForegroundColor='Red'; Write-Host $_ } elseif ($_ -match '✓|success|Success|started|loaded') { $host.UI.RawUI.ForegroundColor='Green'; Write-Host $_ } else { $host.UI.RawUI.ForegroundColor='Gray'; Write-Host $_ } }"

start /B node metadata-worker.js 2^>^&1 ^| powershell -Command "$input | ForEach-Object { if ($_ -match 'error|Error|ERROR|✗|failed|Failed') { $host.UI.RawUI.ForegroundColor='Red'; Write-Host $_ } elseif ($_ -match '✓|success|Success|started|loaded') { $host.UI.RawUI.ForegroundColor='Green'; Write-Host $_ } else { $host.UI.RawUI.ForegroundColor='Gray'; Write-Host $_ } }"

:: Keep console open
pause >nul
