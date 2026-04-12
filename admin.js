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
 * Show a status message in the Hardware page's shared message area.
 * Used in place of alert() for monitor/websocket operation results.
 */
function showHardwareMessage(message, type) {
    const messageDiv = document.getElementById('hardware-message');
    if (!messageDiv) {
        console.log(`[hardware] ${type || 'info'}: ${message}`);
        return;
    }
    messageDiv.className = type === 'error' ? 'error-message' : 'success-message';
    messageDiv.innerHTML = message;
    if (type === 'success') {
        setTimeout(() => {
            messageDiv.innerHTML = '';
            messageDiv.className = '';
        }, 5000);
    }
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
        } else {
            showConfigMessage(`Failed to load config: ${result.error}`, 'error');
        }
    } catch (error) {
        console.error('Failed to load config:', error);
        showConfigMessage(`Error loading configuration: ${error.message}`, 'error');
    }
}

function populateConfigForm(config) {
    // Only the two identity fields remain in the admin UI after the
    // server-driven refactor. Everything else (door lock, projector,
    // extensions, league, API URL, API key) is managed from the Golf
    // Labs dashboard and shipped to the kiosk over the socket.
    document.getElementById('spaceId').value = config.spaceId || '';
    document.getElementById('locationId').value = config.locationId || '';
}

// populateProjectorSettings removed — projector config is server-managed
// from the Golf Labs dashboard now. The Auto On/Off card was removed
// from admin.html in the same pass. Any stale caller is harmless.
function populateProjectorSettings() {}

// Config save/edit removed in the server-driven refactor. All operational
// settings live in the Golf Labs dashboard now. Stubbed so any leftover
// button wiring doesn't throw.
function toggleConfigEdit() {}
async function saveConfig() {}

// Config message surface was removed with the Settings page trim in
// the server-driven refactor. loadConfig() still calls showConfigMessage
// on error paths, so we keep the functions with null guards — any leftover
// call safely no-ops instead of throwing `Cannot set properties of null`.
function showConfigMessage(message, type) {
    const messageDiv = document.getElementById('config-message');
    if (!messageDiv) {
        if (type === 'error') console.error(`[config] ${message}`);
        return;
    }
    messageDiv.className = type === 'error' ? 'error-message' : 'success-message';
    messageDiv.innerHTML = message.replace(/\n/g, '<br>');
    if (type === 'success') {
        setTimeout(() => { clearConfigMessage(); }, 5000);
    }
}

function clearConfigMessage() {
    const messageDiv = document.getElementById('config-message');
    if (!messageDiv) return;
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
        
        // Refresh booking info immediately after clearing cache
        cachedBookings = [];
        loadBookingInfo();

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
// All of these were the old local-config write path. The UI card was
// removed from admin.html as part of the server-driven refactor.
// Stubs are kept only to satisfy any lingering onclick references.
function toggleAutoOnOff() {}
async function saveAutoOnOffState() {}
async function saveProjectorSettings() {}

// testProjectorConnection + showProjectorMessage removed with the
// projector UI card. The main.js projector subsystem still exists
// and continues to use settings pushed from the dashboard.