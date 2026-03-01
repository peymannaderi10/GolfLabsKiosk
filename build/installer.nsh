!macro customInstall
  ; Create Kiosk startup shortcut
  CreateShortCut "$SMSTARTUP\GolfLabsKiosk.lnk" "$INSTDIR\Golf Labs Kiosk.exe" "" "$INSTDIR"
  
  ; Create Watchdog startup shortcut (quoted path for spaces in InstallDir)
  CreateShortCut "$SMSTARTUP\KioskWatchdog.lnk" "wscript.exe" '$\"$INSTDIR\watchdog.vbs$\"' "$INSTDIR"
!macroend

!macro customUnInstall
  Delete "$SMSTARTUP\GolfLabsKiosk.lnk"
  Delete "$SMSTARTUP\KioskWatchdog.lnk"
!macroend
