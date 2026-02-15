@echo off
rem Wait for initial apps to start
timeout /t 10 /nobreak >nul

:watch_loop
   rem — Check kiosk overlay; restart if needed
   tasklist /fi "imagename eq Golf Labs Kiosk.exe" | find /i "Golf Labs Kiosk.exe" >nul
   if errorlevel 1 (
       echo [%time%] Overlay exited — relaunching...
       start "" "C:\GolfLabsKiosk\Golf Labs Kiosk\Golf Labs Kiosk.exe"
   )

   rem — Check simulator; launch or restart if needed
   tasklist /fi "imagename eq UneekorLauncher.exe" | find /i "UneekorLauncher.exe" >nul
   if errorlevel 1 (
       echo [%time%] Simulator not running — launching...
       start "" "C:\Uneekor\Launcher\UneekorLauncher.exe"
   )

   rem — Pause briefly before repeating
   timeout /t 5 /nobreak >nul
goto watch_loop
