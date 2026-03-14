#!/bin/bash
# サーバ疎通テスト（server_key 認証 + RPC + Web 確認）
# Usage: ./test/doTest-ping.sh [-h]
#
# Nakama コンテナが healthy になるまで待機し、
# curl で HTTP API / RPC / Web 配信を確認する。
# 失敗した場合は exit 1 を返す。

case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  Nakama サーバの疎通テストを実行します"
        echo ""
        echo "テスト内容:"
        echo "  1. コンテナ起動待ち (docker healthcheck)"
        echo "  2. HTTP ヘルスチェック (/healthcheck)"
        echo "  3. server_key 認証 (デバイス認証API)"
        echo "  4. Go プラグイン (RPC getWorldMatch)"
        echo "  5. Web 配信 (nginx)"
        echo ""
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
FAILED=0

echo "--- 疎通テスト ---"
echo "server_key: ${SERVER_KEY}"
echo "endpoint:   http://${HOST}:${PORT}"

# ── 1. Nakama コンテナの起動待ち（最大60秒） ──
echo -n "  [1/5] container  ... "
NAKAMA_CONTAINER=$(docker ps --format '{{.Names}}' --filter "name=nakama" 2>/dev/null | grep nakama | head -1)
if [ -n "$NAKAMA_CONTAINER" ]; then
    for i in $(seq 1 60); do
        STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$NAKAMA_CONTAINER" 2>/dev/null)
        if [ "$STATUS" = "healthy" ]; then
            echo "healthy (${i}s)"
            break
        fi
        if [ "$STATUS" = "" ] || [ "$STATUS" = "none" ]; then
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

# ── 2. ヘルスチェック（HTTP、最大30秒リトライ） ──
echo -n "  [2/5] healthcheck ... "
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

# ── 3. server_key 認証テスト（デバイス認証） ──
echo -n "  [3/5] authenticate ... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "http://${HOST}:${PORT}/v2/account/authenticate/device" \
    -H "Content-Type: application/json" \
    -u "${SERVER_KEY}:" \
    -d '{"id":"__ping_test__"}' \
    --connect-timeout 5 --max-time 10 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
    TOKEN=$(echo "$BODY" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "OK"
else
    echo "FAIL (HTTP ${HTTP_CODE})"
    echo "  response: ${BODY}"
    echo "❌ server_key 認証に失敗しました。.env の NAKAMA_SERVER_KEY がサーバと一致しているか確認してください。"
    exit 1
fi

# ── 4. RPC getWorldMatch（Go プラグイン確認） ──
echo -n "  [4/5] RPC getWorldMatch ... "
if [ -z "$TOKEN" ]; then
    echo "SKIP (no token)"
else
    RPC_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        "http://${HOST}:${PORT}/v2/rpc/getWorldMatch" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d '""' \
        --connect-timeout 5 --max-time 10 2>/dev/null)

    RPC_HTTP=$(echo "$RPC_RESPONSE" | tail -1)
    RPC_BODY=$(echo "$RPC_RESPONSE" | head -n -1)

    if [ "$RPC_HTTP" = "200" ]; then
        # payload に matchId が含まれているか確認
        if echo "$RPC_BODY" | grep -q "matchId"; then
            echo "OK"
        else
            echo "OK (no matchId yet)"
        fi
    else
        echo "FAIL (HTTP ${RPC_HTTP})"
        echo "  response: ${RPC_BODY}"
        echo "❌ Go プラグインが正しくロードされていません。doBuild.sh を実行してください。"
        FAILED=1
    fi
fi

# ── 5. Web 配信テスト（nginx） ──
echo -n "  [5/5] web (nginx) ... "
# ポートを検出（dev:80, prod:8080）
WEB_PORT=""
for p in 80 8080; do
    WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}:${p}/" --connect-timeout 2 --max-time 5 2>/dev/null)
    if [ "$WEB_CODE" = "200" ]; then
        WEB_PORT=$p
        break
    fi
done

if [ -n "$WEB_PORT" ]; then
    echo "OK (port ${WEB_PORT})"
else
    echo "FAIL"
    echo "❌ Web コンテナ (nginx) に接続できません。docker compose ps で確認してください。"
    FAILED=1
fi

# ── 結果 ──
echo ""
if [ "$FAILED" -eq 0 ]; then
    echo "✅ 疎通テスト成功"
    exit 0
else
    echo "❌ 疎通テスト失敗（上記のエラーを確認してください）"
    exit 1
fi
