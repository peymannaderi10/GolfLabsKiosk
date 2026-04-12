const { app, globalShortcut, dialog, screen } = require('electron');

const { loadInstallation } = require('./main/installation');
const { runSetup } = require('./main/setup');
const kioskApi = require('./main/kiosk-api');
const { kioskSettingsService } = require('./main/kiosk-settings');
const { logBuffer } = require('./main/config');
const { createWindows, openAdminMode, recreateAdditionalWindows } = require('./main/windows');
const { connectToWebSocket, setupPolling } = require('./main/websocket');
const { registerIpcHandlers } = require('./main/ipc-handlers');
const { initProjector, destroyProjector, reinitProjector } = require('./main/projector');
const { initAppManager } = require('./main/app-manager');
const { initHealth, destroyHealth } = require('./main/health');

const isDev = process.argv.includes('--dev');

// Shared context object passed to all modules. ctx.config carries the
// merged legacy-shaped settings object that every subsystem still
// reads from — the kiosk-settings service rebuilds it in place when
// the server pushes an update.
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
  // True while bootstrap is transitioning between setup window and
  // main windows. Prevents `window-all-closed` from auto-quitting
  // the app during that async gap.
  isBootstrapping: true,
};

async function bootstrap() {
  const pkg = require('./package.json');
  const version = pkg.version || 'unknown';

  // 1. Load the local installation file.
  let installation = loadInstallation();
  if (installation) {
    kioskApi.setInstallationId(installation.installationId);
  }

  // 2. If missing or incomplete, launch the setup wizard. Blocks until
  //    the operator finishes registration or closes the window.
  if (!installation) {
    try {
      installation = await runSetup(version);
      kioskApi.setInstallationId(installation.installationId);
    } catch (err) {
      console.error('Setup aborted:', err.message);
      app.quit();
      return;
    }
  }

  // 3. Fetch server settings. 404 here means the installation has been
  //    cleared from the dashboard — drop back into the setup wizard.
  try {
    await kioskSettingsService.load(installation, ctx);
  } catch (err) {
    if (err.code === 'INSTALLATION_CLEARED') {
      console.warn('Installation cleared from dashboard, re-running setup');
      const { clearInstallation } = require('./main/installation');
      clearInstallation();
      kioskApi.setInstallationId(null);
      try {
        installation = await runSetup(version);
        kioskApi.setInstallationId(installation.installationId);
        await kioskSettingsService.load(installation, ctx);
      } catch (setupErr) {
        console.error('Re-setup failed:', setupErr.message);
        app.quit();
        return;
      }
    } else {
      console.error('Failed to load kiosk settings:', err.message);
      dialog.showErrorBox(
        'Kiosk Startup Error',
        `Could not load settings from the server.\n\n${err.message}\n\nCheck your network connection and restart the kiosk.`
      );
      app.quit();
      return;
    }
  }

  // 4. Boot the kiosk windows + services using the populated ctx.config.
  createWindows(ctx);

  let displayChangeTimeout = null;
  const scheduleRecreateDisplays = () => {
    if (displayChangeTimeout) clearTimeout(displayChangeTimeout);
    displayChangeTimeout = setTimeout(() => {
      displayChangeTimeout = null;
      console.log('Display change detected - recreating projector windows');
      recreateAdditionalWindows(ctx);
    }, 400);
  };
  screen.on('display-added', scheduleRecreateDisplays);
  screen.on('display-removed', scheduleRecreateDisplays);

  globalShortcut.register('PageUp+PageDown', () => {
    console.log('Global shortcut PageUp+PageDown pressed');
    openAdminMode(ctx);
  });

  registerIpcHandlers(ctx);
  connectToWebSocket(ctx);
  setupPolling(ctx);
  initAppManager(ctx);
  initProjector(ctx);
  initHealth(ctx);

  // Main windows are up; safe to allow normal window-all-closed behavior.
  ctx.isBootstrapping = false;

  // 5. React to server-pushed settings changes. The socket handler in
  //    websocket.js delegates the payload to the settings service,
  //    which rebuilds ctx.config and emits granular change events.
  kioskSettingsService.on('projector-changed', () => {
    console.log('[KioskSettings] Projector config changed, reinitializing');
    reinitProjector(ctx);
  });

  kioskSettingsService.on('league-changed', () => {
    console.log('[KioskSettings] League config changed — notifying windows');
    const payload = {
      active: ctx.config.leagueSettings.enabled,
      leagueId: ctx.config.leagueSettings.leagueId,
      spaceId: ctx.config.spaceId,
    };
    [ctx.mainWindow, ...ctx.additionalWindows].forEach((window) => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('league-mode-changed', payload);
      }
    });
    // Re-join the league socket room if enabled.
    if (ctx.socket && ctx.socket.connected && payload.active && payload.leagueId) {
      ctx.socket.emit('register_league', {
        locationId: ctx.config.locationId,
        leagueId: payload.leagueId,
      });
    }
  });
}

app.on('ready', () => {
  bootstrap().catch((err) => {
    console.error('Fatal bootstrap error:', err);
    dialog.showErrorBox('Kiosk Startup Error', err?.message || String(err));
    app.quit();
  });
});

app.on('window-all-closed', function () {
  // During bootstrap we transiently have zero windows (setup window
  // closes before main window opens). Don't auto-quit in that gap —
  // main.js's bootstrap flow will create the main windows shortly.
  if (ctx.isBootstrapping) return;
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (ctx.mainWindow === null) {
    createWindows(ctx);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  destroyProjector();
  destroyHealth();
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
