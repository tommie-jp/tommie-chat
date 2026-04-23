Set-Location $PSScriptRoot
$logDir = "logs"
if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "cpu_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"
Write-Host "log -> $logFile"
py reversi_cpu.py --port COM2 --baud 115200 2>&1 | Tee-Object -FilePath $logFile
