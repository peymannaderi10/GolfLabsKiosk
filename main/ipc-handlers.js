const { ipcMain, BrowserWindow, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const { closeAdditionalWindows, recreateAdditionalWindows } = require('./windows');
const { onSessionEnd } = require('./app-manager');
const { queryStatus } = require('./projector');
const { KIOSK_API_KEY } = require('./constants');
const { updateAdminPassword } = require('./installation');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  // Support legacy plaintext passwords (no colon = not hashed)
  if (!stored.includes(':')) {
    return password === stored;
  }
  const [salt, hash] = stored.split(':');
  const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === testHash;
}

function createApiClient(ctx) {
  return axios.create({
    headers: { 'X-Kiosk-Key': KIOSK_API_KEY },
  });
}

function registerIpcHandlers(ctx) {
  const { CONFIG_PATH } = require('./config');
  const api = createApiClient(ctx);

  // IPC handler for renderer to request config
  ipcMain.handle('get-config', () => {
      const { adminPassword, ...safeConfig } = ctx.config;
      return safeConfig;
  });

  // Returns true if this window should show league UI (additional display, or main if single-monitor)
  ipcMain.handle('is-league-display', (event) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow) return false;
      if (ctx.additionalWindows.length === 0) return true; // single monitor — main shows league
      return ctx.additionalWindows.some(w => w && !w.isDestroyed() && w.id === senderWindow.id);
  });

  // IPC handler for renderer to get the initial list of bookings
  ipcMain.handle('get-initial-bookings', () => {
      return ctx.bookings;
  });

  // Session lifecycle — renderer notifies when a booking session ends
  ipcMain.handle('session-ended', () => {
    console.log('Session ended — triggering app cleanup');
    onSessionEnd(ctx);
    return { success: true };
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
      const { connectToWebSocket, setupPolling } = require('./websocket');
      // connectToWebSocket now calls disconnectWebSocket internally,
      // which properly tears down the old socket (removes listeners,
      // disables background reconnection, disconnects, and nulls ref)
      connectToWebSocket(ctx);
      // Restore polling in case it was cleared (e.g., window close handler)
      setupPolling(ctx);
      return { success: true, message: 'WebSocket reconnection initiated' };
  });

  ipcMain.handle('admin-get-config', () => {
    const { adminPassword, ...safeConfig } = ctx.config || {};
    return { success: true, config: safeConfig, configPath: CONFIG_PATH };
  });

  ipcMain.handle('admin-validate-password', (event, password) => {
      try {
          if (!ctx.config || !ctx.config.adminPassword) {
              return { success: false, error: 'Admin password not configured' };
          }
          
          const isValid = verifyPassword(password, ctx.config.adminPassword);
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
              spaceId: ctx.config.spaceId
          });
          return { success: true, message: 'Cache cleared and sync requested' };
      } else {
          return { success: true, message: 'Cache cleared. WebSocket not connected - sync will happen on reconnect' };
      }
  });

  ipcMain.handle('admin-manual-unlock', async (event, durationMinutes) => {
      console.log(`Admin timed screen unlock requested for ${durationMinutes} minutes`);

      const duration = Number(durationMinutes);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 1440) {
          return { success: false, error: 'Invalid duration. Must be between 1 and 1440 minutes.' };
      }

      try {
          if (ctx.manualUnlockTimer) {
              clearTimeout(ctx.manualUnlockTimer);
              ctx.manualUnlockTimer = null;
          }

          ctx.isManuallyUnlocked = true;

          const durationMs = duration * 60 * 1000;
          ctx.manualUnlockEndTime = new Date(Date.now() + durationMs);

          [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
              if (window && !window.isDestroyed()) {
                  window.webContents.send('manual-unlock-state-changed', ctx.isManuallyUnlocked, ctx.manualUnlockEndTime.toISOString());
              }
          });

          ctx.manualUnlockTimer = setTimeout(() => {
              ctx.isManuallyUnlocked = false;
              ctx.manualUnlockEndTime = null;
              ctx.manualUnlockTimer = null;
              console.log(`Timed screen unlock expired after ${duration} minutes`);

              [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
                  if (window && !window.isDestroyed()) {
                      window.webContents.send('manual-unlock-state-changed', ctx.isManuallyUnlocked, null);
                  }
              });
          }, durationMs);

          console.log(`Screen unlocked via admin panel for ${duration} minutes`);
          return { success: true, message: `Screen unlocked for ${duration} minutes` };
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

          if (!verifyPassword(currentPassword, ctx.config.adminPassword)) {
              return { success: false, error: 'Current password is incorrect' };
          }

          if (!newPassword || newPassword.length < 4) {
              return { success: false, error: 'New password must be at least 4 characters' };
          }

          const hashedNewPassword = hashPassword(newPassword);
          updateAdminPassword(hashedNewPassword);
          ctx.config.adminPassword = hashedNewPassword;

          console.log('Admin password changed successfully');
          return { success: true, message: 'Password changed successfully' };
      } catch (error) {
          console.error('Failed to change admin password:', error);
          return { success: false, error: error.message };
      }
  });

  ipcMain.handle('admin-test-projector', () => {
      const sent = queryStatus();
      if (sent) {
          return { success: true, message: 'Status query sent — check logs for projector response' };
      }
      return { success: false, error: 'Serial port not open — check COM port and restart' };
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
          if (ctx.manualUnlockTimer) {
              clearTimeout(ctx.manualUnlockTimer);
              ctx.manualUnlockTimer = null;
          }
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

  ipcMain.handle('send-heartbeat', async (event, spaceId) => {
      if (!ctx.config) {
          console.error('Heartbeat failed: Kiosk config not loaded.');
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/spaces/${spaceId}/heartbeat`;
      console.log(`Sending heartbeat to: ${url}`);
      
      try {
      const response = await api.post(url, {});
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
      const response = await api.post(url, logData);
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
          const response = await api.get(url);
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

  ipcMain.handle('extend-booking', async (event, bookingId, extensionMinutes, useFreeMinutes) => {
      if (!ctx.config) {
          throw new Error('Kiosk config not loaded');
      }
      const url = `${ctx.config.apiBaseUrl}/bookings/${bookingId}/extend`;
      console.log(`Extending booking at: ${url} for ${extensionMinutes} minutes (useFreeMinutes: ${!!useFreeMinutes})`);

      try {
          const response = await api.post(url, {
              extensionMinutes,
              locationId: ctx.config.locationId,
              spaceId: ctx.config.spaceId,
              useFreeMinutes: !!useFreeMinutes,
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
  // Guard: ipcMain.on stacks if called multiple times (unlike ipcMain.handle which throws)
  ipcMain.removeAllListeners('extension-state-broadcast');
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

  ipcMain.handle('get-league-settings', async () => {
      // Check live space state from API first (handles restart after remote activation)
      if (ctx.config && ctx.config.spaceId && ctx.config.apiBaseUrl) {
          try {
              const url = `${ctx.config.apiBaseUrl}/spaces/${ctx.config.spaceId}/heartbeat`;
              const response = await api.post(url, {});
              const space = response.data;
              if (space && space.league_mode_active && space.league_mode_league_id) {
                  // Space has league mode active in DB — fetch league times
                  if (!ctx.config.leagueSettings) ctx.config.leagueSettings = {};
                  ctx.config.leagueSettings.enabled = true;
                  ctx.config.leagueSettings.leagueId = space.league_mode_league_id;

                  let startTime = null;
                  let endTime = null;
                  try {
                      const leagueRes = await api.get(`${ctx.config.apiBaseUrl}/leagues/${space.league_mode_league_id}`);
                      startTime = leagueRes.data?.start_time || null;
                      endTime = leagueRes.data?.end_time || null;
                  } catch (e) { /* fallback to no times */ }

                  return { enabled: true, leagueId: space.league_mode_league_id, startTime, endTime };
              }
          } catch (err) {
              console.warn('Failed to check space league state on startup:', err.message);
          }
      }
      return ctx.config ? (ctx.config.leagueSettings || { enabled: false, leagueId: '' }) : { enabled: false, leagueId: '' };
  });

  ipcMain.handle('get-league-state', async (event, userId) => {
      if (!ctx.config || !ctx.config.leagueSettings || !ctx.config.leagueSettings.enabled) {
          return null;
      }
      const { leagueId } = ctx.config.leagueSettings;
      if (!leagueId || !userId) return null;

      try {
          const url = `${ctx.config.apiBaseUrl}/leagues/${encodeURIComponent(leagueId)}/kiosk-state?userId=${encodeURIComponent(userId)}`;
          console.log(`Fetching league state for userId ${userId} from: ${url}`);
          const response = await api.get(url);
          return response.data;
      } catch (error) {
          console.error('Error fetching league state:', error.message);
          if (error.response) {
              console.error('League state error details:', error.response.data);
          }
          return null;
      }
  });

  // Fetch league metadata (name, current week, course) without requiring a userId.
  // Used by the leaderboard TV display for its header.
  ipcMain.handle('get-league-info', async () => {
      if (!ctx.config || !ctx.config.leagueSettings || !ctx.config.leagueSettings.enabled) {
          return null;
      }
      const { leagueId } = ctx.config.leagueSettings;
      if (!leagueId) return null;

      try {
          const url = `${ctx.config.apiBaseUrl}/leagues/${encodeURIComponent(leagueId)}`;
          console.log(`Fetching league info from: ${url}`);
          const response = await api.get(url);
          return response.data || null;
      } catch (error) {
          console.error('Error fetching league info:', error.message);
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
          const response = await api.post(url, scoreData);
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
          const response = await api.get(url);
          return response.data;
      } catch (error) {
          console.error('Error fetching league leaderboard:', error.message);
          if (error.response) {
              throw new Error(error.response.data.error || error.message);
          }
          throw error;
      }
  });

  ipcMain.handle('get-league-players', async (event, leagueId, query) => {
      if (!ctx.config || !leagueId) return [];
      try {
          const q = query ? encodeURIComponent(query) : '';
          const url = `${ctx.config.apiBaseUrl}/leagues/${leagueId}/players/search${q ? `?q=${q}` : ''}`;
          const response = await api.get(url);
          return response.data;
      } catch (error) {
          console.error('Error fetching league players:', error.message);
          return [];
      }
  });

  ipcMain.handle('get-league-state-by-player-id', async (event, leagueId, playerId) => {
      if (!ctx.config || !leagueId || !playerId) return null;
      try {
          const url = `${ctx.config.apiBaseUrl}/leagues/${encodeURIComponent(leagueId)}/kiosk-state?playerId=${encodeURIComponent(playerId)}`;
          const response = await api.get(url);
          return response.data;
      } catch (error) {
          console.error('Error fetching league state by player ID:', error.message);
          return null;
      }
  });
}

module.exports = { registerIpcHandlers };
