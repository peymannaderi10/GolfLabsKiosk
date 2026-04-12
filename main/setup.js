const { BrowserWindow, ipcMain, screen, app } = require('electron');
const path = require('path');
const kioskApi = require('./kiosk-api');
const {
  saveInstallation,
  generateInstallationId,
} = require('./installation');

/**
 * Setup window controller. Runs before the main kiosk UI when
 * config.json is missing or incomplete. Hosts a two-step flow:
 *
 *   1. Operator enters their Location ID.
 *   2. Operator picks an unclaimed space from a branded list.
 *
 * On successful registration, the installation file is written and
 * the window closes. Main boots the regular kiosk UI from there.
 */

let setupWindow = null;
let resolveSetup = null;

function createSetupWindow() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;
  setupWindow = new BrowserWindow({
    width: Math.min(900, Math.round(width * 0.8)),
    height: Math.min(700, Math.round(height * 0.85)),
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreen: false,
    center: true,
    title: 'Kiosk Setup',
    // Intentionally no `icon` here — the taskbar uses the default
    // Electron icon until we have a neutral kiosk-setup icon asset.
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload-setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, '..', 'setup.html'));
  setupWindow.on('closed', () => {
    setupWindow = null;
    // If the window is closed without a successful registration,
    // quit the app — the kiosk has no valid installation.
    if (resolveSetup) {
      const reject = resolveSetup;
      resolveSetup = null;
      reject(new Error('Setup aborted by user'));
    }
  });
  return setupWindow;
}

/**
 * Open the setup window and return a promise that resolves with the
 * freshly-written installation once the operator completes the flow.
 * Rejects if the window is closed before registration succeeds.
 */
function runSetup(version) {
  return new Promise((resolve, reject) => {
    resolveSetup = reject; // overwritten on success below
    registerSetupIpc(version, (installation) => {
      resolveSetup = null;
      if (setupWindow && !setupWindow.isDestroyed()) {
        setupWindow.close();
      }
      resolve(installation);
    });
    createSetupWindow();
  });
}

/**
 * IPC handlers scoped to the setup window's lifetime. Removed
 * after the setup completes so they don't leak into the main kiosk
 * runtime.
 */
function registerSetupIpc(version, onSuccess) {
  ipcMain.handle('setup-list-spaces', async (event, locationId) => {
    try {
      const result = await kioskApi.listUnclaimedSpaces(locationId);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('setup-register', async (event, { locationId, spaceId }) => {
    try {
      const installationId = generateInstallationId();
      await kioskApi.registerKiosk({
        installationId,
        spaceId,
        locationId,
        version,
      });
      const installation = saveInstallation({
        installationId,
        locationId,
        spaceId,
      });
      ipcMain.removeHandler('setup-list-spaces');
      ipcMain.removeHandler('setup-register');
      onSuccess(installation);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { runSetup };
