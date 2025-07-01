const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
let socket;
let bookings = []; // In-memory store for bookings
let pollingInterval;

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

  } catch (error) {
    console.error('FATAL: config.json is invalid or cannot be accessed.', error);
    dialog.showErrorBox(
      'Fatal Configuration Error',
      `Could not load or create the configuration file. Please check the file at ${CONFIG_PATH}.\n\nError: ${error.message}`
    );
    app.quit();
  }
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: isDev ? 1200 : 1920,
    height: isDev ? 800 : 1080,
    fullscreen: !isDev,
    transparent: true,
    frame: isDev,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (socket) socket.disconnect();
    clearInterval(pollingInterval);
  });
  
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
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
      // Notify renderer of the update
      if (mainWindow) {
        mainWindow.webContents.send('bookings-updated', bookings);
      }
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
      
      // Notify renderer of the update
      if (mainWindow) {
        mainWindow.webContents.send('bookings-updated', bookings);
      }
    }
  });

  // Listener for door unlock commands
  socket.on('unlock', async (payload) => {
    console.log('Received unlock command:', payload);
    
    // Verify this unlock command is for our bay
    if (payload.bayId !== config.bayId) {
      console.log(`Unlock command is for bay ${payload.bayId}, but we are bay ${config.bayId}. Ignoring.`);
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
      
      const response = await fetch(shellyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody),
        timeout: 5000 // 5 second timeout
      });

      const responseTime = Date.now() - unlockStartTime;
      
      if (!response.ok) {
        throw new Error(`Shelly API responded with status ${response.status}: ${response.statusText}`);
      }

      const result = await response.json().catch(() => ({}));
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

      // Send success log to server
      try {
        await axios.post(`${config.apiBaseUrl}/logs/access`, logData);
        console.log('Successfully logged unlock success');
      } catch (logError) {
        console.error('Failed to log unlock success:', logError.message);
      }

      console.log(`Door successfully unlocked for ${duration} seconds`);

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

      // Send failure log to server
      try {
        await axios.post(`${config.apiBaseUrl}/logs/access`, logData);
        console.log('Successfully logged unlock failure');
      } catch (logError) {
        console.error('Failed to log unlock failure:', logError.message);
      }
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
  createWindow();
  connectToWebSocket();
  setupPolling();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handler for renderer to request config
ipcMain.handle('get-config', () => {
    return config;
});

// IPC handler for renderer to get the initial list of bookings
ipcMain.handle('get-initial-bookings', () => {
    return bookings;
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