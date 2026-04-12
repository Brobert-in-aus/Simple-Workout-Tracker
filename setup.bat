@echo off
:: ============================================================
::  Workout Tracker - Portable Setup
::  Run this ONCE on a machine with internet access.
::  Then copy the entire folder to your mini-PC.
:: ============================================================

setlocal

set NODE_VERSION=22.15.0
set NODE_ARCH=x64
set NODE_DIR=node-v%NODE_VERSION%-win-%NODE_ARCH%
set NODE_ZIP=%NODE_DIR%.zip
set NODE_URL=https://nodejs.org/dist/v%NODE_VERSION%/%NODE_ZIP%

cd /d "%~dp0"

echo.
echo  =====================================================
echo   Workout Tracker - Portable Setup
echo  =====================================================
echo.

:: ---  Step 1: Portable Node.js  ---

if exist "runtime\node.exe" (
    echo [OK] Portable Node.js already present.
    goto :install_deps
)

echo [1/2] Downloading Node.js v%NODE_VERSION% (Windows %NODE_ARCH%)...
echo       %NODE_URL%
echo.

powershell -Command "& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' }"

if not exist "%NODE_ZIP%" (
    echo.
    echo ERROR: Download failed. Check your internet connection.
    pause
    exit /b 1
)

echo       Extracting...
powershell -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '.' -Force"

if exist "runtime" rmdir /s /q "runtime"
rename "%NODE_DIR%" "runtime"
del "%NODE_ZIP%" 2>nul

if not exist "runtime\node.exe" (
    echo.
    echo ERROR: Extraction failed.
    pause
    exit /b 1
)

echo [OK] Node.js v%NODE_VERSION% installed to runtime\
echo.

:: ---  Step 2: Install dependencies  ---

:install_deps

:: Put portable node first in PATH so npm uses it
set "PATH=%CD%\runtime;%PATH%"

if exist "node_modules\better-sqlite3\build\Release\better_sqlite3.node" (
    echo [OK] Dependencies already installed.
    goto :done
)

echo [2/2] Installing npm dependencies...
echo.

call runtime\npm.cmd install --production 2>&1

if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    echo If better-sqlite3 fails to build, install Visual Studio Build Tools:
    echo   https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo Then re-run this script.
    pause
    exit /b 1
)

echo.
echo [OK] Dependencies installed.

:: ---  Done  ---

:done
echo.
echo  =====================================================
echo   Setup complete!
echo.
echo   To run:    double-click  start.bat
echo   To deploy: copy this entire folder to your mini-PC
echo  =====================================================
echo.
pause
