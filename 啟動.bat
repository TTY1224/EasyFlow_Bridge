@echo off
chcp 65001 > nul
title EasyFlow Bridge
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"
%NODE% bridge.mjs
echo.
echo Bridge stopped. Press any key to close this window.
pause > nul
