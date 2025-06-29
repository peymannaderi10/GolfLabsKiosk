const { contextBridge, ipcRenderer } = require('electron');
 
contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getInitialBookings: () => ipcRenderer.invoke('get-initial-bookings'),
  onBookingsUpdated: (callback) => ipcRenderer.on('bookings-updated', (_event, value) => callback(value)),
  sendHeartbeat: (bayId) => ipcRenderer.invoke('send-heartbeat', bayId),
  logAccess: (logData) => ipcRenderer.invoke('log-access', logData),
}); 