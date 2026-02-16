const { app, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const userDataPath = app.getPath('userData');
const CONFIG_PATH = path.join(userDataPath, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(__dirname, '..', 'config.example.json');

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
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('config.json not found. Attempting to create it from example.');
      
      fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
      
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Configuration Needed',
        message: 'A new configuration file has been created for you. Please edit it before restarting the application.',
        detail: `The file is located at: ${CONFIG_PATH}`
      });
      
      app.quit();
      return null;
    }

    const configData = fs.readFileSync(CONFIG_PATH);
    const config = JSON.parse(configData);
    
    if (!config.bayId || !config.locationId || !config.apiBaseUrl || !config.shellyIP) {
        throw new Error('One or more required fields are missing from config.json: bayId, locationId, apiBaseUrl, shellyIP');
    }

    if (!config.adminPassword) {
        config.adminPassword = 'admin123';
        console.log('Admin password not found in config, using default: admin123');
    }

    if (!config.extensionSettings) {
        config.extensionSettings = { enabled: true, triggerMinutes: 5, options: [15, 30, 45, 60] };
        console.log('Extension settings not found in config, using defaults');
    }

    if (!config.leagueSettings) {
        config.leagueSettings = { enabled: false, leagueId: '' };
        console.log('League settings not found in config, using defaults');
    }

    return config;

  } catch (error) {
    console.error('FATAL: config.json is invalid or cannot be accessed.', error);
    dialog.showErrorBox(
      'Fatal Configuration Error',
      `Could not load or create the configuration file. Please check the file at ${CONFIG_PATH}.\n\nError: ${error.message}`
    );
    app.quit();
    return null;
  }
}

module.exports = { loadConfig, logBuffer, CONFIG_PATH };
