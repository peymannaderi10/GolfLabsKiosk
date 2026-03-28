/**
 * App Manager
 *
 * Kills any process running from C:\Uneekor when a booking session ends,
 * except the Uneekor Launcher itself.
 */

const { execFile } = require('child_process');

const UNEEKOR_PATH = 'C:\\Uneekor';

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

/**
 * Get all running processes with their executable paths via PowerShell.
 * Returns array of { pid, name, path }.
 */
function getRunningProcesses() {
  return new Promise((resolve) => {
    const cmd = 'Get-Process | Where-Object { $_.Path } | Select-Object Id,ProcessName,Path | ConvertTo-Csv -NoTypeInformation';
    execFile('powershell.exe', ['-NoProfile', '-Command', cmd], (error, stdout) => {
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
 * Kill a process by PID.
 */
function killByPid(pid, name) {
  return new Promise((resolve) => {
    execFile('taskkill', ['/F', '/PID', pid], (error) => {
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
 * Called when a booking session ends.
 */
async function onSessionEnd(ctx) {
  const settings = ctx.config.appManagerSettings;
  if (!settings || !settings.enabled) return;

  console.log('[AppManager] Session ended — cleaning up apps');
  await killUneekorApps();
}

/**
 * Initialize the app manager.
 */
function initAppManager(ctx) {
  const settings = ctx.config.appManagerSettings;
  if (!settings || !settings.enabled) {
    console.log('[AppManager] App management disabled in config');
    return;
  }

  console.log('[AppManager] Initialized — will close Uneekor apps on session end');
}

module.exports = {
  initAppManager,
  onSessionEnd,
  killUneekorApps,
};
