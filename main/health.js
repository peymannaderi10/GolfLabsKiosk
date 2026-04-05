/**
 * Health Monitor
 *
 * Two safety nets to prevent the kiosk from degrading over extended uptime:
 *
 * 1. Memory monitoring — logs total app memory (main + all renderer processes)
 *    every 5 minutes via app.getAppMetrics(). Warns at threshold, auto-restarts
 *    at critical threshold when idle.
 *
 * 2. Scheduled daily restart — restarts the app at a configurable time
 *    (default 4:00 AM) when no booking is active. If a booking IS active at
 *    the scheduled time, it waits and checks every minute until idle.
 */

const fs = require('fs');
const path = require('path');

const MEMORY_CHECK_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
const MEMORY_WARNING_MB = 512;
const MEMORY_CRITICAL_MB = 1024;
const DAILY_CHECK_INTERVAL_MS = 60 * 1000; // Check every minute for restart window

let memoryCheckInterval = null;
let dailyRestartInterval = null;
let restartPending = false;
let memoryWarningLogged = false;

/**
 * Check if there's an active booking right now.
 */
function hasActiveBooking(ctx) {
  if (!ctx.bookings || ctx.bookings.length === 0) return false;

  const now = new Date();
  return ctx.bookings.some(b => {
    if (b.status !== 'confirmed') return false;
    if (b.spaceId !== ctx.config.spaceId) return false;

    const start = b.startTimeISO ? new Date(b.startTimeISO) : parseTime(b.startTime);
    const end = b.endTimeISO ? new Date(b.endTimeISO) : parseTime(b.endTime);
    return now >= start && now < end;
  });
}

function parseTime(timeString) {
  if (!timeString) return new Date(0);
  const [time, modifier] = timeString.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (modifier === 'PM' && hours < 12) hours += 12;
  if (modifier === 'AM' && hours === 12) hours = 0;
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}

/**
 * Get total memory usage across all Electron processes (main + renderers + GPU).
 * Uses app.getAppMetrics() which reports workingSetSize for every child process.
 */
function getTotalMemoryMB() {
  const { app } = require('electron');
  const metrics = app.getAppMetrics();
  // workingSetSize is in KB
  const totalKB = metrics.reduce((sum, m) => sum + (m.memory ? m.memory.workingSetSize : 0), 0);
  return Math.round(totalKB / 1024);
}

/**
 * Return the path to the last-restart date file in userData.
 */
function getLastRestartFilePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'last-restart.txt');
}

/**
 * Return today's date as a YYYY-MM-DD string.
 */
function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Restart the Electron app cleanly.
 */
function performRestart(ctx, reason) {
  const { app } = require('electron');
  console.log(`[Health] Restarting app: ${reason}`);

  // Persist today's date so the relaunched process skips the restart check
  try {
    fs.writeFileSync(getLastRestartFilePath(), todayDateString(), 'utf8');
  } catch (err) {
    console.error(`[Health] Failed to write last-restart file: ${err.message}`);
  }

  // Destroy all windows
  if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
    ctx.mainWindow.destroy();
  }
  ctx.additionalWindows.forEach(w => {
    if (w && !w.isDestroyed()) w.destroy();
  });

  app.relaunch();
  app.exit(0);
}

/**
 * Start memory monitoring.
 * Uses app.getAppMetrics() to capture memory across ALL processes
 * (main, renderers, GPU helper) — not just main process RSS.
 */
function startMemoryMonitor(ctx) {
  if (memoryCheckInterval) {
    clearInterval(memoryCheckInterval);
  }

  console.log(`[Health] Memory monitor started (warn: ${MEMORY_WARNING_MB}MB, critical: ${MEMORY_CRITICAL_MB}MB)`);

  memoryCheckInterval = setInterval(() => {
    const totalMB = getTotalMemoryMB();
    const mainRssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

    if (totalMB >= MEMORY_CRITICAL_MB) {
      console.error(`[Health] CRITICAL memory: ${totalMB}MB total (main: ${mainRssMB}MB)`);
      if (!hasActiveBooking(ctx) && !ctx.isManuallyUnlocked) {
        performRestart(ctx, `Critical memory usage: ${totalMB}MB total`);
        return;
      }
      console.warn(`[Health] Active booking in progress — deferring restart`);
    } else if (totalMB >= MEMORY_WARNING_MB) {
      if (!memoryWarningLogged) {
        console.warn(`[Health] High memory: ${totalMB}MB total (main: ${mainRssMB}MB)`);
        memoryWarningLogged = true;
      }
    } else {
      if (memoryWarningLogged) {
        console.log(`[Health] Memory recovered: ${totalMB}MB`);
        memoryWarningLogged = false;
      }
      console.log(`[Health] Memory: ${totalMB}MB total (main: ${mainRssMB}MB)`);
    }
  }, MEMORY_CHECK_INTERVAL_MS);
}

/**
 * Start the daily scheduled restart.
 * Checks every minute if it's time to restart.
 */
function startDailyRestart(ctx) {
  if (dailyRestartInterval) {
    clearInterval(dailyRestartInterval);
  }

  const restartHour = (ctx.config.healthSettings && ctx.config.healthSettings.dailyRestartHour) || 4;
  console.log(`[Health] Daily restart scheduled for ${restartHour}:00 (when idle)`);

  // Guard against restart loop: if we already restarted today, skip until tomorrow.
  let lastRestartDate = null;
  try {
    lastRestartDate = fs.readFileSync(getLastRestartFilePath(), 'utf8').trim();
  } catch (_) {
    // File absent on first run — that is expected.
  }
  if (lastRestartDate === todayDateString()) {
    console.log(`[Health] Already restarted today (${lastRestartDate}) — daily restart skipped until tomorrow`);
  }

  dailyRestartInterval = setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // If the persisted date still matches today, do not restart again.
    let persistedDate = null;
    try {
      persistedDate = fs.readFileSync(getLastRestartFilePath(), 'utf8').trim();
    } catch (_) {
      // No file — not yet restarted today.
    }
    if (persistedDate === todayDateString()) {
      return;
    }

    // Trigger during the restart hour (e.g., 4:00 AM window)
    if (hour === restartHour) {
      if (!restartPending) {
        restartPending = true;
        console.log(`[Health] Daily restart window reached (${restartHour}:00)`);
      }
    }

    // Reset the flag after the restart hour passes (so it triggers again tomorrow)
    // Use modulo 24 so hour 23 correctly rolls over to hour 0
    const nextHour = (restartHour + 1) % 24;
    if (hour === nextHour && restartPending) {
      console.log(`[Health] Restart window passed without restart — will try tomorrow`);
      restartPending = false;
    }

    // If restart is pending and we're idle, do it
    if (restartPending && !hasActiveBooking(ctx) && !ctx.isManuallyUnlocked) {
      performRestart(ctx, `Scheduled daily restart at ${hour}:${String(minute).padStart(2, '0')}`);
    }
  }, DAILY_CHECK_INTERVAL_MS);
}

/**
 * Initialize health monitoring.
 */
function initHealth(ctx) {
  // Health settings are optional — always enable with safe defaults
  const settings = ctx.config.healthSettings || {};
  const enabled = settings.enabled !== false; // enabled by default

  if (!enabled) {
    console.log('[Health] Health monitoring disabled in config');
    return;
  }

  startMemoryMonitor(ctx);
  startDailyRestart(ctx);
}

/**
 * Clean up on shutdown.
 */
function destroyHealth() {
  if (memoryCheckInterval) {
    clearInterval(memoryCheckInterval);
    memoryCheckInterval = null;
  }
  if (dailyRestartInterval) {
    clearInterval(dailyRestartInterval);
    dailyRestartInterval = null;
  }
  restartPending = false;
}

module.exports = { initHealth, destroyHealth };
