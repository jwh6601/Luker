@echo off
cd /d "%~dp0"
node server.js --port 8002 --listen false --browserLaunchEnabled true
if errorlevel 1 pause
