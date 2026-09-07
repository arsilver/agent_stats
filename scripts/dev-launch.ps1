#Requires -Version 5.1
<#
  Dev launcher for Agent Stats.

  Double-clicking run.bat used to look like "nothing happens" when a previous
  Electron was still alive without a window (it held the single-instance lock).
  This script:
    - focuses an already-visible Agent Stats window
    - kills a headless leftover, then starts fresh
    - waits until a real window titled "Agent Stats" appears
#>
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Resolve-Path (Join-Path $PSScriptRoot '..'))
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$RepoRoot = (Get-Location).Path
$UserDataHint = 'agent-stats'
$WindowTitle = 'Agent Stats'
$YoungProcessSeconds = 45
$StartupWindowTimeoutSeconds = 50

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class AgentStatsWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int nMax);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr extra);
  public static List<IntPtr> VisibleTitledWindows(uint pid, string title) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint wpid;
      GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      if (IsWindowVisible(h) && sb.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) {
        found.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Activate(IntPtr hWnd) {
    ShowWindow(hWnd, IsIconic(hWnd) ? 9 : 5);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    SetForegroundWindow(hWnd);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
  }
}
"@

function Test-AgentStatsCommandLine([string]$name, [string]$commandLine) {
  if (-not $commandLine) { return $false }
  if ($commandLine -match 'Cursor\.exe|Copy_Voice2Text|craftvoice') { return $false }
  if ($name -eq 'electron.exe') {
    return ($commandLine -match [regex]::Escape($RepoRoot) -or $commandLine -match $UserDataHint)
  }
  if ($name -match '^(node|cmd)\.exe$') {
    return (
      $commandLine -match 'electron-vite' -and
      ($commandLine -match [regex]::Escape($RepoRoot) -or $commandLine -match 'agent_Stats|agent-stats')
    )
  }
  return $false
}

function Get-AgentStatsProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    $_.ProcessId -ne $PID -and
    (Test-AgentStatsCommandLine $_.Name $_.CommandLine)
  }
}

function Get-AgentStatsMainElectron {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'electron.exe' -and
    $_.CommandLine -and
    $_.CommandLine -notmatch '--type=' -and
    (Test-AgentStatsCommandLine $_.Name $_.CommandLine)
  }
}

function Get-VisibleAgentStatsHwnds {
  $hwnds = @()
  foreach ($proc in Get-AgentStatsMainElectron) {
    $hwnds += [AgentStatsWin]::VisibleTitledWindows([uint32]$proc.ProcessId, $WindowTitle)
  }
  return $hwnds
}

function Show-ExistingAgentStatsWindow {
  $hwnds = Get-VisibleAgentStatsHwnds
  if ($hwnds.Count -eq 0) { return $false }
  [AgentStatsWin]::Activate($hwnds[0])
  Write-Host 'Agent Stats is already running - brought the window to the front.'
  return $true
}

function Stop-AgentStatsLeftovers {
  $targets = @(Get-AgentStatsProcesses)
  foreach ($proc in Get-AgentStatsMainElectron) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.ParentProcessId)" -ErrorAction SilentlyContinue
    $walk = 0
    while ($parent -and $walk -lt 8) {
      $walk++
      if ($parent.ProcessId -eq $PID) { break }
      if ($parent.Name -notmatch '^(node|cmd)\.exe$') { break }
      if ($parent.CommandLine -match 'Cursor\.exe') { break }
      $targets += $parent
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)" -ErrorAction SilentlyContinue
    }
  }

  $killed = @()
  $targets |
    Sort-Object ProcessId -Unique |
    ForEach-Object {
      if ($_.ProcessId -eq $PID) { return }
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $killed += ('{0}:{1}' -f $_.Name, $_.ProcessId)
    }

  if ($killed.Count -gt 0) {
    Write-Host ("Stopped leftover Agent Stats process(es): " + ($killed -join ', '))
    Start-Sleep -Seconds 2
  }
}

function Wait-ForAgentStatsWindow([int]$timeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    if ((Get-VisibleAgentStatsHwnds).Count -gt 0) { return $true }
    Start-Sleep -Milliseconds 400
  } while ((Get-Date) -lt $deadline)
  return $false
}

Write-Host 'Starting Agent Stats...'

if (Show-ExistingAgentStatsWindow) {
  exit 0
}

function Get-ProcessAgeSeconds([int]$processId) {
  $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($proc -and $proc.StartTime) {
    return [math]::Round(((Get-Date) - $proc.StartTime).TotalSeconds)
  }
  return 9999
}

$existing = @(Get-AgentStatsMainElectron)
if ($existing.Count -gt 0) {
  $youngest = $existing | Sort-Object ProcessId -Descending | Select-Object -First 1
  $ageSec = Get-ProcessAgeSeconds $youngest.ProcessId

  if ($ageSec -lt $YoungProcessSeconds) {
    Write-Host "Agent Stats is still opening (PID $($youngest.ProcessId))..."
    if (Wait-ForAgentStatsWindow -timeoutSeconds $StartupWindowTimeoutSeconds) {
      [void](Show-ExistingAgentStatsWindow)
      exit 0
    }
  }

  Write-Host 'Found a leftover Agent Stats process with no window. Replacing it.'
  Stop-AgentStatsLeftovers
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  Write-Host 'ERROR: npm was not found on PATH. Install Node.js LTS and try again.'
  exit 1
}

$npmProcess = Start-Process -FilePath $npm.Source -ArgumentList @('run', 'dev') -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
if (-not $npmProcess) {
  Write-Host 'ERROR: failed to start npm run dev.'
  exit 1
}

if (-not (Wait-ForAgentStatsWindow -timeoutSeconds $StartupWindowTimeoutSeconds)) {
  Write-Host ''
  Write-Host 'ERROR: Agent Stats did not open a window.'
  Write-Host 'If this console shows a TypeScript/build error, fix that first.'
  Write-Host 'Otherwise close this window, run run.bat again, and check Logs after it opens.'
  exit 1
}

Write-Host 'Agent Stats window is open.'
Wait-Process -Id $npmProcess.Id
exit $npmProcess.ExitCode
