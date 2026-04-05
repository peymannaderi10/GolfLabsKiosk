/**
 * App Manager
 *
 * Manages Uneekor application lifecycle in sync with space booking schedule:
 * - Launches Uneekor Launcher when space becomes active (pre-start or booking start)
 * - Kills Uneekor apps when space becomes idle (no booking within keepAlive gap)
 *
 * Hooks into the projector module's space lifecycle events so both systems
 * follow the same pre-start / keep-alive schedule.
 */

const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const UNEEKOR_PATH = 'C:\\Uneekor';

let appManagerInitialized = false;

const LAUNCHER_EXES = [
  'uneekorlauncher.exe',
  'uneekorlaunchersettings.exe',
  'uneekorlaunchmonitor.exe',
  'unins000.exe',
];

// Subdirectories under C:\Uneekor that should never be killed (drivers, tools)
const PROTECTED_DIRS = [
  'launcher',
  'device',
  'installer',
];

// The launcher executable to start
const LAUNCHER_EXE_PATH = path.join(UNEEKOR_PATH, 'Launcher', 'UneekorLauncher.exe');

/**
 * Get all running processes with their executable paths via PowerShell.
 * Returns array of { pid, name, path }.
 */
function getRunningProcesses() {
  return new Promise((resolve) => {
    const cmd = 'Get-Process | Where-Object { $_.Path } | Select-Object Id,ProcessName,Path | ConvertTo-Csv -NoTypeInformation';
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout: 15000 }, (error, stdout) => {
      if (error) {
        console.error(`[AppManager] Error listing processes: ${error.message}`);
        resolve([]);
        return;
      }

      const processes = [];
      const lines = stdout.split('\n');
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        // CSV: "Id","ProcessName","Path"
        const match = line.match(/"(\d+)","([^"]+)","([^"]*)"/);
        if (match) {
          processes.push({ pid: match[1], name: match[2], path: match[3] });
        }
      }
      resolve(processes);
    });
  });
}

/**
 * Check if the Uneekor Launcher is already running.
 */
async function isLauncherRunning() {
  const processes = await getRunningProcesses();
  return processes.some(p => {
    const nameLower = (p.name + '.exe').toLowerCase();
    return nameLower === 'uneekorlauncher.exe';
  });
}

/**
 * Launch the Uneekor Launcher if it exists and isn't already running.
 */
async function launchUneekor() {
  if (!fs.existsSync(LAUNCHER_EXE_PATH)) {
    console.log(`[AppManager] Launcher not found at ${LAUNCHER_EXE_PATH} — skipping`);
    return;
  }

  const running = await isLauncherRunning();
  if (running) {
    console.log('[AppManager] Uneekor Launcher already running — skipping launch');
    return;
  }

  console.log(`[AppManager] Launching Uneekor: ${LAUNCHER_EXE_PATH}`);
  exec(`start "" "${LAUNCHER_EXE_PATH}"`, { cwd: path.dirname(LAUNCHER_EXE_PATH) }, (error) => {
    if (error) {
      console.error(`[AppManager] Failed to launch Uneekor: ${error.message}`);
    } else {
      console.log('[AppManager] Uneekor Launcher started');
    }
  });
}

/**
 * Kill all processes running from C:\Uneekor, except the launcher.
 */
async function killUneekorApps() {
  console.log('[AppManager] Scanning for Uneekor processes...');

  const processes = await getRunningProcesses();

  const uneekorProcs = processes.filter(p => {
    if (!p.path) return false;
    const pathLower = p.path.toLowerCase();
    const nameLower = (p.name + '.exe').toLowerCase();
    // Must be running from C:\Uneekor
    if (!pathLower.startsWith(UNEEKOR_PATH.toLowerCase())) return false;
    // Skip launcher executables
    if (LAUNCHER_EXES.includes(nameLower)) return false;
    // Skip protected directories (drivers, tools)
    const relativePath = pathLower.substring(UNEEKOR_PATH.length + 1);
    const topDir = relativePath.split('\\')[0];
    if (PROTECTED_DIRS.includes(topDir)) return false;
    return true;
  });

  if (uneekorProcs.length === 0) {
    console.log('[AppManager] No Uneekor apps were running');
    return [];
  }

  console.log(`[AppManager] Found ${uneekorProcs.length} Uneekor process(es) to kill`);

  const results = await Promise.all(
    uneekorProcs.map(proc => killByPid(proc.pid, proc.name))
  );

  const killed = results.filter(r => r.killed);
  if (killed.length > 0) {
    console.log(`[AppManager] Closed: ${killed.map(r => r.name).join(', ')}`);
  }

  return results;
}

/**
 * Kill ALL Uneekor processes including the launcher.
 */
async function killAllUneekor() {
  console.log('[AppManager] Killing ALL Uneekor processes (including launcher)...');

  const processes = await getRunningProcesses();

  const uneekorProcs = processes.filter(p => {
    if (!p.path) return false;
    const pathLower = p.path.toLowerCase();
    if (!pathLower.startsWith(UNEEKOR_PATH.toLowerCase())) return false;
    // Skip protected directories (drivers, tools)
    const relativePath = pathLower.substring(UNEEKOR_PATH.length + 1);
    const topDir = relativePath.split('\\')[0];
    if (PROTECTED_DIRS.includes(topDir)) return false;
    return true;
  });

  if (uneekorProcs.length === 0) {
    console.log('[AppManager] No Uneekor processes were running');
    return [];
  }

  console.log(`[AppManager] Found ${uneekorProcs.length} Uneekor process(es) to kill`);

  const results = await Promise.all(
    uneekorProcs.map(proc => killByPid(proc.pid, proc.name))
  );

  const killed = results.filter(r => r.killed);
  if (killed.length > 0) {
    console.log(`[AppManager] Closed: ${killed.map(r => r.name).join(', ')}`);
  }

  return results;
}

/**
 * Kill a process by PID.
 */
function killByPid(pid, name) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/PID', pid], { timeout: 10000 }, (error) => {
      if (error) {
        console.error(`[AppManager] Failed to kill ${name} (PID ${pid}): ${error.message}`);
        resolve({ pid, name, killed: false });
      } else {
        console.log(`[AppManager] Killed ${name} (PID ${pid})`);
        resolve({ pid, name, killed: true });
      }
    });
  });
}

/**
 * Called when a booking session ends (renderer-driven).
 * Kills simulator apps but keeps launcher alive if space is still active.
 */
async function onSessionEnd(ctx) {
  const settings = ctx.config.appManagerSettings;
  if (!settings || !settings.enabled) return;

  console.log('[AppManager] Session ended — cleaning up simulator apps');
  await killUneekorApps();
}

/**
 * Initialize the app manager and register space lifecycle hooks.
 * Safe to call once — hooks are registered in the projector lifecycle arrays
 * which persist for the process lifetime. Do not call more than once.
 */
function initAppManager(ctx) {
  const settings = ctx.config.appManagerSettings;
  if (!settings || !settings.enabled) {
    console.log('[AppManager] App management disabled in config');
    return;
  }

  if (appManagerInitialized) {
    console.log('[AppManager] Already initialized — skipping duplicate init');
    return;
  }

  const { onSpaceActive, onSpaceIdle } = require('./projector');

  // When space becomes active (pre-start or booking start) — launch Uneekor
  onSpaceActive(() => {
    console.log('[AppManager] Space active — launching Uneekor');
    launchUneekor();
  });

  // When space becomes idle (no bookings within keepAlive gap) — kill everything
  onSpaceIdle(() => {
    console.log('[AppManager] Space idle — closing all Uneekor apps');
    killAllUneekor();
  });

  appManagerInitialized = true;
  console.log('[AppManager] Initialized — Uneekor follows space booking schedule');
}

module.exports = {
  initAppManager,
  onSessionEnd,
  killUneekorApps,
  killAllUneekor,
  launchUneekor,
};
