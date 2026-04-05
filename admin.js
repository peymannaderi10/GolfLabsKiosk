let displayInfo = null;
let currentConfig = null;
let isEditMode = false;

let cachedBookings = [];

/**
 * Show a non-blocking modal confirm dialog and return a Promise<boolean>.
 * Replaces all window.confirm() calls so dialogs never block the renderer
 * event loop and always appear above the fullscreen kiosk window.
 */
function adminConfirm(message) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('admin-confirm-overlay');
        const messageEl = document.getElementById('admin-confirm-message');
        const okBtn = document.getElementById('admin-confirm-ok');
        const cancelBtn = document.getElementById('admin-confirm-cancel');

        messageEl.textContent = message;
        overlay.style.display = 'flex';

        function cleanup(result) {
            overlay.style.display = 'none';
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            resolve(result);
        }

        function onOk() { cleanup(true); }
        function onCancel() { cleanup(false); }

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
    });
}

/**
 * Show a status message in the System page hardware section.
 * Used in place of alert() for monitor/websocket operation results.
 */
function showHardwareMessage(message, type) {
    // Re-use projector message area which is always present on the hardware page
    showProjectorMessage(message, type || 'success');
}

// Navigation function — sidebar-based
function navigateTo(pageId) {
    // Redirect menu to default section
    if (pageId === 'menu') pageId = 'space-control';

    // Hide all pages
    const pages = document.querySelectorAll('.page');
    pages.forEach(page => page.classList.remove('active'));

    // Show target page
    const page = document.getElementById(`${pageId}-page`);
    if (page) {
        page.classList.add('active');
    }

    // Update sidebar active state
    const navItems = document.querySelectorAll('.nav-item[data-page]');
    navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.page === pageId);
    });

    // Load data for specific pages
    if (pageId === 'space-control') {
        loadBookingInfo();
    } else if (pageId === 'hardware') {
        loadDisplayInfo();
        if (currentConfig) populateProjectorSettings(currentConfig);
    } else if (pageId === 'settings') {
        loadConfig();
    } else if (pageId === 'system') {
        loadSystemInfo();
        refreshLogs();
    }
}

async function loadDisplayInfo() {
    try {
        displayInfo = await window.electronAPI.getDisplayInfo();
        updateDisplayInfo();
    } catch (error) {
        console.error('Failed to load display info:', error);
        document.getElementById('display-info').textContent = 'Error loading display information';
    }
}

function updateDisplayInfo() {
    const infoElement = document.getElementById('display-info');
    if (!displayInfo) {
        infoElement.textContent = 'No display information available';
        return;
    }

    const { displays, additionalWindowsCount } = displayInfo;
    
    let infoHtml = `
        <div style="margin-bottom: 8px;">
            <strong>${displays.length} display${displays.length !== 1 ? 's' : ''}</strong> detected &middot;
            ${additionalWindowsCount + 1} window${additionalWindowsCount + 1 !== 1 ? 's' : ''} active
        </div>
    `;

    displays.forEach((display, index) => {
        infoHtml += `
            <div class="monitor-info">
                <span>Display ${index + 1}: ${display.bounds.width}×${display.bounds.height}</span>
                ${display.isPrimary ? '<span class="primary-badge">PRIMARY</span>' : ''}
            </div>
        `;
    });

    infoElement.innerHTML = infoHtml;
}

async function restartApp() {
    if (await adminConfirm('Are you sure you want to restart the application?')) {
        try {
            await window.electronAPI.adminRestartApp();
        } catch (error) {
            console.error('Restart failed:', error);
            showConfigMessage('Failed to restart application', 'error');
        }
    }
}

async function closeApp() {
    if (await adminConfirm('Are you sure you want to close the application?')) {
        try {
            await window.electronAPI.adminCloseApp();
        } catch (error) {
            console.error('Close failed:', error);
            showConfigMessage('Failed to close application', 'error');
        }
    }
}

async function disconnectMonitors() {
    try {
        const result = await window.electronAPI.adminDisconnectMonitors();
        showHardwareMessage(result.message, 'success');
        await loadDisplayInfo();
    } catch (error) {
        console.error('Disconnect failed:', error);
        showHardwareMessage('Failed to disconnect monitors', 'error');
    }
}

async function reconnectMonitors() {
    try {
        const result = await window.electronAPI.adminReconnectMonitors();
        showHardwareMessage(result.message, 'success');
        await loadDisplayInfo();
    } catch (error) {
        console.error('Reconnect failed:', error);
        showHardwareMessage('Failed to reconnect monitors', 'error');
    }
}

async function reconnectWebsocket() {
    try {
        const result = await window.electronAPI.adminReconnectWebsocket();
        showHardwareMessage(result.message, 'success');
    } catch (error) {
        console.error('WebSocket reconnect failed:', error);
        showHardwareMessage('Failed to reconnect WebSocket', 'error');
    }
}

async function exitAdmin() {
    try {
        await window.electronAPI.adminClose();
    } catch (error) {
        console.error('Exit admin failed:', error);
    }
}

async function validatePassword(event) {
    event.preventDefault();
    
    const passwordInput = document.getElementById('password-input');
    const errorDiv = document.getElementById('password-error');
    const password = passwordInput.value;

    errorDiv.style.display = 'none';
    errorDiv.textContent = '';

    if (!password) {
        showPasswordError('Please enter a password');
        return;
    }

    try {
        const result = await window.electronAPI.adminValidatePassword(password);
        
        if (result.success) {
            document.getElementById('password-overlay').style.display = 'none';
            document.getElementById('admin-content').classList.add('unlocked');
            loadConfig();
            navigateTo('space-control');
        } else {
            showPasswordError(result.error || 'Invalid password');
            passwordInput.value = '';
            passwordInput.focus();
        }
    } catch (error) {
        console.error('Password validation error:', error);
        showPasswordError('Authentication failed. Please try again.');
        passwordInput.value = '';
        passwordInput.focus();
    }
}

function showPasswordError(message) {
    const errorDiv = document.getElementById('password-error');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

async function loadConfig() {
    try {
        const result = await window.electronAPI.adminGetConfig();
        if (result.success) {
            currentConfig = result.config;
            populateConfigForm(result.config);
            populateProjectorSettings(result.config);
        } else {
            showConfigMessage(`Failed to load config: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Failed to load config:', error);
        showConfigMessage(`Error loading configuration: ${error.message}`, 'error');
    }
}

function populateConfigForm(config) {
    document.getElementById('spaceId').value = config.spaceId || '';
    document.getElementById('locationId').value = config.locationId || '';
    document.getElementById('apiBaseUrl').value = config.apiBaseUrl || '';
    document.getElementById('kioskApiKey').value = config.kioskApiKey || '';
    document.getElementById('shellyIP').value = config.shellyIP || '';
    document.getElementById('timezone').value = config.timezone || '';

    // Extension settings
    const ext = config.extensionSettings || { enabled: true, triggerMinutes: 5, options: [15, 30, 45, 60] };
    document.getElementById('extensionEnabled').checked = ext.enabled !== false;
    document.getElementById('extensionTriggerMinutes').value = ext.triggerMinutes || 5;
    document.getElementById('extensionOpt15').checked = (ext.options || []).includes(15);
    document.getElementById('extensionOpt30').checked = (ext.options || []).includes(30);
    document.getElementById('extensionOpt45').checked = (ext.options || []).includes(45);
    document.getElementById('extensionOpt60').checked = (ext.options || []).includes(60);

    // League mode settings
    const league = config.leagueSettings || { enabled: false, leagueId: '' };
    document.getElementById('leagueModeEnabled').checked = league.enabled === true;
    document.getElementById('leagueId').value = league.leagueId || '';

}

function populateProjectorSettings(config) {
    const proj = config.projectorSettings || { enabled: false, comPort: '', baudRate: 115200, powerOnCmd: '\\r*pow=on#\\r', powerOffCmd: '\\r*pow=off#\\r', preStartMinutes: 5, keepAliveGapMinutes: 60 };
    const appMgr = config.appManagerSettings || { enabled: true };
    const isAutoOn = proj.enabled || appMgr.enabled !== false;

    document.getElementById('autoOnOff-switch').checked = isAutoOn;
    document.getElementById('projector-settings-panel').style.display = isAutoOn ? 'block' : 'none';
    const saveFooter = document.getElementById('projector-save-footer');
    if (saveFooter) saveFooter.style.display = isAutoOn ? 'flex' : 'none';

    document.getElementById('projectorComPort').value = proj.comPort || '';
    document.getElementById('projectorBaudRate').value = String(proj.baudRate || 115200);
    document.getElementById('projectorPowerOnCmd').value = proj.powerOnCmd || '\\r*pow=on#\\r';
    document.getElementById('projectorPowerOffCmd').value = proj.powerOffCmd || '\\r*pow=off#\\r';
    document.getElementById('projectorPreStartMinutes').value = proj.preStartMinutes || 5;
    document.getElementById('projectorKeepAliveGap').value = proj.keepAliveGapMinutes || 60;
}

function toggleConfigEdit() {
    const inputs = document.querySelectorAll('#config-form input, #config-form select');
    const toggleBtn = document.getElementById('config-toggle-btn');
    const btnIcon = document.getElementById('config-btn-icon');
    const btnText = document.getElementById('config-btn-text');

    if (isEditMode) {
        saveConfig();
    } else {
        isEditMode = true;
        inputs.forEach(input => input.disabled = false);
        
        toggleBtn.className = 'btn btn-primary btn-block';
        toggleBtn.style.marginTop = '20px';
        toggleBtn.style.padding = '16px';
        toggleBtn.style.background = 'linear-gradient(135deg, #F59E0B, #D97706)';
        btnIcon.innerHTML = '<path d="M15,9H5V5H15M12,19A3,3 0 0,1 9,16A3,3 0 0,1 12,13A3,3 0 0,1 15,16A3,3 0 0,1 12,19M17,3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V7L17,3Z"/>';
        btnText.textContent = 'Save Config';
        
        clearConfigMessage();
    }
}

async function saveConfig() {
    try {
        // Build extension options array from checkboxes
        const extOptions = [];
        if (document.getElementById('extensionOpt15').checked) extOptions.push(15);
        if (document.getElementById('extensionOpt30').checked) extOptions.push(30);
        if (document.getElementById('extensionOpt45').checked) extOptions.push(45);
        if (document.getElementById('extensionOpt60').checked) extOptions.push(60);

        const newConfig = {
            spaceId: document.getElementById('spaceId').value.trim(),
            locationId: document.getElementById('locationId').value.trim(),
            apiBaseUrl: document.getElementById('apiBaseUrl').value.trim(),
            kioskApiKey: document.getElementById('kioskApiKey').value.trim(),
            shellyIP: document.getElementById('shellyIP').value.trim(),
            timezone: document.getElementById('timezone').value.trim(),
            extensionSettings: {
                enabled: document.getElementById('extensionEnabled').checked,
                triggerMinutes: parseInt(document.getElementById('extensionTriggerMinutes').value) || 5,
                options: extOptions
            },
            leagueSettings: {
                enabled: document.getElementById('leagueModeEnabled').checked,
                leagueId: document.getElementById('leagueId').value.trim()
            },
            // Preserve existing projector/app manager settings from current config
            projectorSettings: currentConfig.projectorSettings || { enabled: false, comPort: '', baudRate: 115200, powerOnCmd: '\\r*pow=on#\\r', powerOffCmd: '\\r*pow=off#\\r', preStartMinutes: 5, keepAliveGapMinutes: 60 },
            appManagerSettings: currentConfig.appManagerSettings || { enabled: true }
        };

        const result = await window.electronAPI.adminSaveConfig(newConfig);
        
        if (result.success) {
            currentConfig = newConfig;
            
            isEditMode = false;
            const inputs = document.querySelectorAll('#config-form input, #config-form select');
            inputs.forEach(input => input.disabled = true);
            
            const toggleBtn = document.getElementById('config-toggle-btn');
            const btnIcon = document.getElementById('config-btn-icon');
            const btnText = document.getElementById('config-btn-text');
            
            toggleBtn.className = 'btn btn-primary btn-block';
            toggleBtn.style.marginTop = '20px';
            toggleBtn.style.padding = '16px';
            toggleBtn.style.background = '';
            btnIcon.innerHTML = '<path d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>';
            btnText.textContent = 'Edit Config';
            
            showConfigMessage(`✅ ${result.message}${result.requiresRestart ? '\n⚠️ Application restart required for full effect.' : ''}`, 'success');
            
        } else {
            showConfigMessage(`❌ Failed to save config: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Save config failed:', error);
        showConfigMessage(`❌ Error saving configuration: ${error.message}`, 'error');
    }
}

function showConfigMessage(message, type) {
    const messageDiv = document.getElementById('config-message');
    messageDiv.className = type === 'error' ? 'error-message' : 'success-message';
    messageDiv.innerHTML = message.replace(/\n/g, '<br>');
    
    if (type === 'success') {
        setTimeout(() => {
            clearConfigMessage();
        }, 5000);
    }
}

function clearConfigMessage() {
    const messageDiv = document.getElementById('config-message');
    messageDiv.innerHTML = '';
    messageDiv.className = '';
}

async function changePassword() {
    const currentPassword = document.getElementById('current-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const messageDiv = document.getElementById('password-change-message');

    // Clear previous messages
    messageDiv.innerHTML = '';
    messageDiv.className = '';

    // Validation
    if (!currentPassword) {
        messageDiv.className = 'error-message';
        messageDiv.textContent = 'Please enter your current password';
        return;
    }

    if (!newPassword) {
        messageDiv.className = 'error-message';
        messageDiv.textContent = 'Please enter a new password';
        return;
    }

    if (newPassword.length < 4) {
        messageDiv.className = 'error-message';
        messageDiv.textContent = 'New password must be at least 4 characters';
        return;
    }

    if (newPassword !== confirmPassword) {
        messageDiv.className = 'error-message';
        messageDiv.textContent = 'New passwords do not match';
        return;
    }

    if (currentPassword === newPassword) {
        messageDiv.className = 'error-message';
        messageDiv.textContent = 'New password must be different from current password';
        return;
    }

    try {
        const result = await window.electronAPI.adminChangePassword(currentPassword, newPassword);

        if (result.success) {
            messageDiv.className = 'success-message';
            messageDiv.textContent = '✅ ' + result.message;
            
            // Clear the form
            document.getElementById('current-password').value = '';
            document.getElementById('new-password').value = '';
            document.getElementById('confirm-password').value = '';

            setTimeout(() => {
                messageDiv.innerHTML = '';
                messageDiv.className = '';
            }, 5000);
        } else {
            messageDiv.className = 'error-message';
            messageDiv.textContent = '❌ ' + result.error;
        }
    } catch (error) {
        console.error('Password change failed:', error);
        messageDiv.className = 'error-message';
        messageDiv.textContent = '❌ Error: ' + error.message;
    }
}

async function refreshLogs() {
    try {
        const logs = await window.electronAPI.getLogs();
        renderLogs(logs);
    } catch (error) {
        console.error('Failed to load logs:', error);
    }
}

async function clearLogs() {
    if (await adminConfirm('Are you sure you want to clear all logs?')) {
        try {
            await window.electronAPI.clearLogs();
            renderLogs([]);
        } catch (error) {
            console.error('Failed to clear logs:', error);
        }
    }
}

function renderLogs(logs) {
    const container = document.getElementById('console-container');
    const countEl = document.getElementById('log-count');
    
    countEl.textContent = `${logs.length} entries`;
    
    if (logs.length === 0) {
        container.innerHTML = '<div class="console-empty">No logs available.</div>';
        return;
    }

    container.innerHTML = logs.map(entry => {
        const time = new Date(entry.time).toLocaleTimeString();
        return `
            <div class="console-entry ${entry.level}">
                <span class="console-time">${time}</span>
                <span class="console-level">${entry.level}</span>
                <span class="console-message">${escapeHtml(entry.message)}</span>
            </div>
        `;
    }).join('');

    container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Booking Info functions
function parseTimeString(timeString) {
    // Parse time strings like "12:45 AM" or "1:00 PM"
    const [time, modifier] = timeString.split(' ');
    let [hours, minutes] = time.split(':').map(Number);
    if (modifier === 'PM' && hours < 12) hours += 12;
    if (modifier === 'AM' && hours === 12) hours = 0;
    
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
}

async function loadBookingInfo() {
    try {
        const bookings = await window.electronAPI.getBookings();
        cachedBookings = bookings;
        renderBookings(bookings);
    } catch (error) {
        console.error('Failed to load bookings:', error);
        document.getElementById('booking-list').innerHTML = '<div class="no-bookings">Error loading bookings</div>';
    }
}

function renderBookings(bookings) {
    const listEl = document.getElementById('booking-list');
    const totalEl = document.getElementById('total-bookings');
    const timeUntilEl = document.getElementById('time-until-next');
    
    const now = new Date();
    
    // Sort bookings by start time (prefer ISO timestamps for cross-midnight accuracy)
    const sortedBookings = [...bookings].sort((a, b) => {
        const aStart = a.startTimeISO ? new Date(a.startTimeISO) : parseTimeString(a.startTime);
        const bStart = b.startTimeISO ? new Date(b.startTimeISO) : parseTimeString(b.startTime);
        return aStart - bStart;
    });
    
    // Categorize bookings (prefer ISO timestamps for cross-midnight accuracy)
    const activeBookings = sortedBookings.filter(b => {
        const start = b.startTimeISO ? new Date(b.startTimeISO) : parseTimeString(b.startTime);
        const end = b.endTimeISO ? new Date(b.endTimeISO) : parseTimeString(b.endTime);
        return now >= start && now <= end;
    });

    const upcomingBookings = sortedBookings.filter(b => {
        const start = b.startTimeISO ? new Date(b.startTimeISO) : parseTimeString(b.startTime);
        return start > now;
    });
    
    totalEl.textContent = bookings.length;
    
    // Calculate time until next booking
    if (activeBookings.length > 0) {
        timeUntilEl.textContent = 'NOW';
        timeUntilEl.className = 'info-card-value highlight';
    } else if (upcomingBookings.length > 0) {
        const nextBooking = upcomingBookings[0];
        const nextStart = nextBooking.startTimeISO ? new Date(nextBooking.startTimeISO) : parseTimeString(nextBooking.startTime);
        const timeUntil = nextStart - now;
        timeUntilEl.textContent = formatDuration(timeUntil);
        timeUntilEl.className = 'info-card-value warning';
    } else {
        timeUntilEl.textContent = 'No upcoming';
        timeUntilEl.className = 'info-card-value';
    }
    
    // Render booking list
    if (sortedBookings.length === 0) {
        listEl.innerHTML = '<div class="no-bookings">No bookings loaded for this space</div>';
        return;
    }
    
    let html = '';
    
    // Show active bookings first
    activeBookings.forEach(booking => {
        html += renderBookingItem(booking, 'active');
    });
    
    // Then upcoming bookings
    upcomingBookings.slice(0, 5).forEach(booking => {
        html += renderBookingItem(booking, 'upcoming');
    });
    
    listEl.innerHTML = html || '<div class="no-bookings">No active or upcoming bookings</div>';
}

function renderBookingItem(booking, status) {
    const start = booking.startTimeISO ? new Date(booking.startTimeISO) : parseTimeString(booking.startTime);
    const end = booking.endTimeISO ? new Date(booking.endTimeISO) : parseTimeString(booking.endTime);

    return `
        <div class="booking-item ${status}">
            <span class="booking-status ${status}">${status === 'active' ? 'Active Now' : 'Upcoming'}</span>
            <div class="booking-time">
                ${start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} - ${end.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
            </div>
        </div>
    `;
}

function formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    return `${minutes}m`;
}

async function triggerManualUnlock() {
    const durationMinutes = parseInt(document.getElementById('unlock-duration').value);
    const warningEl = document.getElementById('unlock-warning');
    const successEl = document.getElementById('unlock-success');
    
    warningEl.style.display = 'none';
    successEl.style.display = 'none';
    
    const now = new Date();
    const unlockEnd = new Date(now.getTime() + durationMinutes * 60 * 1000);
    
    // Check for any booking conflicts (active or upcoming)
    const conflicts = cachedBookings.filter(b => {
        const bookingStart = b.startTimeISO ? new Date(b.startTimeISO) : parseTimeString(b.startTime);
        const bookingEnd = b.endTimeISO ? new Date(b.endTimeISO) : parseTimeString(b.endTime);
        // Check if unlock period overlaps with booking
        return (now < bookingEnd && unlockEnd > bookingStart);
    });

    if (conflicts.length > 0) {
        const conflict = conflicts[0];
        const conflictStart = conflict.startTimeISO ? new Date(conflict.startTimeISO) : parseTimeString(conflict.startTime);
        const conflictEnd = conflict.endTimeISO ? new Date(conflict.endTimeISO) : parseTimeString(conflict.endTime);
        
        // Check if there's an active booking vs future conflict
        const isActiveBooking = now >= conflictStart && now <= conflictEnd;
        
        if (isActiveBooking) {
            // There's currently an active booking
            const timeRemaining = Math.floor((conflictEnd - now) / 60000);
            warningEl.textContent = `❌ Cannot unlock: There's an active booking right now (${timeRemaining} minutes remaining). The screen is already unlocked for this session.`;
        } else {
            // There's a future booking that would conflict
            const timeUntilConflict = Math.floor((conflictStart - now) / 60000);
            warningEl.textContent = `❌ Cannot unlock: There's a booking starting in ${timeUntilConflict} minutes. Your ${durationMinutes} minute unlock would overlap with it.`;
        }
        
        warningEl.style.display = 'block';
        return;
    }
    
    await executeManualUnlock(durationMinutes);
}

let isUnlockInProgress = false;

async function executeManualUnlock(durationMinutes) {
    if (isUnlockInProgress) return;
    isUnlockInProgress = true;

    const warningEl = document.getElementById('unlock-warning');
    const successEl = document.getElementById('unlock-success');
    
    warningEl.style.display = 'none';
    
    try {
        const result = await window.electronAPI.manualUnlock(durationMinutes);
        
        if (result.success) {
            successEl.textContent = `✅ ${result.message}`;
            successEl.style.display = 'block';
            setTimeout(() => { successEl.style.display = 'none'; }, 5000);
        } else {
            warningEl.textContent = `❌ Failed: ${result.error}`;
            warningEl.style.display = 'block';
        }
    } catch (error) {
        console.error('Manual unlock failed:', error);
        warningEl.textContent = `❌ Error: ${error.message}`;
        warningEl.style.display = 'block';
    } finally {
        setTimeout(() => { isUnlockInProgress = false; }, 1000);
    }
}

// System Info functions
async function loadSystemInfo() {
    try {
        const versionInfo = await window.electronAPI.getVersion();
        document.getElementById('app-version').textContent = `v${versionInfo.version}`;
        document.getElementById('app-full-name').textContent = versionInfo.name || 'Golf Labs Kiosk';
        document.getElementById('app-description').textContent = versionInfo.description || 'Kiosk Application';
    } catch (error) {
        console.error('Failed to load version info:', error);
    }
}

async function clearCache() {
    const messageEl = document.getElementById('cache-message');
    
    if (!await adminConfirm('This will clear all cached bookings and request fresh data. Continue?')) {
        return;
    }
    
    try {
        const result = await window.electronAPI.clearCache();
        messageEl.className = 'success-message';
        messageEl.textContent = `✅ ${result.message}`;
        
        // Refresh booking info if we're on that page
        cachedBookings = [];
        
        setTimeout(() => { messageEl.textContent = ''; messageEl.className = ''; }, 5000);
    } catch (error) {
        console.error('Clear cache failed:', error);
        messageEl.className = 'error-message';
        messageEl.textContent = `❌ Error: ${error.message}`;
    }
}
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('password-input').focus();
});

const manualUnlockSwitch = document.getElementById('manual-unlock-switch');

window.electronAPI.getManualUnlockState().then(state => {
    manualUnlockSwitch.checked = state.unlocked;
});

manualUnlockSwitch.addEventListener('change', (event) => {
    const isUnlocked = event.target.checked;
    window.electronAPI.setManualUnlockState(isUnlocked).then(result => {
    });
});

// --- Projector / Auto On/Off ---

function toggleAutoOnOff() {
    const isEnabled = document.getElementById('autoOnOff-switch').checked;
    document.getElementById('projector-settings-panel').style.display = isEnabled ? 'block' : 'none';
    const saveFooter = document.getElementById('projector-save-footer');
    if (saveFooter) saveFooter.style.display = isEnabled ? 'flex' : 'none';

    if (!isEnabled) {
        // Save immediately when toggling off
        saveAutoOnOffState(false);
    }
}

async function saveAutoOnOffState(enabled) {
    try {
        const newConfig = {
            ...currentConfig,
            projectorSettings: {
                ...(currentConfig.projectorSettings || {}),
                enabled: enabled
            },
            appManagerSettings: {
                enabled: enabled
            }
        };

        const result = await window.electronAPI.adminSaveConfig(newConfig);
        if (result.success) {
            currentConfig = newConfig;
            showProjectorMessage(enabled ? '✅ Auto On/Off enabled' : '✅ Auto On/Off disabled', 'success');
        } else {
            showProjectorMessage(`❌ Failed to save: ${result.error}`, 'error');
        }
    } catch (error) {
        showProjectorMessage(`❌ Error: ${error.message}`, 'error');
    }
}

async function saveProjectorSettings() {
    try {
        const newConfig = {
            ...currentConfig,
            projectorSettings: {
                enabled: true,
                comPort: document.getElementById('projectorComPort').value.trim(),
                baudRate: parseInt(document.getElementById('projectorBaudRate').value) || 115200,
                powerOnCmd: document.getElementById('projectorPowerOnCmd').value.trim(),
                powerOffCmd: document.getElementById('projectorPowerOffCmd').value.trim(),
                preStartMinutes: parseInt(document.getElementById('projectorPreStartMinutes').value) || 5,
                keepAliveGapMinutes: parseInt(document.getElementById('projectorKeepAliveGap').value) || 60
            },
            appManagerSettings: {
                enabled: true
            }
        };

        const result = await window.electronAPI.adminSaveConfig(newConfig);
        if (result.success) {
            currentConfig = newConfig;
            showProjectorMessage(`✅ ${result.message}${result.requiresRestart ? ' Restart required.' : ''}`, 'success');
        } else {
            showProjectorMessage(`❌ Failed to save: ${result.error}`, 'error');
        }
    } catch (error) {
        showProjectorMessage(`❌ Error: ${error.message}`, 'error');
    }
}

async function testProjectorConnection() {
    try {
        const result = await window.electronAPI.adminTestProjector();
        if (result.success) {
            showProjectorMessage(result.message, 'success');
        } else {
            showProjectorMessage(result.error, 'error');
        }
    } catch (error) {
        showProjectorMessage(`Error: ${error.message}`, 'error');
    }
}

function showProjectorMessage(message, type) {
    const messageDiv = document.getElementById('projector-settings-message');
    if (!messageDiv) return;
    messageDiv.className = type === 'error' ? 'error-message' : 'success-message';
    messageDiv.innerHTML = message;
    if (type === 'success') {
        setTimeout(() => {
            messageDiv.innerHTML = '';
            messageDiv.className = '';
        }, 5000);
    }
}