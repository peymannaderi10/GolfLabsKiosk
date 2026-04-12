// Setup wizard renderer. Talks to the main process via the
// `window.kioskSetup` bridge exposed in preload.js.

const state = {
  step: 'location',
  locationId: '',
  locationName: '',
  spaces: [],
  originalTitle: 'Kiosk Setup',
};

const $ = (id) => document.getElementById(id);

// Strict allowed formats for the server-provided brand color. Anything
// that doesn't match falls back to the neutral default in setup.css.
const HSL_TRIPLET_RE = /^\s*(\d{1,3}(?:\.\d+)?)\s+(\d{1,3}(?:\.\d+)?)%\s+(\d{1,3}(?:\.\d+)?)%\s*$/;
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function applyBranding(brandPrimaryColor) {
  if (!brandPrimaryColor || typeof brandPrimaryColor !== 'string') return;

  let primary = null;
  let soft = null;

  const hsl = brandPrimaryColor.match(HSL_TRIPLET_RE);
  if (hsl) {
    const [, h, s, l] = hsl;
    primary = `hsl(${h} ${s}% ${l}%)`;
    soft = `hsla(${h} ${s}% ${l}% / 0.1)`;
  } else if (HEX_COLOR_RE.test(brandPrimaryColor.trim())) {
    primary = brandPrimaryColor.trim();
    soft = `${brandPrimaryColor.trim()}1a`;
  } else {
    console.warn('[setup] Ignoring unrecognized brand_primary_color format:', brandPrimaryColor);
    return;
  }

  document.documentElement.style.setProperty('--brand-primary', primary);
  document.documentElement.style.setProperty('--brand-primary-soft', soft);
  // Hover color darkens the primary a touch — we keep a best-effort
  // approximation by reusing primary since :hover already implies change.
  document.documentElement.style.setProperty('--brand-primary-hover', primary);
}

function clearBranding() {
  // Reset to neutral slate-900 defaults from setup.css.
  document.documentElement.style.removeProperty('--brand-primary');
  document.documentElement.style.removeProperty('--brand-primary-soft');
  document.documentElement.style.removeProperty('--brand-primary-hover');
}

function setHeaderForLocation(locationName) {
  $('setup-title').textContent = `${locationName} Kiosk Setup`;
}

function resetHeader() {
  $('setup-title').textContent = state.originalTitle;
}

function showStep(name) {
  state.step = name;
  document.querySelectorAll('.step').forEach((el) => el.classList.remove('active'));
  $(`step-${name}`).classList.add('active');
}

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function clearError(id) {
  const el = $(id);
  el.textContent = '';
  el.hidden = true;
}

async function handleLocationContinue() {
  clearError('location-error');
  const locationId = $('location-input').value.trim();
  if (!locationId) {
    showError('location-error', 'Please enter a location ID.');
    return;
  }
  $('location-continue').disabled = true;
  try {
    const result = await window.kioskSetup.listSpaces(locationId);
    if (!result.success) {
      showError('location-error', result.error || 'Failed to fetch spaces.');
      return;
    }
    const { locationName, brandPrimaryColor, spaces } = result.data;
    state.locationId = locationId;
    state.locationName = locationName;
    state.spaces = spaces;
    applyBranding(brandPrimaryColor);
    setHeaderForLocation(locationName);
    renderSpaces();
    showStep('space');
  } catch (err) {
    showError('location-error', err?.message || 'Unexpected error.');
  } finally {
    $('location-continue').disabled = false;
  }
}

function renderSpaces() {
  const list = $('space-list');
  list.innerHTML = '';
  const empty = $('space-empty');
  if (state.spaces.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  state.spaces.forEach((space) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'space-card';
    btn.innerHTML = `
      <span class="number">Bay ${space.spaceNumber}</span>
      <span class="name">${escapeHtml(space.name)}</span>
    `;
    btn.addEventListener('click', () => handleSpacePick(space.id));
    list.appendChild(btn);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

async function handleSpacePick(spaceId) {
  clearError('space-error');
  showStep('registering');
  try {
    const result = await window.kioskSetup.register({
      locationId: state.locationId,
      spaceId,
    });
    if (!result.success) {
      showError('space-error', result.error || 'Failed to register kiosk.');
      showStep('space');
      return;
    }
    // Main process will close this window on success.
  } catch (err) {
    showError('space-error', err?.message || 'Unexpected error.');
    showStep('space');
  }
}

async function handleRefreshSpaces() {
  if (!state.locationId) return;
  clearError('space-error');
  try {
    const result = await window.kioskSetup.listSpaces(state.locationId);
    if (!result.success) {
      showError('space-error', result.error || 'Failed to refresh spaces.');
      return;
    }
    state.spaces = result.data.spaces;
    applyBranding(result.data.brandPrimaryColor);
    renderSpaces();
  } catch (err) {
    showError('space-error', err?.message || 'Unexpected error.');
  }
}

function handleBackToLocation() {
  // Reset branding AND header so the location-ID screen always shows
  // the neutral "Kiosk Setup" shell — consistent regardless of which
  // tenant the operator partially onboarded.
  clearError('space-error');
  clearBranding();
  resetHeader();
  state.locationId = '';
  state.locationName = '';
  state.spaces = [];
  showStep('location');
}

document.addEventListener('DOMContentLoaded', () => {
  $('location-continue').addEventListener('click', handleLocationContinue);
  $('location-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLocationContinue();
  });
  $('back-to-location').addEventListener('click', handleBackToLocation);
  $('refresh-spaces').addEventListener('click', handleRefreshSpaces);
  $('location-input').focus();
});
