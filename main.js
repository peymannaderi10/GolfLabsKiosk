const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const BOOKINGS_PATH = path.join(__dirname, 'bookings.json');

let config;
let mainWindow;

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    const configData = fs.readFileSync(CONFIG_PATH);
    config = JSON.parse(configData);
  } else {
    // Handle error: config.json not found
    console.error('FATAL: config.json not found.');
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
  mainWindow.on('closed', () => mainWindow = null);
  
  // Open DevTools for development
  mainWindow.webContents.openDevTools();
}

async function fetchAndStoreBookings() {
  if (!config) return;

  const { locationId, apiBaseUrl, timezone } = config;
  // Determine "today" based on the location's timezone, not the system's.
  // 'en-CA' gives the required YYYY-MM-DD format.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });

  try {
    console.log(`Fetching bookings for location ${locationId} on ${today} (Timezone: ${timezone})`);
    const response = await axios.get(`${apiBaseUrl}/bookings`, {
      params: { locationId, date: today }
    });
    
    console.log('Bookings:', response.data);
    // Filter out past bookings before writing to the file
    // Note: This needs more robust date parsing based on API response
    const bookings = response.data;

    // --- Start Filtering Logic ---
    const now = new Date();

    // This helper function creates a Date object for today (in the system's timezone)
    // with the time from the booking string. It mirrors the logic in renderer.js for consistency.
    const parseTime = (timeString) => {
      const [time, modifier] = timeString.split(' ');
      let [hours, minutes] = time.split(':').map(Number);
      if (modifier.toUpperCase() === 'PM' && hours < 12) hours += 12;
      if (modifier.toUpperCase() === 'AM' && hours === 12) hours = 0;
      
      const date = new Date(); // Uses today's date from system time
      date.setHours(hours, minutes, 0, 0);
      return date;
    };

    const upcomingBookings = bookings.filter(booking => {
      const endTime = parseTime(booking.endTime);
      return endTime > now;
    });
    // --- End Filtering Logic ---

    fs.writeFileSync(BOOKINGS_PATH, JSON.stringify(upcomingBookings, null, 2));
    console.log(`Successfully fetched ${bookings.length} bookings, stored ${upcomingBookings.length} upcoming bookings.`);
    return upcomingBookings;
  } catch (error) {
    console.error('Error fetching bookings:', error.message);
    // On error, try to read from existing local file
    if (fs.existsSync(BOOKINGS_PATH)) {
      const localData = fs.readFileSync(BOOKINGS_PATH);
      return JSON.parse(localData);
    }
    return [];
  }
}

app.on('ready', () => {
  loadConfig();
  createWindow();
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
ipcMain.handle('get-config', async (event) => {
    return config;
});

// IPC handler for renderer to request a manual refresh
ipcMain.handle('refresh-bookings', async (event) => {
    return await fetchAndStoreBookings();
});

ipcMain.handle('send-heartbeat', async (event, bayId) => {
    if (!config) {
        console.error('Heartbeat failed: Kiosk config not loaded.');
        throw new Error('Kiosk config not loaded');
    }
    const url = `${config.apiBaseUrl}/bays/${bayId}/heartbeat`;
    console.log(`Sending heartbeat to: ${url}`);
    
    try {
        const response = await axios.post(url, {}, {
            // Include the IP address in a header if possible, though req.ip on the server is better.
            // The server-side req.ip is generally more reliable.
        });
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