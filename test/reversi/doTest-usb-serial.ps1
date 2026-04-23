# USB シリアル簡易ターミナル (tio の最小相当)。
# 受信のみ表示。終了は Ctrl+C。
# 双方向で叩きたい場合は PuTTY などを使うこと。
param(
    [string]$Port = 'COM3',
    [int]$Baud = 115200
)

$p = [System.IO.Ports.SerialPort]::new($Port, $Baud, 'None', 8, 'One')
$p.Open()
Write-Host "Opened $Port @ $Baud. Ctrl+C to quit."
try {
    while ($true) {
        if ($p.BytesToRead -gt 0) {
            Write-Host -NoNewline $p.ReadExisting()
        }
        Start-Sleep -Milliseconds 10
    }
} finally {
    if ($p.IsOpen) { $p.Close() }
}
