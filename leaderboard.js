// =====================================================
// LEADERBOARD TV DISPLAY
// Real-time leaderboard powered by Socket.io events
// =====================================================

let leaderboardData = [];
let leagueInfo = null;
let refreshInterval = null;  // Track interval to prevent duplicates
let activeLeagueId = null;   // Track which league we're polling

async function initialize() {
    console.log('Leaderboard display initializing...');

    // Get league settings from config
    const settings = await window.electronAPI.getLeagueSettings();

    if (!settings || !settings.enabled || !settings.leagueId) {
        document.getElementById('lb-subtitle').textContent = 'League mode not configured';
        return;
    }

    activeLeagueId = settings.leagueId;

    // Fetch league metadata for header info (no userId required)
    const info = await window.electronAPI.getLeagueInfo();
    if (info) {
        leagueInfo = info;
        document.getElementById('lb-title').textContent = info.name || 'League Leaderboard';

        // Build subtitle from available fields on the league record
        const parts = [];
        if (info.current_week_number) {
            parts.push(`Week ${info.current_week_number}`);
        }
        if (info.current_week_date) {
            parts.push(formatDate(info.current_week_date));
        }
        if (info.course_name) {
            const par = info.total_par ? ` (Par ${info.total_par})` : '';
            parts.push(`${info.course_name}${par}`);
        }
        document.getElementById('lb-subtitle').textContent = parts.length > 0 ? parts.join(' — ') : '';
    }

    // Fetch initial leaderboard
    await refreshLeaderboard();

    // Listen for real-time updates (onSafe in preload prevents stacking)
    window.electronAPI.onLeagueScoreUpdate(handleScoreUpdate);
    window.electronAPI.onLeagueStandingsUpdate(handleStandingsUpdate);

    // Refresh every 60 seconds as fallback — clear previous interval first
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
    refreshInterval = setInterval(refreshLeaderboard, 60000);
}

async function refreshLeaderboard() {
    if (!activeLeagueId) return;
    try {
        leaderboardData = await window.electronAPI.getLeagueLeaderboard(activeLeagueId);
        renderLeaderboard();
    } catch (err) {
        console.error('Leaderboard refresh failed:', err);
    }
}

function renderLeaderboard() {
    const body = document.getElementById('lb-table-body');

    if (!leaderboardData || leaderboardData.length === 0) {
        body.innerHTML = '<div style="text-align: center; padding: 60px; color: rgba(255,255,255,0.3); font-size: 20px;">Waiting for scores...</div>';
        return;
    }

    body.innerHTML = leaderboardData.map(entry => `
        <div class="lb-row" data-player-id="${entry.playerId}">
            <div class="lb-col-rank">${entry.rank}</div>
            <div class="lb-col-player">
                <div class="lb-player-name">${entry.displayName}</div>
                <div class="lb-player-hcp">HCP ${entry.handicap}</div>
            </div>
            <div class="lb-col-number">${entry.todayGross || '-'}</div>
            <div class="lb-col-number">${entry.todayNet || '-'}</div>
            <div class="lb-col-thru">${entry.thru > 0 ? `${entry.thru}/${entry.totalHoles}` : '-'}</div>
            <div class="lb-col-season">${entry.seasonGross || '-'}</div>
            <div class="lb-col-number" style="font-size: 18px; color: rgba(255,255,255,0.6);">${entry.weeksPlayed}</div>
        </div>
    `).join('');

    document.getElementById('lb-last-update').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function handleScoreUpdate(payload) {
    console.log('Live score update received:', payload);

    // Update the data in-place
    const existing = leaderboardData.find(e => e.playerId === payload.player.id);
    if (existing) {
        existing.todayGross = payload.roundGross;
        existing.thru = payload.holesCompleted;
    } else {
        leaderboardData.push({
            rank: leaderboardData.length + 1,
            playerId: payload.player.id,
            displayName: payload.player.displayName,
            handicap: payload.player.handicap,
            todayGross: payload.roundGross,
            todayNet: payload.roundGross - payload.player.handicap,
            thru: payload.holesCompleted,
            totalHoles: payload.totalHoles,
            seasonGross: 0,
            seasonNet: 0,
            weeksPlayed: 0,
        });
    }

    // Re-sort
    leaderboardData.sort((a, b) => {
        if (a.thru > 0 && b.thru === 0) return -1;
        if (a.thru === 0 && b.thru > 0) return 1;
        if (a.thru > 0 && b.thru > 0) return a.todayGross - b.todayGross;
        return a.rank - b.rank;
    });

    leaderboardData.forEach((e, i) => e.rank = i + 1);

    renderLeaderboard();

    // Highlight the updated row briefly
    setTimeout(() => {
        const row = document.querySelector(`[data-player-id="${payload.player.id}"]`);
        if (row) {
            row.classList.add('updated');
            setTimeout(() => row.classList.remove('updated'), 2000);
        }
    }, 50);
}

function handleStandingsUpdate(payload) {
    console.log('Standings update received:', payload);
    // Full refresh from server — just re-fetch data, don't re-initialize
    // (calling initialize() again would stack intervals and re-register listeners)
    refreshLeaderboard();
}

function formatDate(dateString) {
    try {
        const date = new Date(dateString + 'T00:00:00');
        return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    } catch {
        return dateString;
    }
}

// Start
initialize();
