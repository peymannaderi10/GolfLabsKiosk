const { contextBridge, ipcRenderer } = require('electron');

/**
 * Safe event listener registration that prevents listener accumulation.
 * Removes ALL previous listeners on the channel before adding the new one.
 * This is critical for channels where the renderer page can reload
 * (e.g., index.html → admin.html → back to index.html), which would
 * otherwise stack duplicate listeners on every navigation.
 */
function onSafe(channel, handler) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, handler);
}

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getInitialBookings: () => ipcRenderer.invoke('get-initial-bookings'),
  onBookingsUpdated: (callback) => onSafe('bookings-updated', (_event, value) => callback(value)),
  sendHeartbeat: (spaceId) => ipcRenderer.invoke('send-heartbeat', spaceId),
  logAccess: (logData) => ipcRenderer.invoke('log-access', logData),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.invoke('set-ignore-mouse-events', ignore),
  bringToForeground: () => ipcRenderer.invoke('bring-to-foreground'),

  // Manual Unlock
  getManualUnlockState: () => ipcRenderer.invoke('admin-get-manual-unlock-state'),
  setManualUnlockState: (state) => ipcRenderer.invoke('admin-set-manual-unlock-state', state),
  onManualUnlockStateChanged: (callback) => onSafe('manual-unlock-state-changed', (_event, value, endTime) => callback(value, endTime)),

  // Admin mode APIs
  adminRestartApp: () => ipcRenderer.invoke('admin-restart-app'),
  adminCloseApp: () => ipcRenderer.invoke('admin-close-app'),
  adminDisconnectMonitors: () => ipcRenderer.invoke('admin-disconnect-monitors'),
  adminReconnectMonitors: () => ipcRenderer.invoke('admin-reconnect-monitors'),
  adminReconnectWebsocket: () => ipcRenderer.invoke('admin-reconnect-websocket'),
  adminClose: () => ipcRenderer.invoke('admin-close'),
  getDisplayInfo: () => ipcRenderer.invoke('get-display-info'),
  adminGetConfig: () => ipcRenderer.invoke('admin-get-config'),
  adminSaveConfig: (config) => ipcRenderer.invoke('admin-save-config', config),
  adminValidatePassword: (password) => ipcRenderer.invoke('admin-validate-password', password),
  adminChangePassword: (currentPassword, newPassword) => ipcRenderer.invoke('admin-change-password', { currentPassword, newPassword }),
  adminTestProjector: () => ipcRenderer.invoke('admin-test-projector'),

  // Console log viewer
  getLogs: () => ipcRenderer.invoke('admin-get-logs'),
  clearLogs: () => ipcRenderer.invoke('admin-clear-logs'),

  // Booking info & manual unlock
  getBookings: () => ipcRenderer.invoke('admin-get-bookings'),
  manualUnlock: (durationMinutes) => ipcRenderer.invoke('admin-manual-unlock', durationMinutes),

  // System info
  getVersion: () => ipcRenderer.invoke('admin-get-version'),
  clearCache: () => ipcRenderer.invoke('admin-clear-cache'),

  // Session extension
  getExtensionOptions: (bookingId) => ipcRenderer.invoke('get-extension-options', bookingId),
  extendBooking: (bookingId, minutes, useFreeMinutes) => ipcRenderer.invoke('extend-booking', bookingId, minutes, useFreeMinutes),

  // Extension state sync across screens
  broadcastExtensionState: (stateData) => ipcRenderer.send('extension-state-broadcast', stateData),
  onExtensionStateUpdate: (callback) => onSafe('extension-state-update', (_event, stateData) => callback(stateData)),

  // Session lifecycle
  notifySessionEnd: () => ipcRenderer.invoke('session-ended'),

  // League mode APIs
  isLeagueDisplay: () => ipcRenderer.invoke('is-league-display'),
  getLeagueSettings: () => ipcRenderer.invoke('get-league-settings'),
  getLeagueInfo: () => ipcRenderer.invoke('get-league-info'),
  getLeagueState: (userId) => ipcRenderer.invoke('get-league-state', userId),
  getLeaguePlayers: (leagueId, query) => ipcRenderer.invoke('get-league-players', leagueId, query),
  getLeagueStateByPlayerId: (leagueId, playerId) => ipcRenderer.invoke('get-league-state-by-player-id', leagueId, playerId),
  submitLeagueScore: (leagueId, scoreData) => ipcRenderer.invoke('submit-league-score', leagueId, scoreData),
  getLeagueLeaderboard: (leagueId) => ipcRenderer.invoke('get-league-leaderboard', leagueId),
  onLeagueScoreUpdate: (callback) => onSafe('league-score-update', (_event, payload) => callback(payload)),
  onLeagueStandingsUpdate: (callback) => onSafe('league-standings-update', (_event, payload) => callback(payload)),
  onLeagueModeChanged: (callback) => onSafe('league-mode-changed', (_event, payload) => callback(payload)),
}); 