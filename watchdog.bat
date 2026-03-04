@echo off
setlocal EnableDelayedExpansion
rem ── GolfLabs Kiosk Watchdog (legacy batch fallback) ──
rem    Prefer watchdog.ps1 — this runs only if PowerShell is unavailable.

set "SCRIPT_DIR=%~dp0"
set "KIOSK_EXE=%SCRIPT_DIR%Golf Labs Kiosk.exe"
set "SIMULATOR_EXE=C:\Uneekor\Launcher\UneekorLauncher.exe"
set "LOCKFILE=%SCRIPT_DIR%watchdog.lock"
set "LOGFILE=%SCRIPT_DIR%logs\watchdog_bat.log"

rem ── Create logs directory if missing ──
if not exist "%SCRIPT_DIR%logs" mkdir "%SCRIPT_DIR%logs"

rem ── Single-instance guard via lock file ──
rem    Try to acquire an exclusive write handle. If another watchdog.bat holds
rem    it, the redirect fails and we exit.
2>nul (
    9>"%LOCKFILE%" (
        echo PID %~n0 >"%LOCKFILE%"

        rem ── Wait for system startup ──
        echo [%date% %time%] Watchdog started >>"%LOGFILE%"
        timeout /t 45 /nobreak >nul

        :watch_loop

            rem ── Count kiosk instances ──
            set KIOSK_COUNT=0
            for /f %%a in ('tasklist /fi "imagename eq Golf Labs Kiosk.exe" 2^>nul ^| find /c /i "Golf Labs Kiosk.exe"') do set KIOSK_COUNT=%%a

            if !KIOSK_COUNT! EQU 0 (
                echo [%date% %time%] Kiosk not running - launching >>"%LOGFILE%"
                start "" "!KIOSK_EXE!"
            )
            if !KIOSK_COUNT! GTR 1 (
                echo [%date% %time%] !KIOSK_COUNT! kiosk instances detected - killing all and relaunching >>"%LOGFILE%"
                taskkill /im "Golf Labs Kiosk.exe" /f >nul 2>&1
                timeout /t 3 /nobreak >nul
                start "" "!KIOSK_EXE!"
            )

            rem ── Check simulator ──
            if exist "!SIMULATOR_EXE!" (
                tasklist /fi "imagename eq UneekorLauncher.exe" 2>nul | find /i "UneekorLauncher.exe" >nul
                if errorlevel 1 (
                    echo [%date% %time%] Simulator not running - launching >>"%LOGFILE%"
                    start "" "!SIMULATOR_EXE!"
                )
            )

            rem ── Wait 30 seconds before next check ──
            timeout /t 30 /nobreak >nul
        goto watch_loop
    )
)
rem If we reach here, lock acquisition failed — another watchdog is running
exit /b 0
