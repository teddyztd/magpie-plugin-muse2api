<#
.SYNOPSIS
  muse2api 网关外部看门狗：端口不通就拉起 uvicorn，保证 18610 常活。

.DESCRIPTION
  插件内的保活只在本机 Magpie 成功加载插件时才生效。当 Magpie 插件加载超时/被跳过时，
  这条外部看门狗仍然能把网关拉起来（计划任务每 N 分钟跑一次）。

  只做两件事：
    1) 探测 127.0.0.1:18610 是否可连；
    2) 不通则以隐藏窗口方式启动 `python -m uvicorn app:app --host 127.0.0.1 --port 18610`。

.EXAMPLE
  pwsh -NoProfile -File scripts\gateway-watchdog.ps1
#>
[CmdletBinding()]
param(
  [string]$GatewayDir = "E:\github\muse2api",
  [int]$Port = 18610,
  [string]$PythonPath = "",
  [int]$WaitSeconds = 75
)

$ErrorActionPreference = "Stop"

function Write-Log([string]$Message) {
  try {
    $logDir = Join-Path $GatewayDir "data\logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $line = "{0} {1}" -f (Get-Date).ToUniversalTime().ToString("o"), $Message
    Add-Content -Path (Join-Path $logDir "gateway-watchdog.log") -Value $line -Encoding utf8
  } catch {}
}

function Test-Port([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect("127.0.0.1", $p, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(300)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    try { $client.Close() } catch {}
  }
}

function Resolve-Python {
  if ($PythonPath) { return $PythonPath }
  foreach ($candidate in @(
      (Join-Path $GatewayDir ".venv\Scripts\python.exe"),
      (Join-Path $GatewayDir "venv\Scripts\python.exe")
    )) {
    if (Test-Path $candidate) { return $candidate }
  }
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command py -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return ""
}

if (-not (Test-Path $GatewayDir)) {
  Write-Log "skip: gateway dir missing ($GatewayDir)"
  exit 0
}

if (Test-Port $Port) {
  # 已经活着：静默返回，避免日志膨胀（每小时最多一条心跳）
  $logFile = Join-Path $GatewayDir "data\logs\gateway-watchdog.log"
  $recentHeartbeat = $false
  if (Test-Path $logFile) {
    $last = Get-Content $logFile -Tail 1 -ErrorAction SilentlyContinue
    if ($last -match "heartbeat alive") {
      try {
        $ts = [datetime]::Parse($last.Substring(0, $last.IndexOf(" ")), $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        if (((Get-Date).ToUniversalTime() - $ts).TotalMinutes -lt 60) { $recentHeartbeat = $true }
      } catch {}
    }
  }
  if (-not $recentHeartbeat) { Write-Log "heartbeat alive (port $Port)" }
  exit 0
}

$python = Resolve-Python
if (-not $python) {
  Write-Log "fail: no python found (set -PythonPath or create .venv)"
  exit 1
}

$logDir = Join-Path $GatewayDir "data\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$outLog = Join-Path $logDir "gateway-uvicorn.out.log"
$errLog = Join-Path $logDir "gateway-uvicorn.err.log"

Write-Log "port $Port down, launching: $python -m uvicorn app:app --host 127.0.0.1 --port $Port (cwd=$GatewayDir)"

$proc = Start-Process -FilePath $python `
  -ArgumentList @("-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "$Port") `
  -WorkingDirectory $GatewayDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

# 等待端口起来（最多 WaitSeconds 秒）
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  if (Test-Port $Port) {
    Write-Log "launched pid=$($proc.Id) and port $Port is up"
    exit 0
  }
}

Write-Log "launch timeout after ${WaitSeconds}s (pid=$($proc.Id)); see gateway-uvicorn.err.log"
# 冷启动偶尔超过等待窗口但最终会起来：再补一次最终判定，避免日志误报失败
if (Test-Port $Port) {
  Write-Log "port $Port came up late (pid=$($proc.Id))"
  exit 0
}
exit 1
