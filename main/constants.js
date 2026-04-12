/**
 * Build-time hardcoded constants for the kiosk binary.
 *
 * These are intentionally NOT loaded from config.json — they are
 * environment-level infrastructure that should never vary between
 * installs of the same build, and operators should not be able to
 * accidentally change them from the admin panel. Rotation requires
 * editing this file and rebuilding.
 *
 * The kiosk bootstrap API key is a binary identity, not a per-customer
 * credential. Anyone who unpacks the .exe can read it. It only grants
 * access to the kiosk-scoped endpoints (register, settings, heartbeat,
 * unlock logging) — it cannot impersonate a user or mutate another
 * tenant's data without also knowing that tenant's locationId/spaceId,
 * which the backend validates against the registered installation.
 */

const ENVIRONMENTS = {
  development: {
    API_BASE_URL: 'http://localhost:4242',
    SOCKET_URL: 'http://localhost:4242',
  },
  production: {
    API_BASE_URL: 'https://golflabs-us-api.onrender.com',
    SOCKET_URL: 'https://golflabs-us-api.onrender.com',
  },
};

// `--dev` flag flips to development URLs; packaged builds always land
// on production. Matches the existing `isDev` check in main.js.
const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
const env = isDev ? 'development' : 'production';

// Kiosk API key is loaded from a gitignored local file (`main/secrets.js`),
// NOT embedded in committed source. To rotate: edit secrets.js, rebuild,
// reinstall. To set up on a new dev machine: copy secrets.example.js
// → secrets.js and paste the key. If the file is missing we fail loudly
// rather than silently shipping an empty auth header.
let KIOSK_API_KEY;
try {
  // eslint-disable-next-line global-require
  ({ KIOSK_API_KEY } = require('./secrets'));
} catch (err) {
  console.error(
    '[constants] FATAL: main/secrets.js not found. Copy main/secrets.example.js → main/secrets.js and paste the real key.'
  );
  throw err;
}
if (!KIOSK_API_KEY || typeof KIOSK_API_KEY !== 'string' || KIOSK_API_KEY.length < 32) {
  throw new Error('[constants] KIOSK_API_KEY is missing or invalid in main/secrets.js');
}

module.exports = {
  ENV: env,
  API_BASE_URL: ENVIRONMENTS[env].API_BASE_URL,
  SOCKET_URL: ENVIRONMENTS[env].SOCKET_URL,
  KIOSK_API_KEY,
  TIMEZONE: 'America/New_York',
  // appManagerSettings.enabled was previously a runtime config field;
  // hardcoded to true now since every kiosk should run the app manager.
  APP_MANAGER_ENABLED: true,
};
