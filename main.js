const { app, globalShortcut, dialog } = require('electron');

const { loadConfig, logBuffer } = require('./main/config');
const { createWindows, openAdminMode } = require('./main/windows');
const { connectToWebSocket, setupPolling } = require('./main/websocket');
const { registerIpcHandlers } = require('./main/ipc-handlers');

const isDev = process.argv.includes('--dev');

// Shared context object passed to all modules
const ctx = {
  config: null,
  mainWindow: null,
  additionalWindows: [],
  socket: null,
  bookings: [],
  pollingInterval: null,
  isManuallyUnlocked: false,
  manualUnlockEndTime: null,
  manualUnlockTimer: null,
  keysPressed: new Set(),
  adminKeyCombo: ['PageUp', 'PageDown'],
  isDev,
  logBuffer,
};

app.on('ready', () => {
  ctx.config = loadConfig();
  if (!ctx.config) return; // loadConfig calls app.quit() on failure

  createWindows(ctx);
  
  globalShortcut.register('PageUp+PageDown', () => {
    console.log('Global shortcut PageUp+PageDown pressed');
    openAdminMode(ctx);
  });

  registerIpcHandlers(ctx);
  connectToWebSocket(ctx);
  setupPolling(ctx);
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (ctx.mainWindow === null) {
    createWindows(ctx);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Global error handling for packaged app
process.on('uncaughtException', (error) => {
  console.error('An uncaught exception occurred:', error);
  dialog.showErrorBox(
    'Application Error',
    `An unexpected error occurred. Please restart the application.\n\nDetails: ${error.stack || error.message}`
  );
  app.quit();
});
