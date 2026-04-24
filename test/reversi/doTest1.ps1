Set-Location $PSScriptRoot
$logDir = "logs"
if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "cpu_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"
Write-Host "log -> $logFile"
Write-Host "停止:"
Write-Host "  1. ブラウザのシリアルテスト送信文字列に 'QT' (LF) を送る → 正常終了"
Write-Host "  2. Ctrl+C → 即停止 (ブラウザが使えないときのフォールバック)"
Write-Host ""

# Tee-Object をやめて Start-Transcript に置換したのは、パイプラインの終端が Tee だと
# Ctrl+C が Tee に先に届いて py.exe が孤児化する問題を避けるため。
# Start-Transcript はターミナル表示をファイルへ自動複製する (Tee 相当)。
# py -u は stdout 無バッファ化 (Transcript へのログ反映を遅延させない)。
Start-Transcript -Path $logFile -Force | Out-Null
try {
    py -u reversi_cpu.py --port COM2 --baud 115200
} finally {
    Stop-Transcript | Out-Null
}
