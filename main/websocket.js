const { io } = require('socket.io-client');
const axios = require('axios');
const { scheduleFromBookings } = require('./projector');
const { onSessionEnd } = require('./app-manager');

/**
 * Fully tear down an existing socket connection — remove all listeners,
 * disable reconnection so it doesn't try to reconnect in the background,
 * and disconnect. This prevents orphaned socket.io clients from lingering
 * in memory when we create a new connection (e.g., admin-triggered reconnect).
 */
function disconnectWebSocket(ctx) {
  if (ctx.socket) {
    console.log('Cleaning up existing WebSocket connection...');
    ctx.socket.removeAllListeners();
    ctx.socket.io.opts.reconnection = false; // prevent background reconnection
    ctx.socket.disconnect();
    ctx.socket = null;
  }
}

function connectToWebSocket(ctx) {
  if (!ctx.config) return;

  // Always clean up any existing socket before creating a new one
  disconnectWebSocket(ctx);

  const { locationId, spaceId, apiBaseUrl, kioskApiKey } = ctx.config;
  const apiHeaders = { 'X-Kiosk-Key': kioskApiKey || '' };
  console.log(`Connecting to WebSocket server at ${apiBaseUrl}`);

  ctx.socket = io(apiBaseUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket'],
    auth: { kioskKey: kioskApiKey || '' },
  });

  ctx.socket.on('connect', () => {
    console.log(`WebSocket connected: ${ctx.socket.id}`);
    console.log(`Registering kiosk for location: ${locationId}, space: ${spaceId}`);
    ctx.socket.emit('register_kiosk', { locationId, spaceId });

    ctx.socket.emit('request_initial_bookings', { locationId, spaceId });

    if (ctx.config.leagueSettings && ctx.config.leagueSettings.enabled && ctx.config.leagueSettings.leagueId) {
      console.log(`League mode enabled. Joining league room for league: ${ctx.config.leagueSettings.leagueId}`);
      ctx.socket.emit('register_league', { locationId, leagueId: ctx.config.leagueSettings.leagueId });
    }
  });

  ctx.socket.on('disconnect', (reason) => {
    console.log(`WebSocket disconnected: ${reason}`);
  });

  ctx.socket.on('connect_error', (error) => {
    console.error(`WebSocket connection error: ${error.message}`);
  });

  ctx.socket.on('auth_error', (payload) => {
    console.error(`Kiosk authentication error: ${payload.message}. Check kioskApiKey in config.`);
  });

  ctx.socket.on('bookings_updated', (payload) => {
    console.log('Received full bookings refresh:', payload);
    if (payload.spaceId === ctx.config.spaceId) {
      const bookings = payload.bookings;
      if (!Array.isArray(bookings)) {
        console.warn('[WebSocket] Received invalid bookings_updated payload — skipping');
        return;
      }
      ctx.bookings = bookings;
      [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('bookings-updated', ctx.bookings);
        }
      });
      // Re-evaluate projector schedule with new bookings
      scheduleFromBookings(ctx);
    }
  });
  
  ctx.socket.on('booking_update', (payload) => {
    console.log('Received single booking update:', payload);
    if (!payload || !payload.booking) {
      console.warn('[WebSocket] Received invalid booking_update payload — skipping');
      return;
    }
    if (payload.spaceId === ctx.config.spaceId) {
      if (!Array.isArray(ctx.bookings)) {
        ctx.bookings = [];
      }
      const index = ctx.bookings.findIndex(b => b.id === payload.booking.id);

      if (payload.action === 'add') {
        if (index === -1) {
          ctx.bookings.push(payload.booking);
        } else {
          ctx.bookings[index] = payload.booking;
        }
      } else if (payload.action === 'remove') {
        if (index !== -1) {
          ctx.bookings.splice(index, 1);
        }
      }
      
      [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('bookings-updated', ctx.bookings);
        }
      });
      // Re-evaluate projector schedule with updated bookings
      scheduleFromBookings(ctx);
    }
  });

  ctx.socket.on('league_score_update', (payload) => {
    console.log('Received league score update:', payload);
    [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('league-score-update', payload);
      }
    });
  });

  ctx.socket.on('league_standings_update', (payload) => {
    console.log('Received league standings update:', payload);
    [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('league-standings-update', payload);
      }
    });
  });

  ctx.socket.on('league_mode_changed', (payload) => {
    console.log('Received league_mode_changed:', payload);
    
    if (payload.spaceId && payload.spaceId !== ctx.config.spaceId) {
      console.log(`League mode change is for space ${payload.spaceId}, not us (${ctx.config.spaceId}). Ignoring.`);
      return;
    }

    if (!ctx.config.leagueSettings) {
      ctx.config.leagueSettings = {};
    }
    ctx.config.leagueSettings.enabled = payload.active;
    ctx.config.leagueSettings.leagueId = payload.leagueId || null;

    console.log(`League mode ${payload.active ? 'ACTIVATED' : 'DEACTIVATED'} remotely. LeagueId: ${payload.leagueId}`);

    if (payload.active && payload.leagueId) {
      ctx.socket.emit('register_league', { locationId: ctx.config.locationId, leagueId: payload.leagueId });
    }

    // Send to all windows — all screens unlock/lock, but only the league display shows the picker UI
    [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
      if (window && !window.isDestroyed()) {
        window.webContents.send('league-mode-changed', payload);
      }
    });
  });

  ctx.socket.on('unlock', async (payload, ack) => {
    console.log('Received unlock command:', payload);
    const respond = (response) => {
        if (typeof ack === 'function') {
            ack(response);
        }
    };
    
    if (payload.spaceId !== ctx.config.spaceId) {
      const message = `Unlock command is for space ${payload.spaceId}, but we are space ${ctx.config.spaceId}. Ignoring.`;
      console.log(message);
      respond({ success: false, error: message });
      return;
    }

    const { duration, bookingId, locationId } = payload;
    const unlockStartTime = Date.now();
    
    try {
      console.log(`Executing door unlock for ${duration} seconds...`);
      
      const shellyIP = ctx.config.shellyIP;
      const shellyUrl = `http://${shellyIP}/rpc`;
      
      const requestBody = {
        id: 1,
        method: "Switch.Set",
        params: {
          id: 0,
          on: true,
          toggle_after: duration
        }
      };
      
      const response = await axios.post(shellyUrl, requestBody, { timeout: 20000 });

      const responseTime = Date.now() - unlockStartTime;
      
      if (response.status !== 200 || (response.data && response.data.error)) {
        const errorMessage = response.data.error ? JSON.stringify(response.data.error) : `Shelly API responded with status ${response.status}`;
        throw new Error(errorMessage);
      }

      const result = response.data;
      console.log('Shelly switch response:', result);

      const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId);
      // Skip kiosk access log for employee unlocks - the API already creates one with employee identity
      if (isValidUUID) {
        const logData = {
          location_id: locationId,
          space_id: ctx.config.spaceId,
          booking_id: bookingId,
          action: 'door_unlock_success',
          success: true,
          ip_address: shellyIP,
          user_agent: 'Kiosk',
          unlock_method: 'email_link',
          response_time_ms: responseTime,
          metadata: {
            shelly_response: result,
            unlock_duration: duration,
            shelly_url: shellyUrl,
            shelly_request: requestBody
          }
        };

        axios.post(`${ctx.config.apiBaseUrl}/logs/access`, logData, { headers: apiHeaders })
          .then(() => console.log('Successfully logged unlock success'))
          .catch(logError => console.error('Failed to log unlock success:', logError.message));
      }

      console.log(`Door successfully unlocked for ${duration} seconds`);
      respond({ success: true, message: 'Door unlocked successfully' });

    } catch (error) {
      console.error('Error executing door unlock:', error);
      
      const responseTime = Date.now() - unlockStartTime;
      
      const isFailUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId);
      const logData = {
        location_id: locationId,
        space_id: ctx.config.spaceId,
        booking_id: isFailUUID ? bookingId : null,
        action: 'door_unlock_failure',
        success: false,
        error_message: error.message,
        ip_address: ctx.config.shellyIP,
        user_agent: 'Kiosk',
        unlock_method: isFailUUID ? 'email_link' : 'employee_dashboard',
        response_time_ms: responseTime,
        metadata: {
          error_details: error.toString(),
          unlock_duration: duration,
          attempted_url: `http://${ctx.config.shellyIP}/rpc`,
          attempted_request: {
            id: 1,
            method: "Switch.Set",
            params: {
              id: 0,
              on: true,
              toggle_after: duration
            }
          }
        }
      };

      axios.post(`${ctx.config.apiBaseUrl}/logs/access`, logData, { headers: apiHeaders })
        .then(() => console.log('Successfully logged unlock failure'))
        .catch(logError => console.error('Failed to log unlock failure:', logError.message));
        
      respond({ success: false, error: error.message });
    }
  });
}

function setupPolling(ctx) {
    // Clear any existing polling interval to prevent duplicates
    if (ctx.pollingInterval) {
        clearInterval(ctx.pollingInterval);
        ctx.pollingInterval = null;
    }
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    ctx.pollingInterval = setInterval(() => {
        if (ctx.socket && ctx.socket.connected) {
            console.log('Polling for full booking refresh...');
            ctx.socket.emit('request_initial_bookings', {
                locationId: ctx.config.locationId,
                spaceId: ctx.config.spaceId
            });
        }
    }, SIX_HOURS);
}

module.exports = { connectToWebSocket, disconnectWebSocket, setupPolling };
