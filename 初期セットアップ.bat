@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   MFA Code Generator - Initial Setup
echo ============================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node
echo [OK] Node.js detected.
for /f "tokens=*" %%v in ('node --version') do echo   Version: %%v
echo.

echo [1/3] Running npm install...
echo   This may take 2-3 minutes.
call npm install
if errorlevel 1 goto :npm_failed
echo [OK] npm install complete.
echo.

echo [2/3] Installing Playwright Chromium browser...
echo   This is a one-time download (~170MB) and may take 3-5 minutes.
call npx playwright install chromium
if errorlevel 1 goto :playwright_failed
echo [OK] Playwright Chromium installed.
echo.

echo [3/3] Creating .env file...
if exist .env (
    echo [SKIP] .env already exists.
) else (
    if not exist .env.example goto :no_env_example
    copy .env.example .env >nul
    echo [OK] .env created from .env.example.
    echo [INFO] Edit .env to set your Salesforce Connected App credentials.
)
if not exist logs mkdir logs
echo done > .setup-done
echo.

echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo Next steps:
echo   1. Edit .env file with your Salesforce credentials.
echo   2. Double-click �N��.bat to start the server.
echo.
pause
exit /b 0

:no_node
echo [ERROR] Node.js is not installed.
echo   Download Node.js LTS from: https://nodejs.org/
pause
exit /b 1

:npm_failed
echo [ERROR] npm install failed.
echo   Check your internet connection.
pause
exit /b 1

:playwright_failed
echo [ERROR] Playwright Chromium install failed.
echo   Try manually: npx playwright install chromium
pause
exit /b 1

:no_env_example
echo [ERROR] .env.example file is missing.
pause
exit /b 1
