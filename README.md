# Golf Labs Kiosk Application

## Overview

This is a lightweight Electron-based desktop application designed to run in "kiosk mode" on the PCs connected to each golf simulator bay. The application enforces booking schedules by locking computer access during non-booked periods and provides automated door unlocking capabilities through integrated smart lock controls.

The kiosk operates as a real-time client, maintaining constant communication with the central booking API via WebSocket connections to ensure immediate responses to booking changes and unlock commands.

---

## Features

### 🔒 **Automated Access Control**
- **Screen Locking**: Displays a "Locked" overlay by default, preventing computer access outside of valid bookings
- **Smart Unlocking**: Automatically grants access during confirmed booking periods
- **Real-time Updates**: Instantly responds to booking changes without manual refresh

### 🌐 **Real-time Communication**
- **WebSocket Integration**: Maintains persistent connection to the backend API for instant updates
- **Live Booking Sync**: Receives booking updates immediately as they occur in the system
- **Connection Resilience**: Automatic reconnection with exponential backoff on connection loss

### 🚪 **Smart Lock Integration**
- **Shelly Switch Control**: Direct integration with Shelly Plus 1 smart switches for door access
- **Email-triggered Unlocking**: Processes unlock commands sent from customer email links
- **Comprehensive Logging**: Tracks all unlock attempts with detailed success/failure logging
- **JSON-RPC Communication**: Modern API communication with Shelly devices

### 📱 **Bay-Specific Configuration**
- **Individual Setup**: Each kiosk configured for specific bay and location
- **Network Isolation**: Smart locks operate on local network for security
- **Timezone Awareness**: Handles location-specific time calculations

### 🔧 **Operational Features**
- **In-memory Storage**: Fast booking data access without file system dependencies
- **Offline Resilience**: Maintains unlock state during temporary network outages
- **Heartbeat Monitoring**: Regular health checks with the backend system
- **Manual Sync**: Staff refresh capability for troubleshooting

### 🖥️ **Multi-Monitor & Security Features**
- **Multi-Monitor Support**: Automatically detects and spans across all connected displays
- **Keyboard Lockdown**: Disables common escape shortcuts (Alt+F4, Ctrl+Alt+Del, etc.) in production mode
- **Admin Mode**: Secure administrative interface accessible via PgUp+PgDn key combination
- **Monitor Management**: Ability to disconnect/reconnect additional monitors on-demand
- **System Control**: Administrative restart, shutdown, and WebSocket reconnection capabilities

---

## Prerequisites

Before running this application, ensure you have:

1. [Node.js](https://nodejs.org/) installed (which includes `npm`)
2. The Golf Labs backend API (`GolfLabs.us-api`) running and accessible
3. Shelly Plus 1 smart switch installed and configured on local network
4. Network connectivity between kiosk, API server, and smart switches

---

## Setup & Installation

1. **Install Dependencies**: Navigate to the `GolfLabsKiosk` directory and install required packages:

    ```bash
    npm install
    ```

2. **Configure the Kiosk**: Copy `config.example.json` to `config.json` and edit the values for your environment:

    ```json
    {
        "bayId": "your-unique-bay-id-goes-here",
        "locationId": "your-location-id-goes-here", 
        "apiBaseUrl": "http://localhost:4242",
        "timezone": "America/New_York",
        "shellyIP": "10.0.0.157"
    }
    ```

    **Configuration Parameters:**
    - `bayId`: Unique identifier (UUID) for the specific simulator bay
    - `locationId`: Unique identifier (UUID) for the facility location
    - `apiBaseUrl`: Full URL to your running backend API server
    - `timezone`: IANA timezone name (e.g., "America/New_York", "America/Chicago")
    - `shellyIP`: Local IP address of the Shelly Plus 1 switch controlling door access

---

## System Architecture

### Real-time Data Flow

```
Backend API ←→ WebSocket ←→ Kiosk Application
     ↓                           ↓
Database Updates          In-Memory Bookings
     ↓                           ↓
Email Triggers           Smart Lock Control
     ↓                           ↓
Unlock Commands    →    Shelly Switch API
```

### Key Architectural Changes

**Previous System:**
- File-based booking storage (`bookings.json`)
- HTTP polling every 60 seconds
- Manual refresh requirements

**Current System:**
- **In-memory booking storage** for instant access
- **WebSocket connections** for real-time updates
- **Event-driven architecture** with immediate response
- **Integrated smart lock control** with comprehensive logging

---

## Running the Application

### Development Mode
Launches in a resizable window with developer tools for testing and debugging:

```bash
npm run dev
```

### Production Mode  
Runs in fullscreen kiosk mode as customers will experience:

```bash
npm start
```

**To close the application:** Use `Ctrl + C` in the terminal where it's running.

---

## WebSocket Events

The kiosk listens for several real-time events from the backend:

### Booking Management
- `bookings_updated` - Full booking refresh for the bay
- `booking_update` - Individual booking changes (add/remove/modify)

### Access Control  
- `unlock` - Door unlock commands triggered by customer email links

### Connection Management
- `connect` - Establishes connection and registers kiosk identity
- `disconnect` - Handles connection loss and cleanup
- `connect_error` - Manages connection failures and retry logic

---

## Smart Lock Integration

### Shelly Plus 1 Configuration

The kiosk communicates with Shelly Plus 1 smart switches using the JSON-RPC API:

```javascript
// Unlock command structure
{
  "id": 1,
  "method": "Switch.Set", 
  "params": {
    "id": 0,
    "on": false,        // false = unlocked state
    "toggle_after": 5   // Auto-lock after 5 seconds
  }
}
```

### Unlock Process
1. Customer receives email with secure unlock link
2. Customer clicks unlock button in email
3. Backend validates token and sends WebSocket command to kiosk
4. Kiosk executes Shelly API call to unlock door
5. Door automatically re-locks after specified duration
6. All actions logged to central database

### Security Features
- **Time-limited tokens** that expire with booking end time
- **Local network communication** between kiosk and smart locks
- **Comprehensive audit logging** of all unlock attempts
- **Automatic re-locking** prevents doors being left open

---

## Monitoring & Logging

### Health Monitoring
- **Heartbeat system** confirms kiosk connectivity
- **WebSocket status** tracking for real-time communication
- **Smart lock response** monitoring for unlock reliability

### Access Logging
All unlock attempts are logged with detailed information:
- Success/failure status
- Response times
- Error details for failed attempts  
- Booking and user context
- Shelly device responses

### Operational Resilience
- **Automatic reconnection** on network interruptions
- **Offline operation** maintains unlock state during outages
- **Fallback polling** every 6 hours for data synchronization
- **Error recovery** with detailed logging for troubleshooting

---

## Troubleshooting

### Common Issues

**WebSocket Connection Failures:**
- Check `apiBaseUrl` in config.json
- Verify backend API is running and accessible
- Check firewall settings for WebSocket connections

**Smart Lock Not Responding:**
- Verify `shellyIP` configuration matches device IP
- Test Shelly device directly via web interface
- Check local network connectivity
- Review unlock attempt logs in backend

**Booking Data Not Updating:**
- Confirm WebSocket connection status in logs
- Use manual refresh button on locked screen
- Check bay and location IDs in configuration

### Development Tools

In development mode, you can:
- Access browser developer tools for debugging
- Monitor WebSocket connections in Network tab
- View console logs for troubleshooting
- Test unlock commands manually

---

## Admin Mode

### Accessing Admin Mode
Press **PgUp + PgDn** keys simultaneously to open the admin panel. This provides secure access to system management functions without compromising the kiosk's locked-down state.

### Admin Features
- **Application Control**: Restart or close the entire kiosk application
- **Monitor Management**: View connected displays and manage multi-monitor setup
- **Connection Management**: Reconnect WebSocket connections if needed
- **System Information**: Real-time display of connected monitors and window status

### Security Considerations
- Admin mode is only accessible via specific key combination
- All admin actions require confirmation to prevent accidental changes
- Admin panel automatically tracks connected displays and window states
- Keyboard shortcuts are disabled in production mode except for admin access

## Multi-Monitor Setup

### Automatic Detection
The kiosk automatically:
1. Detects all connected displays on startup
2. Creates fullscreen windows on each display
3. Synchronizes booking data across all windows
4. Maintains proper window hierarchy (primary + secondary displays)

### Monitor Management
Through admin mode, you can:
- **View Display Information**: See resolution and status of each connected display
- **Disconnect Extra Monitors**: Close windows on secondary displays while keeping primary
- **Reconnect Monitors**: Re-enable windows on all detected displays
- **Real-time Monitoring**: Track active window count and display configurations

### Production vs Development
- **Production Mode**: All displays show fullscreen kiosk interface, shortcuts disabled
- **Development Mode**: Windowed mode on primary display only, shortcuts enabled for debugging

*Golf Labs Kiosk - Powering seamless automated golf experiences* 

# Golf-Sim Kiosk Setup Guide

> **Applies to:** Windows 11 (Home/Pro) & Windows 10 (Home/Pro)

This guide converts a Windows PC into a locked-down golf-sim kiosk that:

* Auto-logs into a Windows user account
* Keeps your simulator software (GSPro, Uneekor, etc.) running in the background
* Launches the Electron **Golf Labs Kiosk** overlay to manage bookings & door control
* Blocks escape hatches (Task Manager, Alt+Tab, etc.)

---

## Setup Modes

Choose the setup mode that fits your needs:

| Mode | Description | Use Case |
|------|-------------|----------|
| **Single-User Mode** | Uses existing Windows user, keeps Windows Explorer running in background | Development, testing, staff access needed |
| **Full Kiosk Mode** | Dedicated kiosk user, replaces Windows shell entirely | Production, maximum lockdown |

**This guide covers Single-User Mode.** For Full Kiosk Mode, see [Appendix B](#appendix-b--full-kiosk-mode-separate-user).

---

## 0  Preparation Checklist

1. Sign in with an **administrator** account
2. Verify your simulator software launches (e.g., `C:\Uneekor\Launcher\UneekorLauncher.exe`)
3. Download the Golf Labs Kiosk installer
4. Have your `config.json` ready with correct bay/location IDs

---

## 1  Install the Kiosk App

Run the Golf Labs Kiosk installer and install to:
```
C:\GolfLabsKiosk\
```

The installer will create:
```
C:\GolfLabsKiosk\Golf Labs Kiosk\
├── Golf Labs Kiosk.exe
└── (other app files)
```

---

## 2  Configure the Kiosk

The app looks for `config.json` in your **AppData** folder, not the installation folder.

### Copy your config to the correct location:

```powershell
# Create the config directory
New-Item -ItemType Directory -Path "$env:APPDATA\Golf Labs Kiosk" -Force

# Copy your config (update the source path as needed)
Copy-Item "C:\path\to\your\config.json" "$env:APPDATA\Golf Labs Kiosk\config.json"
```

### Config file location:
```
C:\Users\<YourUsername>\AppData\Roaming\Golf Labs Kiosk\config.json
```

### Example config.json:
```json
{
    "bayId": "your-bay-uuid-here",
    "locationId": "your-location-uuid-here",
    "apiBaseUrl": "https://golflabs-us-api.onrender.com",
    "timezone": "America/New_York",
    "shellyIP": "10.0.0.157"
}
```

---

## 3  Watchdog Scripts

The watchdog monitors both the kiosk and simulator, restarting them if they crash. It also detects and kills duplicate instances. The installer ships three files:

| File | Purpose |
|------|---------|
| `watchdog.vbs` | Hidden launcher — runs the PowerShell watchdog (falls back to .bat) |
| `watchdog.ps1` | Primary watchdog — named mutex, duplicate-instance killing, log rotation |
| `watchdog.bat` | Legacy fallback — used only if PowerShell is unavailable |

### How it works

- **Single-instance guarantee**: A named mutex (`Global\GolfLabsKioskWatchdog`) prevents two watchdog processes from running simultaneously.
- **Duplicate detection**: Each check counts running kiosk instances. If more than one is found, extras are killed (oldest kept).
- **Startup**: Waits 45 seconds after launch for Windows to settle, then checks every 30 seconds.
- **Logging**: Writes to `logs\watchdog.log` next to the exe. Log rotates at 5MB.

### watchdog.vbs
```vb
Set fso = CreateObject("Scripting.FileSystemObject")
ScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = ScriptDir

Ps1Path = ScriptDir & "\watchdog.ps1"
BatPath = ScriptDir & "\watchdog.bat"

If fso.FileExists(Ps1Path) Then
    PsCmd = "powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File " & Chr(34) & Ps1Path & Chr(34)
    WshShell.Run PsCmd, 0, False
ElseIf fso.FileExists(BatPath) Then
    WshShell.Run Chr(34) & BatPath & Chr(34), 0, False
End If
```

> **Note:** Modify the simulator path in `watchdog.ps1` to match your setup (GSPro, Uneekor, etc.)

---

## 4  Create Startup Shortcuts

Run this in **regular PowerShell** (not admin) to create startup shortcuts.

> **Important:** The watchdog handles launching both the kiosk and simulator. Do **not** create a separate `GolfLabsKiosk.lnk` — having both caused duplicate instances in the past.

```powershell
$WshShell = New-Object -ComObject WScript.Shell

# Remove legacy direct kiosk shortcut if present
$legacyKiosk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\GolfLabsKiosk.lnk"
if (Test-Path $legacyKiosk) { Remove-Item $legacyKiosk -Force; Write-Host "Removed legacy GolfLabsKiosk.lnk" -ForegroundColor Yellow }

# Watchdog - the single entry point that launches and monitors kiosk + simulator
$Watchdog = $WshShell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\KioskWatchdog.lnk")
$Watchdog.TargetPath = "wscript.exe"
$Watchdog.Arguments = '"C:\GolfLabsKiosk\Golf Labs Kiosk\watchdog.vbs"'
$Watchdog.WorkingDirectory = "C:\GolfLabsKiosk\Golf Labs Kiosk"
$Watchdog.Save()

Write-Host "Startup shortcut created!" -ForegroundColor Green
```

### Verify shortcuts:
```powershell
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
```

---

## 5  Enable Auto-Logon

### Step 5a: Enable the auto-logon checkbox (Windows 10/11)

Run in **PowerShell as Admin**:
```powershell
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" /v DevicePasswordLessBuildVersion /t REG_DWORD /d 0 /f
```

### Step 5b: Configure auto-logon

1. Run `netplwiz`
2. Uncheck "Users must enter a user name and password to use this computer"
3. Click **Apply**
4. Enter your password twice when prompted
5. Click **OK**

---

## 6  System Lockdown

### Option A: Registry Method (Works on Windows Home & Pro)

Run in **PowerShell as Admin**:

```powershell
# Create registry paths
New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Force | Out-Null
New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" -Force | Out-Null

# Disable Task Manager
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name "DisableTaskMgr" -Value 1 -Type DWord

# Disable Lock Workstation
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name "DisableLockWorkstation" -Value 1 -Type DWord

# Disable Change Password
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name "DisableChangePassword" -Value 1 -Type DWord

# Disable Sign Out
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" -Name "NoLogoff" -Value 1 -Type DWord

Write-Host "Lockdown applied!" -ForegroundColor Green
```

### Option B: Group Policy Editor (Windows Pro only, or Home with gpedit enabled)

1. Run `gpedit.msc` as Admin
2. Navigate to: **User Configuration → Administrative Templates → System → Ctrl+Alt+Del Options**
3. Enable all options to disable Task Manager, Lock, Change Password, Log Off

### To undo lockdown later:

```powershell
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name "DisableTaskMgr" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name "DisableLockWorkstation" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name "DisableChangePassword" -ErrorAction SilentlyContinue
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" -Name "NoLogoff" -ErrorAction SilentlyContinue
Write-Host "Lockdown removed." -ForegroundColor Yellow
```

---

## 7  Power & Update Settings

* **Screen & sleep:** Set to *Never* on AC power
* **Windows Update:** Schedule restarts for off-hours
* Disable touchpad gestures if applicable

Settings → System → Power & battery → Screen and sleep

---

## 8  Test Workflow

1. Reboot the PC
2. Verify auto-login works
3. Verify kiosk overlay launches instantly
4. Verify simulator launches
5. Test `Ctrl+Shift+Esc` - Task Manager should be blocked
6. Test admin mode with **PgUp + PgDn** key combination

---

## 9  Final Folder Structure

```
C:\GolfLabsKiosk\Golf Labs Kiosk\
├── Golf Labs Kiosk.exe    ← Main application
├── watchdog.vbs           ← Hidden launcher (entry point)
├── watchdog.ps1           ← Primary watchdog (PowerShell)
├── watchdog.bat           ← Legacy fallback watchdog
├── logs\
│   └── watchdog.log       ← Watchdog activity log
└── (other installer files)

C:\Users\<You>\AppData\Roaming\Golf Labs Kiosk\
└── config.json            ← Configuration file

C:\Users\<You>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\
└── KioskWatchdog.lnk      ← Watchdog (launches kiosk + simulator)
```

---

## 10  Maintenance

* Access Windows normally via admin mode (PgUp + PgDn)
* Update config at `%APPDATA%\Golf Labs Kiosk\config.json`
* RDP access available for remote administration

---

## 11  Emergency Recovery

If you get locked out:

1. Reboot and hold **Shift** during "Signing in..." screen
2. Select *Restart* → *Troubleshoot* → *Startup Settings* → *Safe Mode*
3. Log in and run the "undo lockdown" PowerShell commands from Step 6

---

## Appendix A  Enable GPEdit on Windows 11/10 Home

Run in **PowerShell as Admin**:

```powershell
Get-ChildItem -Path "$env:SystemRoot\servicing\Packages\Microsoft-Windows-GroupPolicy-ClientExtensions-Package~*.mum" | ForEach-Object { dism /online /norestart /add-package:"$($_.FullName)" }
Get-ChildItem -Path "$env:SystemRoot\servicing\Packages\Microsoft-Windows-GroupPolicy-ClientTools-Package~*.mum" | ForEach-Object { dism /online /norestart /add-package:"$($_.FullName)" }
```

Restart your PC. `gpedit.msc` will now be available.

> **Note:** Some older package versions may show errors - this is normal as long as the latest versions succeed.

---

## Appendix B  Full Kiosk Mode (Separate User)

For maximum lockdown in production environments, you can create a dedicated kiosk user and replace the Windows shell entirely.

### Additional Steps for Full Kiosk Mode:

**B1. Create Kiosk User:**
Settings → Accounts → Other users → Add user without Microsoft account
- Username: `kiosk`
- Account type: Standard user

**B2. Replace Explorer Shell:**
Log in as kiosk user, run `regedit`:
`HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon`

Create String value `Shell`:
```
wscript.exe "C:\GolfLabsKiosk\Golf Labs Kiosk\watchdog.vbs"
```

**B3. Emergency Rollback:**
Boot to Safe Mode, log in as Admin, delete the `Shell` registry value.

> **Warning:** Full Kiosk Mode removes access to Windows desktop, taskbar, and Start menu entirely. Only use in production after thorough testing. 
