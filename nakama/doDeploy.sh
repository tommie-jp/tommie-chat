#!/bin/bash
# デプロイスクリプト（Docker インストール〜アプリ起動）
# Usage: ./nakama/doDeploy.sh [-h]
#
# 前提:
#   - Ubuntu 22.04 / 24.04
#   - sudo 権限を持つユーザーで実行
#   - SSH 鍵認証・ファイアウォールは手動設定済み（doc/40-デプロイ手順.md 参照）

case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  VPS に tommieChat をデプロイします"
        echo ""
        echo "実行内容:"
        echo "  1. ファイアウォール設定"
        echo "  2. スワップ設定（2GB 以下の場合）"
        echo "  3. Docker インストール"
        echo "  4. (予約)"
        echo "  5. 環境変数設定（初回のみ生成、以降は再利用）"
        echo "  6. 本番用 nginx.conf 生成"
        echo "  7. フロントエンド配置（開発環境でビルド済みの dist/ を使用）"
        echo "  8. Docker ログローテーション設定"
        echo "  9. サーバー起動（Go プラグインはビルド済み前提）"
        echo " 10. MinIO バケット初期化"
        exit 0 ;;
esac

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# ── 前提チェック ──
if [ "$(id -u)" -eq 0 ]; then
    fail "root で実行しないでください。sudo 権限を持つ一般ユーザーで実行してください"
fi

# ── 既存コンテナの停止（ポート競合防止） ──
# Bind mount（./data/）を使用するため、データはコンテナ削除後も保持される
cd "$SCRIPT_DIR"

if [ -f docker-compose.prod.yml ]; then
    docker compose -f docker-compose.yml -f docker-compose.prod.yml down 2>/dev/null || true
fi
docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>/dev/null || true
docker compose down 2>/dev/null || true
# 名前ベースでも残留コンテナを削除
EXISTING=$(docker ps -aq --filter "name=nakama" 2>/dev/null; docker ps -aq --filter "name=tommchat-prod" 2>/dev/null)
EXISTING=$(echo "$EXISTING" | sort -u | grep -v '^$' || true)
if [ -n "$EXISTING" ]; then
    warn "残留コンテナを削除します"
    echo "$EXISTING" | xargs -r docker rm -f
fi

# ── 1. ファイアウォール ──
step "1. ファイアウォール設定"
if ! command -v ufw &>/dev/null; then
    warn "ufw が見つかりません。手動でファイアウォールを設定してください"
elif sudo ufw status | grep -q "Status: active"; then
    echo "ファイアウォール既に有効（スキップ）"
    sudo ufw status
else
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22/tcp
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    echo "y" | sudo ufw enable
    sudo ufw status
    echo "✅ ファイアウォール設定完了"
fi

# ── 2. スワップ設定 ──
step "2. スワップ設定"
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [ "$TOTAL_MEM_KB" -le 2097152 ] && [ ! -f /swapfile ]; then
    echo "メモリ ${TOTAL_MEM_KB}KB — スワップ 2GB を作成"
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    if ! grep -q '/swapfile' /etc/fstab; then
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    fi
    echo "✅ スワップ設定完了"
else
    echo "スキップ（メモリ十分 or スワップ既存）"
fi

# ── 3. Docker インストール ──
step "3. Docker インストール"
if command -v docker &>/dev/null; then
    echo "Docker 既にインストール済み: $(docker --version)"
else
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg lsb-release

    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    sudo usermod -aG docker "$USER"
    echo "✅ Docker インストール完了"
    warn "docker グループの反映には再ログインが必要です"
fi

# ── 4. (予約: 将来の拡張用) ──

# ── 5. 環境変数の設定 ──
step "5. 環境変数の設定"
ENV_FILE="$SCRIPT_DIR/.env"
# Bind mount でデータ永続化するため、.env が既にあれば再利用する
if [ -f "$ENV_FILE" ]; then
    echo ".env が既に存在します（再利用）"
    set -a; source "$ENV_FILE"; set +a
else
    PG_PASS=$(openssl rand -hex 16)
    SERVER_KEY=tommie-chat
    CONSOLE_PASS=$(openssl rand -hex 12)
    MINIO_USER="minio-$(openssl rand -hex 4)"
    MINIO_PASS=$(openssl rand -hex 16)
    cat > "$ENV_FILE" <<EOV
POSTGRES_PASSWORD=$PG_PASS
NAKAMA_SERVER_KEY=$SERVER_KEY
NAKAMA_CONSOLE_USER=admin
NAKAMA_CONSOLE_PASS=$CONSOLE_PASS
MINIO_ROOT_USER=$MINIO_USER
MINIO_ROOT_PASSWORD=$MINIO_PASS
EOV
    set -a; source "$ENV_FILE"; set +a
    echo "✅ .env 生成完了（初回生成）"
fi

SERVER_KEY="${NAKAMA_SERVER_KEY}"
CONSOLE_PASS="${NAKAMA_CONSOLE_PASS}"
MINIO_USER="${MINIO_ROOT_USER}"
MINIO_PASS="${MINIO_ROOT_PASSWORD}"

echo ""
echo "  server_key:       $SERVER_KEY"
echo "  console.username: ${NAKAMA_CONSOLE_USER:-admin}"
echo "  console.password: $CONSOLE_PASS"
echo "  minio.user:       $MINIO_USER"
echo "  minio.password:   $MINIO_PASS"

# ── 6. 本番用 nginx.conf 生成 ──
step "6. 本番用 nginx.conf 生成"
NGINX_CONF="$SCRIPT_DIR/nginx.conf"
# 開発用 nginx.conf をバックアップ（初回のみ）
if [ ! -f "$NGINX_CONF.dev" ]; then
    cp "$NGINX_CONF" "$NGINX_CONF.dev"
fi
cat > "$NGINX_CONF" <<'NGINX_EOF'
server {
    listen 80;

    root /usr/share/nginx/html;
    index index.html;

    include /etc/nginx/mime.types;
    types {
        image/ktx2 ktx2;
    }

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # セキュリティヘッダー
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.babylonjs.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' wss://*.tommie.jp https://cdn.babylonjs.com; font-src 'self'; object-src 'none'; frame-ancestors 'none'" always;

    # SPA フォールバック
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Vite ビルド済みアセット — 長期キャッシュ
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # テクスチャ — 長期キャッシュ
    location /textures/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # MinIO S3 リバースプロキシ（avatars バケットの GET のみ許可）
    location /s3/avatars/ {
        limit_except GET HEAD {
            deny all;
        }
        proxy_pass http://minio:9000/avatars/;
        proxy_http_version 1.1;
        proxy_set_header Host minio:9000;
        proxy_buffering off;
    }

    # /s3/ の他パスは全て拒否
    location /s3/ {
        return 403;
    }

    # Nakama HTTP API（Origin 制限: ブラウザからのリクエストのみ許可）
    location /v2/ {
        # Origin or Referer が自サイト or localhost なら許可
        set $origin_ok "N";
        if ($http_origin ~* "^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($http_origin ~* "^https?://mmo\.tommie\.jp(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($http_referer ~* "^https?://mmo\.tommie\.jp/") { set $origin_ok "Y"; }
        if ($origin_ok = "N") { return 403; }

        proxy_pass http://nakama:7350;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Nakama WebSocket（Origin 制限）
    location /ws {
        set $origin_ok "N";
        if ($http_origin ~* "^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($http_origin ~* "^https?://mmo\.tommie\.jp(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($origin_ok = "N") { return 403; }

        proxy_pass http://nakama:7350;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
NGINX_EOF
echo "✅ 本番用 nginx.conf 生成完了（/s3/ → MinIO プロキシ含む）"

# ── 7. フロントエンド配置 ──
step "7. フロントエンド配置"
if [ ! -d "$ROOT_DIR/dist" ] || [ ! -f "$ROOT_DIR/dist/index.html" ]; then
    fail "dist/ が見つかりません。開発環境で先にビルドしてください:
   npm run build  （開発環境で実行）
   rsync -avz --delete dist/ deploy@<VPS>:~/tommie-chat/dist/"
fi
DIST_FILES=$(find "$ROOT_DIR/dist" -type f | wc -l)
echo "  dist/ 検出: ${DIST_FILES} ファイル"
echo "✅ フロントエンド配置確認完了（開発環境でビルド済み）"

# ── 8. Docker ログローテーション ──
step "8. Docker ログローテーション設定"
DAEMON_JSON="/etc/docker/daemon.json"
if [ ! -f "$DAEMON_JSON" ]; then
    sudo tee "$DAEMON_JSON" > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
    sudo systemctl restart docker
    echo "✅ ログローテーション設定完了"
else
    echo "daemon.json 既存（スキップ）"
fi

# ── 9. サーバー起動 ──
step "9. サーバー起動"
cd "$SCRIPT_DIR"
# Bind mount 用ディレクトリ作成（初回のみ）
mkdir -p "$SCRIPT_DIR/data/postgres-prod" "$SCRIPT_DIR/data/minio"
echo "  NAKAMA_SERVER_KEY=${NAKAMA_SERVER_KEY}"
echo "  .env server_key: $(grep NAKAMA_SERVER_KEY "$ENV_FILE" | cut -d= -f2)"
# Go プラグイン（world.so）は開発環境でビルド済み（git に含まれる）
if [ ! -f "$SCRIPT_DIR/modules/world.so" ]; then
    echo "⚠️  nakama/modules/world.so が見つかりません。"
    echo "   開発環境で doBuild.sh を実行してから git push してください。"
    exit 1
fi
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# ── 10. MinIO バケット初期化 ──
step "10. MinIO バケット初期化"
echo "MinIO の起動を待機中..."
for i in $(seq 1 30); do
    if docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T minio mc ready local 2>/dev/null; then
        break
    fi
    sleep 2
done

# mc エイリアス設定 & バケット作成
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T minio \
    sh -c "mc alias set local http://localhost:9000 '$MINIO_USER' '$MINIO_PASS' && \
           mc mb --ignore-existing local/avatars && \
           mc mb --ignore-existing local/assets && \
           mc mb --ignore-existing local/uploads && \
           mc anonymous set download local/avatars && \
           mc anonymous set download local/assets"
echo "✅ MinIO バケット初期化完了（avatars, assets, uploads）"

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  デプロイ完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "  Web:       http://$(hostname -I | awk '{print $1}')"
echo "  Console:   http://127.0.0.1:7351 (admin / $CONSOLE_PASS)"
echo "  MinIO:     http://127.0.0.1:9001 ($MINIO_USER / $MINIO_PASS)"
echo ""
echo "次のステップ:"
echo "  HTTPS を設定: ./nakama/doSetupHTTPS.sh <ドメイン名>"
echo ""
echo "詳細: doc/40-デプロイ手順.md"
