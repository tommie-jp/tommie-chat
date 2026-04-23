#!/usr/bin/env pwsh
# CPU テスターのセルフテスト (参照 CPU を自動起動して仮想ブリッジ経由で検証)
# 前提: HHD / com0com 等で 2 つの COM ポート間にブリッジが作成済み
#
# 使い方:
#   .\doTest-selftest.ps1                       # デフォルト: reversi_cpu=COM1, pytest=COM2
#   .\doTest-selftest.ps1 -CpuPort COM5 -TesterPort COM6
#   .\doTest-selftest.ps1 -Baud 9600
#   .\doTest-selftest.ps1 -Verbose
#
# 仕様:
#   - 別ウィンドウで reversi_cpu.py を -CpuPort で起動し、画面表示 & logs/cpu_*.log へ
#     (PowerShell + Tee-Object で画面ログと両方出力。-NoExit で終了後もウィンドウ保持)
#   - 本ウィンドウで pytest を -TesterPort で実行、画面と logs/pytest_*.log へ
#   - 終了時 (正常/失敗/Ctrl+C) に taskkill /T で reversi_cpu.py 子プロセス含め全殺し

[CmdletBinding()]
param(
    [string]$CpuPort = "COM1",
    [string]$TesterPort = "COM2",
    [int]$Baud = 115200,
    [int]$StartupWaitSec = 3
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$reversiDir = Resolve-Path (Join-Path $scriptDir '..')
$venvPytest = Join-Path $scriptDir '.venv\Scripts\pytest.exe'
$logDir = Join-Path $scriptDir 'logs'

if (-not (Test-Path $venvPytest)) {
    Write-Error @"

pytest が見つかりません: $venvPytest

先に venv を作成してください:
    cd $scriptDir
    py -m venv .venv
    .venv\Scripts\pip install -r requirements.txt

"@
    exit 1
}

# ログディレクトリ作成
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$cpuLog = Join-Path $logDir "cpu_${stamp}.log"
$pytestLog = Join-Path $logDir "pytest_${stamp}.log"

Write-Host "設定:" -ForegroundColor Cyan
Write-Host "  reversi_cpu.py   → $CpuPort (別ウィンドウ)"
Write-Host "  cpu_tester pytest → $TesterPort"
Write-Host "  Baud              : $Baud"
Write-Host "  cpu ログ           : $cpuLog"
Write-Host "  pytest ログ         : $pytestLog"
Write-Host ""

Write-Host "[1/3] reversi_cpu.py を別ウィンドウで起動 (port=$CpuPort)..." -ForegroundColor Cyan
# PowerShell ラッパーで起動し Tee-Object で画面とログの両方へ出力する。
# -NoExit で別ウィンドウは処理終了後も開いたままにし、ログを目視できるようにする。
# -PSNativeCommandUseErrorActionPreference:$false で py の stderr を例外化しない
$cpuCmd = @"
Set-Location '$reversiDir'
`$host.ui.RawUI.WindowTitle = 'reversi_cpu.py (port=$CpuPort)'
`$env:PYTHONUNBUFFERED = '1'
py reversi_cpu.py --port $CpuPort --baud $Baud 2>&1 | Tee-Object -FilePath '$cpuLog'
"@
$refCpu = Start-Process powershell `
    -ArgumentList "-NoProfile","-NoExit","-Command",$cpuCmd `
    -PassThru

Write-Host "[2/3] $StartupWaitSec 秒待機 (reversi_cpu.py の起動完了待ち)..." -ForegroundColor Cyan
Start-Sleep -Seconds $StartupWaitSec

$exitCode = 0
try {
    Write-Host "[3/3] pytest --port $TesterPort を実行..." -ForegroundColor Cyan
    # Tee-Object で画面とログ両方へ出力
    & $venvPytest --port $TesterPort --baud $Baud -v 2>&1 | Tee-Object -FilePath $pytestLog
    $exitCode = $LASTEXITCODE
} finally {
    Write-Host ""
    Write-Host "reversi_cpu.py (wrapper PID=$($refCpu.Id)) とその子プロセスを停止..." -ForegroundColor Cyan
    if ($refCpu -and -not $refCpu.HasExited) {
        # PowerShell ラッパー → py.exe の子プロセスツリーを全部 kill
        # /T: tree kill, /F: force. 出力は捨てる
        taskkill /PID $refCpu.Id /T /F 2>&1 | Out-Null
    }
}

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "=== セルフテスト成功 ===" -ForegroundColor Green
} else {
    Write-Host "=== セルフテスト失敗 (exit $exitCode) ===" -ForegroundColor Red
}
Write-Host "ログ:"
Write-Host "  $pytestLog"
Write-Host "  $cpuLog"
exit $exitCode
