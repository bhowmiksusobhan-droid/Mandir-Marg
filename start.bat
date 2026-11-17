@echo off
cd /d "%~dp0"
python tools\dev_server.py
if errorlevel 1 py -3 tools\dev_server.py
pause
