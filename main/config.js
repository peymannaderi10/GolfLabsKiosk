/**
 * Legacy `config.js` — historically owned loading the runtime
 * config.json. In Phase 3 of the server-driven kiosk refactor, that
 * responsibility moved to `main/installation.js` (local identity)
 * and `main/kiosk-settings.js` (server-pushed operational config).
 *
 * This file now only owns the in-memory log buffer (used by the
 * admin panel console viewer) and re-exports CONFIG_PATH for any
 * caller still referencing it.
 */

const { CONFIG_PATH } = require('./installation');

const logBuffer = [];
const MAX_LOG_ENTRIES = 500;

function addToLogBuffer(level, args) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => { addToLogBuffer('log', args); originalLog(...args); };
console.error = (...args) => { addToLogBuffer('error', args); originalError(...args); };
console.warn = (...args) => { addToLogBuffer('warn', args); originalWarn(...args); };

module.exports = { logBuffer, CONFIG_PATH };
