@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 goto cd_failed

echo ================================================
echo   JK-Cafe POS - First-time Windows Setup
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto node_missing
where npm >nul 2>nul
if errorlevel 1 goto npm_missing

node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22 || (major===22 && minor>=16) ? 0 : 1)" >nul 2>nul
if errorlevel 1 goto node_too_old

if not exist "package-lock.json" goto lock_missing

echo [1/2] Installing dependencies with npm ci...
call npm ci
if errorlevel 1 goto install_failed

echo.
echo [2/2] Building the application...
call npm run build
if errorlevel 1 goto build_failed

echo.
echo ================================================
echo  Setup completed successfully.
echo  Next: double-click start.cmd to run JK-Cafe.
echo ================================================
set "SETUP_EXIT=0"
goto finish

:node_missing
echo ERROR: Node.js was not found.
echo Install Node.js 22.16 or newer, then reopen this file.
goto failed
:npm_missing
echo ERROR: npm was not found. Repair your Node.js installation.
goto failed
:node_too_old
echo ERROR: Node.js 22.16 or newer is required.
node --version
goto failed
:lock_missing
echo ERROR: package-lock.json is missing from this folder.
goto failed
:install_failed
echo ERROR: npm ci failed. Check your internet connection and messages above.
goto failed
:build_failed
echo ERROR: npm run build failed. Read the error messages above.
goto failed
:cd_failed
echo ERROR: Cannot open the JK-Cafe directory.
goto failed
:failed
set "SETUP_EXIT=1"
:finish
echo.
if /I not "%~1"=="--auto" pause
exit /b %SETUP_EXIT%
