@echo off
setlocal
cd /d "%~dp0"

if "%SERVER_BASE_URL%"=="" set "SERVER_BASE_URL=http://192.168.9.104"
if "%PORT%"=="" set "PORT=5180"

echo [web] server = %SERVER_BASE_URL%
echo [web] open   = http://127.0.0.1:%PORT%
echo.

node server.mjs --server "%SERVER_BASE_URL%" --port %PORT%
echo.
echo [web] exit code = %errorlevel%
pause
endlocal
