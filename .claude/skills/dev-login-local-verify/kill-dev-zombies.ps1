# kill-dev-zombies.ps1 -- stop leftover local dev servers (nuxt dev / wrangler dev / workerd).
#
# Why this exists (measured 2026-07-25):
#   * A previous session's `wrangler dev` keeps port 8787, and a NEW wrangler dev still
#     prints "Ready on :8787" while the OLD bundle answers requests -- code changes look
#     like they were not applied (SKILL.md step 0).
#   * Killing only the port listener is NOT enough: all 5 dev ports read "free" while
#     5 node/workerd processes were still alive (the parent wrangler and its workerd
#     children survive after the listener dies, then grab the port again).
#
# Two signals, in this order:
#   1. whoever LISTENS on the ports -- precise, kills what is running right now
#   2. command line match for `<binary> dev` + any workerd.exe -- catches the zombies
#      that already lost their listener
#
# Do NOT match node.exe by process NAME: MCP servers, language servers and npx run node
# too, and a name-wide kill takes them all down (this actually happened). Do NOT match
# the command line loosely either (e.g. /nuxt|wrangler/): the repo path
# "nuxt-dtako-admin" appears in unrelated node command lines. Anchor on the binary name
# immediately followed by "dev".
#
# ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI, so a .ps1
# containing Japanese turns into mojibake and can fail to parse.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File kill-dev-zombies.ps1
#   powershell -ExecutionPolicy Bypass -File kill-dev-zombies.ps1 -Ports 3000,8787
#   powershell -ExecutionPolicy Bypass -File kill-dev-zombies.ps1 -DryRun

[CmdletBinding()]
param(
  # Ports used by this repo's dev setups (front worker / relay / nuxt dev variants).
  [int[]] $Ports = @(3000, 3100, 3101, 8787, 8788),
  # Print what would be killed, kill nothing.
  [switch] $DryRun,
  # Keep workerd (use when another wrangler dev session must survive).
  [switch] $KeepWorkerd
)

# node.exe running "<...>/nuxt.mjs dev", "<...>/wrangler.js dev", "npx-cli.js wrangler", etc.
$cmdlinePattern = '(wrangler(-dist[\\/]cli\.js|\.js)?|nuxt(\.mjs)?|npx-cli\.js)["'']?\s+(dev|wrangler)(\s|$)'
$stopped = 0

function Stop-One {
  param([int] $Id, [string] $Why)
  $proc = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  if ($DryRun) {
    Write-Host ("  would stop PID {0,-6} {1,-12} {2}" -f $Id, $proc.ProcessName, $Why)
    return $false
  }
  try {
    Stop-Process -Id $Id -Force -ErrorAction Stop
    Write-Host ("  stopped PID {0,-6} {1,-12} {2}" -f $Id, $proc.ProcessName, $Why)
    return $true
  }
  catch {
    Write-Host ("  FAILED  PID {0,-6} {1,-12} {2}" -f $Id, $proc.ProcessName, $_.Exception.Message)
    return $false
  }
}

Write-Host "== 1. port listeners"
foreach ($port in $Ports) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if (-not $conns) { Write-Host ("  {0,-5} free" -f $port); continue }
  foreach ($id in ($conns.OwningProcess | Sort-Object -Unique)) {
    if (Stop-One -Id $id -Why "listening on $port") { $stopped++ }
  }
}

Write-Host "== 2. leftovers (command line match / workerd)"
$leftovers = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='workerd.exe'" |
  Where-Object {
    ($_.Name -eq 'workerd.exe' -and -not $KeepWorkerd) -or
    ($_.CommandLine -and $_.CommandLine -match $cmdlinePattern)
  }
if (-not $leftovers) {
  Write-Host "  none"
}
else {
  foreach ($p in $leftovers) {
    $why = if ($p.Name -eq 'workerd.exe') { 'orphan workerd' } else { 'dev server command line' }
    if (Stop-One -Id $p.ProcessId -Why $why) { $stopped++ }
  }
}

if ($DryRun) { Write-Host "== dry run, nothing killed"; exit 0 }

Start-Sleep -Seconds 1

Write-Host "== after"
$busy = @()
foreach ($port in $Ports) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $busy += $port }
}
$alive = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='workerd.exe'" |
  Where-Object { $_.Name -eq 'workerd.exe' -or ($_.CommandLine -and $_.CommandLine -match $cmdlinePattern) }

if ($busy.Count -eq 0 -and -not $alive) {
  Write-Host ("  all clear ({0} process(es) stopped)" -f $stopped)
  exit 0
}
# A port in TIME_WAIT is fine and does not show up here; still LISTENING or still alive
# means something respawned it (a file watcher, or a shell restarting the dev server).
if ($busy.Count -gt 0) { Write-Host ("  STILL LISTENING: {0}" -f ($busy -join ', ')) }
if ($alive) { $alive | ForEach-Object { Write-Host ("  STILL ALIVE: PID {0} {1}" -f $_.ProcessId, $_.Name) } }
Write-Host "  -> something is respawning them; check for a running build/watch task"
exit 1
