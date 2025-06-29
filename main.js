const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, 'config.json');

let config;
let mainWindow;
let socket;
let bookings = []; // In-memory store for bookings
let pollingInterval;

function loadConfig() {
  try {
    const configData = fs.readFileSync(CONFIG_PATH);
    config = JSON.parse(configData);
  } catch (error) {
    console.error('FATAL: config.json not found or is invalid.', error);
    app.quit();
  }
}

function createWindow () {
  const isDev = !app.isPackaged;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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