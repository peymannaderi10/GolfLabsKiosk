const lockScreen = document.getElementById('lock-screen');
const unlockScreen = document.getElementById('unlock-screen');
const countdown = document.getElementById('countdown');

let config;
let currentBooking = null;
let countdownInterval = null;
let localCheckInterval = null;
let isCurrentlyLocked = null;
let localBookings = []; // This is now the definitive in-memory store for the renderer
let heartbeatInterval = null;
let isManuallyUnlocked = false;
let manualUnlockEndTime = null; // Track when timed unlock expires

// Session extension state machine
// States: idle | loading | showing | confirming | processing | declined
let extensionState = 'idle';
let extensionOptions = null; // Cached options from API
let extensionCardInfo = null; // Cached card info from API
let selectedExtension = null; // Currently selected option { minutes, priceCents, priceFormatted }
let isProcessingRemoteState = false; // Prevent broadcast loops

// Broadcast extension state to all screens
function broadcastExtensionState(state, extra = {}) {
    if (isProcessingRemoteState) return; // Don't re-broadcast received state
    window.electronAPI.broadcastExtensionState({
        state,
        options: extensionOptions,
        cardInfo: extensionCardInfo,
        selected: selectedExtension,
        ...extra
    });
}

const LOCAL_CHECK_INTERVAL_MS = 5000;  // Check every 5 seconds

function logAccessEvent(action, success, booking = null) {
    // Do not log session events for manual admin overrides
    if (booking && booking.id === 'manual-override') {
        console.log("Skipping access log for manual override action.");
        return;
    }

    if (!config) {
        console.error("Cannot log access event: config is not loaded.");
        return;
    }

    const logData = {
        action: action,
        success: success,
        bay_id: config.bayId,
        location_id: config.locationId,
        booking_id: booking ? booking.id : undefined,
        user_id: booking ? booking.userId : undefined,
    };

    console.log("Logging access event:", logData);
    window.electronAPI.logAccess(logData).catch(err => {
        console.error("Failed to send access log from renderer:", err);
    });
}

function setLockedState(isLocked, booking = null) {
    if (isCurrentlyLocked === isLocked) {
        return; // State is already correct, do nothing.
    }
    isCurrentlyLocked = isLocked;

    // Tell the main process to make the window click-through when unlocked
    window.electronAPI.setIgnoreMouseEvents(!isLocked);

    // Clear existing intervals for local check and countdown (not heartbeat - that should always run)
    if (localCheckInterval) {
        clearInterval(localCheckInterval);
        localCheckInterval = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    // Note: heartbeat interval is NOT cleared here - it should continue running regardless of lock state

    if (isLocked) {
        lockScreen.style.display = 'flex';
        unlockScreen.style.display = 'none';
        
        // Reset extension state when screen locks
        resetExtensionState();

        if (currentBooking) {
            logAccessEvent('session_ended', true, currentBooking);
        }
        currentBooking = null;
        
        // Bring all kiosk windows to the foreground when locking
        // This ensures the lock screen is always visible, even if another app was fullscreen
        window.electronAPI.bringToForeground();
        
        // Polling is removed. We now rely on the high-frequency local check and pushed updates.
        console.log(`Locking screen. Starting high-frequency local check every ${LOCAL_CHECK_INTERVAL_MS / 1000}s.`);
        localCheckInterval = setInterval(() => {
            checkForActiveBooking(localBookings);
        }, LOCAL_CHECK_INTERVAL_MS);

        // Hide league UI when screen locks (no active booking)
        loadLeagueForCurrentBooking();

    } else {
        lockScreen.style.display = 'none';
        unlockScreen.style.display = 'block';
        currentBooking = booking;
        
        console.log("Unlocking screen. Local check stopped.");
        
        logAccessEvent('session_started', true, booking);

        updateCountdown();
        if(countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(updateCountdown, 1000);

        // Resolve league player from this booking's userId
        loadLeagueForCurrentBooking();
    }
}

function parseTime(timeString) {
    const [time, modifier] = timeString.split(' ');
    let [hours, minutes] = time.split(':').map(Number);
    if (modifier === 'PM' && hours < 12) hours += 12;
    if (modifier === 'AM' && hours === 12) hours = 0;
    
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
}

function checkForActiveBooking(bookings) {
    // Priority 1: Check for manual override
    if (isManuallyUnlocked) {
        setLockedState(false, {
            id: 'manual-override',
            startTime: 'N/A',
            endTime: 'N/A',
            endTimeISO: manualUnlockEndTime, // Store raw ISO timestamp for accurate countdown
            user: { name: 'Admin Override' }
        });
        return;
    }

    // Priority 2: Proceed with normal booking logic
    if (!config || !bookings) return;

    const now = new Date();
    const activeBooking = bookings.find(b => {
        if (b.bayId !== config.bayId) return false;
        // Only consider confirmed bookings - ignore abandoned, cancelled, etc.
        if (b.status !== 'confirmed') return false;
        
        const startTime = parseTime(b.startTime);
        const endTime = parseTime(b.endTime);

        return now >= startTime && now < endTime;
    });

    if (activeBooking) {
        console.log("Active booking found:", activeBooking);
        
        // Check if booking details changed (e.g., extension updated the endTime)
        if (currentBooking && currentBooking.id === activeBooking.id) {
            // Same booking - check if endTime changed
            if (currentBooking.endTime !== activeBooking.endTime) {
                console.log(`Booking extended: ${currentBooking.endTime} -> ${activeBooking.endTime}`);
                currentBooking = activeBooking;
                // Reset extension state so user can extend again if eligible
                resetExtensionState();
            }
        }
        
        setLockedState(false, activeBooking);
    } else {
        setLockedState(true);
    }
}

function updateCountdown() {
    if (!currentBooking) return;

    const now = new Date();
    // Use ISO timestamp if available (for manual override), otherwise parse the formatted time
    const endTime = currentBooking.endTimeISO 
        ? new Date(currentBooking.endTimeISO) 
        : parseTime(currentBooking.endTime);
    const diff = endTime - now;

    if (diff <= 0) {
        countdown.textContent = 'Time expired';
        clearInterval(countdownInterval);
        setLockedState(true);
        return;
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    let countdownText = '';
    if (hours > 0) {
        countdownText += `${hours}h ${minutes}m ${seconds}s`;
    } else if (minutes > 0) {
        countdownText += `${minutes}m ${seconds}s`;
    } else {
        countdownText += `${seconds}s`;
    }

    countdown.textContent = countdownText;

    // --- Extension upsell trigger ---
    checkExtensionTrigger(diff);
}

// =====================================================
// SESSION EXTENSION STATE MACHINE
// =====================================================

function getExtensionSettings() {
    if (!config || !config.extensionSettings) {
        return { enabled: false, triggerMinutes: 5, options: [15, 30, 60] };
    }
    return config.extensionSettings;
}

function checkExtensionTrigger(diffMs) {
    const settings = getExtensionSettings();
    if (!settings.enabled) return;
    if (!currentBooking || currentBooking.id === 'manual-override') return;
    if (extensionState !== 'idle') return;

    const triggerMs = settings.triggerMinutes * 60 * 1000;
    if (diffMs > triggerMs) return;

    // Quick local check: is there enough gap for at least 15 min?
    const currentEndTime = currentBooking.endTimeISO
        ? new Date(currentBooking.endTimeISO)
        : parseTime(currentBooking.endTime);

    const nextBooking = localBookings.find(b => {
        if (b.id === currentBooking.id) return false;
        if (b.bayId !== config.bayId) return false;
        // Only consider confirmed bookings as blocking
        if (b.status !== 'confirmed') return false;
        const bStart = parseTime(b.startTime);
        // Use >= to catch back-to-back bookings (next starts exactly when current ends)
        return bStart >= currentEndTime;
    });

    if (nextBooking) {
        const nextStart = parseTime(nextBooking.startTime);
        const gapMinutes = (nextStart - currentEndTime) / (1000 * 60);
        if (gapMinutes < 15) {
            console.log(`Extension skipped: only ${gapMinutes.toFixed(0)} min gap before next booking.`);
            extensionState = 'declined';
            return;
        }
    }

    // Trigger the extension flow
    console.log('Extension trigger reached. Fetching options...');
    extensionState = 'loading';
    fetchExtensionOptions();
}

async function fetchExtensionOptions() {
    try {
        const result = await window.electronAPI.getExtensionOptions(currentBooking.id);
        console.log('Extension options received:', result);

        if (!result.options || result.options.length === 0) {
            console.log('No extension options available.');
            extensionState = 'declined';
            return;
        }

        extensionOptions = result.options;
        extensionCardInfo = result.card;
        extensionState = 'showing';
        showExtensionBanner();
        
        // Broadcast to other screens
        broadcastExtensionState('showing');

        // Log that we offered the extension
        logAccessEvent('extension_offered', true, currentBooking);
    } catch (error) {
        console.error('Failed to fetch extension options:', error);
        extensionState = 'declined';
    }
}

function showExtensionBanner() {
    const banner = document.getElementById('extension-banner');
    const optionsContainer = document.getElementById('extension-options');

    // Build option buttons
    optionsContainer.innerHTML = '';

    if (!extensionCardInfo) {
        // No card on file - show message
        optionsContainer.innerHTML = '<div class="extension-no-card">Visit the front desk to extend your session</div>';
    } else {
        extensionOptions.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'extension-option-btn';
            btn.innerHTML = `<span class="option-duration">${opt.minutes} min</span><span class="option-price">${opt.priceFormatted}</span>`;
            btn.addEventListener('click', () => selectExtensionOption(opt));
            optionsContainer.appendChild(btn);
        });
    }

    banner.classList.remove('extension-hidden');

    // Wire up dismiss button
    document.getElementById('extension-dismiss-btn').onclick = dismissExtension;

    // Re-enable mouse events on the window so the banner is interactive
    window.electronAPI.setIgnoreMouseEvents(false);
}

function selectExtensionOption(option) {
    selectedExtension = option;
    extensionState = 'confirming';

    // Hide the banner, show confirmation
    document.getElementById('extension-banner').classList.add('extension-hidden');

    const brandLabel = extensionCardInfo.brand
        ? extensionCardInfo.brand.charAt(0).toUpperCase() + extensionCardInfo.brand.slice(1)
        : 'Card';

    document.getElementById('extension-confirm-detail').textContent =
        `Add ${option.minutes} minutes for ${option.priceFormatted}`;
    document.getElementById('extension-confirm-card-info').textContent =
        `Charging ${brandLabel} ending in ${extensionCardInfo.last4}`;

    document.getElementById('extension-confirm').classList.remove('extension-hidden');

    document.getElementById('extension-confirm-btn').onclick = confirmExtension;
    document.getElementById('extension-cancel-btn').onclick = dismissExtension;
    
    // Broadcast to other screens
    broadcastExtensionState('confirming');
}

async function confirmExtension() {
    if (!selectedExtension || !currentBooking) return;

    extensionState = 'processing';
    document.getElementById('extension-confirm').classList.add('extension-hidden');

    const statusEl = document.getElementById('extension-status');
    const statusText = document.getElementById('extension-status-text');
    statusText.textContent = 'Processing payment...';
    statusText.classList.remove('error');
    statusEl.classList.remove('extension-hidden');
    
    // Broadcast processing state
    broadcastExtensionState('processing', { statusText: 'Processing payment...' });

    try {
        const result = await window.electronAPI.extendBooking(
            currentBooking.id,
            selectedExtension.minutes
        );
        console.log('Extension successful:', result);

        const successMsg = `Extended! ${selectedExtension.minutes} min added.`;
        statusText.textContent = successMsg;
        
        // Broadcast success state
        broadcastExtensionState('success', { statusText: successMsg });

        // Brief success message, then hide
        setTimeout(() => {
            statusEl.classList.add('extension-hidden');
            resetExtensionState();
            // Make window click-through again since the extension UI is gone
            window.electronAPI.setIgnoreMouseEvents(true);
            // Broadcast reset to idle
            broadcastExtensionState('idle');
        }, 2000);

        // The WebSocket booking_update event will push the new endTime
        // and checkForActiveBooking will update currentBooking automatically.

    } catch (error) {
        console.error('Extension failed:', error);
        const errorMsg = error.message || 'Extension failed. Visit the front desk.';
        statusText.textContent = errorMsg;
        statusText.classList.add('error');
        
        // Broadcast error state
        broadcastExtensionState('error', { statusText: errorMsg });

        logAccessEvent('extension_payment_failed', false, currentBooking);

        setTimeout(() => {
            statusEl.classList.add('extension-hidden');
            extensionState = 'declined';
            // Restore click-through
            window.electronAPI.setIgnoreMouseEvents(true);
            // Broadcast declined state
            broadcastExtensionState('declined');
        }, 4000);
    }
}

function dismissExtension() {
    console.log('Extension dismissed by user.');
    extensionState = 'declined';

    document.getElementById('extension-banner').classList.add('extension-hidden');
    document.getElementById('extension-confirm').classList.add('extension-hidden');
    document.getElementById('extension-status').classList.add('extension-hidden');

    logAccessEvent('extension_declined', true, currentBooking);

    // Restore click-through
    window.electronAPI.setIgnoreMouseEvents(true);

    selectedExtension = null;
    extensionOptions = null;
    extensionCardInfo = null;
    
    // Broadcast to other screens
    broadcastExtensionState('declined');
}

function resetExtensionState() {
    extensionState = 'idle';
    selectedExtension = null;
    extensionOptions = null;
    extensionCardInfo = null;

    // Hide all extension UI
    const banner = document.getElementById('extension-banner');
    const confirm = document.getElementById('extension-confirm');
    const status = document.getElementById('extension-status');
    if (banner) banner.classList.add('extension-hidden');
    if (confirm) confirm.classList.add('extension-hidden');
    if (status) status.classList.add('extension-hidden');
}

// --- Main Application Logic ---

lockScreen.style.display = 'flex';
unlockScreen.style.display = 'none';

async function initialize() {
    console.log("Initializing renderer...");
    
    config = await window.electronAPI.getConfig();
    console.log('Config loaded:', config);
    
    // Get the initial manual unlock state from the main process
    const unlockState = await window.electronAPI.getManualUnlockState();
    isManuallyUnlocked = unlockState.unlocked;
    manualUnlockEndTime = unlockState.endTime;
    
    // Get the initial bookings from the main process's memory.
    const initialBookings = await window.electronAPI.getInitialBookings();
    localBookings = initialBookings;
    
    // Set the correct state, which will also start the high-frequency local check.
    checkForActiveBooking(localBookings);

    // Start the heartbeat interval. This logic is unchanged.
    startHeartbeat();
    
    // Listen for extension state updates from other screens
    window.electronAPI.onExtensionStateUpdate(handleRemoteExtensionState);
}

// Handle extension state broadcast from another screen
function handleRemoteExtensionState(stateData) {
    console.log('Received extension state from another screen:', stateData.state);
    isProcessingRemoteState = true;
    
    // Update local state
    extensionState = stateData.state;
    extensionOptions = stateData.options;
    extensionCardInfo = stateData.cardInfo;
    selectedExtension = stateData.selected;
    
    // Update UI based on state
    switch (stateData.state) {
        case 'showing':
            showExtensionBanner();
            break;
        case 'confirming':
            // Show confirmation UI with the selected option
            document.getElementById('extension-banner').classList.add('extension-hidden');
            if (selectedExtension && extensionCardInfo) {
                const brandLabel = extensionCardInfo.brand
                    ? extensionCardInfo.brand.charAt(0).toUpperCase() + extensionCardInfo.brand.slice(1)
                    : 'Card';
                document.getElementById('extension-confirm-detail').textContent =
                    `Add ${selectedExtension.minutes} minutes for ${selectedExtension.priceFormatted}`;
                document.getElementById('extension-confirm-card-info').textContent =
                    `Charging ${brandLabel} ending in ${extensionCardInfo.last4}`;
                document.getElementById('extension-confirm').classList.remove('extension-hidden');
                document.getElementById('extension-confirm-btn').onclick = confirmExtension;
                document.getElementById('extension-cancel-btn').onclick = dismissExtension;
            }
            window.electronAPI.setIgnoreMouseEvents(false);
            break;
        case 'processing':
            document.getElementById('extension-confirm').classList.add('extension-hidden');
            document.getElementById('extension-status-text').textContent = stateData.statusText || 'Processing payment...';
            document.getElementById('extension-status-text').classList.remove('error');
            document.getElementById('extension-status').classList.remove('extension-hidden');
            break;
        case 'success':
            document.getElementById('extension-status-text').textContent = stateData.statusText || 'Extended!';
            document.getElementById('extension-status-text').classList.remove('error');
            document.getElementById('extension-status').classList.remove('extension-hidden');
            break;
        case 'error':
            document.getElementById('extension-status-text').textContent = stateData.statusText || 'Extension failed.';
            document.getElementById('extension-status-text').classList.add('error');
            document.getElementById('extension-status').classList.remove('extension-hidden');
            break;
        case 'declined':
        case 'idle':
            // Hide all extension UI
            document.getElementById('extension-banner').classList.add('extension-hidden');
            document.getElementById('extension-confirm').classList.add('extension-hidden');
            document.getElementById('extension-status').classList.add('extension-hidden');
            window.electronAPI.setIgnoreMouseEvents(true);
            break;
    }
    
    isProcessingRemoteState = false;
}

function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    sendHeartbeat();
    const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60 seconds - more frequent for accurate dashboard status
    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    console.log(`Heartbeat service started. Checking in every ${HEARTBEAT_INTERVAL_MS / 1000}s.`);
}

function sendHeartbeat() {
    if (!config || !config.bayId) {
        console.error("Cannot send heartbeat: config or bayId is missing.");
        return;
    }
    console.log("Sending heartbeat...");
    window.electronAPI.sendHeartbeat(config.bayId)
        .then(response => {
            console.log("Heartbeat successful:", response);
        })
        .catch(error => {
            console.error("Heartbeat failed:", error);
        });
}

// Start the application.
initialize();

// Listen for real-time updates pushed from the main process via WebSocket
window.electronAPI.onBookingsUpdated((updatedBookings) => {
    console.log('Received booking updates from main process via WebSocket.');
    localBookings = updatedBookings; // Update the entire local cache
    checkForActiveBooking(localBookings);
});

// Listen for manual unlock state changes
window.electronAPI.onManualUnlockStateChanged((newState, endTime) => {
    console.log(`Manual unlock state changed to: ${newState}, endTime: ${endTime}`);
    isManuallyUnlocked = newState;
    manualUnlockEndTime = endTime;
    checkForActiveBooking(localBookings); // Re-evaluate lock state immediately
});

// =====================================================
// LEAGUE MODE — Score Entry System
// =====================================================

let leagueSettings = null;
let leagueState = null;
let leagueSelectedScores = {};    // Map of playerId -> selected score for their current hole
let leagueActiveCell = null;      // { playerId, holeNumber } currently being edited
let leaguePanelOpen = false;
let leagueSubmitting = false;
let leagueMiniLeaderboard = [];
let leagueInitialized = false;    // true once event listeners are attached
let leagueActiveUserId = null;    // tracks which booking user we've loaded for

async function initializeLeagueMode() {
    leagueSettings = await window.electronAPI.getLeagueSettings();

    if (!leagueSettings || !leagueSettings.enabled || !leagueSettings.leagueId) {
        console.log('League mode is disabled or not configured.');
        return;
    }

    console.log('League mode enabled. Waiting for active booking to detect player...');

    // One-time event listener setup
    if (!leagueInitialized) {
        leagueInitialized = true;

        const bookmark = document.getElementById('league-bookmark');
        bookmark.addEventListener('click', openLeaguePanel);
        document.getElementById('league-close-btn').addEventListener('click', closeLeaguePanel);
        document.getElementById('league-submit-btn').addEventListener('click', submitLeagueScore);
        document.getElementById('league-summary-close').addEventListener('click', closeRoundSummary);

        // Make the bookmark clickable even when the window ignores mouse events.
        // setIgnoreMouseEvents(true, { forward: true }) forwards mouse-move so CSS :hover works.
        // On mouseenter we temporarily capture clicks; on mouseleave we restore pass-through.
        // We attach to the top-right-bar container so the whole area is interactive.
        const topBar = document.getElementById('top-right-bar');
        if (topBar) {
            topBar.addEventListener('mouseenter', () => {
                if (!isCurrentlyLocked && !leaguePanelOpen) {
                    window.electronAPI.setIgnoreMouseEvents(false);
                }
            });
            topBar.addEventListener('mouseleave', () => {
                if (!isCurrentlyLocked && !leaguePanelOpen) {
                    window.electronAPI.setIgnoreMouseEvents(true);
                }
            });
        }

        window.electronAPI.onLeagueScoreUpdate(handleLeagueScoreUpdate);
        window.electronAPI.onLeagueStandingsUpdate(handleLeagueStandingsUpdate);
    }

    // Attempt to load for the current booking's user
    await loadLeagueForCurrentBooking();
}

/**
 * Returns the list of players to enter scores for.
 * If the API returned a teammates array (team mode), use that.
 * Otherwise, build a single-element array from the main player fields.
 */
function getLeaguePlayers() {
    if (!leagueState) return [];
    if (leagueState.teammates && leagueState.teammates.length > 1) {
        return leagueState.teammates;
    }
    if (leagueState.player) {
        return [{
            id: leagueState.player.id,
            displayName: leagueState.player.displayName,
            handicap: leagueState.player.handicap,
            scores: leagueState.scores,
            nextHole: leagueState.nextHole,
            roundComplete: leagueState.roundComplete,
        }];
    }
    return [];
}

/**
 * Called whenever the active booking changes. Resolves the league player
 * from the booking's userId and fetches the league state.
 */
async function loadLeagueForCurrentBooking() {
    if (!leagueSettings || !leagueSettings.enabled) return;

    const userId = currentBooking?.userId || null;

    // If no active booking or no userId, hide league UI
    if (!userId) {
        hideLeagueUI();
        leagueActiveUserId = null;
        leagueState = null;
        return;
    }

    // Don't re-fetch if we already loaded for this exact user
    if (userId === leagueActiveUserId && leagueState) return;

    leagueActiveUserId = userId;
    console.log(`League mode: Resolving player for booking userId ${userId}`);

    // Fetch league state using the booking's userId
    leagueState = await window.electronAPI.getLeagueState(userId);

    if (!leagueState || !leagueState.week) {
        console.log('No active league week. League bookmark hidden.');
        hideLeagueUI();
        return;
    }

    if (!leagueState.player) {
        console.log('User is not enrolled in this league. League bookmark hidden.');
        hideLeagueUI();
        return;
    }

    // Check if ALL players have completed their rounds
    const players = getLeaguePlayers();
    const allComplete = players.length > 0 && players.every(p => p.roundComplete);
    if (allComplete) {
        console.log('Round already complete for all players.');
        hideLeagueUI();
        return;
    }

    // Show the bookmark tab
    document.getElementById('league-bookmark').classList.remove('league-hidden');

    // Fetch initial mini leaderboard
    fetchMiniLeaderboard();

    const names = players.map(p => p.displayName).join(', ');
    console.log(`League mode ready. Players: ${names}`);
}

function hideLeagueUI() {
    document.getElementById('league-bookmark').classList.add('league-hidden');
    document.getElementById('league-score-panel').classList.add('league-hidden');
    document.getElementById('league-round-summary').classList.add('league-hidden');
    if (leaguePanelOpen) {
        leaguePanelOpen = false;
        if (!isCurrentlyLocked) {
            window.electronAPI.setIgnoreMouseEvents(true);
        }
    }
}

function openLeaguePanel() {
    if (leaguePanelOpen) return;
    leaguePanelOpen = true;
    leagueSelectedScores = {};
    leagueActiveCell = null;

    // Make window interactive
    window.electronAPI.setIgnoreMouseEvents(false);

    // Hide bookmark, show panel
    document.getElementById('league-bookmark').classList.add('league-hidden');
    document.getElementById('league-score-panel').classList.remove('league-hidden');

    // Hide the score picker until a cell is tapped
    document.getElementById('league-score-picker').classList.add('league-hidden');
    document.getElementById('league-submit-btn').classList.add('league-hidden');

    renderScorecard();
    updateMiniLeaderboard();
}

function renderScorecard() {
    const players = getLeaguePlayers();
    const numHoles = leagueState.league?.numHoles || 9;
    const holePars = leagueState.course?.holePars || [];

    const table = document.getElementById('league-scorecard');
    table.innerHTML = '';

    // Header row: Hole numbers
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const cornerTh = document.createElement('th');
    cornerTh.className = 'sc-corner';
    cornerTh.textContent = 'Hole';
    headerRow.appendChild(cornerTh);
    for (let h = 1; h <= numHoles; h++) {
        const th = document.createElement('th');
        th.className = 'sc-hole-num';
        th.textContent = h;
        headerRow.appendChild(th);
    }
    const totalTh = document.createElement('th');
    totalTh.className = 'sc-total-header';
    totalTh.textContent = 'Tot';
    headerRow.appendChild(totalTh);
    thead.appendChild(headerRow);

    // Par row
    const parRow = document.createElement('tr');
    parRow.className = 'sc-par-row';
    const parLabel = document.createElement('td');
    parLabel.className = 'sc-player-name sc-par-label';
    parLabel.textContent = 'Par';
    parRow.appendChild(parLabel);
    let totalPar = 0;
    for (let h = 1; h <= numHoles; h++) {
        const td = document.createElement('td');
        td.className = 'sc-cell sc-par-cell';
        const par = holePars[h - 1];
        td.textContent = par !== undefined ? par : '-';
        if (par) totalPar += par;
        parRow.appendChild(td);
    }
    const parTotalTd = document.createElement('td');
    parTotalTd.className = 'sc-cell sc-total-cell';
    parTotalTd.textContent = totalPar || '-';
    parRow.appendChild(parTotalTd);
    thead.appendChild(parRow);
    table.appendChild(thead);

    // Player rows
    const tbody = document.createElement('tbody');
    players.forEach(player => {
        const row = document.createElement('tr');
        row.className = 'sc-player-row';

        const nameTd = document.createElement('td');
        nameTd.className = 'sc-player-name';
        nameTd.textContent = player.displayName;
        row.appendChild(nameTd);

        // Build a lookup for this player's existing scores
        const scoreMap = {};
        (player.scores || []).forEach(s => { scoreMap[s.hole_number] = s.strokes; });

        let playerTotal = 0;

        for (let h = 1; h <= numHoles; h++) {
            const td = document.createElement('td');
            td.className = 'sc-cell';

            if (scoreMap[h] !== undefined) {
                // Already entered
                td.textContent = scoreMap[h];
                td.classList.add('sc-filled');
                playerTotal += scoreMap[h];

                // Color relative to par
                const par = holePars[h - 1];
                if (par) {
                    if (scoreMap[h] < par) td.classList.add('sc-under');
                    else if (scoreMap[h] === par) td.classList.add('sc-on-par');
                    else td.classList.add('sc-over');
                }
            } else if (h === player.nextHole && !player.roundComplete) {
                // Current hole to enter -- interactive cell
                const pendingScore = leagueSelectedScores[player.id];
                td.textContent = pendingScore !== undefined ? pendingScore : '-';
                td.classList.add('sc-current');
                if (pendingScore !== undefined) {
                    td.classList.add('sc-pending');
                    playerTotal += pendingScore;
                }
                td.addEventListener('click', () => openScorePicker(player, h, td));
            } else {
                // Future hole
                td.textContent = '';
                td.classList.add('sc-future');
            }

            row.appendChild(td);
        }

        const totalTd = document.createElement('td');
        totalTd.className = 'sc-cell sc-total-cell';
        totalTd.textContent = playerTotal > 0 ? playerTotal : '-';
        row.appendChild(totalTd);

        tbody.appendChild(row);
    });
    table.appendChild(tbody);
}

function openScorePicker(player, holeNumber, cellElement) {
    leagueActiveCell = { playerId: player.id, holeNumber };

    // Highlight active cell
    document.querySelectorAll('.sc-cell.sc-active').forEach(el => el.classList.remove('sc-active'));
    cellElement.classList.add('sc-active');

    const holePars = leagueState.course?.holePars || [];
    const par = holePars[holeNumber - 1] || null;

    // Update picker label
    const label = document.getElementById('league-picker-label');
    label.textContent = `${player.displayName} — Hole ${holeNumber}` + (par ? ` (Par ${par})` : '');

    // Build picker buttons
    const container = document.getElementById('league-picker-buttons');
    container.innerHTML = '';
    for (let i = 1; i <= 10; i++) {
        const btn = document.createElement('button');
        btn.className = 'league-picker-btn';
        btn.textContent = i;

        if (par !== null) {
            if (i < par) btn.classList.add('league-score-under');
            else if (i === par) btn.classList.add('league-score-par');
            else btn.classList.add('league-score-over');
        }

        if (leagueSelectedScores[player.id] === i) {
            btn.classList.add('selected');
        }

        btn.addEventListener('click', () => pickScore(player.id, i));
        container.appendChild(btn);
    }

    document.getElementById('league-score-picker').classList.remove('league-hidden');
}

function pickScore(playerId, score) {
    leagueSelectedScores[playerId] = score;
    leagueActiveCell = null;

    // Hide picker
    document.getElementById('league-score-picker').classList.add('league-hidden');

    // Re-render scorecard to reflect the new pending score
    renderScorecard();

    // Show submit button when ALL active players have a pending score
    const activePlayers = getLeaguePlayers().filter(p => !p.roundComplete);
    const allSelected = activePlayers.every(p => leagueSelectedScores[p.id] !== undefined);
    if (allSelected) {
        document.getElementById('league-submit-btn').classList.remove('league-hidden');
    }
}

function closeLeaguePanel() {
    leaguePanelOpen = false;
    leagueSelectedScores = {};
    leagueActiveCell = null;

    document.getElementById('league-score-panel').classList.add('league-hidden');
    document.getElementById('league-score-picker').classList.add('league-hidden');

    // Show bookmark again (unless all rounds are complete)
    const players = getLeaguePlayers();
    const allComplete = players.length > 0 && players.every(p => p.roundComplete);
    if (!allComplete) {
        document.getElementById('league-bookmark').classList.remove('league-hidden');
    }

    // Restore click-through if screen is unlocked
    if (!isCurrentlyLocked) {
        window.electronAPI.setIgnoreMouseEvents(true);
    }
}

async function submitLeagueScore() {
    if (leagueSubmitting) return;

    const players = getLeaguePlayers().filter(p => !p.roundComplete);
    const allSelected = players.every(p => leagueSelectedScores[p.id] !== undefined);
    if (!allSelected) return;

    leagueSubmitting = true;

    const submitBtn = document.getElementById('league-submit-btn');
    submitBtn.textContent = 'Submitting...';
    submitBtn.disabled = true;

    try {
        const results = [];

        for (const player of players) {
            const strokes = leagueSelectedScores[player.id];
            const scoreData = {
                leagueWeekId: leagueState.week.id,
                leaguePlayerId: player.id,
                holeNumber: player.nextHole,
                strokes,
                bayId: config.bayId,
                enteredVia: 'kiosk',
            };

            const result = await window.electronAPI.submitLeagueScore(leagueSettings.leagueId, scoreData);
            console.log(`Score submitted for ${player.displayName}:`, result);
            results.push({ player, result, strokes });
        }

        // Update state for each player
        // Note: save holeNumber before mutating, since player and tm may be the same reference
        let lastCompleteGross = 0;

        for (const { player, result, strokes } of results) {
            const submittedHole = result.holes_entered; // the hole we just submitted (1-based count)

            if (leagueState.teammates && leagueState.teammates.length > 1) {
                const tm = leagueState.teammates.find(t => t.id === player.id);
                if (tm) {
                    tm.scores.push({ hole_number: submittedHole, strokes });
                    if (result.round_complete) {
                        tm.roundComplete = true;
                        lastCompleteGross = result.round_gross;
                    } else {
                        tm.nextHole = result.holes_entered + 1;
                    }
                }
            } else {
                leagueState.scores.push({ hole_number: submittedHole, strokes });
                if (result.round_complete) {
                    leagueState.roundComplete = true;
                    lastCompleteGross = result.round_gross;
                } else {
                    leagueState.nextHole = result.holes_entered + 1;
                }
            }
        }

        // Close the panel after submit
        closeLeaguePanel();

        // Check if ALL players are now complete
        const allPlayers = getLeaguePlayers();
        const allComplete = allPlayers.length > 0 && allPlayers.every(p => p.roundComplete);
        if (allComplete) {
            document.getElementById('league-bookmark').classList.add('league-hidden');
            showRoundSummary(lastCompleteGross);
        }

    } catch (error) {
        console.error('Failed to submit scores:', error);
        showLeagueToast('Error submitting scores!');
    } finally {
        leagueSubmitting = false;
        submitBtn.textContent = 'Submit Scores';
        submitBtn.disabled = false;
    }
}

function showLeagueToast(message) {
    const toast = document.getElementById('league-toast');
    document.getElementById('league-toast-content').textContent = message;
    toast.classList.remove('league-hidden');

    setTimeout(() => {
        toast.classList.add('league-hidden');
    }, 2500);
}

function showRoundSummary(grossScore) {
    const handicap = leagueState.player?.handicap || 0;
    const netScore = Math.round((grossScore - handicap) * 10) / 10;

    document.getElementById('league-summary-gross').textContent = grossScore;
    document.getElementById('league-summary-net').textContent = netScore;
    document.getElementById('league-summary-rank').textContent = '--'; // Will update from leaderboard

    document.getElementById('league-round-summary').classList.remove('league-hidden');

    // Make window interactive for the summary
    window.electronAPI.setIgnoreMouseEvents(false);
}

function closeRoundSummary() {
    document.getElementById('league-round-summary').classList.add('league-hidden');

    // Restore click-through
    if (!isCurrentlyLocked) {
        window.electronAPI.setIgnoreMouseEvents(true);
    }
}

async function fetchMiniLeaderboard() {
    if (!leagueSettings || !leagueSettings.leagueId) return;

    try {
        leagueMiniLeaderboard = await window.electronAPI.getLeagueLeaderboard(leagueSettings.leagueId);
        updateMiniLeaderboard();
    } catch (error) {
        console.error('Failed to fetch mini leaderboard:', error);
    }
}

function updateMiniLeaderboard() {
    const list = document.getElementById('league-mini-list');
    if (!list) return;

    const top5 = (leagueMiniLeaderboard || []).slice(0, 5);

    if (top5.length === 0) {
        list.innerHTML = '<div style="color: rgba(255,255,255,0.4); font-size: 13px; padding: 8px;">No scores yet</div>';
        return;
    }

    list.innerHTML = top5.map(entry => {
        const isMe = entry.playerId === leagueState?.player?.id;
        return `
            <div class="league-mini-row ${isMe ? 'highlight' : ''}">
                <span class="league-mini-rank">${entry.rank}</span>
                <span class="league-mini-name">${entry.displayName}</span>
                <span class="league-mini-score">${entry.todayGross || '-'}</span>
                <span class="league-mini-thru">${entry.thru > 0 ? `thru ${entry.thru}` : ''}</span>
            </div>
        `;
    }).join('');
}

function handleLeagueScoreUpdate(payload) {
    console.log('Real-time league score update:', payload);

    // Update mini leaderboard in-place
    const existing = leagueMiniLeaderboard.find(e => e.playerId === payload.player.id);
    if (existing) {
        existing.todayGross = payload.roundGross;
        existing.thru = payload.holesCompleted;
    } else {
        leagueMiniLeaderboard.push({
            rank: leagueMiniLeaderboard.length + 1,
            playerId: payload.player.id,
            displayName: payload.player.displayName,
            handicap: payload.player.handicap,
            todayGross: payload.roundGross,
            todayNet: 0,
            thru: payload.holesCompleted,
            totalHoles: payload.totalHoles,
            seasonGross: 0,
            seasonNet: 0,
            weeksPlayed: 0,
        });
    }

    // Re-sort by today's gross
    leagueMiniLeaderboard.sort((a, b) => {
        if (a.thru > 0 && b.thru === 0) return -1;
        if (a.thru === 0 && b.thru > 0) return 1;
        return a.todayGross - b.todayGross;
    });

    leagueMiniLeaderboard.forEach((e, i) => e.rank = i + 1);

    updateMiniLeaderboard();
}

function handleLeagueStandingsUpdate(payload) {
    console.log('League standings update:', payload);
    // Refresh full leaderboard from server
    fetchMiniLeaderboard();
}

// Listen for remote league mode changes from the employee dashboard
window.electronAPI.onLeagueModeChanged((payload) => {
    console.log('Remote league mode change received:', payload);

    if (payload.active) {
        // League mode activated remotely
        // Update local settings in memory
        leagueSettings = {
            enabled: true,
            leagueId: payload.leagueId,
        };

        console.log('League mode ACTIVATED remotely. Re-initializing...');
        // Re-initialize league mode (will set up event listeners if not already done)
        initializeLeagueMode().then(() => {
            // If there's an active booking, try to load the league for it
            if (currentBooking) {
                leagueActiveUserId = null; // Force reload
                loadLeagueForCurrentBooking();
            }
        });
    } else {
        // League mode deactivated remotely
        console.log('League mode DEACTIVATED remotely. Hiding UI...');
        leagueSettings = { enabled: false, leagueId: null };
        leagueState = null;
        leagueActiveUserId = null;
        hideLeagueUI();
    }
});

// Initialize league mode after main initialization
// Event listeners are set up once; actual player resolution happens when a booking becomes active.
initializeLeagueMode(); 