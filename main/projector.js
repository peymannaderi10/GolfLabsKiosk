/**
 * Projector Power Manager
 *
 * Controls BenQ AH30ST projector via RS-232 serial commands.
 * - Powers ON 5 minutes before a booking starts
 * - Powers OFF after a booking ends (if no booking within the keepAliveGap)
 * - Gracefully skips if COM port is unavailable
 *
 * Also drives space lifecycle callbacks (onSpaceActive / onSpaceIdle) so other
 * systems (e.g., App Manager) can follow the same schedule.
 */

let SerialPort;
try {
  SerialPort = require('serialport').SerialPort;
} catch {
  SerialPort = null;
}

// Default BenQ RS-232 commands — overridden by config
let COMMANDS = {
  POWER_ON: '\r*pow=on#\r',
  POWER_OFF: '\r*pow=off#\r',
};

// Cooldown after power off (BenQ needs ~90s to cool before accepting power on)
const COOLDOWN_MS = 100 * 1000;

let port = null;
let isProjectorOn = null; // null = unknown, true = on, false = off
let isSpaceActive = false; // tracks whether the space is in "active" state
let lastPowerOffTime = 0;
let preStartTimer = null;
let postEndTimer = null;
let cooldownTimer = null;

// Lifecycle callbacks — other modules register to follow the same schedule
const lifecycleCallbacks = {
  onSpaceActive: [],  // called when space becomes active (pre-start or booking start)
  onSpaceIdle: [],    // called when space becomes idle (no bookings within keepAlive gap)
};

function onSpaceActive(fn) {
  lifecycleCallbacks.onSpaceActive.push(fn);
}

function onSpaceIdle(fn) {
  lifecycleCallbacks.onSpaceIdle.push(fn);
}

function emitSpaceActive(ctx) {
  if (isSpaceActive) return; // already active
  isSpaceActive = true;
  console.log('[SpaceLifecycle] Space becoming ACTIVE');
  lifecycleCallbacks.onSpaceActive.forEach(fn => fn(ctx));
}

function emitSpaceIdle(ctx) {
  if (!isSpaceActive) return; // already idle
  isSpaceActive = false;
  console.log('[SpaceLifecycle] Space becoming IDLE');
  lifecycleCallbacks.onSpaceIdle.forEach(fn => fn(ctx));
}

/**
 * Parse a time string like "2:30 PM" into a Date object for today,
 * using the configured timezone.
 */
function parseTimeToday(timeString, timezone) {
  const [time, modifier] = timeString.split(' ');
  let [hours, minutes] = time.split(':').map(Number);
  if (modifier === 'PM' && hours < 12) hours += 12;
  if (modifier === 'AM' && hours === 12) hours = 0;

  // Build a date in the configured timezone
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
  return new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`);
}

/**
 * Convert escaped string from config (e.g., "\\r*pow=on#\\r") to actual control characters.
 */
function unescapeCommand(str) {
  return str.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/**
 * Open the serial port. Returns true if successful, false if skipped/failed.
 */
function openPort(comPort, baudRate) {
  if (!SerialPort) {
    console.log('[Projector] serialport package not installed — projector control disabled');
    return false;
  }

  try {
    port = new SerialPort({
      path: comPort,
      baudRate: baudRate || 115200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autoOpen: false,
    });

    port.open((err) => {
      if (err) {
        console.warn(`[Projector] Could not open ${comPort}: ${err.message} — projector control disabled`);
        port = null;
        return;
      }
      console.log(`[Projector] Serial port ${comPort} opened successfully`);
    });

    port.on('data', (data) => {
      const response = data.toString().trim();
      console.log(`[Projector] Response: ${response}`);
      if (response.includes('pow=on')) isProjectorOn = true;
      if (response.includes('pow=off')) isProjectorOn = false;
    });

    port.on('error', (err) => {
      console.error(`[Projector] Serial port error: ${err.message}`);
    });

    port.on('close', () => {
      console.log('[Projector] Serial port closed');
      port = null;
    });

    return true;
  } catch (err) {
    console.warn(`[Projector] Failed to create serial port: ${err.message} — projector control disabled`);
    port = null;
    return false;
  }
}

/**
 * Send a raw command to the projector.
 */
function sendCommand(command, label) {
  if (!port || !port.isOpen) {
    console.log(`[Projector] Port not open — skipping ${label}`);
    return false;
  }

  port.write(command, (err) => {
    if (err) {
      console.error(`[Projector] Failed to send ${label}: ${err.message}`);
    } else {
      console.log(`[Projector] Sent ${label}`);
    }
  });
  return true;
}

function queryStatus() {
  const cmd = '\r*pow=?#\r';
  return sendCommand(cmd, 'QUERY_STATUS');
}

function powerOn() {
  const timeSinceOff = Date.now() - lastPowerOffTime;
  if (timeSinceOff < COOLDOWN_MS) {
    const waitMs = COOLDOWN_MS - timeSinceOff;
    console.log(`[Projector] In cooldown — delaying power on by ${Math.ceil(waitMs / 1000)}s`);
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      sendCommand(COMMANDS.POWER_ON, 'POWER_ON');
      isProjectorOn = true;
    }, waitMs);
    return;
  }
  sendCommand(COMMANDS.POWER_ON, 'POWER_ON');
  isProjectorOn = true;
}

function powerOff() {
  sendCommand(COMMANDS.POWER_OFF, 'POWER_OFF');
  isProjectorOn = false;
  lastPowerOffTime = Date.now();
}

/**
 * Clear all scheduled timers.
 */
function clearTimers() {
  if (preStartTimer) {
    clearTimeout(preStartTimer);
    preStartTimer = null;
  }
  if (postEndTimer) {
    clearTimeout(postEndTimer);
    postEndTimer = null;
  }
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
}

/**
 * Given the current bookings list, schedule projector on/off and drive space
 * lifecycle events (onSpaceActive / onSpaceIdle). The lifecycle scheduling
 * always runs when appManagerSettings OR projectorSettings is enabled so that
 * Uneekor is managed even when projector hardware is not connected.
 */
function scheduleFromBookings(ctx) {
  const projSettings = ctx.config.projectorSettings;
  const appMgrSettings = ctx.config.appManagerSettings;
  const projectorEnabled = projSettings && projSettings.enabled;
  const appManagerEnabled = appMgrSettings && appMgrSettings.enabled !== false;

  // Bail out only if neither system needs the schedule
  if (!projectorEnabled && !appManagerEnabled) return;

  // Projector hardware writes require an open port
  const projectorHardwareReady = projectorEnabled && port && port.isOpen;

  const settings = projSettings || {};
  clearTimers();

  const now = new Date();
  const timezone = ctx.config.timezone || 'America/New_York';
  const preStartMinutes = settings.preStartMinutes || 5;
  const keepAliveGapMinutes = settings.keepAliveGapMinutes || 60;

  // Filter to confirmed bookings for this space
  // Prefer ISO timestamps for cross-midnight accuracy
  const spaceBookings = (ctx.bookings || [])
    .filter(b => b.spaceId === ctx.config.spaceId && b.status === 'confirmed')
    .map(b => ({
      ...b,
      start: b.startTimeISO ? new Date(b.startTimeISO) : parseTimeToday(b.startTime, timezone),
      end: b.endTimeISO ? new Date(b.endTimeISO) : parseTimeToday(b.endTime, timezone),
    }))
    .sort((a, b) => a.start - b.start);

  console.log(`[Projector] Evaluating ${spaceBookings.length} confirmed booking(s), projector state: ${isProjectorOn}`);

  if (spaceBookings.length === 0) {
    // No bookings — power off projector and signal idle
    console.log('[Projector] No bookings — powering off');
    if (projectorHardwareReady) powerOff();
    emitSpaceIdle(ctx);
    return;
  }

  // Find the currently active booking
  const activeBooking = spaceBookings.find(b => now >= b.start && now < b.end);

  // Find the next upcoming booking
  const nextBooking = spaceBookings.find(b => b.start > now);

  if (activeBooking) {
    // We're in a session — projector should be on
    if (projectorHardwareReady && isProjectorOn !== true) {
      console.log(`[Projector] Active booking found — powering on`);
      powerOn();
    }
    emitSpaceActive(ctx);

    // Schedule a fresh re-evaluation at booking end using live ctx data
    const msUntilEnd = activeBooking.end - now;
    if (msUntilEnd > 0) {
      postEndTimer = setTimeout(() => {
        console.log('[Projector] Active booking timer fired — re-evaluating with live data');
        scheduleFromBookings(ctx);
      }, msUntilEnd + 2000); // +2s buffer for time overlap
      console.log(`[Projector] Will re-evaluate at session end in ${Math.ceil(msUntilEnd / 60000)}m`);
    }
  } else if (nextBooking) {
    // No active booking — check if we should pre-start
    const msUntilStart = nextBooking.start - now;
    const preStartMs = preStartMinutes * 60 * 1000;

    if (msUntilStart <= preStartMs) {
      // Within pre-start window — turn on now
      if (projectorHardwareReady && isProjectorOn !== true) {
        console.log(`[Projector] Next booking in ${Math.ceil(msUntilStart / 60000)}m — powering on (pre-start)`);
        powerOn();
      }
      emitSpaceActive(ctx);
      // Schedule re-evaluation at booking end so we can power off
      const msUntilEnd = nextBooking.end - now;
      if (msUntilEnd > 0) {
        postEndTimer = setTimeout(() => {
          console.log('[Projector] Booking ended (from pre-start) — re-evaluating');
          scheduleFromBookings(ctx);
        }, msUntilEnd + 2000);
        console.log(`[Projector] Will re-evaluate at booking end in ${Math.ceil(msUntilEnd / 60000)}m`);
      }
    } else {
      // Schedule pre-start
      const scheduleIn = msUntilStart - preStartMs;
      preStartTimer = setTimeout(() => {
        console.log(`[Projector] Pre-start timer fired — powering on`);
        if (projectorHardwareReady) powerOn();
        // Re-schedule to handle end-of-booking
        scheduleFromBookings(ctx);
      }, scheduleIn);
      console.log(`[Projector] Scheduled pre-start in ${Math.ceil(scheduleIn / 60000)}m`);

      // No active booking — check if we should turn off based on gap
      const keepAliveMs = keepAliveGapMinutes * 60 * 1000;
      if (msUntilStart > keepAliveMs) {
        console.log(`[Projector] No booking within ${keepAliveGapMinutes}m — powering off`);
        if (projectorHardwareReady) powerOff();
        emitSpaceIdle(ctx);
      } else if (projectorHardwareReady && isProjectorOn !== false) {
        console.log(`[Projector] Next booking within ${keepAliveGapMinutes}m — keeping projector on`);
      }
    }
  } else {
    // All bookings are in the past — power off and signal idle
    console.log('[Projector] All bookings ended — powering off');
    if (projectorHardwareReady) powerOff();
    emitSpaceIdle(ctx);
  }
}


/**
 * Initialize the projector manager.
 * Always runs the initial schedule if appManagerSettings is enabled,
 * even when projector hardware is not configured — so space lifecycle
 * events (onSpaceActive / onSpaceIdle) fire correctly for app management.
 */
function initProjector(ctx) {
  // Clean up any previous init to prevent serial port handle leaks on double-init
  destroyProjector();

  const projSettings = ctx.config.projectorSettings;
  const appMgrSettings = ctx.config.appManagerSettings;
  const projectorEnabled = projSettings && projSettings.enabled;
  const appManagerEnabled = appMgrSettings && appMgrSettings.enabled !== false;

  if (!projectorEnabled && !appManagerEnabled) {
    console.log('[Projector] Both projector control and app manager disabled — skipping init');
    return;
  }

  if (projectorEnabled) {
    if (!projSettings.comPort) {
      console.log('[Projector] Projector enabled but no COM port configured — hardware control disabled');
    } else {
      // Apply custom commands from config (with unescape for control characters)
      if (projSettings.powerOnCmd) {
        COMMANDS.POWER_ON = unescapeCommand(projSettings.powerOnCmd);
      }
      if (projSettings.powerOffCmd) {
        COMMANDS.POWER_OFF = unescapeCommand(projSettings.powerOffCmd);
      }

      const baudRate = projSettings.baudRate || 115200;
      console.log(`[Projector] Initializing — COM: ${projSettings.comPort}, baud: ${baudRate}, pre-start: ${projSettings.preStartMinutes}m, keep-alive: ${projSettings.keepAliveGapMinutes}m`);
      console.log(`[Projector] Power ON cmd: ${JSON.stringify(COMMANDS.POWER_ON)}, Power OFF cmd: ${JSON.stringify(COMMANDS.POWER_OFF)}`);
      openPort(projSettings.comPort, baudRate);
    }
  } else {
    console.log('[Projector] Projector hardware control disabled — running lifecycle scheduling for app manager only');
  }

  // Always run the initial schedule (drives space lifecycle for app manager)
  // Use a short delay when a serial port was opened to let it connect;
  // otherwise run immediately.
  const delay = (projectorEnabled && projSettings.comPort) ? 2000 : 0;
  setTimeout(() => {
    scheduleFromBookings(ctx);
  }, delay);
}

/**
 * Clean up on shutdown.
 */
function destroyProjector() {
  clearTimers();
  if (port && port.isOpen) {
    port.close((err) => {
      if (err) console.error(`[Projector] Error closing port: ${err.message}`);
    });
  }
}

module.exports = {
  initProjector,
  destroyProjector,
  scheduleFromBookings,
  powerOn,
  powerOff,
  queryStatus,
  onSpaceActive,
  onSpaceIdle,
  lifecycleCallbacks,
};
