#!/bin/bash
# snd/rcv 整合性テスト実行スクリプト
# サーバログとクライアントログを並行取得し、整合性を確認する
#
# 使い方: ./test/doTest-snd-rcv.sh
# 前提: cd nakama && docker compose up -d

if [ "${1:-}" = "-h" ]; then
    cat <<'EOF'
使い方: ./test/doTest-snd-rcv.sh [-h]

snd/rcv 整合性テストを実行します。
サーバログとクライアントログを並行取得し、各 snd/rcv ペアの整合性を確認します。

オプション:
  -h    このヘルプを表示して終了

テスト内容:
  [1人ログインテスト]
    1クライアント（solo1）がブラウザのログインフローを再現し、
    initPos・AOI_UPDATE・syncChunks・getServerInfo が正しく送信できるかを検証します。

  [2人ログインテスト]
    2つのブラウザクライアント（tommie1, tommie2）が nakama-js で同時にログインし、
    互いの AOI 範囲に入った際に AOI_ENTER を正しく受信できるかを検証します。
    各クライアントはブラウザのログインフロー（認証 → getWorldMatch → joinMatch →
    initPos → AOI_UPDATE → syncChunks → getServerInfo）を再現します。

  各テストの前に nakama サーバを再起動してクリーンな状態で実行します。

処理の流れ:
  1. nakama サーバ再起動 → サーバログ取得開始 → 1人ログインテスト実行
  2. nakama サーバ再起動 → サーバログ取得開始 → 2人ログインテスト実行
  3. 各テストの snd/rcv ペア整合性チェックを実施
  4. Markdown レポート生成・シンボリックリンク更新

整合性チェック対象:
  [共通]
  Login            クライアント snd Login        ↔ サーバ rcv login
  storeLoginTime   クライアント snd storeLoginTime ↔ サーバ rcv storeLoginTime
  getWorldMatch    クライアント snd getWorldMatch  ↔ サーバ rcv getWorldMatch
  initPos          クライアント snd initPos        ↔ サーバ rcv initPos
  AOI_UPDATE       クライアント snd AOI_UPDATE     ↔ サーバ rcv AOI_UPDATE
  syncChunks       クライアント snd syncChunks     ↔ サーバ rcv syncChunks
  getServerInfo    クライアント snd getServerInfo  ↔ サーバ rcv getServerInfo
  [2人のみ]
  AOI_ENTER(双方向) クライアント rcv AOI_ENTER     ↔ サーバ snd AOI_ENTER

ログ出力先:
  test/log/doTest-snd-rcv-solo-server.log    1人テスト サーバログ
  test/log/doTest-snd-rcv-solo-client.log    1人テスト クライアントログ
  test/log/doTest-snd-rcv-duo-server.log     2人テスト サーバログ
  test/log/doTest-snd-rcv-duo-client.log     2人テスト クライアントログ
  test/log/snd-rcv-YYYYMMDD-HHMMSS.md       Markdownレポート（タイムスタンプ付き）
  test/log/04-snd-rcv.md                    最新レポートへのシンボリックリンク

前提:
  cd nakama && docker compose up -d
EOF
    exit 0
fi

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SCRIPT_DIR/log"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LOG_DIR/snd-rcv-${TIMESTAMP}.md"
SOLO_CHECK_OUT="/tmp/snd-rcv-solo-check-$$.txt"
DUO_CHECK_OUT="/tmp/snd-rcv-duo-check-$$.txt"
trap 'rm -f "$SOLO_CHECK_OUT" "$DUO_CHECK_OUT"' EXIT

GREP_FILTER="rcv login\|rcv logout\|rcv setBlock\|rcv getWorldMatch\|rcv getServerInfo\
\|rcv getGroundChunk\|rcv syncChunks\|rcv storeLoginTime\|rcv initPos\|rcv AOI_UPDATE\
\|snd AOI_ENTER\|snd AOI_LEAVE\|snd setBlock:signal"

TOTAL_ERRORS=0

# ── サーバ再起動 ──
restart_server() {
    echo "  nakama サーバ再起動..."
    cd "$ROOT_DIR/nakama"
    docker compose restart nakama
    # ヘルスチェック（最大30秒）
    local i
    for i in $(seq 1 30); do
        if docker compose logs --tail 5 nakama 2>/dev/null | grep -q "Startup"; then
            echo "  起動確認 (${i}s)"
            break
        fi
        sleep 1
    done
    sleep 2
}

# ── サーバログ取得開始 ──
start_server_log() {
    local log_file="$1"
    cd "$ROOT_DIR/nakama"
    docker compose logs -f --tail 0 nakama 2>&1 \
      | grep --line-buffered "$GREP_FILTER" \
      | sed -u 's/^[^ ]* *| *//' \
      | sed -u 's/\([0-9a-f]\{8\}\)-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}/\1/g' \
      > "$log_file" &
    echo $!
}

# ── 整合性チェック（Python スクリプトに委譲） ──
run_consistency_check() {
    local client_log="$1"
    local server_log="$2"
    local extra_args="${3:-}"
    local out_file="$4"
    local rc
    set +e
    python3 "$SCRIPT_DIR/check-snd-rcv.py" "$client_log" "$server_log" $extra_args 2>&1 | tee "$out_file"
    rc=${PIPESTATUS[0]}
    set -e
    TOTAL_ERRORS=$((TOTAL_ERRORS + rc))
}

# ── ANSI除去 ──
strip_ansi() { sed 's/\x1b\[[0-9;]*[mGKHF]//g'; }

# =========================================
echo "========================================="
echo "snd/rcv 整合性テスト"
echo "========================================="

# =========================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[Phase 1] 1人ログインテスト"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

SOLO_SERVER_LOG="$LOG_DIR/doTest-snd-rcv-solo-server.log"
SOLO_CLIENT_LOG="$LOG_DIR/doTest-snd-rcv-solo-client.log"

restart_server

echo "  サーバログ取得開始..."
SOLO_LOG_PID=$(start_server_log "$SOLO_SERVER_LOG")
echo "  PID=$SOLO_LOG_PID -> $SOLO_SERVER_LOG"

echo "  Vitest 実行 (1人ログインテスト)..."
cd "$ROOT_DIR"
set +e
npx vitest run test/nakama-snd-rcv.test.ts -t "1人ログインテスト" 2>&1 | tee "$SOLO_CLIENT_LOG"
SOLO_RC=${PIPESTATUS[0]}
set -e

sleep 1
kill "$SOLO_LOG_PID" 2>/dev/null || true

echo ""
echo "  サーバログ: $SOLO_SERVER_LOG"
echo "  -----------------------------------------"
cat "$SOLO_SERVER_LOG"

echo ""
echo "  整合性チェック (1人ログインテスト):"
run_consistency_check "$SOLO_CLIENT_LOG" "$SOLO_SERVER_LOG" "" "$SOLO_CHECK_OUT"

# =========================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[Phase 2] 2人ログインテスト"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

DUO_SERVER_LOG="$LOG_DIR/doTest-snd-rcv-duo-server.log"
DUO_CLIENT_LOG="$LOG_DIR/doTest-snd-rcv-duo-client.log"

restart_server

echo "  サーバログ取得開始..."
DUO_LOG_PID=$(start_server_log "$DUO_SERVER_LOG")
echo "  PID=$DUO_LOG_PID -> $DUO_SERVER_LOG"

echo "  Vitest 実行 (2人ログインテスト)..."
cd "$ROOT_DIR"
set +e
npx vitest run test/nakama-snd-rcv.test.ts -t "2人ログインテスト" 2>&1 | tee "$DUO_CLIENT_LOG"
DUO_RC=${PIPESTATUS[0]}
set -e

sleep 1
kill "$DUO_LOG_PID" 2>/dev/null || true

echo ""
echo "  サーバログ: $DUO_SERVER_LOG"
echo "  -----------------------------------------"
cat "$DUO_SERVER_LOG"

echo ""
echo "  整合性チェック (2人ログインテスト):"
run_consistency_check "$DUO_CLIENT_LOG" "$DUO_SERVER_LOG" "--duo" "$DUO_CHECK_OUT"

# =========================================
# ── 最終結果判定 ──
FINAL_RC=0
[ "$SOLO_RC" -ne 0 ] && FINAL_RC=1
[ "$DUO_RC"  -ne 0 ] && FINAL_RC=1
[ "$TOTAL_ERRORS" -gt 0 ] && FINAL_RC=1

echo ""
echo "========================================="
echo "最終結果"
echo "========================================="
[ "$SOLO_RC" -ne 0 ]     && echo "❌ 1人ログインテスト Vitest 失敗 (exit=$SOLO_RC)"
[ "$DUO_RC"  -ne 0 ]     && echo "❌ 2人ログインテスト Vitest 失敗 (exit=$DUO_RC)"
[ "$TOTAL_ERRORS" -gt 0 ] && echo "❌ 整合性エラー: ${TOTAL_ERRORS}件"
[ "$FINAL_RC" -eq 0 ]     && echo "✅ 全チェック通過"

# =========================================
# ── Markdown レポート生成 ──
RESULT_LABEL=$([ "$FINAL_RC" -eq 0 ] && echo "✅ ALL PASS" || echo "❌ FAILED")
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')

{
    echo "# snd/rcv 整合性テスト レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| サーバ | 127.0.0.1:7350 |"
    echo "| 結果 | ${RESULT_LABEL} |"
    echo ""

    # ── Phase 1 ──
    echo "## Phase 1: 1人ログインテスト"
    echo ""
    SOLO_VITEST_RESULT=$([ "$SOLO_RC" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=$SOLO_RC)")
    echo "**Vitest:** ${SOLO_VITEST_RESULT}"
    echo ""
    echo "### 整合性チェック"
    echo ""
    echo '```'
    cat "$SOLO_CHECK_OUT"
    echo '```'
    echo ""
    echo "### サーバログ"
    echo ""
    echo '```'
    cat "$SOLO_SERVER_LOG"
    echo '```'
    echo ""

    # ── Phase 2 ──
    echo "## Phase 2: 2人ログインテスト"
    echo ""
    DUO_VITEST_RESULT=$([ "$DUO_RC" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=$DUO_RC)")
    echo "**Vitest:** ${DUO_VITEST_RESULT}"
    echo ""
    echo "### 整合性チェック"
    echo ""
    echo '```'
    cat "$DUO_CHECK_OUT"
    echo '```'
    echo ""
    echo "### サーバログ"
    echo ""
    echo '```'
    cat "$DUO_SERVER_LOG"
    echo '```'
    echo ""

    # ── Vitest 詳細 ──
    echo "## Vitest 詳細"
    echo ""
    echo "### Phase 1: 1人ログインテスト"
    echo ""
    echo '```'
    cat "$SOLO_CLIENT_LOG" | strip_ansi | grep -E "✓|×|PASS|FAIL|Tests|Duration" || true
    echo '```'
    echo ""
    echo "### Phase 2: 2人ログインテスト"
    echo ""
    echo '```'
    cat "$DUO_CLIENT_LOG" | strip_ansi | grep -E "✓|×|PASS|FAIL|Tests|Duration" || true
    echo '```'
    echo ""
} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$LOG_DIR/04-snd-rcv.md"

echo ""
echo "---"
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: $LOG_DIR/04-snd-rcv.md"

exit $FINAL_RC
