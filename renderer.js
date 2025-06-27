const lockScreen = document.getElementById('lock-screen');
const unlockScreen = document.getElementById('unlock-screen');
const countdown = document.getElementById('countdown');
const refreshButton = document.getElementById('refresh-button');

let config;
let currentBooking = null;
let stateCheckInterval = null;
let countdownInterval = null;
let localCheckInterval = null;
let isCurrentlyLocked = null;
let localBookings = [];
let heartbeatInterval = null;

const POLLING_INTERVAL_MS = 60 * 1000; // 60 seconds
const LOCAL_CHECK_INTERVAL_MS = 1000;  // 1 second for high-precision start times

function logAccessEvent(action, success, booking = null) {
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

    // Always clear existing intervals to avoid multiple timers
    if (stateCheckInterval) {
        clearInterval(stateCheckInterval);
        stateCheckInterval = null;
    }
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
        
        // Log previous session ending, if there was one
        if (currentBooking) {
            logAccessEvent('session_ended', true, currentBooking);
        }

        currentBooking = null;
        
        // Start low-frequency API polling
        console.log(`Locking screen. Starting API polling every ${POLLING_INTERVAL_MS / 1000}s.`);
        stateCheckInterval = setInterval(() => {
            window.electronAPI.refreshBookings().then(newBookings => {
                localBookings = newBookings; // Update local cache
            });
        }, POLLING_INTERVAL_MS);

        // Start high-frequency local check
        console.log(`Starting high-frequency local check every ${LOCAL_CHECK_INTERVAL_MS / 1000}s.`);
        localCheckInterval = setInterval(() => {
            checkForActiveBooking(localBookings);
        }, LOCAL_CHECK_INTERVAL_MS);

    } else {
        lockScreen.style.display = 'none';
        unlockScreen.style.display = 'block';
        currentBooking = booking;
        
        // Polling is stopped because we cleared the intervals at the top.
        console.log("Unlocking screen. All polling stopped.");
        
        logAccessEvent('session_started', true, booking);

        updateCountdown();
        if(countdownInterval) clearInterval(countdownInterval);
        countdownInterval = setInterval(updateCountdown, 1000);
    }
}

function parseTime(timeString) {
    // This is a naive parser based on the "h:mm A" format.
    // It will need to be more robust.
    const [time, modifier] = timeString.split(' ');
    let [hours, minutes] = time.split(':').map(Number);
    if (modifier === 'PM' && hours < 12) hours += 12;
    if (modifier === 'AM' && hours === 12) hours = 0;
    
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
}

function checkForActiveBooking(bookings) {
    if (!config || !bookings) return;

    // This function is now only for checking, not for setting timers.
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
        // Set the state to locked. This will automatically start the polling interval.
        setLockedState(true);
        return;
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    countdown.textContent = `Time left: ${hours}h ${minutes}m ${seconds}s`;
}

// --- Main Application Logic ---

// Set the initial UI state visually before any logic runs
lockScreen.style.display = 'flex';
unlockScreen.style.display = 'none';

refreshButton.addEventListener('click', () => {
    console.log('Refresh clicked, fetching bookings...');
    window.electronAPI.refreshBookings().then(checkForActiveBooking);
});

// This is the main entry point for the renderer's logic.
async function initialize() {
    console.log("Initializing renderer...");
    
    // 1. Get the configuration from the main process.
    config = await window.electronAPI.getConfig();
    console.log('Config loaded:', config);
    
    // 2. Perform the single, authoritative fetch on startup.
    const initialBookings = await window.electronAPI.refreshBookings();
    localBookings = initialBookings; // Populate local cache
    
    // 3. Check the initial bookings and set the correct state, which will also start the correct timers.
    checkForActiveBooking(initialBookings);

    // 4. Start the heartbeat interval.
    startHeartbeat();
}

function startHeartbeat() {
    // Clear any existing interval
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
    }

    // Immediately send a heartbeat on startup
    sendHeartbeat();

    // Then set it to run every 5 minutes
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

// Listen for updates pushed from the main process
window.electronAPI.onBookingsUpdated((bookings) => {
    // This listener is now effectively unused on startup, but could be useful in the future.
    console.log('Received booking updates from main process.');
    checkForActiveBooking(bookings);
}); 