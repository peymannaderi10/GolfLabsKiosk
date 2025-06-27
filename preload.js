const { contextBridge, ipcRenderer } = require('electron');
 
contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  refreshBookings: () => ipcRenderer.invoke('refresh-bookings'),
  onBookingsUpdated: (callback) => ipcRenderer.on('bookings-updated', (_event, value) => callback(value)),
  sendHeartbeat: (bayId) => ipcRenderer.invoke('send-heartbeat', bayId),
  logAccess: (logData) => ipcRenderer.invoke('log-access', logData),
}); 