@echo off
setlocal
cd /d "%~dp0"

if "%FMT_SERVER_BASE_URL%"=="" set "FMT_SERVER_BASE_URL=http://192.168.9.104"

echo [start-dev] server = %FMT_SERVER_BASE_URL%
echo [start-dev] stub expected at 4789 (node tools\stub-server.mjs --port 4789)
echo.

node scripts\run-electron.mjs
echo.
echo [start-dev] exit code = %errorlevel%
pause
endlocal
