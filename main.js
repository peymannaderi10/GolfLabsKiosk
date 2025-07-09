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

// Admin mode key tracking
let keysPressed = new Set();
let adminKeyCombo = ['PageUp', 'PageDown'];

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
    transparent: true,
    frame: isDev,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  window.loadFile('index.html');
  
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
    app.relaunch();
    app.exit(0);
});

ipcMain.handle('admin-close-app', () => {
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
    return isManuallyUnlocked;
});

ipcMain.handle('admin-set-manual-unlock-state', (event, newState) => {
    isManuallyUnlocked = newState;
    console.log(`Manual unlock state set to: ${isManuallyUnlocked}`);

    // Notify all windows of the change
    [mainWindow, ...additionalWindows].forEach(window => {
        if (window && !window.isDestroyed()) {
            window.webContents.send('manual-unlock-state-changed', isManuallyUnlocked);
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