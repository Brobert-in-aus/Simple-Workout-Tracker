@echo off
title Cleanup Pre-2026 Data
color 0B
cd /d "%~dp0"

set "ROOT=%~dp0.."
set "NODE="

if exist "%ROOT%\runtime\node.exe" (
    set "NODE=%ROOT%\runtime\node.exe"
    set "PATH=%ROOT%\runtime;%PATH%"
) else (
    where node >nul 2>&1
    if not errorlevel 1 set "NODE=node"
)

if "%NODE%"=="" (
    echo.
    echo  ERROR: Node.js not found.
    echo  Run setup.bat first or install Node.js.
    echo.
    pause
    exit /b 1
)

echo ============================================
echo      CLEANUP PRE-2026 WORKOUT DATA
echo ============================================
echo.
echo  This will remove:
echo    - workouts before 2026-01-01
echo    - related workout exercises and sets
echo    - bodyweight entries before 2026-01-01
echo.
echo  A backup will be created first.
echo.
set /p "CONFIRM=Type YES to continue: "
if /i not "%CONFIRM%"=="YES" (
    echo.
    echo  Cancelled.
    pause
    exit /b 0
)

echo.
echo  Creating backup...
"%NODE%" "%ROOT%\backup.js" pre-2026-cleanup
if errorlevel 1 (
    echo.
    echo  Backup failed. Cleanup not run.
    pause
    exit /b 1
)

echo.
echo  Removing pre-2026 data...
"%NODE%" "%~dp0cleanup_pre2026.js" --apply
set "EXITCODE=%ERRORLEVEL%"
echo.

if not "%EXITCODE%"=="0" (
    echo  Cleanup failed.
    pause
    exit /b %EXITCODE%
)

echo  Cleanup finished successfully.
pause
