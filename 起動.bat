@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   MFA Code Generator v3.0
echo   (Playwright UI Automation Mode)
echo ============================================
echo.

REM ---------------- Node.js check ----------------
where node >nul 2>&1
if errorlevel 1 goto :no_node

REM ---------------- Setup check ----------------
if exist .setup-done goto :skip_setup

echo [SETUP] First-time setup detected.
echo.
echo [SETUP 1/2] Running npm install (2-3 min)...
call npm install
if errorlevel 1 goto :npm_failed
echo [OK] npm install done.
echo.

echo [SETUP 2/2] Installing Playwright Chromium (3-5 min, ~170MB)...
call npx playwright install chromium
if errorlevel 1 goto :playwright_failed
echo [OK] Playwright Chromium installed.
echo.

echo done > .setup-done
echo [SETUP] All setup complete.
echo.

:skip_setup

REM ---------------- .env check ----------------
if exist .env goto :env_ok
echo [SETUP] Creating .env file...
if not exist .env.example goto :no_env_example
copy .env.example .env >nul
echo [INFO] Please edit .env with your Salesforce credentials.
notepad .env
echo.
echo After editing .env, press any key to continue.
pause
:env_ok

REM ---------------- logs dir ----------------
if not exist logs mkdir logs

REM ---------------- Port 3000 cleanup ----------------
echo [CHECK] Checking port 3000...
set PORT_IN_USE=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    set PORT_IN_USE=1
    echo [WARN] Port 3000 is in use - PID: %%a
    taskkill /PID %%a /F >nul 2>&1
)
if !PORT_IN_USE!==1 (
    timeout /t 2 /nobreak >nul
    echo [OK] Port 3000 released.
) else (
    echo [OK] Port 3000 is available.
)
echo.

REM ---------------- Start server ----------------
echo [START] Launching server v3.0...
echo --------------------------------------
echo.
node server.js
set EXITCODE=!ERRORLEVEL!
echo.
echo --------------------------------------
if !EXITCODE! neq 0 (
    echo [ERROR] Server exited with code !EXITCODE!
) else (
    echo [INFO] Server exited normally.
)
echo.
echo Press any key to close this window.
pause >nul
exit /b !EXITCODE!

:no_node
echo.
echo [ERROR] Node.js is not installed or not in PATH.
echo   Download Node.js LTS from: https://nodejs.org/
echo.
pause
exit /b 1

:npm_failed
echo.
echo [ERROR] npm install failed.
echo   Check your internet connection and try again.
echo.
pause
exit /b 1

:playwright_failed
echo.
echo [ERROR] Playwright Chromium install failed.
echo   Try running manually: npx playwright install chromium
echo.
pause
exit /b 1

:no_env_example
echo.
echo [ERROR] .env.example file is missing.
echo   Please ensure all files are extracted properly.
echo.
pause
exit /b 1
