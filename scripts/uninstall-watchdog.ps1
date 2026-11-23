<#
.SYNOPSIS
  卸载 muse2api 网关外部看门狗计划任务。

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-watchdog.ps1
#>
[CmdletBinding()]
param([string]$TaskName = "Muse2API Gateway Watchdog")

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Host "not installed: $TaskName"; exit 0 }

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "unregistered: $TaskName"
