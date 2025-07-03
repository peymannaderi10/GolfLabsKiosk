const { contextBridge, ipcRenderer } = require('electron');
 
contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getInitialBookings: () => ipcRenderer.invoke('get-initial-bookings'),
  onBookingsUpdated: (callback) => ipcRenderer.on('bookings-updated', (_event, value) => callback(value)),
  sendHeartbeat: (bayId) => ipcRenderer.invoke('send-heartbeat', bayId),
  logAccess: (logData) => ipcRenderer.invoke('log-access', logData),
  
  // Manual Unlock
  getManualUnlockState: () => ipcRenderer.invoke('admin-get-manual-unlock-state'),
  setManualUnlockState: (state) => ipcRenderer.invoke('admin-set-manual-unlock-state', state),
  onManualUnlockStateChanged: (callback) => ipcRenderer.on('manual-unlock-state-changed', (_event, value) => callback(value)),
  
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
}); 