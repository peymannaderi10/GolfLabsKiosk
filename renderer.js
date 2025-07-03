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

    // Always clear existing intervals to avoid multiple timers
    if (localCheckInterval) {
        clearInterval(localCheckInterval);
        localCheckInterval = null;
    }
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    if (isLocked) {
        lockScreen.style.display = 'flex';
        unlockScreen.style.display = 'none';
        
        if (currentBooking) {
            logAccessEvent('session_ended', true, currentBooking);
        }
        currentBooking = null;
        
        // Polling is removed. We now rely on the high-frequency local check and pushed updates.
        console.log(`Locking screen. Starting high-frequency local check every ${LOCAL_CHECK_INTERVAL_MS / 1000}s.`);
        localCheckInterval = setInterval(() => {
            checkForActiveBooking(localBookings);
        }, LOCAL_CHECK_INTERVAL_MS);

    } else {
        lockScreen.style.display = 'none';
        unlockScreen.style.display = 'block';
        currentBooking = booking;
        
        console.log("Unlocking screen. Local check stopped.");
        
        logAccessEvent('session_started', true, booking);

        updateCountdown();
        if(countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(updateCountdown, 1000);
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
            user: { name: 'Admin Override' }
        });
        return;
    }

    // Priority 2: Proceed with normal booking logic
    if (!config || !bookings) return;

    const now = new Date();
    const activeBooking = bookings.find(b => {
        if (b.bayId !== config.bayId) return false;
        
        const startTime = parseTime(b.startTime);
        const endTime = parseTime(b.endTime);

        return now >= startTime && now < endTime;
    });

    if (activeBooking) {
        console.log("Active booking found:", activeBooking);
        setLockedState(false, activeBooking);
    } else {
        setLockedState(true);
    }
}

function updateCountdown() {
    if (!currentBooking) return;

    const now = new Date();
    const endTime = parseTime(currentBooking.endTime);
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

    countdown.textContent = `Time left: ${hours}h ${minutes}m ${seconds}s`;
}

// --- Main Application Logic ---

lockScreen.style.display = 'flex';
unlockScreen.style.display = 'none';

async function initialize() {
    console.log("Initializing renderer...");
    
    config = await window.electronAPI.getConfig();
    console.log('Config loaded:', config);
    
    // Get the initial manual unlock state from the main process
    isManuallyUnlocked = await window.electronAPI.getManualUnlockState();
    
    // Get the initial bookings from the main process's memory.
    const initialBookings = await window.electronAPI.getInitialBookings();
    localBookings = initialBookings;
    
    // Set the correct state, which will also start the high-frequency local check.
    checkForActiveBooking(localBookings);

    // Start the heartbeat interval. This logic is unchanged.
    startHeartbeat();
}

function startHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }
    sendHeartbeat();
    const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
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
window.electronAPI.onManualUnlockStateChanged((newState) => {
    console.log(`Manual unlock state changed to: ${newState}`);
    isManuallyUnlocked = newState;
    checkForActiveBooking(localBookings); // Re-evaluate lock state immediately
}); 