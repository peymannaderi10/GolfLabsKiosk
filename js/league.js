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
