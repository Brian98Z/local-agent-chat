@echo off
node "%~dp0server.mjs" %*
if errorlevel 1 pause
