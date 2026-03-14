#!/bin/bash
# サーバ疎通テスト（server_key 認証 + RPC + Web 確認）
# Usage: ./test/doTest-ping.sh [--host HOST] [--port PORT] [--web-port PORT] [-h]
#
# Nakama サーバに接続し、認証・RPC・Web 配信を確認する。
# ローカル（127.0.0.1）でもリモート（mmo.tommie.jp 等）でも使用可能。
# リモートの場合、nginx プロキシ経由（Web ポート）で Nakama API にアクセスする。
# 失敗した場合は exit 1 を返す。

# ── オプション解析 ──
OPT_HOST=""
OPT_PORT=""
OPT_WEB_PORT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./test/doTest-ping.sh [--host HOST] [--port PORT] [--web-port PORT] [-h]

Nakama サーバの疎通テストを実行します。

オプション:
  --host HOST       接続先ホスト (デフォルト: NAKAMA_HOST or 127.0.0.1)
  --port PORT       Nakama API ポート (デフォルト: NAKAMA_PORT or 7350)
                    ローカル時のみ使用。リモート時は Web ポート経由でアクセス。
  --web-port PORT   Web ポート (デフォルト: 80,8080 を自動検出)
  -h                このヘルプを表示

環境変数:
  NAKAMA_HOST         接続先ホスト (--host より優先度低)
  NAKAMA_PORT         Nakama API ポート (--port より優先度低)
  NAKAMA_SERVER_KEY   サーバキー (nakama/.env から自動読み込み)

テスト内容:
  1. コンテナ起動待ち (ローカルのみ、docker healthcheck)
  2. HTTP ヘルスチェック (/healthcheck)
  3. server_key 認証 (デバイス認証API)
  4. Go プラグイン (RPC getWorldMatch)
  5. Web 配信 (nginx)

ローカル時は Nakama API ポート (7350) に直接アクセスします。
リモート時は nginx プロキシ経由 (Web ポート) でアクセスします。

例:
  ./test/doTest-ping.sh                          # ローカル (127.0.0.1)
  ./test/doTest-ping.sh --host mmo.tommie.jp     # リモート
  NAKAMA_HOST=mmo.tommie.jp ./test/doTest-ping.sh  # 環境変数で指定
EOF
            exit 0 ;;
        --host)
            OPT_HOST="${2:-}"; shift 2 ;;
        --port)
            OPT_PORT="${2:-}"; shift 2 ;;
        --web-port)
            OPT_WEB_PORT="${2:-}"; shift 2 ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

cd "$(dirname "$0")/.."
# .env から NAKAMA_SERVER_KEY 等を自動読み込み
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f nakama/.env ]; then
    set -a; source nakama/.env; set +a
fi

SERVER_KEY="${NAKAMA_SERVER_KEY:-defaultkey}"
# 優先順位: --host > NAKAMA_HOST > 127.0.0.1
HOST="${OPT_HOST:-${NAKAMA_HOST:-127.0.0.1}}"
PORT="${OPT_PORT:-${NAKAMA_PORT:-7350}}"
IS_LOCAL=false
if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
    IS_LOCAL=true
fi
FAILED=0

echo "--- 疎通テスト ---"
echo "server_key: ${SERVER_KEY}"

# ── リモート時: Web ポートを先に検出（API は nginx プロキシ経由） ──
API_BASE=""
if [ "$IS_LOCAL" = true ]; then
    API_BASE="http://${HOST}:${PORT}"
    echo "endpoint:   ${API_BASE} (direct)"
else
    # Web ポート検出
    if [ -n "$OPT_WEB_PORT" ]; then
        WEB_PORTS=("$OPT_WEB_PORT")
    else
        WEB_PORTS=(80 8080)
    fi
    DETECTED_WEB_PORT=""
    for p in "${WEB_PORTS[@]}"; do
        WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}:${p}/" --connect-timeout 2 --max-time 5 2>/dev/null)
        if [ "$WEB_CODE" = "200" ]; then
            DETECTED_WEB_PORT=$p
            break
        fi
    done
    if [ -n "$DETECTED_WEB_PORT" ]; then
        API_BASE="http://${HOST}:${DETECTED_WEB_PORT}"
        echo "endpoint:   ${API_BASE} (nginx proxy)"
    else
        echo "endpoint:   http://${HOST}:${PORT} (direct, fallback)"
        API_BASE="http://${HOST}:${PORT}"
    fi
fi

# ── 1. Nakama コンテナの起動待ち（ローカルのみ、最大60秒） ──
echo -n "  [1/5] container  ... "
if [ "$IS_LOCAL" = true ]; then
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
else
    echo "skip (remote)"
fi

# ── 2. ヘルスチェック（HTTP、最大30秒リトライ） ──
echo -n "  [2/5] healthcheck ... "
HTTP_CODE=""
for i in $(seq 1 30); do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/healthcheck" --connect-timeout 2 --max-time 5 2>/dev/null)
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
    if [ "$IS_LOCAL" != true ]; then
        echo "  リモートの場合: nginx に /healthcheck プロキシが設定されているか確認してください。"
    fi
    exit 1
fi

# ── 3. server_key 認証テスト（デバイス認証） ──
echo -n "  [3/5] authenticate ... "
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${API_BASE}/v2/account/authenticate/device" \
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
    if [ "$IS_LOCAL" != true ]; then
        echo "  リモートの場合: nginx に /v2/ プロキシが設定されているか確認してください。"
    fi
    exit 1
fi

# ── 4. RPC getWorldMatch（Go プラグイン確認） ──
echo -n "  [4/5] RPC getWorldMatch ... "
if [ -z "$TOKEN" ]; then
    echo "SKIP (no token)"
else
    RPC_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
        "${API_BASE}/v2/rpc/getWorldMatch" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d '""' \
        --connect-timeout 5 --max-time 10 2>/dev/null)

    RPC_HTTP=$(echo "$RPC_RESPONSE" | tail -1)
    RPC_BODY=$(echo "$RPC_RESPONSE" | head -n -1)

    if [ "$RPC_HTTP" = "200" ]; then
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
if [ "$IS_LOCAL" = true ]; then
    # ローカル: Web ポートを検出
    if [ -n "$OPT_WEB_PORT" ]; then
        WEB_PORTS=("$OPT_WEB_PORT")
    else
        WEB_PORTS=(80 8080)
    fi
    WEB_PORT=""
    for p in "${WEB_PORTS[@]}"; do
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
        echo "❌ Web (nginx) に接続できません。"
        FAILED=1
    fi
else
    # リモート: 既に検出済み
    if [ -n "$DETECTED_WEB_PORT" ]; then
        echo "OK (port ${DETECTED_WEB_PORT})"
    else
        echo "FAIL"
        echo "❌ Web (nginx) に接続できません。"
        FAILED=1
    fi
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
