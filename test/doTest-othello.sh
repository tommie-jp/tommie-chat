#!/bin/bash
# オセロ対戦テスト（RPC フロー: 作成→一覧→参加→着手→投了）
# Usage: ./test/doTest-Othello.sh [--host HOST] [--port PORT] [-h]
#
# 2ユーザーを認証し、オセロ RPC の全フローをテストする。
# 失敗した場合は exit 1 を返す。

OPT_HOST=""
OPT_PORT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./test/doTest-Othello.sh [--host HOST] [--port PORT] [-h]

オセロ対戦の RPC フローをテストします。

オプション:
  --host HOST   接続先ホスト (デフォルト: NAKAMA_HOST or 127.0.0.1)
  --port PORT   Nakama API ポート (デフォルト: NAKAMA_PORT or 7350)
  -h            このヘルプを表示

テスト内容:
  1. 2ユーザー認証 (device auth)
  2. othelloCreate — ゲーム作成
  3. othelloList — 一覧取得（待機中ゲームの確認）
  4. othelloJoin — 対戦参加（ゲーム開始）
  5. othelloMove — 着手（黒→白 各1手）
  6. othelloResign — 投了（終局確認）
  7. othelloList — 終局後の一覧（消えていること）

例:
  ./test/doTest-Othello.sh
  ./test/doTest-Othello.sh --host mmo.tommie.jp --port 443
EOF
            exit 0 ;;
        --host)
            OPT_HOST="${2:-}"; shift 2 ;;
        --port)
            OPT_PORT="${2:-}"; shift 2 ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/nakama-test-lib.sh"
load_nakama_config
detect_api_base

echo "========================================="
echo "オセロ対戦テスト"
echo "========================================="
echo "endpoint: ${API_BASE}"
echo ""

# ── ヘルパー関数 ──

# Nakama REST RPC 呼び出し
# Usage: rpc_call TOKEN RPC_NAME PAYLOAD
# PAYLOAD は JSON 文字列（例: '{"worldId":0}'）。空なら "" を送信。
# 結果は RPC_HTTP (HTTPステータス) と RPC_BODY (レスポンスボディ) に格納。
rpc_call() {
    local token="$1"
    local rpc_name="$2"
    local payload="${3:-}"

    local body='""'
    if [ -n "$payload" ]; then
        body="\"$(echo "$payload" | sed 's/"/\\"/g')\""
    fi

    local response
    response=$(curl -s -w "\n%{http_code}" -X POST \
        "${API_BASE}/v2/rpc/${rpc_name}" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${token}" \
        -d "$body" \
        --connect-timeout 5 --max-time 10 2>/dev/null)

    RPC_HTTP=$(echo "$response" | tail -1)
    RPC_BODY=$(echo "$response" | head -n -1)
}

# レスポンスの payload フィールドを抽出（Nakama REST API は {payload: "..."} で返す）
extract_payload() {
    echo "$1" | grep -oP '"payload"\s*:\s*"([^"]*(?:\\.[^"]*)*)"' | head -1 | sed 's/"payload"\s*:\s*"//;s/"$//' | sed 's/\\"/"/g;s/\\\\/\\/g'
}

# JSON からフィールド値を取得（簡易: ネストなしの文字列/数値）
json_field() {
    local json="$1"
    local field="$2"
    echo "$json" | grep -oP "\"${field}\"\s*:\s*\"?[^,}\"]*\"?" | head -1 | sed "s/\"${field}\"\s*:\s*//;s/\"//g"
}

# デバイス認証してトークンを取得
# Usage: authenticate DEVICE_ID
# 結果は AUTH_TOKEN に格納
authenticate() {
    local device_id="$1"
    local response
    response=$(curl -s -w "\n%{http_code}" -X POST \
        "${API_BASE}/v2/account/authenticate/device?create=true" \
        -H "Content-Type: application/json" \
        -u "${SERVER_KEY}:" \
        -d "{\"id\":\"${device_id}\"}" \
        --connect-timeout 5 --max-time 10 2>/dev/null)

    local http_code
    http_code=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | head -n -1)

    if [ "$http_code" = "200" ]; then
        AUTH_TOKEN=$(echo "$body" | grep -oP '"token"\s*:\s*"[^"]*"' | head -1 | cut -d'"' -f4)
    else
        AUTH_TOKEN=""
    fi
}

# ── テスト開始 ──

echo "--- 1. ユーザー認証 ---"
echo -n "  認証: playerA (othello_test_a) ... "
authenticate "othello_test_a"
TOKEN_A="$AUTH_TOKEN"
if [ -n "$TOKEN_A" ]; then
    echo "OK"
else
    echo "FAIL"
    echo "❌ playerA の認証に失敗しました"
    exit 1
fi

echo -n "  認証: playerB (othello_test_b) ... "
authenticate "othello_test_b"
TOKEN_B="$AUTH_TOKEN"
if [ -n "$TOKEN_B" ]; then
    echo "OK"
else
    echo "FAIL"
    echo "❌ playerB の認証に失敗しました"
    exit 1
fi

echo ""
echo "--- 2. オセロ RPC テスト ---"

# ── othelloCreate ──
rpc_call "$TOKEN_A" "othelloCreate" '{"worldId":0}'
PAYLOAD_CREATE=$(extract_payload "$RPC_BODY")
GAME_ID=$(json_field "$PAYLOAD_CREATE" "gameId")
CREATE_STATUS=$(json_field "$PAYLOAD_CREATE" "status")

check "othelloCreate: HTTP 200" "$([ "$RPC_HTTP" = "200" ] && echo 0 || echo 1)" "HTTP=${RPC_HTTP}"
check "othelloCreate: gameId 取得" "$([ -n "$GAME_ID" ] && echo 0 || echo 1)" "gameId=${GAME_ID}"
check "othelloCreate: status=waiting" "$([ "$CREATE_STATUS" = "waiting" ] && echo 0 || echo 1)" "status=${CREATE_STATUS}"

echo "     gameId=${GAME_ID}"

# ── othelloList ──
rpc_call "$TOKEN_A" "othelloList" '{"worldId":0}'
PAYLOAD_LIST=$(extract_payload "$RPC_BODY")
LIST_HAS_GAME=$(echo "$PAYLOAD_LIST" | grep -c "$GAME_ID")

check "othelloList: HTTP 200" "$([ "$RPC_HTTP" = "200" ] && echo 0 || echo 1)" "HTTP=${RPC_HTTP}"
check "othelloList: ゲームが一覧に存在" "$([ "$LIST_HAS_GAME" -ge 1 ] && echo 0 || echo 1)" ""

# ── othelloJoin ──
rpc_call "$TOKEN_B" "othelloJoin" "{\"gameId\":\"${GAME_ID}\"}"
PAYLOAD_JOIN=$(extract_payload "$RPC_BODY")
JOIN_STATUS=$(json_field "$PAYLOAD_JOIN" "status")
JOIN_TURN=$(json_field "$PAYLOAD_JOIN" "turn")

check "othelloJoin: HTTP 200" "$([ "$RPC_HTTP" = "200" ] && echo 0 || echo 1)" "HTTP=${RPC_HTTP}"
check "othelloJoin: status=playing" "$([ "$JOIN_STATUS" = "playing" ] && echo 0 || echo 1)" "status=${JOIN_STATUS}"
check "othelloJoin: turn=1(黒)" "$([ "$JOIN_TURN" = "1" ] && echo 0 || echo 1)" "turn=${JOIN_TURN}"

# ── othelloMove: 黒（playerA）が (2,3) に着手 ──
# 初期盤面: d4=白, e4=黒, d5=黒, e5=白 → (2,3) は黒の合法手
rpc_call "$TOKEN_A" "othelloMove" "{\"gameId\":\"${GAME_ID}\",\"row\":2,\"col\":3}"
PAYLOAD_MOVE1=$(extract_payload "$RPC_BODY")
MOVE1_TURN=$(json_field "$PAYLOAD_MOVE1" "turn")
MOVE1_STATUS=$(json_field "$PAYLOAD_MOVE1" "status")

check "othelloMove(黒): HTTP 200" "$([ "$RPC_HTTP" = "200" ] && echo 0 || echo 1)" "HTTP=${RPC_HTTP}"
check "othelloMove(黒): status=playing" "$([ "$MOVE1_STATUS" = "playing" ] && echo 0 || echo 1)" "status=${MOVE1_STATUS}"
check "othelloMove(黒): ターン交代(turn=2)" "$([ "$MOVE1_TURN" = "2" ] && echo 0 || echo 1)" "turn=${MOVE1_TURN}"

# ── othelloMove: 白（playerB）が (2,2) に着手 ──
rpc_call "$TOKEN_B" "othelloMove" "{\"gameId\":\"${GAME_ID}\",\"row\":2,\"col\":2}"
PAYLOAD_MOVE2=$(extract_payload "$RPC_BODY")
MOVE2_TURN=$(json_field "$PAYLOAD_MOVE2" "turn")

check "othelloMove(白): HTTP 200" "$([ "$RPC_HTTP" = "200" ] && echo 0 || echo 1)" "HTTP=${RPC_HTTP}"
check "othelloMove(白): ターン交代(turn=1)" "$([ "$MOVE2_TURN" = "1" ] && echo 0 || echo 1)" "turn=${MOVE2_TURN}"

# ── othelloMove: 不正な手（相手のターンに打つ） ──
rpc_call "$TOKEN_B" "othelloMove" "{\"gameId\":\"${GAME_ID}\",\"row\":0,\"col\":0}"

check "othelloMove(不正): 拒否される" "$([ "$RPC_HTTP" != "200" ] && echo 0 || echo 1)" "HTTP=${RPC_HTTP}"

# ── othelloResign ──
rpc_call "$TOKEN_B" "othelloResign" "{\"gameId\":\"${GAME_ID}\"}"
PAYLOAD_RESIGN=$(extract_payload "$RPC_BODY")
RESIGN_STATUS=$(json_field "$PAYLOAD_RESIGN" "status")
RESIGN_WINNER=$(json_field "$PAYLOAD_RESIGN" "winner")

check "othelloResign: HTTP 200" "$([ "$RPC_HTTP" = "200" ] && echo 0 || echo 1)" "HTTP=${RPC_HTTP}"
check "othelloResign: status=finished" "$([ "$RESIGN_STATUS" = "finished" ] && echo 0 || echo 1)" "status=${RESIGN_STATUS}"
check "othelloResign: winner=1(黒勝ち)" "$([ "$RESIGN_WINNER" = "1" ] && echo 0 || echo 1)" "winner=${RESIGN_WINNER}"

# ── othelloList: 終局後は一覧から消える ──
rpc_call "$TOKEN_A" "othelloList" '{"worldId":0}'
PAYLOAD_LIST2=$(extract_payload "$RPC_BODY")
LIST2_HAS_GAME=$(echo "$PAYLOAD_LIST2" | grep -c "$GAME_ID")

check "othelloList(終局後): ゲームが一覧から除外" "$([ "$LIST2_HAS_GAME" -eq 0 ] && echo 0 || echo 1)" ""

# ── 結果 ──
echo ""
echo "========================================="
echo "結果: ${PASS} passed / ${FAILED} failed / ${TOTAL} total"
echo "========================================="

if [ "$FAILED" -eq 0 ]; then
    echo "✅ オセロテスト全パス"
    exit 0
else
    echo "❌ オセロテスト失敗"
    exit 1
fi
