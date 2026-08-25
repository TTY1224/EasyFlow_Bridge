@echo off
chcp 65001 > nul
cd /d "%~dp0"
title EasyFlow Bridge

rem Windows blocks scripts downloaded from the internet (Mark of the Web).
rem Smart App Control refuses to run the .vbs until the mark is removed.
rem A .bat is NOT blocked, so we use it to clear the mark, then hand off.
rem Only top-level files + node.exe need it -- files inside node_modules are
rem read as data by node, not executed by a script host.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0.' -File | Unblock-File -ErrorAction SilentlyContinue; Unblock-File -LiteralPath '%~dp0node\node.exe' -ErrorAction SilentlyContinue" 2>nul

if not exist "%~dp0EasyFlow_bridge.vbs" goto :nofile
start "" wscript.exe "%~dp0EasyFlow_bridge.vbs"
exit /b 0

:nofile
echo.
echo  [!] EasyFlow bridge files are missing. Please extract the whole zip again.
echo.
pause > nul
