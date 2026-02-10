const { contextBridge, ipcRenderer } = require('electron');
 
contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getInitialBookings: () => ipcRenderer.invoke('get-initial-bookings'),
  onBookingsUpdated: (callback) => ipcRenderer.on('bookings-updated', (_event, value) => callback(value)),
  sendHeartbeat: (bayId) => ipcRenderer.invoke('send-heartbeat', bayId),
  logAccess: (logData) => ipcRenderer.invoke('log-access', logData),
  setIgnoreMouseEvents: (ignore) => ipcRenderer.invoke('set-ignore-mouse-events', ignore),
  bringToForeground: () => ipcRenderer.invoke('bring-to-foreground'),
  
  // Manual Unlock
  getManualUnlockState: () => ipcRenderer.invoke('admin-get-manual-unlock-state'),
  setManualUnlockState: (state) => ipcRenderer.invoke('admin-set-manual-unlock-state', state),
  onManualUnlockStateChanged: (callback) => ipcRenderer.on('manual-unlock-state-changed', (_event, value, endTime) => callback(value, endTime)),
  
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
  extendBooking: (bookingId, minutes) => ipcRenderer.invoke('extend-booking', bookingId, minutes),
  
  // Extension state sync across screens
  broadcastExtensionState: (stateData) => ipcRenderer.send('extension-state-broadcast', stateData),
  onExtensionStateUpdate: (callback) => ipcRenderer.on('extension-state-update', (_event, stateData) => callback(stateData)),
}); 