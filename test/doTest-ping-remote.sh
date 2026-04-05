#!/bin/bash
# リモート疎通テスト（SSH 経由で VPS 上の Nakama を確認）
# Usage: ./test/doTest-ping-remote.sh <VPSホスト> [SSHユーザー] [-h]
#
# 開発環境（WSL2 Ubuntu 24.04）から実行する。
# SSH 経由で VPS 上でテストスクリプトを実行し、Nakama の疎通を確認する。
SCRIPT_VERSION="2026-04-05"

# ── 引数解析 ──
VPS_HOST=""
SSH_USER="deploy"

for arg in "$@"; do
    case "$arg" in
        -h|--help)
            cat <<'EOF'
Usage: ./test/doTest-ping-remote.sh <VPSホスト> [SSHユーザー]

SSH 経由で VPS 上の Nakama サーバの疎通テストを実行します。

処理内容:
  1. SSH 接続テスト
  2. コンテナ起動確認 (docker inspect)
  3. HTTP ヘルスチェック (/healthcheck)
  4. server_key 認証 (デバイス認証API)
  5. Go プラグイン (RPC getWorldMatch)
  6. Web 配信 (nginx)

引数:
  VPSホスト    SSH接続先（例: mmo.tommie.jp, 123.45.67.89）
  SSHユーザー  SSHユーザー名（デフォルト: deploy）

前提:
  - VPS に SSH 鍵認証で接続可能

例:
  ./test/doTest-ping-remote.sh mmo.tommie.jp
  ./test/doTest-ping-remote.sh mmo.tommie.jp tommie
EOF
            exit 0 ;;
        -v|--version)
            echo "doTest-ping-remote.sh  version: ${SCRIPT_VERSION}"
            exit 0 ;;
        *)
            if [ -z "$VPS_HOST" ]; then
                VPS_HOST="$arg"
            else
                SSH_USER="$arg"
            fi ;;
    esac
done

if [ -z "$VPS_HOST" ]; then
    echo "Usage: $0 <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)"
    exit 1
fi

SSH_TARGET="${SSH_USER}@${VPS_HOST}"

echo "doTest-ping-remote.sh  version: ${SCRIPT_VERSION}"
echo ""

# ── 1. SSH 接続テスト ──
echo -n "  [1/6] SSH 接続    ... "
if ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    echo "OK"
else
    echo "FAIL"
    echo "❌ SSH 接続に失敗しました: ${SSH_TARGET}"
    exit 1
fi

# ── 2. コンテナ起動確認 ──
echo -n "  [2/6] container   ... "
NAKAMA_CONTAINER=$(ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" \
    "docker ps --format '{{.Names}}' --filter 'name=nakama' 2>/dev/null | grep nakama | head -1")
if [ -n "$NAKAMA_CONTAINER" ]; then
    STATUS=""
    for i in $(seq 1 60); do
        STATUS=$(ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" \
            "docker inspect --format '{{.State.Health.Status}}' '$NAKAMA_CONTAINER' 2>/dev/null")
        if [ "$STATUS" = "healthy" ]; then
            echo "healthy (${i}s)"
            break
        fi
        if [ "$STATUS" = "" ] || [ "$STATUS" = "none" ]; then
            echo "skip (no healthcheck)"
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
    echo "FAIL (container not found)"
    echo "❌ Nakama コンテナが見つかりません。デプロイされているか確認してください。"
    exit 1
fi

# ── 3〜6. VPS 上でテスト実行（SSH でスクリプトを送信） ──
# クォート問題を避けるため、ヒアドキュメントで VPS 上にスクリプトを送り込む
ssh -o ConnectTimeout=10 "${SSH_TARGET}" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

# .env から server_key を取得
SERVER_KEY="defaultkey"
if [ -f ~/tommie-chat/nakama/.env ]; then
    SK=$(grep '^NAKAMA_SERVER_KEY=' ~/tommie-chat/nakama/.env 2>/dev/null | cut -d= -f2)
    [ -n "$SK" ] && SERVER_KEY="$SK"
fi

PORT=7350
API_BASE="http://127.0.0.1:${PORT}"
FAILED=0

echo "--- リモート疎通テスト ---"
echo "server_key: ${SERVER_KEY}"
echo "endpoint:   ${API_BASE}"
echo ""

# [3/6] ヘルスチェック
printf "  [3/6] healthcheck ... "
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
    exit 1
fi

# [4/6] server_key 認証
printf "  [4/6] authenticate ... "
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
    echo "❌ server_key 認証に失敗しました。"
    exit 1
fi

# [5/6] RPC getWorldMatch
printf "  [5/6] RPC getWorldMatch ... "
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

# [6/6] Web 配信テスト
printf "  [6/6] web (nginx)  ... "
WEB_PORT=""
for p in 80 8081; do
    WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${p}/" --connect-timeout 2 --max-time 5 2>/dev/null)
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

# 結果
echo ""
if [ "$FAILED" -eq 0 ]; then
    echo "✅ リモート疎通テスト成功"
else
    echo "❌ リモート疎通テスト失敗（上記のエラーを確認してください）"
    exit 1
fi
REMOTE_SCRIPT
