@echo off
:: ============================================================
::  Workout Tracker - Start Server
::  Double-click this to launch. Access from any device on LAN.
:: ============================================================

title Workout Tracker
color 0B

cd /d "%~dp0"

:: --- Log file (persistent, appended across sessions) ---
:: Use relative path — cd /d "%~dp0" above guarantees we're in the script directory.
:: mkdir 2>nul is idempotent (suppresses "already exists" error).
set "LOG=data\server-log.txt"
mkdir data 2>nul

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

call :log "=== SERVER STARTED (PID %PID%) ==="
if exist "%LOGFILE%" type "%LOGFILE%" >> "%LOG%"

:menu
set "choice="
set /p "choice=  > "
if /i "%choice%"=="r" goto restart
if /i "%choice%"=="u" goto update
if /i "%choice%"=="q" goto quit
goto menu

:restart
echo.
call :log "--- Restart requested ---"
echo  Stopping server...
call :stop_server
set "WAIT_RETURN=restart_done" & set "WAIT_TICKS=0" & goto wait_for_exit
:restart_done
call :log "Server stopped."
goto start

:update
echo.
call :log "=== UPDATE STARTED ==="
echo  Stopping server...
call :stop_server
set "WAIT_RETURN=update_stopped" & set "WAIT_TICKS=0" & goto wait_for_exit
:update_stopped
call :log "Server stopped. Running pre-update backup..."
echo  Backing up database...
"%NODE%" "%~dp0backup.js" pre-update > "%TEMP%\wt-backup.tmp" 2>&1
type "%TEMP%\wt-backup.tmp"
type "%TEMP%\wt-backup.tmp" >> "%LOG%"
del "%TEMP%\wt-backup.tmp" >nul 2>&1
:: Snapshot package.json before pull to detect changes
set "PKG_HASH_BEFORE="
for /f "tokens=*" %%h in ('certutil -hashfile package.json MD5 2^>nul ^| findstr /v "hash MD5"') do set "PKG_HASH_BEFORE=%%h"
call :log "Running git pull..."
echo  Pulling latest changes...
echo.
git pull > "%TEMP%\wt-gitpull.tmp" 2>&1
type "%TEMP%\wt-gitpull.tmp"
type "%TEMP%\wt-gitpull.tmp" >> "%LOG%"
del "%TEMP%\wt-gitpull.tmp" >nul 2>&1
if errorlevel 1 (
    call :log "ERROR: git pull failed (exit code %ERRORLEVEL%). Restarting with current code."
    echo.
    echo  WARNING: git pull failed. Check your connection or resolve conflicts.
    echo  Restarting server with current code...
    timeout /t 1 /nobreak >nul
    goto start
)
call :log "git pull succeeded."
:: Check if package.json changed
set "PKG_HASH_AFTER="
for /f "tokens=*" %%h in ('certutil -hashfile package.json MD5 2^>nul ^| findstr /v "hash MD5"') do set "PKG_HASH_AFTER=%%h"
if not "%PKG_HASH_BEFORE%"=="%PKG_HASH_AFTER%" (
    call :log "package.json changed - reinstalling dependencies..."
    echo.
    echo  package.json changed - reinstalling dependencies...
    call "%NPM%" install --production > "%TEMP%\wt-npm.tmp" 2>&1
    type "%TEMP%\wt-npm.tmp"
    type "%TEMP%\wt-npm.tmp" >> "%LOG%"
    del "%TEMP%\wt-npm.tmp" >nul 2>&1
)
call :log "=== UPDATE COMPLETE ==="
timeout /t 1 /nobreak >nul
goto start

:quit
echo.
call :log "--- Quit requested ---"
echo  Stopping server...
call :stop_server
set "WAIT_RETURN=quit_done" & set "WAIT_TICKS=0" & goto wait_for_exit
:quit_done
call :log "Server stopped. Exiting."
del "%LOGFILE%" >nul 2>&1
echo  Goodbye!
timeout /t 1 /nobreak >nul
exit

:: --- Subroutine: ask server to shut down gracefully via HTTP, fall back to taskkill /f ---
:stop_server
"%NODE%" -e "require('http').request({host:'127.0.0.1',port:3000,path:'/api/shutdown',method:'POST'},function(r){r.resume()}).on('error',function(){}).end()" >nul 2>&1
goto :eof

:: --- Subroutine: wait for PID to exit, force-kill after 10s ---
:: Caller sets WAIT_RETURN (label to goto on done) and WAIT_TICKS=0.
:wait_for_exit
tasklist /fi "pid eq %PID%" 2>nul | find "%PID%" >nul 2>&1
if errorlevel 1 goto %WAIT_RETURN%
set /a WAIT_TICKS+=1
if %WAIT_TICKS% GEQ 10 (
    call :log "WARNING: Server did not exit after 10s - force killing (PID %PID%)."
    echo  WARNING: Server did not exit cleanly - force killing...
    taskkill /f /pid %PID% >nul 2>&1
    timeout /t 1 /nobreak >nul
    goto %WAIT_RETURN%
)
timeout /t 1 /nobreak >nul
goto wait_for_exit

:: --- Subroutine: append timestamped message to log ---
:log
mkdir data 2>nul
echo [%date% %time:~0,8%] %~1 >> "%LOG%" 2>nul
echo  %~1
goto :eof
