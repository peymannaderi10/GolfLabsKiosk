const { ipcMain, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const { closeAdditionalWindows, recreateAdditionalWindows } = require('./windows');

function registerIpcHandlers(ctx) {
  const { CONFIG_PATH } = require('./config');

  // IPC handler for renderer to request config
  ipcMain.handle('get-config', () => {
      return ctx.config;
  });

  // IPC handler for renderer to get the initial list of bookings
  ipcMain.handle('get-initial-bookings', () => {
      return ctx.bookings;
  });

  // Admin mode IPC handlers
  ipcMain.handle('admin-restart-app', () => {
      const { app } = require('electron');
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.destroy();
      }
      ctx.additionalWindows.forEach(window => {
          if (!window.isDestroyed()) {
              window.destroy();
          }
      });
      app.relaunch();
      app.exit(0);
  });

  ipcMain.handle('admin-close-app', () => {
      const { app } = require('electron');
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          ctx.mainWindow.destroy();
      }
      ctx.additionalWindows.forEach(window => {
          if (!window.isDestroyed()) {
              window.destroy();
          }
      });
      app.quit();
  });

  ipcMain.handle('admin-disconnect-monitors', () => {
      closeAdditionalWindows(ctx);
      return { success: true, message: 'Additional monitors disconnected' };
  });

  ipcMain.handle('admin-reconnect-monitors', () => {
      recreateAdditionalWindows(ctx);
      return { success: true, message: 'Additional monitors reconnected' };
  });

  ipcMain.handle('admin-reconnect-websocket', () => {
      const { connectToWebSocket } = require('./websocket');
      if (ctx.socket) {
          ctx.socket.disconnect();
      }
      connectToWebSocket(ctx);
      return { success: true, message: 'WebSocket reconnection initiated' };
  });

  ipcMain.handle('admin-get-config', () => {
      try {
          const configData = fs.readFileSync(CONFIG_PATH, 'utf8');
          const fullConfig = JSON.parse(configData);
          
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
          if (!ctx.config || !ctx.config.adminPassword) {
              return { success: false, error: 'Admin password not configured' };
          }
          
          const isValid = password === ctx.config.adminPassword;
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
      return ctx.logBuffer;
  });

  ipcMain.handle('admin-clear-logs', () => {
      ctx.logBuffer.length = 0;
      return { success: true };
  });

  ipcMain.handle('admin-get-bookings', () => {
      return ctx.bookings;
  });

  ipcMain.handle('admin-get-version', () => {
      try {
          const packagePath = path.join(__dirname, '..', 'package.json');
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
      ctx.bookings = [];
      
      if (ctx.socket && ctx.socket.connected) {
          ctx.socket.emit('request_initial_bookings', { 
              locationId: ctx.config.locationId, 
              bayId: ctx.config.bayId 
          });
          return { success: true, message: 'Cache cleared and sync requested' };
      } else {
          return { success: true, message: 'Cache cleared. WebSocket not connected - sync will happen on reconnect' };
      }
  });

  ipcMain.handle('admin-manual-unlock', async (event, durationMinutes) => {
      console.log(`Admin timed screen unlock requested for ${durationMinutes} minutes`);

      try {
          ctx.isManuallyUnlocked = true;
          
          const durationMs = durationMinutes * 60 * 1000;
          ctx.manualUnlockEndTime = new Date(Date.now() + durationMs);
          
          [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
              if (window && !window.isDestroyed()) {
                  window.webContents.send('manual-unlock-state-changed', ctx.isManuallyUnlocked, ctx.manualUnlockEndTime.toISOString());
              }
          });

          setTimeout(() => {
              ctx.isManuallyUnlocked = false;
              ctx.manualUnlockEndTime = null;
              console.log(`Timed screen unlock expired after ${durationMinutes} minutes`);
              
              [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
                  if (window && !window.isDestroyed()) {
                      window.webContents.send('manual-unlock-state-changed', ctx.isManuallyUnlocked, null);
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
          if (!ctx.config || !ctx.config.adminPassword) {
              return { success: false, error: 'Admin password not configured' };
          }

          if (currentPassword !== ctx.config.adminPassword) {
              return { success: false, error: 'Current password is incorrect' };
          }

          if (!newPassword || newPassword.length < 4) {
              return { success: false, error: 'New password must be at least 4 characters' };
          }

          const currentConfigData = fs.readFileSync(CONFIG_PATH, 'utf8');
          const currentConfigFromFile = JSON.parse(currentConfigData);

          currentConfigFromFile.adminPassword = newPassword;

          const backupPath = CONFIG_PATH + '.backup';
          fs.copyFileSync(CONFIG_PATH, backupPath);

          fs.writeFileSync(CONFIG_PATH, JSON.stringify(currentConfigFromFile, null, 4));

          ctx.config.adminPassword = newPassword;

          console.log('Admin password changed successfully');
          return { success: true, message: 'Password changed successfully' };
      } catch (error) {
          console.error('Failed to change admin password:', error);
          return { success: false, error: error.message };
      }
  });

  ipcMain.handle('admin-save-config', (event, newConfig) => {
      try {
          const requiredFields = ['bayId', 'locationId', 'apiBaseUrl', 'shellyIP'];
          for (const field of requiredFields) {
              if (!newConfig[field] || typeof newConfig[field] !== 'string' || newConfig[field].trim() === '') {
                  throw new Error(`Required field '${field}' is missing or empty`);
              }
          }

          try {
              new URL(newConfig.apiBaseUrl);
          } catch {
              throw new Error('apiBaseUrl must be a valid URL');
          }

          const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
          if (!ipRegex.test(newConfig.shellyIP.trim())) {
              throw new Error('shellyIP must be a valid IP address');
          }

          const currentConfigData = fs.readFileSync(CONFIG_PATH, 'utf8');
          const currentConfig = JSON.parse(currentConfigData);
          
          const finalConfig = {
              ...newConfig,
              adminPassword: currentConfig.adminPassword
          };

          const backupPath = CONFIG_PATH + '.backup';
          fs.copyFileSync(CONFIG_PATH, backupPath);

          fs.writeFileSync(CONFIG_PATH, JSON.stringify(finalConfig, null, 4));

          ctx.config = finalConfig;

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

  ipcMain.handle('admin-close', () => {
      if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
          console.log('Exiting admin mode, reloading kiosk screen.');
          ctx.mainWindow.loadFile('index.html');
      }
      return { success: true };
  });

  ipcMain.handle('admin-get-manual-unlock-state', () => {
      return {
          unlocked: ctx.isManuallyUnlocked,
          endTime: ctx.manualUnlockEndTime ? ctx.manualUnlockEndTime.toISOString() : null
      };
  });

  ipcMain.handle('admin-set-manual-unlock-state', (event, newState) => {
      ctx.isManuallyUnlocked = newState;
      if (!newState) {
          ctx.manualUnlockEndTime = null;
      }
      console.log(`Manual unlock state set to: ${ctx.isManuallyUnlocked}`);

      [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
          if (window && !window.isDestroyed()) {
              window.webContents.send('manual-unlock-state-changed', ctx.isManuallyUnlocked, ctx.manualUnlockEndTime ? ctx.manualUnlockEndTime.toISOString() : null);
          }
      });

      return { success: true };
  });

  ipcMain.handle('set-ignore-mouse-events', (event, ignore) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
          win.setIgnoreMouseEvents(ignore, { forward: true });
      }
  });

  ipcMain.handle('bring-to-foreground', () => {
      if (ctx.isDev) return;
      
      const allWindows = [ctx.mainWindow, ...ctx.additionalWindows];
      
      allWindows.forEach(window => {
          if (window && !window.isDestroyed()) {
              if (window.isMinimized()) {
                  window.restore();
              }
              
              window.setFullScreen(true);
              window.setAlwaysOnTop(true, 'screen-saver');
              
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
          additionalWindowsCount: ctx.additionalWindows.length
      };
  });

  ipcMain.handle('send-heartbeat', async (event, bayId) => {
      if (!ctx.config) {
          console.error('Heartbeat failed: Kiosk config not loaded.');
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/bays/${bayId}/heartbeat`;
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
      if (!ctx.config) {
          console.error('Access log failed: Kiosk config not loaded.');
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/logs/access`;
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
      if (!ctx.config) {
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/bookings/${bookingId}/extension-options`;
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
      if (!ctx.config) {
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/bookings/${bookingId}/extend`;
      console.log(`Extending booking at: ${url} for ${extensionMinutes} minutes`);

      try {
          const response = await axios.post(url, {
              extensionMinutes,
              locationId: ctx.config.locationId,
              bayId: ctx.config.bayId
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
      const allWindows = [ctx.mainWindow, ...ctx.additionalWindows];
      allWindows.forEach(window => {
          if (window && !window.isDestroyed()) {
              window.webContents.send('extension-state-update', stateData);
          }
      });
  });

  // --- League Mode IPC Handlers ---

  ipcMain.handle('get-league-settings', () => {
      return ctx.config ? ctx.config.leagueSettings : { enabled: false, leagueId: '' };
  });

  ipcMain.handle('get-league-state', async (event, userId) => {
      if (!ctx.config || !ctx.config.leagueSettings || !ctx.config.leagueSettings.enabled) {
          return null;
      }
      const { leagueId } = ctx.config.leagueSettings;
      if (!leagueId || !userId) return null;

      try {
          const url = `${ctx.config.apiBaseUrl}/leagues/${leagueId}/kiosk-state?userId=${userId}`;
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
      if (!ctx.config) {
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/leagues/${leagueId}/scores`;
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
      if (!ctx.config) {
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/leagues/${leagueId}/leaderboard`;
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
}

module.exports = { registerIpcHandlers };
