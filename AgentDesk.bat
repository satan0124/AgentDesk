@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies for the first run...
  call npm install
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
