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
let leagueActivePlayerId = null;  // tracks which player is selected in picker mode
let leaguePlayerPickerVisible = false;
let leaguePlayerSearchTimer = null;
let leagueAllPlayers = [];        // full list fetched once on open
let leagueSelectedPlayerIds = []; // multi-select: players chosen for this session

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// =====================================================
// PLAYER PICKER (used during league mode without bookings)
// =====================================================

let leagueLoadingPlayers = false;

async function showPlayerPicker() {
    if (!leagueSettings || !leagueSettings.leagueId) return;
    if (leagueLoadingPlayers) return;
    leagueLoadingPlayers = true;

    leaguePlayerPickerVisible = true;
    const picker = document.getElementById('league-player-picker');
    const searchInput = document.getElementById('league-player-search');
    picker.classList.remove('league-hidden');

    window.electronAPI.setIgnoreMouseEvents(false);

    searchInput.value = '';
    document.getElementById('league-player-list').innerHTML = '';
    renderSelectedChips();
    updateStartButton();

    // Load all players once
    try {
        leagueAllPlayers = await window.electronAPI.getLeaguePlayers(leagueSettings.leagueId, '') || [];
    } catch (err) {
        console.error('Failed to load players:', err);
        leagueAllPlayers = [];
    }

    searchInput.removeEventListener('input', handlePlayerSearch);
    searchInput.addEventListener('input', handlePlayerSearch);
    searchInput.focus();
    leagueLoadingPlayers = false;
}

function hidePlayerPicker() {
    leaguePlayerPickerVisible = false;
    document.getElementById('league-player-picker').classList.add('league-hidden');
    document.getElementById('league-player-search').removeEventListener('input', handlePlayerSearch);
}

function handlePlayerSearch(e) {
    clearTimeout(leaguePlayerSearchTimer);
    const query = e.target.value.trim().toLowerCase();
    leaguePlayerSearchTimer = setTimeout(() => {
        renderFilteredPlayers(query);
    }, 150);
}

function renderFilteredPlayers(query) {
    const list = document.getElementById('league-player-list');

    if (!query) {
        list.innerHTML = '';
        return;
    }

    const filtered = leagueAllPlayers.filter(p =>
        p.display_name.toLowerCase().includes(query) &&
        !leagueSelectedPlayerIds.includes(p.id) &&
        !p.round_complete
    );

    if (filtered.length === 0) {
        list.innerHTML = '<div class="league-player-list-empty">No players found</div>';
        return;
    }

    list.innerHTML = filtered.map(p => `
        <div class="league-player-item" data-player-id="${escapeHtml(p.id)}" data-player-name="${escapeHtml(p.display_name)}">
            <span class="league-player-name">${escapeHtml(p.display_name)}</span>
            <span class="league-player-handicap">HC ${p.current_handicap || 0}</span>
        </div>
    `).join('');

    list.querySelectorAll('.league-player-item').forEach(item => {
        item.addEventListener('click', () => {
            addPlayerToSelection(item.dataset.playerId, item.dataset.playerName);
        });
    });
}

function addPlayerToSelection(playerId) {
    if (leagueSelectedPlayerIds.includes(playerId)) return;
    leagueSelectedPlayerIds.push(playerId);
    renderSelectedChips();
    updateStartButton();

    // Clear search and results
    const searchInput = document.getElementById('league-player-search');
    searchInput.value = '';
    document.getElementById('league-player-list').innerHTML = '';
    searchInput.focus();
}

function removePlayerFromSelection(playerId) {
    leagueSelectedPlayerIds = leagueSelectedPlayerIds.filter(id => id !== playerId);
    renderSelectedChips();
    updateStartButton();
}

function renderSelectedChips() {
    const container = document.getElementById('league-selected-players');
    const selected = leagueSelectedPlayerIds.map(id => leagueAllPlayers.find(p => p.id === id)).filter(Boolean);

    container.innerHTML = selected.map(p => `
        <div class="league-selected-chip">
            ${escapeHtml(p.display_name)}
            <button class="league-selected-chip-remove" data-player-id="${escapeHtml(p.id)}">&times;</button>
        </div>
    `).join('');

    container.querySelectorAll('.league-selected-chip-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            removePlayerFromSelection(btn.dataset.playerId);
        });
    });
}

function updateStartButton() {
    const wrap = document.getElementById('league-picker-start-wrap');
    const btn = document.getElementById('league-picker-start-btn');
    if (leagueSelectedPlayerIds.length > 0) {
        wrap.classList.remove('league-hidden');
        btn.textContent = leagueSelectedPlayerIds.length === 1
            ? 'Start Scoring'
            : `Start Scoring (${leagueSelectedPlayerIds.length} players)`;
    } else {
        wrap.classList.add('league-hidden');
    }
}

async function startScoringSession() {
    if (leagueSelectedPlayerIds.length === 0) return;

    console.log(`Starting scoring session for ${leagueSelectedPlayerIds.length} player(s)`);
    hidePlayerPicker();

    try {
        // Fetch state for all selected players in parallel
        const statePromises = leagueSelectedPlayerIds.map(id =>
            window.electronAPI.getLeagueStateByPlayerId(leagueSettings.leagueId, id)
        );
        const states = await Promise.all(statePromises);

        // Use the first valid state as the base (league/course/week info)
        const baseState = states.find(s => s !== null);
        if (!baseState) {
            console.error('Failed to load league state for any player');
            showPlayerPicker();
            return;
        }

        // Build a combined teammates array from all player states
        const allPlayers = states
            .filter(s => s !== null)
            .map(s => ({
                id: s.player.id,
                displayName: s.player.displayName,
                handicap: s.player.handicap,
                scores: s.scores,
                nextHole: s.nextHole,
                roundComplete: s.roundComplete,
            }));

        // Merge into a single leagueState with all players as teammates
        leagueState = {
            ...baseState,
            teammates: allPlayers,
        };

        leagueActivePlayerId = leagueSelectedPlayerIds[0];
        document.getElementById('league-bookmark').classList.remove('league-hidden');
        openLeaguePanel();
    } catch (err) {
        console.error('Error loading league states:', err);
        showPlayerPicker();
    }
}

function returnToPlayerPicker() {
    // Full state reset
    leagueState = null;
    leagueActiveUserId = null;
    leagueActivePlayerId = null;
    leagueSelectedPlayerIds = [];
    leagueSelectedScores = {};
    leagueActiveCell = null;
    leagueSubmitting = false;
    hideLeagueUI();
    closeLeaguePanel();
    showPlayerPicker();
}

async function initializeLeagueMode() {
    leagueSettings = await window.electronAPI.getLeagueSettings();

    if (!leagueSettings || !leagueSettings.enabled || !leagueSettings.leagueId) {
        console.log('League mode is disabled or not configured.');
        return;
    }

    console.log('League mode enabled.');

    // One-time event listener setup
    if (!leagueInitialized) {
        leagueInitialized = true;

        const bookmark = document.getElementById('league-bookmark');
        bookmark.addEventListener('click', openLeaguePanel);
        document.getElementById('league-close-btn').addEventListener('click', closeLeaguePanel);
        document.getElementById('league-submit-btn').addEventListener('click', submitLeagueScore);
        document.getElementById('league-summary-close').addEventListener('click', closeRoundSummary);
        document.getElementById('league-done-btn').addEventListener('click', returnToPlayerPicker);
        document.getElementById('league-picker-start-btn').addEventListener('click', startScoringSession);

        const topBar = document.getElementById('top-right-bar');
        if (topBar) {
            topBar.addEventListener('mouseenter', () => {
                if (!isCurrentlyLocked && !leaguePanelOpen && !leaguePlayerPickerVisible) {
                    window.electronAPI.setIgnoreMouseEvents(false);
                }
            });
            topBar.addEventListener('mouseleave', () => {
                if (!isCurrentlyLocked && !leaguePanelOpen && !leaguePlayerPickerVisible) {
                    window.electronAPI.setIgnoreMouseEvents(true);
                }
            });
        }

        window.electronAPI.onLeagueScoreUpdate(handleLeagueScoreUpdate);
        window.electronAPI.onLeagueStandingsUpdate(handleLeagueStandingsUpdate);
    }

    // Branch: league mode active = show player picker, otherwise use booking-based flow
    if (isLeagueModeActive) {
        console.log('League mode active — showing player picker');
        showPlayerPicker();
    } else {
        console.log('Waiting for active booking to detect player...');
        await loadLeagueForCurrentBooking();
    }
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
    document.getElementById('league-done-btn').classList.add('league-hidden');
    if (leaguePanelOpen) {
        leaguePanelOpen = false;
        // Don't restore click-through if player picker is visible
        if (!isCurrentlyLocked && !leaguePlayerPickerVisible) {
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

    // Set panel title to course name
    const courseName = leagueState?.course?.courseName;
    document.getElementById('league-panel-title').textContent = courseName || 'Scorecard';

    // Hide the score picker until a cell is tapped
    document.getElementById('league-score-picker').classList.add('league-hidden');
    document.getElementById('league-submit-btn').classList.add('league-hidden');

    // Hide done button — all players score on the same card and submit together
    document.getElementById('league-done-btn').classList.add('league-hidden');

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
        // Build batch payload — one API call for all players
        const entries = players.map(player => ({
            leaguePlayerId: player.id,
            holeNumber: player.nextHole,
            strokes: leagueSelectedScores[player.id],
        }));

        const batchData = {
            leagueWeekId: leagueState.week.id,
            bayId: config.bayId,
            enteredVia: 'kiosk',
            entries,
        };

        const response = await window.electronAPI.submitLeagueScore(leagueSettings.leagueId, batchData);
        // Response is single result for 1 entry, array for multiple
        const resultArray = Array.isArray(response) ? response : [response];

        const results = players.map((player, i) => ({
            player,
            result: resultArray[i] || resultArray[0],
            strokes: leagueSelectedScores[player.id],
        }));

        console.log(`Scores submitted for ${players.length} player(s):`, resultArray);

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

        // Check if ALL players are now complete
        const allPlayers = getLeaguePlayers();
        const allComplete = allPlayers.length > 0 && allPlayers.every(p => p.roundComplete);
        if (allComplete) {
            closeLeaguePanel();
            document.getElementById('league-bookmark').classList.add('league-hidden');
            showRoundSummary(lastCompleteGross);
        } else {
            // Close panel, show toast, user reopens via bookmark to continue
            leagueSelectedScores = {};
            leagueActiveCell = null;
            closeLeaguePanel();
            showLeagueToast('Scores saved!');
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
    document.getElementById('league-summary-rank').textContent = '--';

    document.getElementById('league-round-summary').classList.remove('league-hidden');

    // Make window interactive for the summary
    window.electronAPI.setIgnoreMouseEvents(false);

    // Fetch leaderboard to resolve actual rank
    fetchMiniLeaderboard().then(() => {
        const playerId = leagueState?.player?.id;
        if (playerId && leagueMiniLeaderboard.length > 0) {
            const entry = leagueMiniLeaderboard.find(e => e.playerId === playerId);
            if (entry) {
                document.getElementById('league-summary-rank').textContent = entry.rank;
            }
        }
    });
}

function closeRoundSummary() {
    document.getElementById('league-round-summary').classList.add('league-hidden');

    if (isLeagueModeActive) {
        // Return to player picker for the next person
        returnToPlayerPicker();
    } else {
        // Restore click-through
        if (!isCurrentlyLocked) {
            window.electronAPI.setIgnoreMouseEvents(true);
        }
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
        leagueSettings = {
            enabled: true,
            leagueId: payload.leagueId,
        };

        console.log('League mode ACTIVATED remotely.');

        // Fetch league times for auto-lock, then unlock
        window.electronAPI.getLeagueSettings().then(settings => {
            setLeagueModeState(true, payload.leagueId, settings?.endTime || null);
            initializeLeagueMode();
        }).catch(() => {
            setLeagueModeState(true, payload.leagueId, null);
            initializeLeagueMode();
        });
    } else {
        console.log('League mode DEACTIVATED remotely.');
        leagueSettings = { enabled: false, leagueId: null };
        leagueState = null;
        leagueActiveUserId = null;
        leagueActivePlayerId = null;
        leagueSelectedPlayerIds = [];
        leagueAllPlayers = [];
        leagueInitialized = false;
        hideLeagueUI();
        hidePlayerPicker();
        // Update core.js state — this re-locks the bay if no booking
        setLeagueModeState(false, null, null);
    }
});

// Wait for core.js to finish initializing before starting league mode
// Only initialize on the league display (additional monitor, or main if single-monitor)
document.addEventListener('kiosk-initialized', async () => {
    const isLeagueDisplay = await window.electronAPI.isLeagueDisplay();
    if (!isLeagueDisplay) {
        console.log('Not the league display — skipping league mode initialization');
        return;
    }
    initializeLeagueMode();
});
