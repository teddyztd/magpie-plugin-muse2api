<#
.SYNOPSIS
  注册/更新 muse2api 网关外部看门狗计划任务（登录时启动 + 每 3 分钟巡检）。

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1 -IntervalMinutes 5
#>
[CmdletBinding()]
param(
  [string]$TaskName = "Muse2API Gateway Watchdog",
  [int]$IntervalMinutes = 3,
  [string]$GatewayDir = "E:\github\muse2api",
  [int]$Port = 18610,
  [string]$PythonPath = ""
)

$ErrorActionPreference = "Stop"

$watchdog = Join-Path $PSScriptRoot "gateway-watchdog.ps1"
if (-not (Test-Path $watchdog)) { throw "watchdog script not found: $watchdog" }

$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
$hostExe = if ($pwshCmd) { $pwshCmd.Source } else { (Get-Command powershell.exe).Source }

$argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$watchdog`" -GatewayDir `"$GatewayDir`" -Port $Port"
if ($PythonPath) { $argLine += " -PythonPath `"$PythonPath`"" }

$action = New-ScheduledTaskAction -Execute $hostExe -Argument $argLine

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerLogon.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggerLogon -Settings $settings -Force | Out-Null
Write-Host "registered: $TaskName (every $IntervalMinutes min, gateway=$GatewayDir port=$Port)"

# 立刻跑一次，确认可用
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName, LastRunTime, LastTaskResult | Format-List
