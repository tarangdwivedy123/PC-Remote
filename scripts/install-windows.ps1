<#
.SYNOPSIS
  Sets up PC Remote on this machine: a firewall rule for the LAN, and a scheduled
  task that starts the agent when you log in.

.DESCRIPTION
  Everything here is also documented step by step in the README — this script
  exists so you do not have to type it, not to hide what it does. Run with
  -WhatIf first if you would rather see the plan.

  The firewall rule needs an elevated prompt. The scheduled task does not, and is
  deliberately created WITHOUT elevation: the agent has no need for admin rights,
  and running a network-listening background service as administrator for no
  reason is a bad habit.

.PARAMETER Port
  The port the agent listens on. Must match the agent's config.

.PARAMETER Remove
  Removes the firewall rule and the scheduled task instead of creating them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [int]$Port = 8765,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$RuleName = 'PC Remote (LAN)'
$TaskName = 'PC Remote agent'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$agentEntry = Join-Path $repoRoot 'agent\dist\agent.mjs'

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ---------------------------------------------------------------------------
# Remove
# ---------------------------------------------------------------------------

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
      Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
    }
  } else {
    Write-Host "No scheduled task '$TaskName' to remove."
  }

  if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
    if (-not (Test-Elevated)) {
      Write-Warning "Removing the firewall rule needs an elevated prompt. Re-run as administrator."
    } elseif ($PSCmdlet.ShouldProcess($RuleName, 'Remove firewall rule')) {
      Remove-NetFirewallRule -DisplayName $RuleName
      Write-Host "Removed firewall rule '$RuleName'." -ForegroundColor Green
    }
  } else {
    Write-Host "No firewall rule '$RuleName' to remove."
  }
  return
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if (-not (Test-Path $agentEntry)) {
  throw "Agent bundle not found at $agentEntry. Run 'npm run build' first."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe is not on PATH. Install Node.js, then re-run." }

Write-Host ""
Write-Host "  PC Remote setup" -ForegroundColor Cyan
Write-Host "  ---------------"
Write-Host "  repo:  $repoRoot"
Write-Host "  node:  $node"
Write-Host "  agent: $agentEntry"
Write-Host "  port:  $Port"
Write-Host ""

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------

$existingRule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if ($existingRule) {
  Write-Host "Firewall rule '$RuleName' already exists." -ForegroundColor Green
} elseif (-not (Test-Elevated)) {
  Write-Warning @"
Skipping the firewall rule: it needs an elevated prompt.

Either re-run this script as administrator, or run this one line in an elevated
PowerShell:

  New-NetFirewallRule -DisplayName '$RuleName' -Direction Inbound ``
    -Action Allow -Protocol TCP -LocalPort $Port -Profile Private

Without it, the phone will not be able to reach the agent.
"@
} elseif ($PSCmdlet.ShouldProcess("TCP $Port (Private profile)", 'Create inbound firewall rule')) {
  # Private profile only. The whole point of this project is that it never faces
  # the internet, and a rule on the Public profile would open it on untrusted
  # networks such as cafe or hotel Wi-Fi.
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
  Write-Host "Created firewall rule '$RuleName' (TCP $Port, Private profile)." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Scheduled task
# ---------------------------------------------------------------------------

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Scheduled task '$TaskName' already exists; replacing it."
  if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister existing task')) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Register scheduled task')) {
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$agentEntry`"" -WorkingDirectory $repoRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

  # RunLevel Limited: the agent listens on the network and needs no admin rights.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  # A short delay so the network stack is up before the agent tries to work out
  # which interface is the LAN one.
  $trigger.Delay = 'PT20S'

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Starts the PC Remote agent at logon (LAN dashboard for a phone).' | Out-Null

  Write-Host "Registered scheduled task '$TaskName' (runs at logon, unelevated)." -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Start it now without logging out:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "The agent writes its PIN and URL to its config; to see them:"
Write-Host "  npm start -- --show-pin"
Write-Host ""
Write-Host "To undo everything:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Remove"
Write-Host ""
