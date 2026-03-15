#!/bin/bash
# HTTPS デプロイ確認テスト
#
# さくらVPS で HTTPS 設定が正しく動作しているか確認する。
# 各段階で PASS/FAIL を表示し、どこで問題が発生しているか特定できる。
#
# 使い方:
#   ./test/doTest-https.sh <ドメイン名>
#   ./test/doTest-https.sh mmo.tommie.jp

set -e

if [ "$1" = "-h" ] || [ "$1" = "--help" ] || [ -z "$1" ]; then
    echo "使い方: $0 <ドメイン名>"
    echo ""
    echo "HTTPS デプロイの各段階を確認します:"
    echo "  1. ホスト nginx 起動確認"
    echo "  2. SSL 証明書の存在確認"
    echo "  3. Docker nginx (8080) 応答確認"
    echo "  4. Content-Type 確認（text/html）"
    echo "  5. HTTP → HTTPS リダイレクト確認"
    echo "  6. HTTPS 応答確認"
    echo "  7. HTTPS Content-Type 確認"
    echo "  8. WebSocket プロキシ確認"
    echo "  9. Nakama API プロキシ確認"
    echo " 10. ポート 7350 外部非公開確認"
    echo " 11. ポート 7350 ローカル応答確認"
    echo ""
    echo "例: $0 mmo.tommie.jp"
    exit 0
fi

DOMAIN="$1"
FAILED=0
PASS=0

check() {
    local label="$1"
    local result="$2"
    local detail="$3"
    if [ "$result" = "0" ]; then
        echo "  ✅ $label"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $label"
        [ -n "$detail" ] && echo "     $detail"
        FAILED=$((FAILED + 1))
    fi
}

echo "=== HTTPS デプロイ確認（${DOMAIN}） ==="
echo ""

# 1. ホスト nginx 起動確認
echo "[1/11] ホスト nginx ..."
NGINX_ACTIVE=$(systemctl is-active nginx 2>/dev/null || echo "inactive")
check "nginx サービス起動" "$([ "$NGINX_ACTIVE" = "active" ] && echo 0 || echo 1)" \
    "状態: ${NGINX_ACTIVE}。sudo systemctl start nginx で起動してください"

# 2. SSL 証明書の存在確認
echo "[2/11] SSL 証明書 ..."
CERT_EXISTS=1
if sudo test -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" 2>/dev/null; then
    CERT_EXISTS=0
fi
check "証明書ファイル存在" "$CERT_EXISTS" \
    "/etc/letsencrypt/live/${DOMAIN}/ が見つかりません。certbot で証明書を取得してください"

if [ "$CERT_EXISTS" = "0" ]; then
    # 証明書の有効期限確認
    EXPIRY=$(sudo openssl x509 -enddate -noout -in "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" 2>/dev/null | cut -d= -f2)
    if [ -n "$EXPIRY" ]; then
        EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || echo 0)
        NOW_EPOCH=$(date +%s)
        DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
        if [ "$DAYS_LEFT" -gt 0 ]; then
            check "証明書有効期限（残り${DAYS_LEFT}日）" "0"
        else
            check "証明書有効期限" "1" "証明書が期限切れです。certbot renew で更新してください"
        fi
    fi
fi

# 3. Docker nginx (8080) 応答確認
echo "[3/11] Docker nginx (8080) ..."
DOCKER_HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/ --connect-timeout 3 --max-time 5 2>/dev/null)
check "Docker nginx 応答 (HTTP ${DOCKER_HTTP})" "$([ "$DOCKER_HTTP" = "200" ] && echo 0 || echo 1)" \
    "Docker コンテナが起動していない可能性があります。docker compose ps で確認してください"

# 4. Content-Type 確認
echo "[4/11] Content-Type ..."
CONTENT_TYPE=$(curl -s -I http://127.0.0.1:8080/ --connect-timeout 3 --max-time 5 2>/dev/null | grep -i "content-type" | tr -d '\r' | awk '{print $2}')
check "Content-Type: text/html（実際: ${CONTENT_TYPE:-なし}）" "$(echo "$CONTENT_TYPE" | grep -q 'text/html' && echo 0 || echo 1)" \
    "nginx.conf に include /etc/nginx/mime.types; を追加してください"

# 5. HTTP → HTTPS リダイレクト確認
echo "[5/11] HTTP → HTTPS リダイレクト ..."
REDIRECT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null)
check "HTTP リダイレクト (${REDIRECT_CODE})" "$([ "$REDIRECT_CODE" = "301" ] && echo 0 || echo 1)" \
    "期待: 301、実際: ${REDIRECT_CODE}。nginx の server_name と listen 80 の設定を確認してください"

# 6. HTTPS 応答確認
echo "[6/11] HTTPS 応答 ..."
HTTPS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null)
check "HTTPS 応答 (HTTP ${HTTPS_CODE})" "$([ "$HTTPS_CODE" = "200" ] && echo 0 || echo 1)" \
    "SSL 証明書、nginx 設定、ファイアウォール (443/tcp) を確認してください"

# 7. HTTPS Content-Type 確認
echo "[7/11] HTTPS Content-Type ..."
HTTPS_CT=$(curl -s -I "https://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null | grep -i "content-type" | tr -d '\r' | awk '{print $2}')
check "HTTPS Content-Type: text/html（実際: ${HTTPS_CT:-なし}）" "$(echo "$HTTPS_CT" | grep -q 'text/html' && echo 0 || echo 1)" \
    "Docker nginx の Content-Type 設定を確認してください"

# 8. WebSocket プロキシ確認（HTTP Upgrade ヘッダーが通るか）
echo "[8/11] WebSocket プロキシ ..."
WS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/ws" \
    -H "Upgrade: websocket" -H "Connection: upgrade" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
# WebSocket は 101 (Switching Protocols)、400 (Bad Request)、401 (Unauthorized) が期待値（Nakama に到達している）
check "WebSocket プロキシ (HTTP ${WS_CODE})" "$([ "$WS_CODE" = "101" ] || [ "$WS_CODE" = "400" ] || [ "$WS_CODE" = "401" ] && echo 0 || echo 1)" \
    "nginx の proxy_set_header Upgrade/Connection 設定を確認してください"

# 9. Nakama API プロキシ確認
echo "[9/11] Nakama API プロキシ ..."
API_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/v2/account/authenticate/device?create=false" \
    -X POST -H "Content-Type: application/json" -d '{}' \
    --connect-timeout 5 --max-time 10 2>/dev/null)
# 認証なしなので 401 が期待値（Nakama に到達している証拠）
check "Nakama API プロキシ (HTTP ${API_CODE})" "$([ "$API_CODE" = "401" ] && echo 0 || echo 1)" \
    "期待: 401（認証エラー）、実際: ${API_CODE}。nginx の /v2/ プロキシ設定を確認してください"

# 10. Nakama API ポート 7350 が 127.0.0.1 のみバインドされていること
echo "[10/11] ポート 7350 バインド確認 ..."
BIND7350=$(docker compose -f docker-compose.yml -f docker-compose.prod.yml port nakama 7350 2>/dev/null || ss -tlnp 2>/dev/null | grep ":7350 ")
IS_LOCAL_ONLY=1
if echo "$BIND7350" | grep -q "127.0.0.1"; then
    IS_LOCAL_ONLY=0
elif echo "$BIND7350" | grep -q "0.0.0.0"; then
    IS_LOCAL_ONLY=1
fi
check "ポート 7350 は 127.0.0.1 のみ（${BIND7350:-不明}）" "$IS_LOCAL_ONLY" \
    "docker-compose.prod.yml で 127.0.0.1:7350:7350 にバインドしてください"

# 11. Nakama API ポート 7350 がローカルで応答すること
echo "[11/11] ポート 7350 ローカル応答 ..."
LOCAL7350_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:7350/healthcheck" \
    --connect-timeout 3 --max-time 5 2>/dev/null)
check "ポート 7350 ローカル応答 (HTTP ${LOCAL7350_CODE})" "$([ "$LOCAL7350_CODE" = "200" ] && echo 0 || echo 1)" \
    "Nakama サーバが起動していないか、127.0.0.1:7350 にバインドされていません"

# 結果
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILED" -eq 0 ]; then
    echo "✅ 全テスト成功（${PASS}/${PASS}）"
else
    echo "❌ ${FAILED}件失敗（成功: ${PASS}、失敗: ${FAILED}）"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━"
exit $FAILED
