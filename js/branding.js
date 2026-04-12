/**
 * Shared branding bootstrapper. Loaded by every kiosk HTML page that
 * needs to adopt the location's brand color: index.html (lock/unlock
 * screens), admin.html (admin panel), leaderboard.html (league
 * leaderboard TV display). The setup wizard uses neutral colors and
 * intentionally does NOT load this file.
 *
 * The backend stores one canonical value in
 * location_settings.brand_primary_color as an HSL triplet
 * ("H S% L%", e.g. "158 100% 33%"). This file derives SIX runtime
 * CSS variables from that one value so the main lock-screen CSS
 * (css/base.css), session extension overlays (css/extension.css),
 * league UI (css/league.css), and the admin panel (admin.css) all
 * share a single source of truth:
 *
 *   --primary              triplet used inside `hsl(var(--primary))`
 *   --brand-primary        full hsl() color for solid fills & borders
 *   --brand-primary-hover  darker shade for button hover / gradients
 *   --brand-primary-dim    12% alpha variant for badge backgrounds
 *   --brand-primary-ring   30% alpha variant for focus outlines
 *   --brand-primary-glow    6% alpha variant for ambient glows
 *
 * Accepts either an HSL triplet or a hex color. Unknown formats log
 * a warning and leave the stylesheet defaults in place, so the UI
 * never renders half-broken.
 *
 * Runs automatically on DOMContentLoaded — every page that loads
 * this script gets branded with no further wiring required.
 */
(function () {
  'use strict';

  const HSL_RE = /^(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%$/;
  const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  /**
   * Convert a raw brand color string into an HSL triplet "H S% L%".
   * Returns null if the input is neither a triplet nor a hex color.
   */
  function toTriplet(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();

    const hslMatch = trimmed.match(HSL_RE);
    if (hslMatch) return trimmed;

    if (HEX_RE.test(trimmed)) {
      const hex = trimmed.slice(1);
      const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
      const r = parseInt(full.slice(0, 2), 16) / 255;
      const g = parseInt(full.slice(2, 4), 16) / 255;
      const b = parseInt(full.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      let h = 0;
      let s = 0;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h *= 60;
      }
      return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
    }

    return null;
  }

  /**
   * Parse an HSL triplet into its three numeric components so we
   * can derive hover (darker) and alpha variants programmatically.
   */
  function parseTriplet(triplet) {
    const m = triplet.match(HSL_RE);
    if (!m) return null;
    return {
      h: parseFloat(m[1]),
      s: parseFloat(m[2]),
      l: parseFloat(m[3]),
    };
  }

  /**
   * Apply the full brand palette to :root via inline styles. Inline
   * styles win over stylesheet `:root` rules with equal specificity
   * by cascade order, so this overrides the defaults in base.css /
   * admin.css / etc.
   */
  function applyBrandColor(raw) {
    const triplet = toTriplet(raw);
    if (!triplet) {
      console.warn('[brand] Ignoring unrecognized brand_primary_color:', raw);
      return;
    }

    const parts = parseTriplet(triplet);
    if (!parts) return;

    // Hover = same H/S, lightness reduced by ~8 percentage points,
    // clamped to [0,100]. Matches the relative darkness of the old
    // GolfLabs palette (#00A36C → #008B5A was about -8% lightness).
    const hoverL = Math.max(0, parts.l - 8);
    const hoverTriplet = `${parts.h} ${parts.s}% ${hoverL}%`;

    const root = document.documentElement.style;
    root.setProperty('--primary', triplet);
    root.setProperty('--brand-primary', `hsl(${triplet})`);
    root.setProperty('--brand-primary-hover', `hsl(${hoverTriplet})`);
    root.setProperty('--brand-primary-dim', `hsla(${triplet} / 0.12)`);
    root.setProperty('--brand-primary-ring', `hsla(${triplet} / 0.3)`);
    root.setProperty('--brand-primary-glow', `hsla(${triplet} / 0.06)`);
    console.log('[brand] Applied location color:', triplet);
  }

  /**
   * Fetch config from the main process and apply the brand color.
   * Called automatically on DOMContentLoaded; also re-runs on the
   * `kiosk-settings-updated` IPC event so live dashboard edits to
   * the location's brand color propagate without a kiosk restart.
   */
  async function bootstrap() {
    try {
      if (!window.electronAPI || typeof window.electronAPI.getConfig !== 'function') {
        console.warn('[brand] electronAPI.getConfig unavailable — skipping');
        return;
      }
      const config = await window.electronAPI.getConfig();
      applyBrandColor(config && config.brandPrimaryColor);
    } catch (err) {
      console.error('[brand] Failed to apply brand color on load:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    // Script loaded after DOMContentLoaded already fired.
    bootstrap();
  }

  // Expose for manual re-invocation (e.g. after receiving a
  // settings-updated IPC event from the main process).
  window.applyBrandColor = applyBrandColor;
  window.rebootstrapBranding = bootstrap;
})();
