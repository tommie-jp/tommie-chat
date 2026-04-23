Set-Location $PSScriptRoot

$failed = 0

Write-Host "=== Phase 1: Python replay scenarios ===" -ForegroundColor Cyan
& "$PSScriptRoot\doTest-replay.ps1"
if ($LASTEXITCODE -ne 0) { $failed++ }

Write-Host ""
Write-Host "=== Phase 2: Adapter Vitest (SerialReversiAdapter) ===" -ForegroundColor Cyan
# UNC パス上の PowerShell から npx を叩くと cmd.exe が UNC 非対応で失敗するため
# WSL 側で vitest を実行する。~/.bashrc は非インタラクティブで early return するので
# fnm を明示的に初期化して Node 24 を拾う。
$wslCmd = @'
export PATH="$HOME/.local/share/fnm:$PATH"
eval "$(fnm env 2>/dev/null)"
cd ~/24-mmo-Tommie-chat
npx vitest run test/SerialReversiAdapter.test.ts
'@
wsl bash -c $wslCmd
if ($LASTEXITCODE -ne 0) { $failed++ }

if ($failed -gt 0) {
    [Console]::Error.WriteLine("$failed phase(s) failed")
    exit 1
}
Write-Host ""
Write-Host "all tests passed" -ForegroundColor Green
