#!/bin/bash
# プレイヤーリスト通知テスト実行スクリプト
# 各フェーズの前にサーバを再起動してクリーンな状態でテストする
#
# 使い方: ./test/doTest-player-list.sh [-n N] [-r R] [-t T] [-h]
# 前提: cd nakama && docker compose up -d

PLAYERS_FILTER=""
LOGIN_RATE=40       # 秒あたりのログイン数（0=無制限, サーバ側MAX_LOGIN_RATE_PER_SEC未満にすること）
TIMEOUT_SEC=0       # テストタイムアウト秒（0=デフォルト値を使用）

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
使い方: ./test/doTest-player-list.sh [-n N] [-r R] [-t T] [-h]

プレイヤーリスト通知テストを実行します。
プロフィール（displayName, textureUrl, loginTime）がサーバから正しく取得できるかを検証します。

オプション:
  -n N, --players N   N人テストのみ実行（デフォルト: 1, 10, 100, 1000, 2000 すべて実行）
  -r R, --rate R      秒あたりのログイン数を指定 (デフォルト: 40)
                      例: -r 50 → 50人/秒でバッチログイン
  -t T, --timeout T   テストタイムアウトを秒単位で指定 (デフォルト: 人数に応じて自動)
                      例: -t 600 → 600秒タイムアウト
  -h                  このヘルプを表示して終了

テスト内容（各人数 N=1, 10, 100, 1000, 2000 について）:
  [プロフィール通知]
    N人がログイン後、player[0] が全員の OP_PROFILE_REQUEST を送信し、
    displayName, textureUrl, loginTime が正しく返ることを検証します。

  [表示名変更通知]
    N人がログイン後、player[0] が表示名を変更し、他のプレイヤーが
    OP_DISPLAY_NAME を受信すること、またプロフィール取得で反映されることを検証します。

追加テスト（1人・10人固定）:
  [不正sessionIdプロフィール要求]
    存在しない/ログアウト済みのsessionIdを含むprofileRequestが
    エラーにならず、有効なもののみ返ることを検証します。

  [テクスチャ変更プロフィール反映]
    avatarChange (op=3) で textureUrl を変更後、profileRequest で
    更新後の値が返ることを検証します。

  [途中参加プロフィール取得]
    N人ログイン完了後に1人追加で参加し、途中参加者が既存全員の
    プロフィールを取得でき、既存プレイヤーも途中参加者を取得できることを検証します。

  各テストの前に nakama サーバを再起動してクリーンな状態で実行します。

ログ出力先:
  test/log/doTest-player-list-*-server.log  各フェーズのサーバログ
  test/log/doTest-player-list-*-client.log  各フェーズのクライアントログ
  test/log/player-list-YYYYMMDD-HHMMSS.md   Markdownレポート
  test/log/05-player-list.md                最新レポートへのシンボリックリンク

前提:
  cd nakama && docker compose up -d
EOF
            exit 0 ;;
        -n|--players)
            PLAYERS_FILTER="${2:-}"
            shift 2 ;;
        -r|--rate)
            LOGIN_RATE="${2:-0}"
            shift 2 ;;
        -t|--timeout)
            TIMEOUT_SEC="${2:-0}"
            shift 2 ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

set -euo pipefail
export LOGIN_RATE_PER_SEC="$LOGIN_RATE"
export TEST_TIMEOUT_MS=$(( TIMEOUT_SEC > 0 ? TIMEOUT_SEC * 1000 : 0 ))
# V8ヒープ上限を拡張（vitest親プロセス + worker両方に適用）
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=8192"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
# .env から NAKAMA_SERVER_KEY 等を自動読み込み
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f "$ROOT_DIR/nakama/.env" ]; then
    set -a; source "$ROOT_DIR/nakama/.env"; set +a
fi
# docker compose コマンド（prod override 自動検出）
COMPOSE="docker compose"
if [ -f "$ROOT_DIR/nakama/docker-compose.prod.yml" ]; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
fi

LOG_DIR="$SCRIPT_DIR/log"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LOG_DIR/player-list-${TIMESTAMP}.md"

GREP_FILTER="rcv login\|rcv logout\|rcv getWorldMatch\|rcv initPos\|rcv AOI_UPDATE\
\|snd AOI_ENTER\|snd AOI_LEAVE\|rcv profileRequest\|snd profileResponse\
\|rcv displayName\|snd displayName\|rcv avatarChange\|snd avatarChange"

# 実行する人数リスト
if [ -n "$PLAYERS_FILTER" ]; then
    COUNTS=("$PLAYERS_FILTER")
else
    COUNTS=(1 10 100 1000 2000)
fi

# フェーズ結果を連想配列で管理
declare -A PHASE_RC
FINAL_RC=0

echo "========================================="
echo "プレイヤーリスト通知テスト"
echo "========================================="
echo "server_key: ${NAKAMA_SERVER_KEY:-defaultkey}"
echo "テスト人数: ${COUNTS[*]}"
echo "ログインレート: ${LOGIN_RATE_PER_SEC}人/秒 (0=無制限)"

# ── Go プラグインビルド ──
echo ""
echo "--- Go プラグインビルド ---"
"$ROOT_DIR/nakama/doBuild.sh"

# ── サーバ再起動 ──
restart_server() {
    echo "  nakama サーバ再起動..."
    cd "$ROOT_DIR/nakama"
    $COMPOSE restart -t 3 nakama
    local i
    for i in $(seq 1 30); do
        if $COMPOSE logs --tail 5 nakama 2>/dev/null | grep -q "Startup"; then
            echo "  起動確認 (${i}s)"
            break
        fi
        sleep 1
    done
    sleep 1
}

# ── サーバログ取得開始 ──
start_server_log() {
    local log_file="$1"
    cd "$ROOT_DIR/nakama"
    stdbuf -oL $COMPOSE logs -f --tail 0 nakama 2>&1 \
      | grep --line-buffered "$GREP_FILTER" \
      | sed -u 's/^[^ ]* *| *//' \
      | sed -u 's/\([0-9a-f]\{8\}\)-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}/\1/g' \
      > "$log_file" &
    echo $!
}

# ── ANSI除去 ──
strip_ansi() { sed 's/\x1b\[[0-9;]*[mGKHF]//g'; }

# ── フェーズ実行関数 ──
# run_phase <phase_key> <label> <vitest_filter> <server_log> <client_log> <wait_sec>
run_phase() {
    local phase_key="$1"
    local label="$2"
    local vitest_filter="$3"
    local server_log="$4"
    local client_log="$5"
    local wait_sec="${6:-1}"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[${phase_key}] ${label}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    restart_server

    echo "  サーバログ取得開始..."
    local log_pid
    log_pid=$(start_server_log "$server_log")
    echo "  PID=$log_pid -> $server_log"

    echo "  Vitest 実行 (${label})..."
    cd "$ROOT_DIR"
    set +e
    npx vitest run test/nakama-player-list.test.ts -t "$vitest_filter" 2>&1 | stdbuf -oL tee "$client_log"
    local rc=${PIPESTATUS[0]}
    set -e

    sleep "$wait_sec"
    kill "$log_pid" 2>/dev/null || true

    echo ""
    echo "  サーバログ: $server_log"
    cat "$server_log"

    PHASE_RC["$phase_key"]=$rc
    if [ "$rc" -gt 0 ]; then FINAL_RC=1; fi
}

# ── テスト実行 ──
PHASE_NUM=0
for N in "${COUNTS[@]}"; do
    # デフォルト(1,10,100)以外の人数は環境変数で vitest に通知
    case "$N" in
        1|10|100|1000|2000) unset PLAYER_LIST_N_COUNT ;;
        *)                 export PLAYER_LIST_N_COUNT="$N" ;;
    esac

    PHASE_NUM=$((PHASE_NUM + 1))
    local_wait=$([ "$N" -le 10 ] && echo 1 || echo 3)

    run_phase "P${PHASE_NUM}-prof${N}" \
        "${N}人 プロフィール通知" \
        "${N}人 プロフィール通知" \
        "$LOG_DIR/doTest-player-list-prof${N}-server.log" \
        "$LOG_DIR/doTest-player-list-prof${N}-client.log" \
        "$local_wait"

    PHASE_NUM=$((PHASE_NUM + 1))

    run_phase "P${PHASE_NUM}-dn${N}" \
        "${N}人 表示名変更通知" \
        "${N}人 表示名変更通知" \
        "$LOG_DIR/doTest-player-list-dn${N}-server.log" \
        "$LOG_DIR/doTest-player-list-dn${N}-client.log" \
        "$local_wait"
done

# ── 追加テスト（不正sessionId / テクスチャ変更 / 途中参加） ──
# これらは人数非依存（1人・10人固定）なので、-n フィルタに関係なく実行
for N in 1 10; do
    PHASE_NUM=$((PHASE_NUM + 1))
    run_phase "P${PHASE_NUM}-invsid${N}" \
        "${N}人 不正sessionIdプロフィール要求" \
        "${N}人 不正sessionIdプロフィール要求" \
        "$LOG_DIR/doTest-player-list-invsid${N}-server.log" \
        "$LOG_DIR/doTest-player-list-invsid${N}-client.log" \
        1

    PHASE_NUM=$((PHASE_NUM + 1))
    run_phase "P${PHASE_NUM}-txchg${N}" \
        "${N}人 テクスチャ変更プロフィール反映" \
        "${N}人 テクスチャ変更プロフィール反映" \
        "$LOG_DIR/doTest-player-list-txchg${N}-server.log" \
        "$LOG_DIR/doTest-player-list-txchg${N}-client.log" \
        1

    PHASE_NUM=$((PHASE_NUM + 1))
    run_phase "P${PHASE_NUM}-late${N}" \
        "${N}人 途中参加プロフィール取得" \
        "${N}人 途中参加プロフィール取得" \
        "$LOG_DIR/doTest-player-list-late${N}-server.log" \
        "$LOG_DIR/doTest-player-list-late${N}-client.log" \
        1
done

# ── 最終結果 ──
echo ""
echo "========================================="
echo "最終結果"
echo "========================================="
for key in $(echo "${!PHASE_RC[@]}" | tr ' ' '\n' | sort); do
    rc=${PHASE_RC[$key]}
    label="${key#*-}"  # P1-prof1 → prof1
    if [ "$rc" -eq 0 ]; then
        echo "✅ ${key}: ${label} 成功"
    else
        echo "❌ ${key}: ${label} 失敗 (exit=$rc)"
    fi
done
if [ "$FINAL_RC" -eq 0 ]; then echo "✅ 全チェック通過"; fi

# ── Markdown レポート ──
RESULT_LABEL=$([ "$FINAL_RC" -eq 0 ] && echo "✅ ALL PASS" || echo "❌ FAILED")
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')

{
    echo "# プレイヤーリスト通知テスト レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| サーバ | 127.0.0.1:7350 |"
    echo "| テスト人数 | ${COUNTS[*]} |"
    echo "| ログインレート | $([ "${LOGIN_RATE_PER_SEC}" -gt 0 ] && echo "${LOGIN_RATE_PER_SEC}人/秒" || echo "無制限") |"
    echo "| タイムアウト | $([ "${TEST_TIMEOUT_MS}" -gt 0 ] && echo "$((TEST_TIMEOUT_MS / 1000))秒" || echo "自動") |"
    echo "| 結果 | ${RESULT_LABEL} |"
    echo ""

    for key in $(echo "${!PHASE_RC[@]}" | tr ' ' '\n' | sort); do
        rc=${PHASE_RC[$key]}
        label="${key#*-}"
        result=$([ "$rc" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=${rc})")
        echo "## ${key}: ${label}"
        echo ""
        echo "**Vitest:** ${result}"
        echo ""
        # ログファイル名を推定
        server_log="$LOG_DIR/doTest-player-list-${label}-server.log"
        client_log="$LOG_DIR/doTest-player-list-${label}-client.log"
        echo "### サーバログ"
        echo ""
        echo '```'
        [ -f "$server_log" ] && cat "$server_log" || echo "(ログなし)"
        echo '```'
        echo ""
        echo "### Vitest 詳細"
        echo ""
        echo '```'
        [ -f "$client_log" ] && strip_ansi < "$client_log" | grep -E "✓|×|PASS|FAIL|Tests|Duration" || true
        echo '```'
        echo ""
    done
} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$LOG_DIR/05-player-list.md"

echo ""
echo "---"
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: $LOG_DIR/05-player-list.md"

exit $FINAL_RC
