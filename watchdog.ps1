#Requires -Version 5.1
<#
  GolfLabs Kiosk Watchdog
  Monitors the kiosk and simulator processes, restarts them if they crash,
  and kills duplicate instances. Uses a named mutex so only one watchdog
  can run at a time.

  Note: The kiosk is an Electron app which spawns multiple child processes
  (renderer, GPU, utility). This watchdog counts only root instances -
  processes whose parent is NOT another kiosk process.
#>

# -- Configuration -----------------------------------------------------------
$KioskProcessName  = "Golf Labs Kiosk"
$KioskExeName      = "Golf Labs Kiosk.exe"
$SimProcessName    = "UneekorLauncher"
$ScriptDir         = Split-Path -Parent $MyInvocation.MyCommand.Definition
$KioskExe          = Join-Path $ScriptDir "Golf Labs Kiosk.exe"
$SimExe            = "C:\Uneekor\Launcher\UneekorLauncher.exe"
$LogDir            = Join-Path $ScriptDir "logs"
$InitialWaitSec    = 45
$CheckIntervalSec  = 30
$MaxLogSizeMB      = 5

# -- Logging ------------------------------------------------------------------
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir "watchdog.log"

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $Message"
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}

function Rotate-Log {
    if (Test-Path $LogFile) {
        $size = (Get-Item $LogFile).Length / 1MB
        if ($size -ge $MaxLogSizeMB) {
            $archive = Join-Path $LogDir "watchdog_prev.log"
            if (Test-Path $archive) { Remove-Item $archive -Force }
            Rename-Item $LogFile $archive -Force
            Write-Log "Log rotated (previous log exceeded ${MaxLogSizeMB}MB)"
        }
    }
}

# -- Single-instance mutex ----------------------------------------------------
$MutexName = "Global\GolfLabsKioskWatchdog"
$mutex = $null
try {
    $created = $false
    $mutex = New-Object System.Threading.Mutex($true, $MutexName, [ref]$created)
    if (-not $created) {
        if ($mutex) { $mutex.Dispose() }
        exit 0
    }
} catch [System.Threading.AbandonedMutexException] {
    Write-Log "Acquired abandoned mutex from a previous watchdog instance"
}

Write-Log "===== Watchdog started (PID $PID) ====="
Write-Log "Kiosk exe: $KioskExe"
Write-Log "Simulator exe: $SimExe"
Write-Log "Check interval: ${CheckIntervalSec}s"

# -- Electron-aware process helpers -------------------------------------------
# Electron apps spawn multiple child processes (renderer, GPU, utility) that
# all share the same exe name. We identify "root" instances as those whose
# parent is NOT another kiosk process. A healthy single kiosk = 1 root + N children.

function Get-KioskRootProcesses {
    $allKiosk = Get-CimInstance Win32_Process -Filter "Name = '$KioskExeName'" -ErrorAction SilentlyContinue
    if (-not $allKiosk) { return @() }

    $kioskPids = @{}
    foreach ($p in $allKiosk) { $kioskPids[$p.ProcessId] = $true }

    # A root process is one whose parent is NOT another kiosk process
    $roots = @()
    foreach ($p in $allKiosk) {
        if (-not $kioskPids.ContainsKey($p.ParentProcessId)) {
            $roots += $p
        }
    }
    return $roots
}

function Get-SimProcesses {
    return @(Get-Process -Name $SimProcessName -ErrorAction SilentlyContinue)
}

# Kill a root kiosk process and all its children via taskkill /T (tree kill)
function Stop-KioskTree {
    param([uint32]$ProcessId)
    try {
        $output = & taskkill /PID $ProcessId /T /F 2>&1
        Write-Log "  Killed process tree for PID $ProcessId"
    } catch {
        Write-Log "  Failed to kill tree for PID ${ProcessId}: $_"
    }
}

function Remove-DuplicateKioskInstances {
    param($Roots)
    if ($Roots.Count -le 1) { return }

    Write-Log "WARNING: $($Roots.Count) kiosk instances detected - killing duplicates"

    # Keep the one with the earliest creation date
    $sorted = $Roots | Sort-Object CreationDate
    $keep = $sorted[0]
    $dupes = $sorted | Select-Object -Skip 1

    foreach ($proc in $dupes) {
        $startStr = if ($proc.CreationDate) { $proc.CreationDate.ToString('HH:mm:ss') } else { 'unknown' }
        Write-Log "  Killing duplicate instance PID $($proc.ProcessId) (started $startStr)"
        Stop-KioskTree -ProcessId $proc.ProcessId
    }

    $keepStart = if ($keep.CreationDate) { $keep.CreationDate.ToString('HH:mm:ss') } else { 'unknown' }
    Write-Log "  Kept instance PID $($keep.ProcessId) (started $keepStart)"
}

function Remove-DuplicateSimInstances {
    param([System.Diagnostics.Process[]]$Processes)
    if ($Processes.Count -le 1) { return }

    Write-Log "WARNING: $($Processes.Count) simulator instances detected - killing duplicates"
    $sorted = $Processes | Sort-Object StartTime
    $keep = $sorted[0]
    $dupes = $sorted | Select-Object -Skip 1

    foreach ($proc in $dupes) {
        try {
            Write-Log "  Killing duplicate PID $($proc.Id) (started $($proc.StartTime.ToString('HH:mm:ss')))"
            $proc.Kill()
            $proc.WaitForExit(5000)
        } catch {
            Write-Log "  Failed to kill PID $($proc.Id): $_"
        }
    }
    Write-Log "  Kept PID $($keep.Id) (started $($keep.StartTime.ToString('HH:mm:ss')))"
}

# -- Initial wait --------------------------------------------------------------
Write-Log "Waiting ${InitialWaitSec}s for system startup..."
Start-Sleep -Seconds $InitialWaitSec

# -- Main loop ----------------------------------------------------------------
try {
    while ($true) {
        Rotate-Log

        # -- Kiosk (Electron-aware) --
        $kioskRoots = Get-KioskRootProcesses

        if ($kioskRoots.Count -eq 0) {
            Write-Log "Kiosk not running - launching..."
            try {
                Start-Process -FilePath $KioskExe -WorkingDirectory $ScriptDir
                Write-Log "Kiosk launched"
            } catch {
                Write-Log "ERROR: Failed to launch kiosk: $_"
            }
        } elseif ($kioskRoots.Count -gt 1) {
            Remove-DuplicateKioskInstances -Roots $kioskRoots
        }

        # -- Simulator --
        if (Test-Path $SimExe) {
            $simProcs = Get-SimProcesses

            if ($simProcs.Count -eq 0) {
                Write-Log "Simulator not running - launching..."
                try {
                    Start-Process -FilePath $SimExe
                    Write-Log "Simulator launched"
                } catch {
                    Write-Log "ERROR: Failed to launch simulator: $_"
                }
            } elseif ($simProcs.Count -gt 1) {
                Remove-DuplicateSimInstances -Processes $simProcs
            }
        }

        Start-Sleep -Seconds $CheckIntervalSec
    }
} catch {
    Write-Log "ERROR: Unhandled exception: $_"
} finally {
    Write-Log "===== Watchdog exiting ====="
    if ($mutex) {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}
