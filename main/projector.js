/**
 * Projector Power Manager
 *
 * Controls BenQ AH30ST projector via RS-232 serial commands.
 * - Powers ON 5 minutes before a booking starts
 * - Powers OFF after a booking ends (if no booking within the keepAliveGap)
 * - Gracefully skips if COM port is unavailable
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
let lastPowerOffTime = 0;
let preStartTimer = null;
let postEndTimer = null;

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
    setTimeout(() => {
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
}

/**
 * Given the current bookings list, schedule projector on/off.
 * Called whenever bookings are updated.
 */
function scheduleFromBookings(ctx) {
  const settings = ctx.config.projectorSettings;
  if (!settings || !settings.enabled) return;
  if (!port && !SerialPort) return; // No serial support at all

  clearTimers();

  const now = new Date();
  const timezone = ctx.config.timezone || 'America/New_York';
  const preStartMinutes = settings.preStartMinutes || 5;
  const keepAliveGapMinutes = settings.keepAliveGapMinutes || 60;

  // Filter to confirmed bookings for this bay
  // Prefer ISO timestamps for cross-midnight accuracy
  const bayBookings = (ctx.bookings || [])
    .filter(b => b.bayId === ctx.config.bayId && b.status === 'confirmed')
    .map(b => ({
      ...b,
      start: b.startTimeISO ? new Date(b.startTimeISO) : parseTimeToday(b.startTime, timezone),
      end: b.endTimeISO ? new Date(b.endTimeISO) : parseTimeToday(b.endTime, timezone),
    }))
    .sort((a, b) => a.start - b.start);

  console.log(`[Projector] Evaluating ${bayBookings.length} confirmed booking(s), projector state: ${isProjectorOn}`);

  if (bayBookings.length === 0) {
    // No bookings — send power off (always send to be safe)
    console.log('[Projector] No bookings — powering off');
    powerOff();
    return;
  }

  // Find the currently active booking
  const activeBooking = bayBookings.find(b => now >= b.start && now < b.end);

  // Find the next upcoming booking
  const nextBooking = bayBookings.find(b => b.start > now);

  if (activeBooking) {
    // We're in a session — projector should be on
    if (isProjectorOn !== true) {
      console.log(`[Projector] Active booking found — powering on`);
      powerOn();
    }

    // Schedule check at end of this booking
    const msUntilEnd = activeBooking.end - now;
    if (msUntilEnd > 0) {
      postEndTimer = setTimeout(() => {
        handleBookingEnd(ctx, activeBooking, bayBookings);
      }, msUntilEnd + 2000); // +2s buffer for time overlap
      console.log(`[Projector] Will check at session end in ${Math.ceil(msUntilEnd / 60000)}m`);
    }
  } else if (nextBooking) {
    // No active booking — check if we should pre-start
    const msUntilStart = nextBooking.start - now;
    const preStartMs = preStartMinutes * 60 * 1000;

    if (msUntilStart <= preStartMs) {
      // Within pre-start window — turn on now
      if (isProjectorOn !== true) {
        console.log(`[Projector] Next booking in ${Math.ceil(msUntilStart / 60000)}m — powering on (pre-start)`);
        powerOn();
      }
    } else {
      // Schedule pre-start
      const scheduleIn = msUntilStart - preStartMs;
      preStartTimer = setTimeout(() => {
        console.log(`[Projector] Pre-start timer fired — powering on`);
        powerOn();
        // Re-schedule to handle end-of-booking
        scheduleFromBookings(ctx);
      }, scheduleIn);
      console.log(`[Projector] Scheduled pre-start in ${Math.ceil(scheduleIn / 60000)}m`);

      // No active booking — check if we should turn off based on gap
      const keepAliveMs = keepAliveGapMinutes * 60 * 1000;
      if (msUntilStart > keepAliveMs) {
        console.log(`[Projector] No booking within ${keepAliveGapMinutes}m — powering off`);
        powerOff();
      } else if (isProjectorOn !== false) {
        console.log(`[Projector] Next booking within ${keepAliveGapMinutes}m — keeping projector on`);
      }
    }
  } else {
    // All bookings are in the past — send power off (always send to be safe)
    console.log('[Projector] All bookings ended — powering off');
    powerOff();
  }
}

/**
 * Called when an active booking ends. Decide whether to keep projector on.
 */
function handleBookingEnd(ctx, endedBooking, allBookings) {
  const now = new Date();
  const settings = ctx.config.projectorSettings;
  const keepAliveGapMinutes = settings.keepAliveGapMinutes || 60;
  const keepAliveMs = keepAliveGapMinutes * 60 * 1000;

  // Find next booking after the one that just ended
  const nextBooking = allBookings.find(b => b.start >= endedBooking.end && b.id !== endedBooking.id);

  if (nextBooking) {
    const gapMs = nextBooking.start - now;
    if (gapMs <= keepAliveMs) {
      console.log(`[Projector] Next booking in ${Math.ceil(gapMs / 60000)}m — keeping projector on`);
      // Re-schedule for the next booking cycle
      scheduleFromBookings(ctx);
      return;
    }
  }

  console.log(`[Projector] No booking within ${keepAliveGapMinutes}m — powering off`);
  powerOff();
}

/**
 * Initialize the projector manager.
 */
function initProjector(ctx) {
  const settings = ctx.config.projectorSettings;
  if (!settings || !settings.enabled) {
    console.log('[Projector] Projector control disabled in config');
    return;
  }

  if (!settings.comPort) {
    console.log('[Projector] No COM port configured — projector control disabled');
    return;
  }

  // Apply custom commands from config (with unescape for control characters)
  if (settings.powerOnCmd) {
    COMMANDS.POWER_ON = unescapeCommand(settings.powerOnCmd);
  }
  if (settings.powerOffCmd) {
    COMMANDS.POWER_OFF = unescapeCommand(settings.powerOffCmd);
  }

  const baudRate = settings.baudRate || 115200;
  console.log(`[Projector] Initializing — COM: ${settings.comPort}, baud: ${baudRate}, pre-start: ${settings.preStartMinutes}m, keep-alive: ${settings.keepAliveGapMinutes}m`);
  console.log(`[Projector] Power ON cmd: ${JSON.stringify(COMMANDS.POWER_ON)}, Power OFF cmd: ${JSON.stringify(COMMANDS.POWER_OFF)}`);
  openPort(settings.comPort, baudRate);

  // Do initial schedule after a short delay to let the port open
  setTimeout(() => {
    scheduleFromBookings(ctx);
  }, 2000);
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
};
