/**
 * Template for main/secrets.js. COPY to `main/secrets.js`, fill in
 * the real values, and leave the real file untracked (`main/secrets.js`
 * is in .gitignore).
 *
 * Rotating the kiosk API key: update the value here, rebuild the
 * installer, reinstall on every kiosk. Then rotate the corresponding
 * KIOSK_API_KEY env var on the API side.
 */
module.exports = {
  KIOSK_API_KEY: 'paste-kiosk-api-key-here',
};
