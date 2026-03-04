!macro customInstall
  ; Remove legacy direct-launch shortcut if present (watchdog now owns kiosk lifecycle)
  Delete "$SMSTARTUP\GolfLabsKiosk.lnk"
  
  ; Create Watchdog startup shortcut — the watchdog launches and monitors the kiosk
  CreateShortCut "$SMSTARTUP\KioskWatchdog.lnk" "wscript.exe" '$\"$INSTDIR\watchdog.vbs$\"' "$INSTDIR"
!macroend

!macro customUnInstall
  Delete "$SMSTARTUP\GolfLabsKiosk.lnk"
  Delete "$SMSTARTUP\KioskWatchdog.lnk"
!macroend
