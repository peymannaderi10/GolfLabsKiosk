@echo off
setlocal EnableDelayedExpansion
rem Script dir = app install dir (same folder as Golf Labs Kiosk.exe)
set "SCRIPT_DIR=%~dp0"
set "KIOSK_EXE=%SCRIPT_DIR%Golf Labs Kiosk.exe"
set "SIMULATOR_EXE=C:\Uneekor\Launcher\UneekorLauncher.exe"

rem Wait for initial apps to start
timeout /t 10 /nobreak >nul

:watch_loop
   rem Check kiosk overlay; restart if needed
   tasklist /fi "imagename eq Golf Labs Kiosk.exe" 2>nul | find /i "Golf Labs Kiosk.exe" >nul
   if errorlevel 1 (
       echo [%time%] Kiosk exited - relaunching...
       start "" "!KIOSK_EXE!"
   )

   rem Check simulator; launch or restart if needed
   tasklist /fi "imagename eq UneekorLauncher.exe" 2>nul | find /i "UneekorLauncher.exe" >nul
   if errorlevel 1 (
       echo [%time%] Simulator not running - launching...
       start "" "!SIMULATOR_EXE!"
   )

   rem Pause briefly before repeating
   timeout /t 5 /nobreak >nul
goto watch_loop
