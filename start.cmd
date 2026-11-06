@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 goto cd_failed

where node >nul 2>nul
if errorlevel 1 goto node_missing

if not exist "node_modules\express\package.json" goto setup_required
if not exist "dist\index.html" goto setup_required
goto run

:setup_required
echo First run or missing build detected.
echo Starting automatic setup (requires internet access)...
echo.
call "%~dp0setup.cmd" --auto
if errorlevel 1 goto setup_failed

:run
echo.
echo ================================================
echo   JK-Cafe POS Server
echo ================================================
echo Keep this window open while the register is in use.
echo On this PC, open: http://localhost:3000/
echo Press Ctrl+C to stop the server.
echo ================================================
echo.
node "server\index.js"
set "SERVER_EXIT=%ERRORLEVEL%"
echo.
echo JK-Cafe server has stopped. Exit code: %SERVER_EXIT%
pause
exit /b %SERVER_EXIT%

:setup_failed
echo ERROR: Automatic setup did not complete.
echo You can try double-clicking setup.cmd to see the error.
goto failed
:node_missing
echo ERROR: Node.js was not found. Install Node.js 22.16 or newer.
goto failed
:cd_failed
echo ERROR: Cannot open the JK-Cafe directory.
goto failed
:failed
pause
exit /b 1
