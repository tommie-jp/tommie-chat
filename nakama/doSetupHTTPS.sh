#!/bin/bash
# HTTPS 設定スクリプト（Let's Encrypt + ホスト nginx）
# Usage: ./nakama/doSetupHTTPS.sh <ドメイン名> [-h]
#
# 前提:
#   - doDeploy.sh 実行済み（サーバー起動済み）
#   - DNS の A レコードがこのサーバーの IP を指している
#   - VPS 上で実行する
#
# 構成:
#   ブラウザ → ホスト nginx (443/HTTPS) → Docker nginx (${WEB_PORT}/HTTP) → Nakama
#   Docker nginx は HTTP のまま変更しない。HTTPS はホスト nginx が終端する。
#   Docker nginx の公開ポートは nakama/.env の WEB_PORT で決まる（既定 8081）。
#   複数環境（prod+staging 等）を同一 VPS で運用する場合は環境ごとに別ポートとする。

case "${1:-}" in
    -h|--help|"")
        echo "Usage: $0 <ドメイン名>"
        echo "  Let's Encrypt で HTTPS を設定します"
        echo ""
        echo "構成:"
        echo "  ブラウザ → ホスト nginx (443/HTTPS) → Docker nginx (\${WEB_PORT}/HTTP) → Nakama"
        echo "  Docker nginx.conf は変更しません"
        echo "  プロキシ先のポートは nakama/.env の WEB_PORT を参照します（既定 8081）"
        echo ""
        echo "例: $0 mmo.tommie.jp"
        echo ""
        echo "前提:"
        echo "  - doDeploy.sh 実行済み"
        echo "  - DNS A レコードがこのサーバーの IP に設定済み"
        exit 0 ;;
esac

set -euo pipefail

DOMAIN="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# nakama/.env を読み込んで WEB_PORT / COMPOSE_PROJECT_NAME 等を取得
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/.env"
    set +a
fi
WEB_PORT="${WEB_PORT:-8081}"

# WEB_PORT は 1-65535 の数値のみ許可（nginx 設定への注入防止）
case "$WEB_PORT" in
    ''|*[!0-9]*)
        echo "❌ WEB_PORT が数値ではありません: '${WEB_PORT}'" >&2
        exit 1 ;;
esac
if [ "$WEB_PORT" -lt 1 ] || [ "$WEB_PORT" -gt 65535 ]; then
    echo "❌ WEB_PORT が範囲外です: ${WEB_PORT}" >&2
    exit 1
fi

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

# Docker nginx が起動しているか
if ! docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --status running 2>/dev/null | grep -q web; then
    fail "Docker nginx (web) が起動していません。先に doDeploy.sh を実行してください"
fi

# Docker nginx (WEB_PORT) に接続できるか
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${WEB_PORT}/" --connect-timeout 3 --max-time 5 2>/dev/null)
if [ "$HTTP_CODE" != "200" ]; then
    fail "Docker nginx (${WEB_PORT}) に接続できません (HTTP $HTTP_CODE)"
fi

# ── 1. ホスト nginx インストール ──
step "1. ホスト nginx インストール"
if command -v nginx &>/dev/null; then
    echo "nginx 既にインストール済み: $(nginx -v 2>&1)"
else
    sudo apt-get update
    sudo apt-get install -y nginx
    echo "✅ nginx インストール完了"
fi

# ── 2. certbot インストール ──
step "2. certbot インストール"
if command -v certbot &>/dev/null; then
    echo "certbot 既にインストール済み"
else
    sudo apt-get update
    sudo apt-get install -y certbot
    echo "✅ certbot インストール完了"
fi

# ── 3. 証明書の取得 ──
step "3. 証明書の取得（ドメイン: $DOMAIN）"

# 既存の証明書を確認
if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    echo "証明書が既に存在します。更新を試みます..."
    sudo certbot renew --dry-run 2>/dev/null && echo "✅ 証明書は有効です" || {
        warn "証明書の更新に失敗しました。再取得します"
        # ホスト nginx を一時停止してポート80を解放
        sudo systemctl stop nginx 2>/dev/null || true
        sudo certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
        sudo systemctl start nginx
    }
else
    # ホスト nginx を一時停止してポート80を解放
    sudo systemctl stop nginx 2>/dev/null || true
    sudo certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
    sudo systemctl start nginx
    echo "✅ 証明書取得完了"
fi

# ── 4. ホスト nginx の HTTPS 設定 ──
step "4. ホスト nginx 設定（/etc/nginx/sites-available/$DOMAIN）"

MAINT_DIR="/var/www/tommie-chat-error"
sudo mkdir -p "$MAINT_DIR"
sudo cp "$SCRIPT_DIR/../dist/maintenance.html" "$MAINT_DIR/maintenance.html"
sudo cp "$SCRIPT_DIR/../dist/404.html" "$MAINT_DIR/404.html"
echo "✅ エラーページ配置: $MAINT_DIR"

sudo tee "/etc/nginx/sites-available/$DOMAIN" > /dev/null <<NGINX_EOF
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

    # メンテナンスページ（Docker コンテナ停止時に表示）
    error_page 502 503 504 /maintenance.html;
    location = /maintenance.html {
        root $MAINT_DIR;
        internal;
    }
    error_page 404 /404.html;
    location = /404.html {
        root $MAINT_DIR;
        internal;
    }

    location / {
        proxy_pass http://127.0.0.1:${WEB_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_intercept_errors on;
    }
}
NGINX_EOF

# 有効化
sudo ln -sf "/etc/nginx/sites-available/$DOMAIN" /etc/nginx/sites-enabled/
# default サイトを無効化（競合防止）
sudo rm -f /etc/nginx/sites-enabled/default

# 設定テスト
if sudo nginx -t 2>&1; then
    sudo systemctl reload nginx
    echo "✅ ホスト nginx 設定完了"
else
    fail "nginx 設定テストに失敗しました"
fi

# ── 5. 証明書の自動更新 cron ──
step "5. 証明書の自動更新設定"
CRON_CMD="0 3 1,15 * * certbot renew --pre-hook 'systemctl stop nginx' --post-hook 'systemctl start nginx'"

if crontab -l 2>/dev/null | grep -q 'certbot renew'; then
    echo "certbot cron 既に設定済み"
else
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "✅ 自動更新 cron 設定完了（毎月1日・15日 3:00）"
fi

# ── 6. 確認 ──
step "6. 動作確認"
sleep 2
HTTPS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://$DOMAIN/" --connect-timeout 5 --max-time 10 2>/dev/null)
if [ "$HTTPS_CODE" = "200" ]; then
    echo "✅ https://$DOMAIN/ → HTTP $HTTPS_CODE"
else
    warn "https://$DOMAIN/ → HTTP $HTTPS_CODE（確認してください）"
fi

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  HTTPS 設定完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "  URL: https://$DOMAIN"
echo ""
echo "構成:"
echo "  ブラウザ → ホスト nginx (443/HTTPS) → Docker nginx (${WEB_PORT}/HTTP) → Nakama"
echo ""
echo "確認:"
echo "  curl -I https://$DOMAIN"
echo "  ./test/doTest-https.sh $DOMAIN"
