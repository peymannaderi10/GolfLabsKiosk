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

## Creating Installers

You can create professional installers for both Mac and Windows platforms:

### Quick Build Commands
```bash
# Install electron-builder (if not already installed)
npm install electron-builder --save-dev

# Build for current platform
npm run build

# Build for specific platforms
npm run build:win    # Windows installer
npm run build:mac    # Mac installer (macOS required)
npm run build:all    # Both platforms
```

### Installer Features
- **Windows**: NSIS installer with desktop shortcuts and uninstaller
- **Mac**: DMG with drag-and-drop installation + PKG installer
- **Universal builds**: Support for both Intel and Apple Silicon Macs
- **Code signing ready**: For production deployment

### Requirements
- **Icons**: Place `icon.ico` (Windows) and `icon.icns` (Mac) in `assets/` directory
- **macOS**: Required for building Mac installers (due to Apple restrictions)
- **Windows**: Can be built from any platform

📖 **See [BUILD.md](BUILD.md) for complete installation and distribution guide**

---

*Golf Labs Kiosk - Powering seamless automated golf experiences* 