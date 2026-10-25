@echo off
setlocal
cd /d "%~dp0"
if not exist "sentinel.config.json" (
  echo [sentinel] Missing sentinel.config.json
  echo [sentinel] Copy sentinel.config.example.json, fill identity/model paths, then run again.
  exit /b 2
)
node sentinel.mjs --config "sentinel.config.json"
