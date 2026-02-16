const { BrowserWindow, screen } = require('electron');
const path = require('path');

function createWindows(ctx) {
  const displays = screen.getAllDisplays();
  console.log(`Found ${displays.length} display(s)`);

  const primaryDisplay = screen.getPrimaryDisplay();
  ctx.mainWindow = createWindow(ctx, primaryDisplay, true);

  displays.forEach((display, index) => {
    if (display.id !== primaryDisplay.id) {
      console.log(`Creating window for display ${index + 1}: ${display.bounds.width}x${display.bounds.height}`);
      const window = createWindow(ctx, display, false);
      ctx.additionalWindows.push(window);
    }
  });
}

function createWindow(ctx, display, isPrimary = false) {
  const window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: ctx.isDev ? 1200 : display.bounds.width,
    height: ctx.isDev ? 800 : display.bounds.height,
    fullscreen: !ctx.isDev,
    resizable: ctx.isDev,
    transparent: true,
    frame: ctx.isDev,
    closable: ctx.isDev,
    minimizable: ctx.isDev,
    skipTaskbar: !ctx.isDev,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  window.loadFile('index.html');

  if (!ctx.isDev) {
    window.on('close', (event) => {
      console.log('Window close attempted - preventing in kiosk mode');
      event.preventDefault();
      return false;
    });

    window.on('minimize', () => {
      console.log('Window minimize detected - restoring immediately in kiosk mode');
      setImmediate(() => {
        if (window && !window.isDestroyed()) {
          window.restore();
          window.show();
          window.focus();
          window.setFullScreen(true);
          window.setAlwaysOnTop(true, 'screen-saver');
          window.moveTop();
        }
      });
    });
  }

  window.once('ready-to-show', () => {
    window.show();
    if (!ctx.isDev) {
      window.setFullScreen(true);
      window.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  window.on('closed', () => {
    if (isPrimary) {
      ctx.mainWindow = null;
      if (ctx.socket) ctx.socket.disconnect();
      clearInterval(ctx.pollingInterval);
    }
  });
  
  window.on('focus', () => {
    ctx.keysPressed.clear();
  });

  window.on('blur', () => {
    ctx.keysPressed.clear();
  });
  
  if (ctx.isDev && isPrimary) {
    window.webContents.openDevTools();
  }

  return window;
}

function openAdminMode(ctx) {
  if (!ctx.mainWindow || ctx.mainWindow.isDestroyed() || ctx.mainWindow.webContents.getURL().endsWith('admin.html')) {
    console.log('Cannot open admin mode: Main window not available or already in admin mode.');
    return;
  }
  
  console.log('Switching main window to admin mode...');
  ctx.mainWindow.setIgnoreMouseEvents(false);
  ctx.mainWindow.loadFile('admin.html');
}

function closeAdditionalWindows(ctx) {
  ctx.additionalWindows.forEach(window => {
    if (!window.isDestroyed()) {
      window.close();
    }
  });
  ctx.additionalWindows = [];
  console.log('Closed all additional monitor windows');
}

function recreateAdditionalWindows(ctx) {
  closeAdditionalWindows(ctx);
  
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();

  displays.forEach((display, index) => {
    if (display.id !== primaryDisplay.id) {
      console.log(`Recreating window for display ${index + 1}`);
      const window = createWindow(ctx, display, false);
      ctx.additionalWindows.push(window);
    }
  });
}

module.exports = { createWindows, openAdminMode, closeAdditionalWindows, recreateAdditionalWindows };
