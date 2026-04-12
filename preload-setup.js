const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script scoped to the setup wizard window only.
 *
 * Exposes ONLY the `kioskSetup` bridge — the main kiosk runtime
 * preload (preload.js) must not expose these APIs, so that a
 * compromised renderer in the main kiosk window cannot invoke
 * setup-* IPC handlers (which are themselves removed after setup
 * completes, but defense-in-depth keeps them unreachable at the
 * preload layer too).
 */
contextBridge.exposeInMainWorld('kioskSetup', {
  listSpaces: (locationId) => ipcRenderer.invoke('setup-list-spaces', locationId),
  register: (payload) => ipcRenderer.invoke('setup-register', payload),
});
