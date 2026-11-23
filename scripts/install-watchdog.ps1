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

# 登录触发：开机登录后立刻巡检一次
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn

# 时间触发：每 N 分钟巡检。必须有独立时间触发器——只给登录触发器挂 Repetition 时
# 任务计划程序不会计算 NextRunTime，等效能于「登录时跑一次」，保活就失效了。
$triggerTimer = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($triggerLogon, $triggerTimer) -Settings $settings -Force | Out-Null
Write-Host "registered: $TaskName (every $IntervalMinutes min, gateway=$GatewayDir port=$Port)"

# 立刻跑一次，确认可用
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object TaskName, LastRunTime, LastTaskResult | Format-List
