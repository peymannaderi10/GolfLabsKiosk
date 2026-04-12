const EventEmitter = require('events');
const { API_BASE_URL, KIOSK_API_KEY, TIMEZONE, APP_MANAGER_ENABLED } = require('./constants');
const kioskApi = require('./kiosk-api');

/**
 * Single source of truth for kiosk settings. Loads the authoritative
 * payload from the backend on boot, caches it, and mutates `ctx.config`
 * in place so every existing subsystem (websocket, projector, league,
 * extensions) keeps reading from the familiar `ctx.config.X` paths
 * without any refactoring.
 *
 * When a `kiosk_settings_updated` socket event arrives, this service
 * rebuilds `ctx.config` from the new payload and emits a
 * `settings-changed` event that subsystems can subscribe to if they
 * need to reinitialize (e.g. projector re-opening its serial port).
 */
class KioskSettingsService extends EventEmitter {
  constructor() {
    super();
    this.current = null;
  }

  /**
   * Convert a server-shaped KioskSettings payload into the legacy
   * `ctx.config` object that every existing subsystem reads from.
   * This lets us drop in server-driven settings with zero changes
   * to projector.js, websocket.js, ipc-handlers.js, etc.
   */
  static toLegacyConfig(settings, installation) {
    return {
      // Identity (from local installation file)
      installationId: installation.installationId,
      spaceId: installation.spaceId,
      locationId: installation.locationId,
      adminPassword: installation.adminPassword,

      // Infrastructure (from constants.js)
      apiBaseUrl: API_BASE_URL,
      kioskApiKey: KIOSK_API_KEY,
      timezone: TIMEZONE,

      // Server-managed
      shellyIP: settings.shellyIp || '',

      projectorSettings: {
        enabled: settings.projectorControlEnabled,
        comPort: settings.projectorSerialPort || '',
        baudRate: settings.projectorBaudRate || 9600,
        powerOnCmd: settings.projectorOnCommand || '',
        powerOffCmd: settings.projectorOffCommand || '',
        preStartMinutes: settings.projectorPreStartMinutes ?? 5,
        keepAliveGapMinutes: settings.projectorKeepAliveGapMinutes ?? 60,
      },

      leagueSettings: {
        enabled: settings.leagueModeEnabled,
        leagueId: settings.leagueId || '',
      },

      extensionSettings: {
        enabled: settings.extensionsEnabled,
        triggerMinutes: settings.extensionTriggerMinutes || 15,
        options: settings.extensionDurationOptions,
      },

      appManagerSettings: {
        enabled: APP_MANAGER_ENABLED,
      },

      // Location branding — pulled from location_settings.brand_primary_color
      // by the backend. The renderer reads this via getConfig() and sets
      // the --primary CSS variable so idle screens, buttons, and overlays
      // adopt the location's color.
      brandPrimaryColor: settings.brandPrimaryColor || '158 100% 33%',
    };
  }

  /**
   * Initial boot load. Fetches server settings for the current
   * installation, builds the legacy config shape, and mutates
   * `ctx.config` in place. Returns the new config.
   *
   * Throws with code `INSTALLATION_CLEARED` if the backend returns
   * 404 — the caller should drop into the setup wizard.
   */
  async load(installation, ctx) {
    const settings = await kioskApi.getSettings(installation.installationId);
    this.current = settings;
    const legacy = KioskSettingsService.toLegacyConfig(settings, installation);
    // Mutate ctx.config in place so existing subsystems pick up new values.
    if (ctx.config) {
      Object.assign(ctx.config, legacy);
    } else {
      ctx.config = legacy;
    }
    this.emit('settings-loaded', this.current);
    return ctx.config;
  }

  /**
   * Apply a fresh settings payload received from a socket event.
   * Computes which slices changed and emits targeted events that
   * subsystems subscribe to for surgical reinitialization.
   */
  applySocketUpdate(newSettings, ctx, installation) {
    const prev = this.current;
    this.current = newSettings;

    const legacy = KioskSettingsService.toLegacyConfig(newSettings, installation);
    Object.assign(ctx.config, legacy);

    if (!prev) {
      this.emit('settings-changed', { all: true });
      this.emit('projector-changed', ctx);
      return;
    }

    const changed = {
      shelly: prev.shellyIp !== newSettings.shellyIp,
      league: this._leagueChanged(prev, newSettings),
    };

    this.emit('settings-changed', changed);
    // reinitProjector is cheap; always emit and let the handler decide.
    this.emit('projector-changed', ctx);
    if (changed.league) this.emit('league-changed', ctx);
  }

  _leagueChanged(a, b) {
    return a.leagueModeEnabled !== b.leagueModeEnabled || a.leagueId !== b.leagueId;
  }
}

// Singleton — there's only ever one settings state per running kiosk.
const kioskSettingsService = new KioskSettingsService();

module.exports = { kioskSettingsService, KioskSettingsService };
