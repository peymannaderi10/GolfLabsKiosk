const { app, BrowserWindow, ipcMain, dialog, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const axios = require('axios');

const isDev = process.argv.includes('--dev');
const userDataPath = app.getPath('userData');
const CONFIG_PATH = path.join(userDataPath, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

let config;
let mainWindow;
let additionalWindows = [];
let socket;
let bookings = []; // In-memory store for bookings
let pollingInterval;
let isManuallyUnlocked = false;
let manualUnlockEndTime = null; // Track when the timed unlock expires

// Admin mode key tracking
let keysPressed = new Set();
let adminKeyCombo = ['PageUp', 'PageDown'];

// In-memory log buffer (keep last 500 entries)
const logBuffer = [];
const MAX_LOG_ENTRIES = 500;

function addToLogBuffer(level, args) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => { addToLogBuffer('log', args); originalLog(...args); };
console.error = (...args) => { addToLogBuffer('error', args); originalError(...args); };
console.warn = (...args) => { addToLogBuffer('warn', args); originalWarn(...args); };

function loadConfig() {
  try {
    // Check if config.json exists in the user's data directory.
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('config.json not found. Attempting to create it from example.');
      
      // If not, copy it from the example included with the app.
      fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
      
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Configuration Needed',
        message: 'A new configuration file has been created for you. Please edit it before restarting the application.',
        detail: `The file is located at: ${CONFIG_PATH}`
      });
      
      // Quit the app so the user can configure it.
      app.quit();
      return;
    }

    const configData = fs.readFileSync(CONFIG_PATH);
    config = JSON.parse(configData);
    
    // Basic validation
    if (!config.bayId || !config.locationId || !config.apiBaseUrl || !config.shellyIP) {
        throw new Error('One or more required fields are missing from config.json: bayId, locationId, apiBaseUrl, shellyIP');
    }

    // Set default admin password if not present
    if (!config.adminPassword) {
        config.adminPassword = 'admin123';
        console.log('Admin password not found in config, using default: admin123');
    }

    // Set default extension settings if not present
    if (!config.extensionSettings) {
        config.extensionSettings = { enabled: true, triggerMinutes: 5, options: [15, 30, 45, 60] };
        console.log('Extension settings not found in config, using defaults');
    }

    // Set default league settings if not present
    if (!config.leagueSettings) {
        config.leagueSettings = { enabled: false, leagueId: '' };
        console.log('League settings not found in config, using defaults');
    }

  } catch (error) {
    console.error('FATAL: config.json is invalid or cannot be accessed.', error);
    dialog.showErrorBox(
      'Fatal Configuration Error',
      `Could not load or create the configuration file. Please check the file at ${CONFIG_PATH}.\n\nError: ${error.message}`
    );
    app.quit();
  }
}

function createWindows() {
  const displays = screen.getAllDisplays();
  console.log(`Found ${displays.length} display(s)`);

  // Create main window on primary display
  const primaryDisplay = screen.getPrimaryDisplay();
  mainWindow = createWindow(primaryDisplay, true);

  // Create additional windows on other displays
  displays.forEach((display, index) => {
    if (display.id !== primaryDisplay.id) {
      console.log(`Creating window for display ${index + 1}: ${display.bounds.width}x${display.bounds.height}`);
      const window = createWindow(display, false);
      additionalWindows.push(window);
    }
  });
}

function createWindow(display, isPrimary = false) {
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: isDev ? 1200 : display.bounds.width,
    height: isDev ? 800 : display.bounds.height,
    fullscreen: !isDev,
    resizable: isDev,
    transparent: true,
    frame: isDev,
    closable: isDev, // Only allow closing in dev mode
    minimizable: isDev, // Prevent minimizing in kiosk mode
    skipTaskbar: !isDev, // Hide from taskbar in kiosk mode to prevent minimize via taskbar click
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  window.loadFile('index.html');

  // Prevent window from closing in kiosk mode (handles Alt+F4 and other close attempts)
  if (!isDev) {
    window.on('close', (event) => {
      console.log('Window close attempted - preventing in kiosk mode');
      event.preventDefault();
      return false;
    });

    // If somehow minimized (shouldn't happen with minimizable: false), restore immediately
    window.on('minimize', () => {
      console.log('Window minimize detected - restoring immediately in kiosk mode');
      // Use setImmediate to ensure restore happens after the minimize completes
      setImmediate(() => {
        if (window && !window.isDestroyed()) {
          window.restore();
          window.show();
          window.focus();
          window.setFullScreen(true);
          window.setAlwaysOnTop(true, 'screen-saver');
          window.moveTop();
        }
      });
    });
  }

  window.once('ready-to-show', () => {
    window.show();
    if (!isDev) {
      window.setFullScreen(true);
      window.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  window.on('closed', () => {
    if (isPrimary) {
      mainWindow = null;
      if (socket) socket.disconnect();
      clearInterval(pollingInterval);
    }
  });
  
  // Clear key tracking when window gets focus/blur to prevent stale key states
  window.on('focus', () => {
    keysPressed.clear();
  });

  window.on('blur', () => {
    keysPressed.clear();
  });
  
  if (isDev && isPrimary) {
    window.webContents.openDevTools();
  }

  return window;
}

function openAdminMode() {
  // If we don't have a main window, or we are already on the admin page, do nothing.
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.getURL().endsWith('admin.html')) {
    console.log('Cannot open admin mode: Main window not available or already in admin mode.');
    return;
  }
  
  console.log('Switching main window to admin mode...');

  // First, make the window solid and interactive again.
  mainWindow.setIgnoreMouseEvents(false);
  
  // Then, load the admin file into the main window.
  mainWindow.loadFile('admin.html');
}

function closeAdditionalWindows() {
  additionalWindows.forEach(window => {
    if (!window.isDestroyed()) {
      window.close();
    }
  });
  additionalWindows = [];
  console.log('Closed all additional monitor windows');
}

function recreateAdditionalWindows() {
  closeAdditionalWindows();
  
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  displays.forEach((display, index) => {
    if (display.id !== primaryDisplay.id) {
      console.log(`Recreating window for display ${index + 1}`);
      const window = createWindow(display, false);
      additionalWindows.push(window);
    }
  });
}

function connectToWebSocket() {
  if (!config) return;

  const { locationId, bayId, apiBaseUrl } = config;
  console.log(`Connecting to WebSocket server at ${apiBaseUrl}`);

  socket = io(apiBaseUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket'], // Force websocket connection, bypassing HTTP polling
  });

  socket.on('connect', () => {
    console.log(`WebSocket connected: ${socket.id}`);
    console.log(`Registering kiosk for location: ${locationId}, bay: ${bayId}`);
    socket.emit('register_kiosk', { locationId, bayId });

    // Request initial data dump upon connection
    socket.emit('request_initial_bookings', { locationId, bayId });

    // If league mode is enabled, join the league room
    if (config.leagueSettings && config.leagueSettings.enabled && config.leagueSettings.leagueId) {
      console.log(`League mode enabled. Joining league room for league: ${config.leagueSettings.leagueId}`);
      socket.emit('register_league', { locationId, leagueId: config.leagueSettings.leagueId });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`WebSocket disconnected: ${reason}`);
  });

  socket.on('connect_error', (error) => {
    console.error(`WebSocket connection error: ${error.message}`);
  });

  // Listener for full data refresh
  socket.on('bookings_updated', (payload) => {
    console.log('Received full bookings refresh:', payload);
    if (payload.bayId === config.bayId) {
      bookings = payload.bookings;
      // Notify all windows of the update
      [mainWindow, ...additionalWindows].forEach(window => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('bookings-updated', bookings);
        }
      });
    }
  });
  
  // Listener for single booking changes
  socket.on('booking_update', (payload) => {
    console.log('Received single booking update:', payload);
    if (payload.bayId === config.bayId) {
      const index = bookings.findIndex(b => b.id === payload.booking.id);

      if (payload.action === 'add') {
        if (index === -1) {
          bookings.push(payload.booking);
        } else {
          bookings[index] = payload.booking; // Update existing
        }
      } else if (payload.action === 'remove') {
        if (index !== -1) {
          bookings.splice(index, 1);
        }
      }
      
      // Notify all windows of the update
      [mainWindow, ...additionalWindows].forEach(window => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('bookings-updated', bookings);
        }
      });
    }
  });

  // --- League Mode: Listen for real-time score and standings updates ---
  socket.on('league_score_update', (payload) => {
    console.log('Received league score update:', payload);
    [mainWindow, ...additionalWindows].forEach(window => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('league-score-update', payload);
      }
    });
  });

  socket.on('league_standings_update', (payload) => {
    console.log('Received league standings update:', payload);
    [mainWindow, ...additionalWindows].forEach(window => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('league-standings-update', payload);
      }
    });
  });

  // Listener for door unlock commands
  socket.on('unlock', async (payload, ack) => {
    console.log('Received unlock command:', payload);
    const respond = (response) => {
        if (typeof ack === 'function') {
            ack(response);
        }
    };
    
    // Verify this unlock command is for our bay
    if (payload.bayId !== config.bayId) {
      const message = `Unlock command is for bay ${payload.bayId}, but we are bay ${config.bayId}. Ignoring.`;
      console.log(message);
      respond({ success: false, error: message });
      return;
    }

    const { duration, bookingId, locationId } = payload;
    const unlockStartTime = Date.now();
    
    try {
      console.log(`Executing door unlock for ${duration} seconds...`);
      
      // Execute the Shelly switch unlock command using JSON-RPC API
      const shellyIP = config.shellyIP;
      const shellyUrl = `http://${shellyIP}/rpc`;
      
      const requestBody = {
        id: 1,
        method: "Switch.Set",
        params: {
          id: 0,
          on: false, // Set to false since we want to unlock (assuming false = unlocked)
          toggle_after: duration
        }
      };
      
      // Using axios for consistent timeout handling as it's already a dependency
      const response = await axios.post(shellyUrl, requestBody);

      const responseTime = Date.now() - unlockStartTime;
      
      if (response.status !== 200 || (response.data && response.data.error)) {
        const errorMessage = response.data.error ? JSON.stringify(response.data.error) : `Shelly API responded with status ${response.status}`;
        throw new Error(errorMessage);
      }

      const result = response.data;
      console.log('Shelly switch response:', result);

      // Log successful unlock
      const logData = {
        location_id: locationId,
        bay_id: config.bayId,
        booking_id: bookingId,
        action: 'door_unlock_success',
        success: true,
        ip_address: shellyIP,
        user_agent: 'Kiosk',
        unlock_method: 'email_link',
        response_time_ms: responseTime,
        metadata: {
          shelly_response: result,
          unlock_duration: duration,
          shelly_url: shellyUrl,
          shelly_request: requestBody
        }
      };

      // Send success log to server (fire and forget is fine for logging)
      axios.post(`${config.apiBaseUrl}/logs/access`, logData)
        .then(() => console.log('Successfully logged unlock success'))
        .catch(logError => console.error('Failed to log unlock success:', logError.message));

      console.log(`Door successfully unlocked for ${duration} seconds`);
      respond({ success: true, message: 'Door unlocked successfully' });

    } catch (error) {
      console.error('Error executing door unlock:', error);
      
      const responseTime = Date.now() - unlockStartTime;
      
      // Log failed unlock attempt
      const logData = {
        location_id: locationId,
        bay_id: config.bayId,
        booking_id: bookingId,
        action: 'door_unlock_failure',
        success: false,
        error_message: error.message,
        ip_address: config.shellyIP,
        user_agent: 'Kiosk',
        unlock_method: 'email_link',
        response_time_ms: responseTime,
        metadata: {
          error_details: error.toString(),
          unlock_duration: duration,
          attempted_url: `http://${config.shellyIP}/rpc`,
          attempted_request: {
            id: 1,
            method: "Switch.Set",
            params: {
              id: 0,
              on: false,
              toggle_after: duration
            }
          }
        }
      };

      // Send failure log to server (fire and forget is fine for logging)
      axios.post(`${config.apiBaseUrl}/logs/access`, logData)
        .then(() => console.log('Successfully logged unlock failure'))
        .catch(logError => console.error('Failed to log unlock failure:', logError.message));
        
      respond({ success: false, error: error.message });
    }
  });
}

// Set up a fallback polling mechanism
function setupPolling() {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    pollingInterval = setInterval(() => {
        if (socket && socket.connected) {
            console.log('Polling for full booking refresh...');
            socket.emit('request_initial_bookings', { 
                locationId: config.locationId, 
                bayId: config.bayId 
            });
        }
    }, SIX_HOURS);
}

app.on('ready', () => {
  loadConfig();
  createWindows();
  
  // Register the global shortcut here
  globalShortcut.register('PageUp+PageDown', () => {
    console.log('Global shortcut PageUp+PageDown pressed');
    openAdminMode();
  });

  connectToWebSocket();
  setupPolling();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindows();
  }
});

app.on('will-quit', () => {
  // Unregister all shortcuts when the app is about to quit.
  globalShortcut.unregisterAll();
});

// IPC handler for renderer to request config
ipcMain.handle('get-config', () => {
    return config;
});

// IPC handler for renderer to get the initial list of bookings
ipcMain.handle('get-initial-bookings', () => {
    return bookings;
});

// Admin mode IPC handlers
ipcMain.handle('admin-restart-app', () => {
    // Force close all windows before restarting
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
    }
    additionalWindows.forEach(window => {
        if (!window.isDestroyed()) {
            window.destroy();
        }
    });
    app.relaunch();
    app.exit(0);
});

ipcMain.handle('admin-close-app', () => {
    // Force close all windows before quitting
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
    }
    additionalWindows.forEach(window => {
        if (!window.isDestroyed()) {
            window.destroy();
        }
    });
    app.quit();
});

ipcMain.handle('admin-disconnect-monitors', () => {
    closeAdditionalWindows();
    return { success: true, message: 'Additional monitors disconnected' };
});

ipcMain.handle('admin-reconnect-monitors', () => {
    recreateAdditionalWindows();
    return { success: true, message: 'Additional monitors reconnected' };
});

ipcMain.handle('admin-reconnect-websocket', () => {
    if (socket) {
        socket.disconnect();
    }
    connectToWebSocket();
    return { success: true, message: 'WebSocket reconnection initiated' };
});

ipcMain.handle('admin-get-config', () => {
    try {
        const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
        const fullConfig = JSON.parse(configData);
        
        // Remove adminPassword from the response - we don't want to show it in the UI
        const { adminPassword, ...configForUI } = fullConfig;
        
        return { 
            success: true, 
            config: configForUI,
            configPath: CONFIG_PATH
        };
    } catch (error) {
        console.error('Failed to read config file:', error);
        return { 
            success: false, 
            error: error.message,
            configPath: CONFIG_PATH
        };
    }
});

ipcMain.handle('admin-validate-password', (event, password) => {
    try {
        if (!config || !config.adminPassword) {
            return { success: false, error: 'Admin password not configured' };
        }
        
        const isValid = password === config.adminPassword;
        return { 
            success: isValid, 
            error: isValid ? null : 'Invalid password'
        };
    } catch (error) {
        console.error('Error validating admin password:', error);
        return { 
            success: false, 
            error: 'Password validation failed'
        };
    }
});

ipcMain.handle('admin-get-logs', () => {
    return logBuffer;
});

ipcMain.handle('admin-clear-logs', () => {
    logBuffer.length = 0;
    return { success: true };
});

ipcMain.handle('admin-get-bookings', () => {
    return bookings;
});

ipcMain.handle('admin-get-version', () => {
    try {
        const packagePath = path.join(__dirname, 'package.json');
        const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        return {
            version: packageData.version,
            name: packageData.productName || packageData.name,
            description: packageData.description
        };
    } catch (error) {
        console.error('Failed to read package.json:', error);
        return { version: 'Unknown', name: 'Golf Labs Kiosk', description: '' };
    }
});

ipcMain.handle('admin-clear-cache', () => {
    console.log('Clearing bookings cache and requesting fresh sync...');
    bookings = [];
    
    // Request fresh bookings from server
    if (socket && socket.connected) {
        socket.emit('request_initial_bookings', { 
            locationId: config.locationId, 
            bayId: config.bayId 
        });
        return { success: true, message: 'Cache cleared and sync requested' };
    } else {
        return { success: true, message: 'Cache cleared. WebSocket not connected - sync will happen on reconnect' };
    }
});

ipcMain.handle('admin-manual-unlock', async (event, durationMinutes) => {
    console.log(`Admin timed screen unlock requested for ${durationMinutes} minutes`);

    try {
        // Set the manual unlock state to true
        isManuallyUnlocked = true;
        
        // Calculate and store the end time
        const durationMs = durationMinutes * 60 * 1000;
        manualUnlockEndTime = new Date(Date.now() + durationMs);
        
        // Notify all windows of the change with end time
        [mainWindow, ...additionalWindows].forEach(window => {
            if (window && !window.isDestroyed()) {
                window.webContents.send('manual-unlock-state-changed', isManuallyUnlocked, manualUnlockEndTime.toISOString());
            }
        });

        // Set a timer to re-lock the screen after the duration
        setTimeout(() => {
            isManuallyUnlocked = false;
            manualUnlockEndTime = null;
            console.log(`Timed screen unlock expired after ${durationMinutes} minutes`);
            
            // Notify all windows of the change
            [mainWindow, ...additionalWindows].forEach(window => {
                if (window && !window.isDestroyed()) {
                    window.webContents.send('manual-unlock-state-changed', isManuallyUnlocked, null);
                }
            });
        }, durationMs);

        console.log(`Screen unlocked via admin panel for ${durationMinutes} minutes`);
        return { success: true, message: `Screen unlocked for ${durationMinutes} minutes` };
    } catch (error) {
        console.error('Admin timed screen unlock failed:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('admin-change-password', (event, { currentPassword, newPassword }) => {
    try {
        if (!config || !config.adminPassword) {
            return { success: false, error: 'Admin password not configured' };
        }

        // Verify current password
        if (currentPassword !== config.adminPassword) {
            return { success: false, error: 'Current password is incorrect' };
        }

        // Validate new password
        if (!newPassword || newPassword.length < 4) {
            return { success: false, error: 'New password must be at least 4 characters' };
        }

        // Read current config
        const currentConfigData = fs.readFileSync(CONFIG_PATH, 'utf8');
        const currentConfigFromFile = JSON.parse(currentConfigData);

        // Update password
        currentConfigFromFile.adminPassword = newPassword;

        // Create backup
        const backupPath = CONFIG_PATH + '.backup';
        fs.copyFileSync(CONFIG_PATH, backupPath);

        // Write updated config
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfigFromFile, null, 4));

        // Update in-memory config
        config.adminPassword = newPassword;

        console.log('Admin password changed successfully');
        return { success: true, message: 'Password changed successfully' };
    } catch (error) {
        console.error('Failed to change admin password:', error);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('admin-save-config', (event, newConfig) => {
    try {
        // Validate required fields (excluding adminPassword which is not editable)
        const requiredFields = ['bayId', 'locationId', 'apiBaseUrl', 'shellyIP'];
        for (const field of requiredFields) {
            if (!newConfig[field] || typeof newConfig[field] !== 'string' || newConfig[field].trim() === '') {
                throw new Error(`Required field '${field}' is missing or empty`);
            }
        }

        // Validate URL format for apiBaseUrl
        try {
            new URL(newConfig.apiBaseUrl);
        } catch {
            throw new Error('apiBaseUrl must be a valid URL');
        }

        // Validate IP format for shellyIP (basic check)
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (!ipRegex.test(newConfig.shellyIP.trim())) {
            throw new Error('shellyIP must be a valid IP address');
        }

        // Read current config to preserve adminPassword
        const currentConfigData = fs.readFileSync(CONFIG_PATH, 'utf8');
        const currentConfig = JSON.parse(currentConfigData);
        
        // Merge new config with existing adminPassword
        const finalConfig = {
            ...newConfig,
            adminPassword: currentConfig.adminPassword // Preserve existing password
        };

        // Create backup of current config
        const backupPath = CONFIG_PATH + '.backup';
        fs.copyFileSync(CONFIG_PATH, backupPath);

        // Write new config
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(finalConfig, null, 4));

        // Update the in-memory config
        config = finalConfig;

        console.log('Config file updated successfully');
        return { 
            success: true, 
            message: 'Configuration saved successfully. Restart the application for all changes to take effect.',
            requiresRestart: true
        };
    } catch (error) {
        console.error('Failed to save config file:', error);
        return { 
            success: false, 
            error: error.message 
        };
    }
});

// This handler now reloads the main kiosk view instead of closing a window.
ipcMain.handle('admin-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('Exiting admin mode, reloading kiosk screen.');
        mainWindow.loadFile('index.html');
    }
    return { success: true };
});

ipcMain.handle('admin-get-manual-unlock-state', () => {
    return {
        unlocked: isManuallyUnlocked,
        endTime: manualUnlockEndTime ? manualUnlockEndTime.toISOString() : null
    };
});

ipcMain.handle('admin-set-manual-unlock-state', (event, newState) => {
    isManuallyUnlocked = newState;
    // When toggling manually (not timed), clear any timed unlock
    if (!newState) {
        manualUnlockEndTime = null;
    }
    console.log(`Manual unlock state set to: ${isManuallyUnlocked}`);

    // Notify all windows of the change
    [mainWindow, ...additionalWindows].forEach(window => {
        if (window && !window.isDestroyed()) {
            window.webContents.send('manual-unlock-state-changed', isManuallyUnlocked, manualUnlockEndTime ? manualUnlockEndTime.toISOString() : null);
        }
    });

    return { success: true };
});

// New handler to control window click-through behavior
ipcMain.handle('set-ignore-mouse-events', (event, ignore) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        win.setIgnoreMouseEvents(ignore, { forward: true });
    }
});

// Handler to bring all kiosk windows to the foreground
// This ensures the lock screen is always visible when activated
ipcMain.handle('bring-to-foreground', () => {
    if (isDev) return; // Only in production mode
    
    const allWindows = [mainWindow, ...additionalWindows];
    
    allWindows.forEach(window => {
        if (window && !window.isDestroyed()) {
            // Restore if minimized
            if (window.isMinimized()) {
                window.restore();
            }
            
            // Ensure fullscreen and always on top
            window.setFullScreen(true);
            window.setAlwaysOnTop(true, 'screen-saver');
            
            // Bring to front and focus
            window.show();
            window.focus();
            window.moveTop();
        }
    });
    
    console.log('All kiosk windows brought to foreground');
});

ipcMain.handle('get-display-info', () => {
    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    return {
        displays: displays.map(d => ({
            id: d.id,
            bounds: d.bounds,
            isPrimary: d.id === primaryDisplay.id
        })),
        additionalWindowsCount: additionalWindows.length
    };
});

ipcMain.handle('send-heartbeat', async (event, bayId) => {
    if (!config) {
        console.error('Heartbeat failed: Kiosk config not loaded.');
        throw new Error('Kiosk config not loaded');
    }
    const url = `${config.apiBaseUrl}/bays/${bayId}/heartbeat`;
    console.log(`Sending heartbeat to: ${url}`);
    
    try {
        const response = await axios.post(url, {});
        console.log('Heartbeat response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error sending heartbeat:', error.message);
        if (error.response) {
            console.error('Heartbeat error details:', error.response.data);
            throw new Error(error.response.data.message || error.message);
        }
        throw error;
    }
});

ipcMain.handle('log-access', async (event, logData) => {
    if (!config) {
        console.error('Access log failed: Kiosk config not loaded.');
        throw new Error('Kiosk config not loaded');
    }
    const url = `${config.apiBaseUrl}/logs/access`;
    console.log(`Logging access event to: ${url}`);
    
    try {
        const response = await axios.post(url, logData);
        console.log('Access log response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error sending access log:', error.message);
        if (error.response) {
            console.error('Access log error details:', error.response.data);
            throw new Error(error.response.data.message || error.message);
        }
        throw error;
    }
});

// --- Session Extension IPC Handlers ---

ipcMain.handle('get-extension-options', async (event, bookingId) => {
    if (!config) {
        throw new Error('Kiosk config not loaded');
    }
    const url = `${config.apiBaseUrl}/bookings/${bookingId}/extension-options`;
    console.log(`Fetching extension options from: ${url}`);

    try {
        const response = await axios.get(url);
        console.log('Extension options response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error fetching extension options:', error.message);
        if (error.response) {
            console.error('Extension options error details:', error.response.data);
            throw new Error(error.response.data.error || error.message);
        }
        throw error;
    }
});

ipcMain.handle('extend-booking', async (event, bookingId, extensionMinutes) => {
    if (!config) {
        throw new Error('Kiosk config not loaded');
    }
    const url = `${config.apiBaseUrl}/bookings/${bookingId}/extend`;
    console.log(`Extending booking at: ${url} for ${extensionMinutes} minutes`);

    try {
        const response = await axios.post(url, {
            extensionMinutes,
            locationId: config.locationId,
            bayId: config.bayId
        });
        console.log('Extend booking response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error extending booking:', error.message);
        if (error.response) {
            console.error('Extend booking error details:', error.response.data);
            throw new Error(error.response.data.error || error.message);
        }
        throw error;
    }
});

// --- Extension State Broadcast (sync across all screens) ---
ipcMain.on('extension-state-broadcast', (event, stateData) => {
    console.log('Broadcasting extension state to all windows:', stateData.state);
    const allWindows = [mainWindow, ...additionalWindows];
    allWindows.forEach(window => {
        if (window && !window.isDestroyed()) {
            window.webContents.send('extension-state-update', stateData);
        }
    });
});

// --- League Mode IPC Handlers ---

ipcMain.handle('get-league-settings', () => {
    return config ? config.leagueSettings : { enabled: false, leagueId: '' };
});

ipcMain.handle('get-league-state', async (event, userId) => {
    if (!config || !config.leagueSettings || !config.leagueSettings.enabled) {
        return null;
    }
    const { leagueId } = config.leagueSettings;
    if (!leagueId || !userId) return null;

    try {
        const url = `${config.apiBaseUrl}/leagues/${leagueId}/kiosk-state?userId=${userId}`;
        console.log(`Fetching league state for userId ${userId} from: ${url}`);
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('Error fetching league state:', error.message);
        if (error.response) {
            console.error('League state error details:', error.response.data);
        }
        return null;
    }
});

ipcMain.handle('submit-league-score', async (event, leagueId, scoreData) => {
    if (!config) {
        throw new Error('Kiosk config not loaded');
    }
    const url = `${config.apiBaseUrl}/leagues/${leagueId}/scores`;
    console.log(`Submitting league score to: ${url}`, scoreData);

    try {
        const response = await axios.post(url, scoreData);
        console.log('League score response:', response.data);
        return response.data;
    } catch (error) {
        console.error('Error submitting league score:', error.message);
        if (error.response) {
            console.error('League score error details:', error.response.data);
            throw new Error(error.response.data.error || error.message);
        }
        throw error;
    }
});

ipcMain.handle('get-league-leaderboard', async (event, leagueId) => {
    if (!config) {
        throw new Error('Kiosk config not loaded');
    }
    const url = `${config.apiBaseUrl}/leagues/${leagueId}/leaderboard`;
    console.log(`Fetching league leaderboard from: ${url}`);

    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        console.error('Error fetching league leaderboard:', error.message);
        if (error.response) {
            throw new Error(error.response.data.error || error.message);
        }
        throw error;
    }
});

// --- NEW: Global error handling for packaged app ---
process.on('uncaughtException', (error) => {
  console.error('An uncaught exception occurred:', error);
  dialog.showErrorBox(
    'Application Error',
    `An unexpected error occurred. Please restart the application.\n\nDetails: ${error.stack || error.message}`
  );
  app.quit();
});
// --- END NEW --- 