# LAN接続手順（WSL2 NATモード）

WSL2上で動作するtommieChatに、LAN内のiPhone等からアクセスする手順。

## ポート構成

ブラウザはポート80（本番は443）のみに接続する。nginxがリバースプロキシとして内部サービスに振り分ける。

```
ブラウザ ── :80 ── nginx ─┬─ /            → 静的ファイル配信（HTML/JS/CSS）
                           ├─ /v2/*        → nakama:7350（API）
                           ├─ /ws          → nakama:7350（WebSocket）
                           └─ /s3/*        → minio:9000（アセットストレージ）
```

外部に開放するポートは **80番のみ**。7350, 9000, 9001, 5432 等はDocker内部通信のみで使用する。

## 手順

### 1. WSL2のIPアドレスを確認

```bash
ip addr show eth0 | grep 'inet '
```

例: `172.18.188.130`

### 2. Windowsでポートフォワード設定（PowerShell 管理者権限）

```powershell
$wslIp = (wsl hostname -I).Trim()
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=80 connectaddress=$wslIp
```

### 3. Windowsファイアウォール開放（初回のみ）

```powershell
New-NetFirewallRule -DisplayName "WSL2 Port 80" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80
```

### 4. WindowsのLAN IPを確認

```powershell
ipconfig
```

Wi-Fi または イーサネットの IPv4 アドレス（例: `192.168.1.40`）をメモ。

### 5. iPhoneからアクセス

ブラウザで `http://192.168.1.40` を開く。

## 注意事項

- **WSL2のIPは再起動で変わる**ため、手順2のポートフォワード設定はWSL2再起動のたびにやり直す必要がある
- ビルド済みファイル（`dist/`）が古い場合は `npm run build` で更新する。Dockerコンテナ `nakama-web-1` は `dist/` をボリュームマウントしているため、ビルドだけで反映される

### ポートフォワード管理コマンド

```powershell
# 現在の設定を確認
netsh interface portproxy show all

# 設定を削除
netsh interface portproxy delete v4tov4 listenport=80 listenaddress=0.0.0.0

# WSL2再起動後にまとめて再設定するスクリプト例
$wslIp = (wsl hostname -I).Trim()
netsh interface portproxy delete v4tov4 listenport=80 listenaddress=0.0.0.0
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=80 connectaddress=$wslIp
```
