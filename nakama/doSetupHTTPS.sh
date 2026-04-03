#!/bin/bash
# HTTPS 設定スクリプト（Let's Encrypt）
# Usage: ./nakama/doSetupHTTPS.sh <ドメイン名> [-h]
#
# 前提:
#   - doDeploy.sh 実行済み（サーバー起動済み）
#   - DNS の A レコードがこのサーバーの IP を指している

case "${1:-}" in
    -h|--help|"")
        echo "Usage: $0 <ドメイン名>"
        echo "  Let's Encrypt で HTTPS を設定します"
        echo ""
        echo "例: $0 chat.example.com"
        echo ""
        echo "前提:"
        echo "  - doDeploy.sh 実行済み"
        echo "  - DNS A レコードがこのサーバーの IP に設定済み"
        exit 0 ;;
esac

set -euo pipefail

DOMAIN="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
NGINX_CONF="$SCRIPT_DIR/nginx.conf"

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

# ── 1. certbot インストール ──
step "1. certbot インストール"
if command -v certbot &>/dev/null; then
    echo "certbot 既にインストール済み"
else
    sudo apt-get update
    sudo apt-get install -y certbot
    echo "✅ certbot インストール完了"
fi

# ── 2. 証明書の取得 ──
step "2. 証明書の取得（ドメイン: $DOMAIN）"

# nginx を一時停止してポート80を解放
cd "$SCRIPT_DIR"
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop web

sudo certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

# ── 3. nginx.conf の HTTPS 化 ──
step "3. nginx.conf の更新"

# バックアップ
if [ ! -f "$NGINX_CONF.http" ]; then
    cp "$NGINX_CONF" "$NGINX_CONF.http"
    echo "HTTP版を nginx.conf.http にバックアップ"
fi

cat > "$NGINX_CONF" <<NGINX_EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    root /usr/share/nginx/html;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    types {
        image/ktx2 ktx2;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /textures/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # MinIO S3 リバースプロキシ
    location /s3/ {
        proxy_pass http://minio:9000/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_buffering off;
    }

    # Nakama HTTP API
    location /v2/ {
        proxy_pass http://nakama:7350;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    # Nakama WebSocket
    location /ws {
        proxy_pass http://nakama:7350;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
NGINX_EOF

echo "✅ nginx.conf を HTTPS 化"

# ── 4. docker-compose.yml に証明書マウントと443ポートを追加 ──
step "4. docker-compose.yml の更新"

# web サービスに letsencrypt ボリュームを追加
if ! grep -q 'letsencrypt' "$COMPOSE_FILE"; then
    sed -i '/nginx.conf:\/etc\/nginx\/conf.d\/default.conf:ro/a\      - /etc/letsencrypt:/etc/letsencrypt:ro' "$COMPOSE_FILE"
fi

# 443 ポートを追加
if ! grep -q '"443:443"' "$COMPOSE_FILE"; then
    sed -i '/"80:80"/a\      - "443:443"' "$COMPOSE_FILE"
fi

echo "✅ docker-compose.yml 更新完了"

# ── 5. クライアント接続先の変更 ──
step "5. クライアント接続先の変更"
INDEX_HTML="$ROOT_DIR/index.html"

if [ -f "$INDEX_HTML" ]; then
    # APP_NAKAMA_HOST を変更
    sed -i "s|APP_NAKAMA_HOST.*=.*\"[^\"]*\"|APP_NAKAMA_HOST = \"$DOMAIN\"|" "$INDEX_HTML"
    # APP_NAKAMA_PORT を 443 に変更
    sed -i 's|APP_NAKAMA_PORT.*=.*"[^"]*"|APP_NAKAMA_PORT = "443"|' "$INDEX_HTML"
    # APP_NAKAMA_USE_SSL を true に変更
    sed -i 's|APP_NAKAMA_USE_SSL.*=.*false|APP_NAKAMA_USE_SSL = true|' "$INDEX_HTML"
    echo "✅ index.html の接続先を $DOMAIN:443 (SSL) に変更"

    # フロントエンド再ビルド
    cd "$ROOT_DIR"
    npm run build
    echo "✅ フロントエンド再ビルド完了"
fi

# ── 6. nginx 再起動 ──
step "6. サーバー再起動"
cd "$SCRIPT_DIR"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# ── 7. 証明書の自動更新 cron ──
step "7. 証明書の自動更新設定"
CRON_CMD="0 3 1,15 * * certbot renew --pre-hook 'cd $SCRIPT_DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml stop web' --post-hook 'cd $SCRIPT_DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml start web'"

if crontab -l 2>/dev/null | grep -q 'certbot renew'; then
    echo "certbot cron 既に設定済み"
else
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "✅ 自動更新 cron 設定完了（毎月1日・15日 3:00）"
fi

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  HTTPS 設定完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "  URL: https://$DOMAIN"
echo ""
echo "確認:"
echo "  curl -I https://$DOMAIN"
