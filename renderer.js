const lockScreen = document.getElementById('lock-screen');
const unlockScreen = document.getElementById('unlock-screen');
const countdown = document.getElementById('countdown');
const refreshButton = document.getElementById('refresh-button');

let config;
let currentBooking = null;
let stateCheckInterval = null;
let countdownInterval = null;
let isCurrentlyLocked = null; // Use null to ensure the first call always runs

const POLLING_INTERVAL_MS = 60 * 1000; // 60 seconds

function setLockedState(isLocked, booking = null) {
    if (isCurrentlyLocked === isLocked) {
        return; // State is already correct, do nothing.
    }
    isCurrentlyLocked = isLocked;

    // Always clear the existing interval to avoid multiple timers running
    if (stateCheckInterval) {
        clearInterval(stateCheckInterval);
        stateCheckInterval = null;
    }

    if (isLocked) {
        lockScreen.style.display = 'flex';
        unlockScreen.style.display = 'none';
        currentBooking = null;
        if(countdownInterval) clearInterval(countdownInterval);
        
        // Start polling for new bookings only when locked.
        console.log(`Locking screen. Starting polling every ${POLLING_INTERVAL_MS / 1000}s.`);
        stateCheckInterval = setInterval(() => {
            window.electronAPI.refreshBookings().then(checkForActiveBooking);
        }, POLLING_INTERVAL_MS);

    } else {
        lockScreen.style.display = 'none';
        unlockScreen.style.display = 'block';
        currentBooking = booking;
        
        // Stop polling while unlocked (already handled by clearing at the top)
        console.log("Unlocking screen. Polling stopped.");
        
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
        console.log("No active booking found.");
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
    
    // 3. Check the initial bookings and set the correct state, which will also start the polling timer.
    checkForActiveBooking(initialBookings);
}

// Start the application.
initialize();

// Listen for updates pushed from the main process
window.electronAPI.onBookingsUpdated((bookings) => {
    // This listener is now effectively unused on startup, but could be useful in the future.
    console.log('Received booking updates from main process.');
    checkForActiveBooking(bookings);
}); 