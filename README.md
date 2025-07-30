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

> **Applies to:** Windows 11 Pro (primary) & Windows 10 Pro (see "Windows 10 Notes" blocks)

This guide converts a fresh Windows PC into a locked-down golf-sim kiosk that

* auto-logs into a non-admin **kiosk** user
* keeps **GSPro+** running full-screen in the background
* launches the Electron **GolfLabsKiosk** overlay to manage bookings & door control
* blocks all escape hatches (Task Manager, Alt + Tab, etc.)

---
## 0  Preparation Checklist

1. Sign in with an **administrator** account (RDP or local).
2. Verify GSPro+ launches: `C:\Program Files\GSPro\GSPro.exe`.
3. Copy/installer for `GolfLabsKiosk.exe` ready.
4. Choose a folder (`C:\GolfLabsKiosk\`).

> **Windows 10 Note**  All steps work the same on Windows 10 Pro. If you are on **Windows 10 Home** you must first install the Group-Policy Editor (see Appendix A) or apply the equivalent registry files provided in `policy-exports/`.

---
## 1  Create the Kiosk User

Settings → **Accounts → Other users**

1. Add → "I don’t have this person’s sign-in information" → "Add a user without a Microsoft account".
2. Username **kiosk**, secure password.
3. Change account type → **Standard user**.

> **Windows 10 Note**  UI path is *Settings → Accounts → Family & other users*.

---
## 2  Install / Copy the Kiosk App

```powershell
mkdir C:\GolfLabsKiosk
copy GolfLabsKiosk.exe C:\GolfLabsKiosk\
copy config.json       C:\GolfLabsKiosk\
```
Ensure **Users** group has *Read & execute*.

---
## 3  Create the Launcher and Watchdog Scripts

### launch.vbs (hides the console window)
Save this as `C:\GolfLabsKiosk\launch.vbs`:

```vb
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "C:\GolfLabsKiosk\start.bat", 0, False
```

### start.bat (overlay + GSPro watchdog)
Save this as `C:\GolfLabsKiosk\start.bat`:

```bat
@echo off
rem —————————————————————————————————————————————
rem Launch the kiosk overlay immediately (non-blocking)
start "" "C:\GolfLabsKiosk\GolfLabsKiosk.exe"

rem Give overlay a moment to initialize
timeout /t 3 /nobreak >nul

rem —————————————————————————————————————————————
rem Watchdog Loop
:watch_loop

   rem — Check kiosk overlay; restart if needed
   tasklist /fi "imagename eq GolfLabsKiosk.exe" | find /i "GolfLabsKiosk.exe" >nul
   if errorlevel 1 (
       echo [%time%] Overlay exited — relaunching...
       start "" "C:\GolfLabsKiosk\GolfLabsKiosk.exe"
   )

   rem — Check GSPro; launch or restart if needed
   tasklist /fi "imagename eq GSPro.exe" | find /i "GSPro.exe" >nul
   if errorlevel 1 (
       echo [%time%] GSPro not running — launching...
       start "" "C:\Program Files\GSPro\GSPro.exe"
   )

   rem — Pause briefly before repeating
   timeout /t 5 /nobreak >nul
goto watch_loop
```

**What this does:**

1. Starts the kiosk overlay on top.
2. Enters a loop every 5 seconds:
   • If the overlay isn't running, it restarts it.
   • If GSPro isn't running, it launches it.

> This watchdog approach ensures both the kiosk overlay and GSPro remain running continuously, automatically restarting either component if it crashes or is closed.

---
## 4  Enable Auto-Logon

Run `netplwiz`, un-tick *Users must enter a user name…*, pick **kiosk**, supply password.

> **Windows 10 Note**  Identical.

---
## 5  Replace Explorer Shell

Log in as **kiosk**, run **regedit** →
`HKCU\Software\Microsoft\Windows NT\CurrentVersion\Winlogon` →

1. Delete the existing `Shell` entry (if present)
2. Create new String `Shell` = 
   ```
   wscript.exe "C:\GolfLabsKiosk\launch.vbs"
   ```

Now Windows will run the VBScript (which hides the console) at login.

---
## 6  Group-Policy Lock-down

Launch **gpedit.msc** as **Admin** and apply the table below.
Users of Windows 10 Pro follow the same paths; Windows 10 Home: import `*.reg` files from `policy-exports/`.
### SET ALL BELOW TO ENABLED
User Configuration → Administrative Templates → System → Ctrl+Alt+Del Options
<img width="645" height="112" alt="image" src="https://github.com/user-attachments/assets/bb374f52-2424-49f9-8d29-ae2f71416188" />

User Configuration → Administrative Templates → Start Menu and Taskbar → Remove Run menu
<img width="680" height="98" alt="image" src="https://github.com/user-attachments/assets/c1cbeae1-9ca0-4528-96fd-bbef09d26541" />

User Configuration → Administrative Templates → System → Prevent access to registry editing tools
<img width="664" height="71" alt="image" src="https://github.com/user-attachments/assets/cdd61af9-4146-468f-981b-1fe90da9dc89" />

User Configuration → Administrative Templates → Windows Components → File Explorer → Remove File Explorer’s default context menu
<img width="671" height="87" alt="image" src="https://github.com/user-attachments/assets/c4fefe35-93d7-4c29-b9d0-fd47bdf68d7d" />

User Configuration → Administrative Templates → Windows Components → File Explorer → Turn off Windows + X hotkeys
<img width="669" height="84" alt="image" src="https://github.com/user-attachments/assets/b5188e77-3c59-4032-97cc-51e89020c4d3" />

Afterwards `gpupdate /force` or reboot.

---
## 7  Hotkey Suppression (Electron)

Add to `main.js` (after `app.whenReady()`):
```js
if (!isDev) {
  const blocked = ['F11','F12','Control+Shift+I','Alt+F4'];
  blocked.forEach(accel => globalShortcut.register(accel, () => {}));
}
```

---
## 8  Power & Update Settings

* **Screen & sleep:** *Never* on AC.
* Disable multi-finger gestures if touchpad present.
* Windows Update → schedule off-hours restarts.

> **Windows 10 Note**  Settings → *System → Power & sleep*.

---
## 9  Test Workflow

1. Reboot.
2. Auto-login → GSPro+ → overlay.
3. Verify hotkeys blocked and overlay logic works.

---
## 10  Maintenance

Admin may RDP/sign-in, update files in `C:\GolfLabsKiosk`, reboot.

---
## 11  Emergency Rollback

1. Power-cycle.
2. During *Signing in…* hold **Shift** → *Restart* → *Troubleshoot → Startup Settings → Safe Mode with Networking*.
3. Log in as Admin, delete `Shell` value, reboot.

---
## Appendix A  Installing GPEdit on Windows 10 Home

If you are running Windows 10 Home:

1. Open PowerShell **as administrator**.
2. Run:
   ```powershell
   dism /online /Add-Capability /CapabilityName:Rsat.GroupPolicy.Management.Tools~~~~0.0.1.0
   ```
3. Reboot. **gpedit.msc** is now available.

Alternatively, import the provided `*.reg` files in `policy-exports/` to enforce identical lockdown settings. 
