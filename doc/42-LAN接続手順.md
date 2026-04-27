# LAN接続手順（WSL2 NATモード）

WSL2上で動作するtommieChatに、LAN内のiPhone等からアクセスする手順。

## ポート構成（開発時）

ブラウザはポート80のみに接続する。Docker内のnginxがリバースプロキシとしてVite devサーバーに転送し、ViteがHMR・静的配信・API/WSプロキシをすべて担当する。

```text
iPhone/PC :80 ── Docker nginx ── Vite devサーバー :3000 ─┬─ /       → HMR付き静的配信
                                                         ├─ /v2/*   → nakama:7350（API）
                                                         ├─ /ws     → nakama:7350（WebSocket）
                                                         └─ /s3/*   → minio:9000（MinIO）
```

外部に開放するポートは **80番のみ**。7350, 9000, 9001, 5432 等はDocker内部通信のみで使用する。

### 前提条件

- `npm run dev` が動いていること（Vite devサーバーが `:3000` で起動）
- Vite が停止しているとポート80は 502 Bad Gateway を返す

### 関連する設定変更（2026/03/30）

1. **`nakama/nginx.conf`** — 静的ファイル配信から Vite へのリバースプロキシに変更
2. **`nakama/docker-compose.yml`** — web サービスに `extra_hosts: host.docker.internal:host-gateway` を追加（Docker → ホストの名前解決）
3. **`vite.config.ts`** — `server.allowedHosts: true` を追加（Docker nginx からのプロキシ許可）
4. **UFW** — Docker ネットワーク（`172.16.0.0/12`）からポート 3000 への接続を許可

   ```bash
   sudo ufw allow from 172.16.0.0/12 to any port 3000 proto tcp comment "Vite dev from Docker"
   ```

5. **WSL2 nginx** — 不要になったため停止・無効化済み

### PC単体での開発

`http://localhost:3000` でnginxなしでもログイン・WebSocket通信が可能。

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
- 開発時は `npm run dev` が必須。Vite が停止しているとポート80は 502 になる
- 本番デプロイ時は `npm run build` で `dist/` を更新し、`nakama/nginx.conf` を静的配信用に戻す

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

## ハマりポイント（任意ポート転送、例: Vite 5173 / HTTPS）

別プロジェクト（例: `~/28-QR-code` の Vite + mkcert を `https://localhost:5173/` で公開する場合）で、`netsh portproxy` 設定後も **Windows ブラウザから繋がらない** ときの切り分け。

### 1. UFW で当該ポートが拒否されている（最頻出）

WSL2 の UFW は `Default: deny (incoming)` のため、ポート 80/3000 等の既存ルール以外は **Windows ホスト側ゲートウェイ（例: `172.18.176.1`）からの接続が黙ってドロップされる**。

```bash
# 確認
sudo ufw status verbose

# 対処（WSL2側で実行）
sudo ufw allow 5173/tcp
# または該当ネットワークだけ許可（より絞る場合）
sudo ufw allow from 172.18.176.0/20 to any port 5173 proto tcp
```

WSL2 内から `curl -k https://172.18.188.130:5173/` が通るのに Windows ブラウザだけ繋がらない場合、ほぼ UFW が原因。

### 2. VSCode の Auto Forward Ports と競合する可能性

VSCode の Remote-WSL は PORTS タブに自動転送を表示するが、実際にバインドしているプロセスは Windows 側で確認する：

```powershell
Get-NetTCPConnection -LocalPort 5173 -State Listen | Select-Object LocalAddress,OwningProcess
Get-Process -Id (Get-NetTCPConnection -LocalPort 5173 -State Listen).OwningProcess
```

- `svchost`（iphlpsvc） → netsh portproxy が有効
- `Code.exe` / `node.exe` → VSCode 側が握っている

両方走らせると競合するので、原則どちらか一方に寄せる。VSCode 側に任せるなら netsh portproxy は削除し、UFW 設定も不要（VSCode トンネルは WSL 内 loopback 経由のため UFW を通らない）。

### 3. mkcert の証明書警告

vite-plugin-mkcert の証明書は **WSL2 内の CA で署名**されており Windows ブラウザは信頼しない。開発用途は「詳細設定 → 安全でないサイトに進む」で続行可。警告を消したい場合は WSL2 の `~/.local/share/mkcert/rootCA.pem` を Windows の「信頼されたルート証明機関」にインポート。

### 切り分けフロー（順番に確認）

1. WSL2 内で `curl -k https://localhost:5173/` → 200 か？（No なら Vite 自体の問題）
2. WSL2 内で `curl -k https://<eth0 IP>:5173/` → 200 か？（No なら Vite が `0.0.0.0` でリスンしていない）
3. Windows で `netsh interface portproxy show all` に当該ポートが出ているか
4. Windows で `Get-NetTCPConnection -LocalPort 5173 -State Listen` のリスナーが期待通りか
5. WSL2 で `sudo ufw status` に該当ポート許可があるか
