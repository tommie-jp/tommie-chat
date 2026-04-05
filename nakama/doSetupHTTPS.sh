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
#   ブラウザ → ホスト nginx (443/HTTPS) → Docker nginx (8081/HTTP) → Nakama
#   Docker nginx は HTTP のまま変更しない。HTTPS はホスト nginx が終端する。

case "${1:-}" in
    -h|--help|"")
        echo "Usage: $0 <ドメイン名>"
        echo "  Let's Encrypt で HTTPS を設定します"
        echo ""
        echo "構成:"
        echo "  ブラウザ → ホスト nginx (443/HTTPS) → Docker nginx (8081/HTTP) → Nakama"
        echo "  Docker nginx.conf は変更しません"
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
cd "$SCRIPT_DIR"
if ! docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --status running 2>/dev/null | grep -q web; then
    fail "Docker nginx (web) が起動していません。先に doDeploy.sh を実行してください"
fi

# Docker nginx (8081) に接続できるか
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/ --connect-timeout 3 --max-time 5 2>/dev/null)
if [ "$HTTP_CODE" != "200" ]; then
    fail "Docker nginx (8081) に接続できません (HTTP $HTTP_CODE)"
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

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
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
echo "  ブラウザ → ホスト nginx (443/HTTPS) → Docker nginx (8081/HTTP) → Nakama"
echo ""
echo "確認:"
echo "  curl -I https://$DOMAIN"
echo "  ./test/doTest-https.sh $DOMAIN"
