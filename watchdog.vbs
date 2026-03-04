' GolfLabs Kiosk Watchdog Launcher
' Runs watchdog.ps1 hidden (no console window). Falls back to watchdog.bat
' if PowerShell is unavailable.

Set fso = CreateObject("Scripting.FileSystemObject")
ScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = ScriptDir

Ps1Path = ScriptDir & "\watchdog.ps1"
BatPath = ScriptDir & "\watchdog.bat"

If fso.FileExists(Ps1Path) Then
    ' Launch PowerShell hidden, bypass execution policy for this script only
    PsCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File " & Chr(34) & Ps1Path & Chr(34)
    WshShell.Run PsCmd, 0, False
ElseIf fso.FileExists(BatPath) Then
    ' Fallback to the legacy batch watchdog
    WshShell.Run Chr(34) & BatPath & Chr(34), 0, False
End If
