@echo off
chcp 65001 > nul
title EasyFlow Bridge
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node\node.exe" set NODE="%~dp0node\node.exe"
echo Starting EasyFlow Bridge window...
%NODE% app.mjs
