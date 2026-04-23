# test/reversi/scenarios/*.txt を一括で CPU replay テストに流す。
# 失敗は累積し、最後に exit code 1 で終了。
Set-Location $PSScriptRoot

$fail = 0
foreach ($scn in Get-ChildItem -Path 'scenarios' -Filter '*.txt' | Sort-Object Name) {
    Write-Host "=== scenarios/$($scn.Name) ==="
    py reversi_cpu.py --replay "scenarios/$($scn.Name)" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("  FAIL: scenarios/$($scn.Name)")
        $fail++
    }
}

if ($fail -gt 0) {
    [Console]::Error.WriteLine("$fail scenario(s) failed")
    exit 1
}
Write-Host "all scenarios passed"
