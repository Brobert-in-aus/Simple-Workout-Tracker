@echo off
:: ============================================================
::  Workout Tracker - Start Server
::  Double-click this to launch. Access from any device on LAN.
:: ============================================================

title Workout Tracker
color 0B

cd /d "%~dp0"

:: --- Find Node.js (portable first, then system) ---

set "NODE="
set "NPM="

if exist "runtime\node.exe" (
    set "NODE=%CD%\runtime\node.exe"
    set "NPM=%CD%\runtime\npm.cmd"
    set "PATH=%CD%\runtime;%PATH%"
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        set "NODE=node"
        set "NPM=npm"
    )
)

if "%NODE%"=="" (
    echo.
    echo  ERROR: Node.js not found.
    echo  Run setup.bat first to download portable Node.js,
    echo  or install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: --- Check dependencies ---

if not exist "node_modules\express" (
    echo.
    echo  Dependencies not found. Installing...
    echo.
    call "%NPM%" install --production
    echo.
)

:: --- Launch ---

:start
cls
echo ============================================
echo        SIMPLE WORKOUT TRACKER
echo ============================================
echo.
echo  Starting server...
echo.

:: Start server in background, pipe output to temp file
set "LOGFILE=%TEMP%\workout-tracker-log.txt"
start /b cmd /c ""%NODE%" "%~dp0server.js" > "%LOGFILE%" 2>&1"

:: Wait for server to start and grab the output
timeout /t 2 /nobreak >nul

:: Find the node PID
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo list ^| findstr "PID"') do set PID=%%a

:: Display connection details
echo  Server running (PID: %PID%)
echo.
if exist "%LOGFILE%" type "%LOGFILE%"
echo.
echo ============================================
echo.
echo  Open in browser:
echo    Local:  http://localhost:3000
echo.
:: Show LAN IPs
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        echo    LAN:    http://%%b:3000
    )
)
echo.
echo ============================================
echo.
echo  Commands:
echo    [R] Restart server
echo    [U] Update (git pull) and restart
echo    [Q] Quit
echo.
echo ============================================

:menu
set "choice="
set /p "choice=  > "
if /i "%choice%"=="r" goto restart
if /i "%choice%"=="u" goto update
if /i "%choice%"=="q" goto quit
goto menu

:restart
echo.
echo  Stopping server...
taskkill /pid %PID% >nul 2>&1
set "WAIT_RETURN=restart_done" & set "WAIT_TICKS=0" & goto wait_for_exit
:restart_done
goto start

:update
echo.
echo  Stopping server...
taskkill /pid %PID% >nul 2>&1
set "WAIT_RETURN=update_done" & set "WAIT_TICKS=0" & goto wait_for_exit
:update_done
echo  Backing up database...
"%NODE%" "%~dp0backup.js" pre-update
:: Snapshot package.json before pull to detect changes
set "PKG_HASH_BEFORE="
for /f "tokens=*" %%h in ('certutil -hashfile package.json MD5 2^>nul ^| findstr /v "hash MD5"') do set "PKG_HASH_BEFORE=%%h"
echo  Pulling latest changes...
echo.
git pull
if errorlevel 1 (
    echo.
    echo  WARNING: git pull failed. Check your connection or resolve conflicts.
    echo  Restarting server with current code...
    timeout /t 1 /nobreak >nul
    goto start
)
:: Check if package.json changed
set "PKG_HASH_AFTER="
for /f "tokens=*" %%h in ('certutil -hashfile package.json MD5 2^>nul ^| findstr /v "hash MD5"') do set "PKG_HASH_AFTER=%%h"
if not "%PKG_HASH_BEFORE%"=="%PKG_HASH_AFTER%" (
    echo.
    echo  package.json changed — reinstalling dependencies...
    call "%NPM%" install --production 2>&1
)
timeout /t 1 /nobreak >nul
goto start

:quit
echo.
echo  Stopping server...
taskkill /pid %PID% >nul 2>&1
set "WAIT_RETURN=quit_done" & set "WAIT_TICKS=0" & goto wait_for_exit
:quit_done
del "%LOGFILE%" >nul 2>&1
echo  Goodbye!
timeout /t 1 /nobreak >nul
exit

:: --- Subroutine: wait for PID to exit, force-kill after 10s ---
:: Caller sets WAIT_RETURN (label to goto on done) and WAIT_TICKS=0.
:wait_for_exit
tasklist /fi "pid eq %PID%" 2>nul | find "%PID%" >nul 2>&1
if errorlevel 1 goto %WAIT_RETURN%
set /a WAIT_TICKS+=1
if %WAIT_TICKS% GEQ 10 (
    echo  WARNING: Server did not exit cleanly - force killing...
    taskkill /f /pid %PID% >nul 2>&1
    timeout /t 1 /nobreak >nul
    goto %WAIT_RETURN%
)
timeout /t 1 /nobreak >nul
goto wait_for_exit
