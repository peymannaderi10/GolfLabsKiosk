const { io } = require('socket.io-client');
const axios = require('axios');

function connectToWebSocket(ctx) {
  if (!ctx.config) return;

  const { locationId, bayId, apiBaseUrl } = ctx.config;
  console.log(`Connecting to WebSocket server at ${apiBaseUrl}`);

  ctx.socket = io(apiBaseUrl, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    transports: ['websocket'],
  });

  ctx.socket.on('connect', () => {
    console.log(`WebSocket connected: ${ctx.socket.id}`);
    console.log(`Registering kiosk for location: ${locationId}, bay: ${bayId}`);
    ctx.socket.emit('register_kiosk', { locationId, bayId });

    ctx.socket.emit('request_initial_bookings', { locationId, bayId });

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

  ctx.socket.on('bookings_updated', (payload) => {
    console.log('Received full bookings refresh:', payload);
    if (payload.bayId === ctx.config.bayId) {
      ctx.bookings = payload.bookings;
      [ctx.mainWindow, ...ctx.additionalWindows].forEach(window => {
        if (window && !window.isDestroyed()) {
          window.webContents.send('bookings-updated', ctx.bookings);
        }
      });
    }
  });
  
  ctx.socket.on('booking_update', (payload) => {
    console.log('Received single booking update:', payload);
    if (payload.bayId === ctx.config.bayId) {
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
    
    if (payload.bayId && payload.bayId !== ctx.config.bayId) {
      console.log(`League mode change is for bay ${payload.bayId}, not us (${ctx.config.bayId}). Ignoring.`);
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
    
    if (payload.bayId !== ctx.config.bayId) {
      const message = `Unlock command is for bay ${payload.bayId}, but we are bay ${ctx.config.bayId}. Ignoring.`;
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
          on: false,
          toggle_after: duration
        }
      };
      
      const response = await axios.post(shellyUrl, requestBody);

      const responseTime = Date.now() - unlockStartTime;
      
      if (response.status !== 200 || (response.data && response.data.error)) {
        const errorMessage = response.data.error ? JSON.stringify(response.data.error) : `Shelly API responded with status ${response.status}`;
        throw new Error(errorMessage);
      }

      const result = response.data;
      console.log('Shelly switch response:', result);

      const logData = {
        location_id: locationId,
        bay_id: ctx.config.bayId,
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

      axios.post(`${ctx.config.apiBaseUrl}/logs/access`, logData)
        .then(() => console.log('Successfully logged unlock success'))
        .catch(logError => console.error('Failed to log unlock success:', logError.message));

      console.log(`Door successfully unlocked for ${duration} seconds`);
      respond({ success: true, message: 'Door unlocked successfully' });

    } catch (error) {
      console.error('Error executing door unlock:', error);
      
      const responseTime = Date.now() - unlockStartTime;
      
      const logData = {
        location_id: locationId,
        bay_id: ctx.config.bayId,
        booking_id: bookingId,
        action: 'door_unlock_failure',
        success: false,
        error_message: error.message,
        ip_address: ctx.config.shellyIP,
        user_agent: 'Kiosk',
        unlock_method: 'email_link',
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
              on: false,
              toggle_after: duration
            }
          }
        }
      };

      axios.post(`${ctx.config.apiBaseUrl}/logs/access`, logData)
        .then(() => console.log('Successfully logged unlock failure'))
        .catch(logError => console.error('Failed to log unlock failure:', logError.message));
        
      respond({ success: false, error: error.message });
    }
  });
}

function setupPolling(ctx) {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    ctx.pollingInterval = setInterval(() => {
        if (ctx.socket && ctx.socket.connected) {
            console.log('Polling for full booking refresh...');
            ctx.socket.emit('request_initial_bookings', { 
                locationId: ctx.config.locationId, 
                bayId: ctx.config.bayId 
            });
        }
    }, SIX_HOURS);
}

module.exports = { connectToWebSocket, setupPolling };
