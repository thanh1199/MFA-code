@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   MFA Code Generator - Initial Setup
echo ============================================
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is required.
    pause
    exit /b 1
)
echo [1/3] npm install ...
call npm install || (echo [ERROR] npm install failed & pause & exit /b 1)
echo [2/3] Playwright install ...
call npx playwright install chromium || (echo [ERROR] playwright install failed & pause & exit /b 1)
echo [3/3] Creating .env ...
if not exist .env copy .env.example .env >nul
if not exist logs mkdir logs
if not exist runtime mkdir runtime
echo Setup complete. Edit .env then run ‹N“®.bat
pause
