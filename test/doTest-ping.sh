#!/bin/bash
# サーバ疎通テスト（server_key 認証確認）
# Usage: ./test/doTest-ping.sh [-h]
#
# Nakama コンテナが healthy になるまで待機し、
# curl で HTTP API に接続して server_key で認証できるかを確認する。
# 失敗した場合は exit 1 を返す。

case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  Nakama サーバに server_key で接続できるか確認します"
        echo "  前提: nakama サーバが 127.0.0.1:7350 で起動していること"
        exit 0 ;;
esac

cd "$(dirname "$0")/.."
# .env から NAKAMA_SERVER_KEY 等を自動読み込み
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f nakama/.env ]; then
    set -a; source nakama/.env; set +a
fi

SERVER_KEY="${NAKAMA_SERVER_KEY:-defaultkey}"
HOST="127.0.0.1"
PORT="7350"

echo "--- 疎通テスト ---"
echo "server_key: ${SERVER_KEY}"
echo "endpoint:   http://${HOST}:${PORT}"

# ── Nakama コンテナの起動待ち（最大60秒） ──
echo -n "  waiting for nakama ... "
NAKAMA_CONTAINER=$(docker ps --format '{{.Names}}' --filter "name=nakama" 2>/dev/null | grep nakama | head -1)
if [ -n "$NAKAMA_CONTAINER" ]; then
    for i in $(seq 1 60); do
        STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$NAKAMA_CONTAINER" 2>/dev/null)
        if [ "$STATUS" = "healthy" ]; then
            echo "healthy (${i}s)"
            break
        fi
        if [ "$STATUS" = "" ] || [ "$STATUS" = "none" ]; then
            # healthcheck 未設定の場合は HTTP で待つ
            break
        fi
        sleep 1
    done
    if [ "$STATUS" != "healthy" ] && [ "$STATUS" != "" ] && [ "$STATUS" != "none" ]; then
        echo "FAIL (status: ${STATUS})"
        echo "❌ Nakama コンテナが healthy になりません。docker logs $NAKAMA_CONTAINER を確認してください。"
        exit 1
    fi
else
    echo "skip (container not found)"
fi

# ── ヘルスチェック（HTTP、最大30秒リトライ） ──
echo -n "  healthcheck ... "
HTTP_CODE=""
for i in $(seq 1 30); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}:${PORT}/healthcheck" --connect-timeout 2 --max-time 5 2>/dev/null)
    if [ "$HTTP_CODE" = "200" ]; then
        break
    fi
    sleep 1
done
if [ "$HTTP_CODE" = "200" ]; then
    echo "OK (${i}s)"
else
    echo "FAIL (HTTP ${HTTP_CODE:-timeout})"
    echo "❌ サーバに接続できません。nakama が起動しているか確認してください。"
    exit 1
fi

# ── server_key 認証テスト（デバイス認証） ──
echo -n "  authenticate ... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "http://${HOST}:${PORT}/v2/account/authenticate/device" \
    -H "Content-Type: application/json" \
    -u "${SERVER_KEY}:" \
    -d '{"id":"__ping_test__"}' \
    --connect-timeout 5 --max-time 10 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
    echo "OK"
    echo "✅ 疎通テスト成功"
    exit 0
else
    echo "FAIL (HTTP ${HTTP_CODE})"
    echo "  response: ${BODY}"
    echo "❌ server_key 認証に失敗しました。.env の NAKAMA_SERVER_KEY がサーバと一致しているか確認してください。"
    exit 1
fi
