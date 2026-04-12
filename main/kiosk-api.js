const axios = require('axios');
const { API_BASE_URL, KIOSK_API_KEY } = require('./constants');

/**
 * Thin wrapper around axios for the /kiosk/* endpoints. Every call
 * carries the hardcoded X-Kiosk-Key header. The API base URL is
 * build-time constant — nothing here reads from config.json.
 *
 * All methods return the parsed `data` field from the backend's
 * `{ success, data }` envelope and throw on any non-2xx or
 * `success: false` response.
 */

const client = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'X-Kiosk-Key': KIOSK_API_KEY },
  timeout: 15000,
});

/**
 * Installation id is set once at boot (after loadInstallation) and
 * attached to every outbound kiosk-api request via the
 * `X-Kiosk-Installation-Id` header. The backend uses this header to
 * scope settings/register/heartbeat calls to the calling installation
 * — without it the API rejects tenant-sensitive routes.
 *
 * Calls made BEFORE the id is set (e.g. setup wizard's list-spaces /
 * register, which run before an installation exists) simply omit the
 * header — the backend permits those endpoints without it.
 */
let installationId = null;

function setInstallationId(id) {
  installationId = id || null;
}

client.interceptors.request.use((config) => {
  if (installationId) {
    config.headers = config.headers || {};
    config.headers['X-Kiosk-Installation-Id'] = installationId;
  }
  return config;
});

function unwrap(res) {
  if (!res?.data?.success) {
    throw new Error(res?.data?.error || `Request failed (${res.status})`);
  }
  return res.data.data;
}

function errorMessage(err) {
  if (err?.response?.data?.error) return err.response.data.error;
  if (err?.message) return err.message;
  return 'Unknown error';
}

async function listUnclaimedSpaces(locationId) {
  try {
    const res = await client.get(`/kiosk/locations/${encodeURIComponent(locationId)}/spaces`);
    return unwrap(res);
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

async function registerKiosk({ installationId, spaceId, locationId, version }) {
  try {
    const res = await client.post('/kiosk/register', {
      installationId,
      spaceId,
      locationId,
      version,
    });
    return unwrap(res);
  } catch (err) {
    throw new Error(errorMessage(err));
  }
}

async function getSettings(installationId) {
  try {
    const res = await client.get(`/kiosk/settings/${encodeURIComponent(installationId)}`);
    return unwrap(res);
  } catch (err) {
    // 404 means the installation has been cleared from the dashboard —
    // tag the original error so the caller can drop back into setup.
    if (err?.response?.status === 404) err.code = 'INSTALLATION_CLEARED';
    throw err;
  }
}

module.exports = {
  client,
  setInstallationId,
  listUnclaimedSpaces,
  registerKiosk,
  getSettings,
};
