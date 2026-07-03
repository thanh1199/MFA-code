@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo ============================================
echo   MFA Code Generator v6.0 (Auto Mode)
echo ============================================
echo [INFO] Current directory: %CD%
echo.

REM ---- Node.js check ----
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo   Please install Node.js LTS from https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo [OK] Node.js %%v detected

REM ---- .env check ----
if not exist .env (
    echo [WARN] .env not found. Copying from .env.example...
    if not exist .env.example (
        echo [ERROR] .env.example is missing.
        pause
        exit /b 1
    )
    copy .env.example .env >nul
    echo [INFO] Please edit .env and set your Salesforce credentials, then re-run this script.
    pause
    exit /b 0
)

REM ---- node_modules ----
if not exist node_modules (
    echo [SETUP] node_modules not found. Running npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo [SETUP] Installing Playwright Chromium...
    call npx playwright install chromium
)

REM ---- logs / runtime dir ----
if not exist logs mkdir logs
if not exist runtime mkdir runtime

REM ---- Start ----
echo.
echo [START] Launching MFA Code Generator (Auto Mode)...
echo --------------------------------------
call npm start
set EXITCODE=!ERRORLEVEL!
echo --------------------------------------
if !EXITCODE! neq 0 (
    echo [ERROR] Server exited with code !EXITCODE!
) else (
    echo [INFO] Server exited normally.
)
pause
exit /b !EXITCODE!
