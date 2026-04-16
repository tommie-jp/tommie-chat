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

TOTAL=17
if [ "$1" = "-h" ] || [ "$1" = "--help" ] || [ -z "$1" ]; then
    echo "使い方: $0 <ドメイン名>"
    echo ""
    echo "HTTPS デプロイの各段階を確認します:"
    echo "  1. ホスト nginx 起動確認"
    echo "  2. SSL 証明書の存在確認"
    echo "  3. Docker nginx (8081) 応答確認"
    echo "  4. Content-Type 確認（text/html）"
    echo "  5. HTTP → HTTPS リダイレクト確認"
    echo "  6. HTTPS 応答確認"
    echo "  7. HTTPS Content-Type 確認"
    echo "  8. WebSocket プロキシ確認"
    echo "  9. Nakama API プロキシ確認"
    echo " 10. ポート 7350 外部非公開確認"
    echo " 11. ポート 7350 ローカル応答確認"
    echo " 12. カスタム 404 ページ（/s3/xxx）"
    echo " 13. maintenance.html 直接アクセス不可（internal）"
    echo " 14. セキュリティヘッダー（CSP, X-Frame-Options, X-Content-Type-Options）"
    echo " 15. HSTS ヘッダー（Strict-Transport-Security）"
    echo " 16. TLS バージョン確認（TLS 1.2 以上）"
    echo " 17. 証明書のドメイン一致"
    echo ""
    echo "※ メンテナンスページ（502 時）のテストは doTest-maintenance.sh を使用"
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
echo "[1/${TOTAL}] ホスト nginx ..."
NGINX_ACTIVE=$(systemctl is-active nginx 2>/dev/null || echo "inactive")
check "nginx サービス起動" "$([ "$NGINX_ACTIVE" = "active" ] && echo 0 || echo 1)" \
    "状態: ${NGINX_ACTIVE}。sudo systemctl start nginx で起動してください"

# 2. SSL 証明書の存在確認
echo "[2/${TOTAL}] SSL 証明書 ..."
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

# 3. Docker nginx (8081) 応答確認
echo "[3/${TOTAL}] Docker nginx (8081) ..."
DOCKER_HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8081/ --connect-timeout 3 --max-time 5 2>/dev/null)
check "Docker nginx 応答 (HTTP ${DOCKER_HTTP})" "$([ "$DOCKER_HTTP" = "200" ] && echo 0 || echo 1)" \
    "Docker コンテナが起動していない可能性があります。docker compose ps で確認してください"

# 4. Content-Type 確認
echo "[4/${TOTAL}] Content-Type ..."
CONTENT_TYPE=$(curl -s -I http://127.0.0.1:8081/ --connect-timeout 3 --max-time 5 2>/dev/null | grep -i "content-type" | tr -d '\r' | awk '{print $2}')
check "Content-Type: text/html（実際: ${CONTENT_TYPE:-なし}）" "$(echo "$CONTENT_TYPE" | grep -q 'text/html' && echo 0 || echo 1)" \
    "nginx.conf に include /etc/nginx/mime.types; を追加してください"

# 5. HTTP → HTTPS リダイレクト確認
echo "[5/${TOTAL}] HTTP → HTTPS リダイレクト ..."
REDIRECT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null)
check "HTTP リダイレクト (${REDIRECT_CODE})" "$([ "$REDIRECT_CODE" = "301" ] && echo 0 || echo 1)" \
    "期待: 301、実際: ${REDIRECT_CODE}。nginx の server_name と listen 80 の設定を確認してください"

# 6. HTTPS 応答確認
echo "[6/${TOTAL}] HTTPS 応答 ..."
HTTPS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null)
check "HTTPS 応答 (HTTP ${HTTPS_CODE})" "$([ "$HTTPS_CODE" = "200" ] && echo 0 || echo 1)" \
    "SSL 証明書、nginx 設定、ファイアウォール (443/tcp) を確認してください"

# 7. HTTPS Content-Type 確認
echo "[7/${TOTAL}] HTTPS Content-Type ..."
HTTPS_CT=$(curl -s -I "https://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null | grep -i "content-type" | tr -d '\r' | awk '{print $2}')
check "HTTPS Content-Type: text/html（実際: ${HTTPS_CT:-なし}）" "$(echo "$HTTPS_CT" | grep -q 'text/html' && echo 0 || echo 1)" \
    "Docker nginx の Content-Type 設定を確認してください"

# 8. WebSocket プロキシ確認（HTTP Upgrade ヘッダーが通るか）
echo "[8/${TOTAL}] WebSocket プロキシ ..."
WS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/ws" \
    -H "Origin: https://${DOMAIN}" \
    -H "Upgrade: websocket" -H "Connection: upgrade" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
# WebSocket は 101 (Switching Protocols)、400 (Bad Request)、401 (Unauthorized) が期待値（Nakama に到達している）
check "WebSocket プロキシ (HTTP ${WS_CODE})" "$([ "$WS_CODE" = "101" ] || [ "$WS_CODE" = "400" ] || [ "$WS_CODE" = "401" ] && echo 0 || echo 1)" \
    "nginx の proxy_set_header Upgrade/Connection 設定を確認してください"

# 9. Nakama API プロキシ確認
echo "[9/${TOTAL}] Nakama API プロキシ ..."
API_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/v2/account/authenticate/device?create=false" \
    -H "Origin: https://${DOMAIN}" \
    -X POST -H "Content-Type: application/json" -d '{}' \
    --connect-timeout 5 --max-time 10 2>/dev/null)
# 認証なしなので 401 が期待値（Nakama に到達している証拠）
check "Nakama API プロキシ (HTTP ${API_CODE})" "$([ "$API_CODE" = "401" ] && echo 0 || echo 1)" \
    "期待: 401（認証エラー）、実際: ${API_CODE}。nginx の /v2/ プロキシ設定を確認してください"

# 10. Nakama API ポート 7350 が 127.0.0.1 のみバインドされていること
echo "[10/${TOTAL}] ポート 7350 バインド確認 ..."
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
echo "[11/${TOTAL}] ポート 7350 ローカル応答 ..."
LOCAL7350_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:7350/healthcheck" \
    --connect-timeout 3 --max-time 5 2>/dev/null)
check "ポート 7350 ローカル応答 (HTTP ${LOCAL7350_CODE})" "$([ "$LOCAL7350_CODE" = "200" ] && echo 0 || echo 1)" \
    "Nakama サーバが起動していないか、127.0.0.1:7350 にバインドされていません"

# 12. カスタム 404 ページ（/s3/xxx で 404 + カスタム HTML が返ること）
echo "[12/${TOTAL}] カスタム 404 ページ ..."
ERR404_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/s3/does-not-exist" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
ERR404_BODY=$(curl -s "https://${DOMAIN}/s3/does-not-exist" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
ERR404_HAS_CUSTOM=$(echo "$ERR404_BODY" | grep -q "tommieChat" && echo "Y" || echo "N")
check "カスタム 404 (HTTP ${ERR404_CODE}, カスタムHTML: ${ERR404_HAS_CUSTOM})" \
    "$([ "$ERR404_CODE" = "404" ] && [ "$ERR404_HAS_CUSTOM" = "Y" ] && echo 0 || echo 1)" \
    "期待: 404 + tommieChat 文字列含む。error_page 404 と 404.html の配置を確認してください"

# 13. maintenance.html 直接アクセス不可（internal 指定で SPA フォールバック）
echo "[13/${TOTAL}] maintenance.html 直接アクセス不可 ..."
MAINT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/maintenance.html" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
# internal 指定なのでホスト nginx → Docker nginx → SPA フォールバック → 200（index.html）
check "maintenance.html 直接アクセス不可 (HTTP ${MAINT_CODE})" \
    "$([ "$MAINT_CODE" = "200" ] && echo 0 || echo 1)" \
    "期待: 200（SPA フォールバック）。internal 指定が外れている可能性があります"

# 14. セキュリティヘッダー確認
echo "[14/${TOTAL}] セキュリティヘッダー ..."
SEC_HEADERS=$(curl -s -I "https://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null)

# CSP
SEC_CSP=$(echo "$SEC_HEADERS" | grep -i "content-security-policy" | tr -d '\r')
HAS_CSP=$([ -n "$SEC_CSP" ] && echo "Y" || echo "N")
check "Content-Security-Policy ヘッダー存在" \
    "$([ "$HAS_CSP" = "Y" ] && echo 0 || echo 1)" \
    "Docker nginx の add_header Content-Security-Policy を確認してください"

# X-Frame-Options
HAS_XFO=$(echo "$SEC_HEADERS" | grep -qi "x-frame-options" && echo "Y" || echo "N")
check "X-Frame-Options ヘッダー存在" \
    "$([ "$HAS_XFO" = "Y" ] && echo 0 || echo 1)" \
    "Docker nginx の add_header X-Frame-Options を確認してください"

# X-Content-Type-Options
HAS_XCTO=$(echo "$SEC_HEADERS" | grep -qi "x-content-type-options" && echo "Y" || echo "N")
check "X-Content-Type-Options ヘッダー存在" \
    "$([ "$HAS_XCTO" = "Y" ] && echo 0 || echo 1)" \
    "Docker nginx の add_header X-Content-Type-Options を確認してください"

# Referrer-Policy
HAS_RP=$(echo "$SEC_HEADERS" | grep -qi "referrer-policy" && echo "Y" || echo "N")
check "Referrer-Policy ヘッダー存在" \
    "$([ "$HAS_RP" = "Y" ] && echo 0 || echo 1)" \
    "Docker nginx の add_header Referrer-Policy を確認してください"

# 15. HSTS ヘッダー
echo "[15/${TOTAL}] HSTS ヘッダー ..."
HAS_HSTS=$(echo "$SEC_HEADERS" | grep -qi "strict-transport-security" && echo "Y" || echo "N")
if [ "$HAS_HSTS" = "Y" ]; then
    check "Strict-Transport-Security ヘッダー存在" "0"
else
    # HSTS 未設定は警告（FAIL ではなく PASS 扱い + 注意喚起）
    echo "  ⚠️  Strict-Transport-Security 未設定（推奨: add_header Strict-Transport-Security \"max-age=31536000\" always;）"
    PASS=$((PASS + 1))
fi

# 16. TLS バージョン確認（TLS 1.2 以上のみ）
echo "[16/${TOTAL}] TLS バージョン ..."
# TLS 1.1 で接続を試み、失敗すれば TLS 1.2+ のみ = 安全
TLS11_FAIL=0
if curl -s -o /dev/null --tls-max 1.1 "https://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null; then
    TLS11_FAIL=1  # TLS 1.1 で接続できてしまった
fi
# TLS 1.2 で接続を試み、成功すれば OK
TLS12_OK=0
if curl -s -o /dev/null --tlsv1.2 "https://${DOMAIN}/" --connect-timeout 5 --max-time 10 2>/dev/null; then
    TLS12_OK=1
fi
check "TLS 1.2+ のみ許可（TLS 1.1 拒否: $([ "$TLS11_FAIL" = "0" ] && echo "Y" || echo "N"), TLS 1.2 接続: $([ "$TLS12_OK" = "1" ] && echo "Y" || echo "N")）" \
    "$([ "$TLS11_FAIL" = "0" ] && [ "$TLS12_OK" = "1" ] && echo 0 || echo 1)" \
    "nginx の ssl_protocols を TLSv1.2 TLSv1.3 のみに設定してください"

# 17. 証明書のドメイン一致
echo "[17/${TOTAL}] 証明書ドメイン一致 ..."
CERT_CN=$(echo | openssl s_client -servername "${DOMAIN}" -connect "${DOMAIN}:443" 2>/dev/null \
    | openssl x509 -noout -subject -nameopt multiline 2>/dev/null \
    | grep commonName | sed 's/.*= //')
CERT_SAN=$(echo | openssl s_client -servername "${DOMAIN}" -connect "${DOMAIN}:443" 2>/dev/null \
    | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)
DOMAIN_MATCH="N"
if [ "$CERT_CN" = "$DOMAIN" ]; then
    DOMAIN_MATCH="Y"
elif echo "$CERT_SAN" | grep -q "DNS:${DOMAIN}"; then
    DOMAIN_MATCH="Y"
fi
check "証明書ドメイン一致（CN: ${CERT_CN:-不明}）" \
    "$([ "$DOMAIN_MATCH" = "Y" ] && echo 0 || echo 1)" \
    "証明書のドメインが ${DOMAIN} と一致しません。certbot で正しいドメインの証明書を取得してください"

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
