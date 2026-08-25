@echo off
chcp 65001 > nul
title EasyFlow Bridge - Setup
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"
%NODE% setup.mjs
echo.
pause > nul
