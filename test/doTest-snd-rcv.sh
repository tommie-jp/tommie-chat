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
  [Phase 1: 1人ログインテスト]
    1クライアント（solo1）がブラウザのログインフローを再現し、
    initPos・AOI_UPDATE・syncChunks・getServerInfo が正しく送信できるかを検証します。

  [Phase 2: 2人ログインテスト]
    2つのブラウザクライアント（tommie1, tommie2）が nakama-js で同時にログインし、
    互いの AOI 範囲に入った際に AOI_ENTER を正しく受信できるかを検証します。

  [Phase 3: setBlock テスト]
    1クライアント（block1）がブロック設置を行い、getGroundChunk と
    setBlock:signal (op=4) の受信を検証します。

  [Phase 4: AOI_LEAVE テスト]
    2クライアント（leave1, leave2）がログインし、leave2 切断後に
    leave1 が AOI_LEAVE (op=7) を受信することを検証します。

  [Phase 5: opMoveTarget テスト]
    2クライアント（move1, move2）がログインし、move1 の移動を
    move2 が op=2 として受信することを検証します。

  [Phase 6: opAvatarChange テスト]
    2クライアント（avatar1, avatar2）がログインし、avatar1 のアバター変更を
    avatar2 が op=3 として受信することを検証します。

  各テストの前に nakama サーバを再起動してクリーンな状態で実行します。

処理の流れ:
  1. nakama サーバ再起動 → サーバログ取得開始 → 1人ログインテスト実行
  2. nakama サーバ再起動 → サーバログ取得開始 → 2人ログインテスト実行
  3. nakama サーバ再起動 → サーバログ取得開始 → setBlock テスト実行
  4. nakama サーバ再起動 → サーバログ取得開始 → AOI_LEAVE テスト実行
  5. nakama サーバ再起動 → サーバログ取得開始 → opMoveTarget テスト実行
  6. nakama サーバ再起動 → サーバログ取得開始 → opAvatarChange テスト実行
  7. 各テストの snd/rcv ペア整合性チェックを実施
  8. Markdown レポート生成・シンボリックリンク更新

整合性チェック対象:
  [共通]
  Login            クライアント snd Login        ↔ サーバ rcv login
  storeLoginTime   クライアント snd storeLoginTime ↔ サーバ rcv storeLoginTime
  getWorldMatch    クライアント snd getWorldMatch  ↔ サーバ rcv getWorldMatch
  initPos          クライアント snd initPos        ↔ サーバ rcv initPos
  AOI_UPDATE       クライアント snd AOI_UPDATE     ↔ サーバ rcv AOI_UPDATE
  syncChunks       クライアント snd syncChunks     ↔ サーバ rcv syncChunks
  getServerInfo    クライアント snd getServerInfo  ↔ サーバ rcv getServerInfo
  [Phase 2 のみ]
  AOI_ENTER(双方向) クライアント rcv AOI_ENTER     ↔ サーバ snd AOI_ENTER
  [Phase 3 のみ]
  setBlock         クライアント snd setBlock       ↔ サーバ rcv setBlock
  getGroundChunk   クライアント snd getGroundChunk ↔ サーバ rcv getGroundChunk
  setBlock:signal  クライアント rcv matchdata op=4 ↔ サーバ snd setBlock:signal
  [Phase 4 のみ]
  AOI_LEAVE        クライアント rcv matchdata op=7 ↔ サーバ snd AOI_LEAVE
  [Phase 5 のみ]
  moveTarget       クライアント snd moveTarget     ↔ サーバ rcv moveTarget
  moveTarget:signal クライアント rcv matchdata op=2 ↔ サーバ snd moveTarget:signal
  [Phase 6 のみ]
  avatarChange     クライアント snd avatarChange   ↔ サーバ rcv avatarChange
  avatarChange:signal クライアント rcv matchdata op=3 ↔ サーバ snd avatarChange:signal

ログ出力先:
  test/log/doTest-snd-rcv-solo-server.log      Phase 1 サーバログ
  test/log/doTest-snd-rcv-solo-client.log      Phase 1 クライアントログ
  test/log/doTest-snd-rcv-duo-server.log       Phase 2 サーバログ
  test/log/doTest-snd-rcv-duo-client.log       Phase 2 クライアントログ
  test/log/doTest-snd-rcv-setblock-server.log      Phase 3 サーバログ
  test/log/doTest-snd-rcv-setblock-client.log      Phase 3 クライアントログ
  test/log/doTest-snd-rcv-aileave-server.log       Phase 4 サーバログ
  test/log/doTest-snd-rcv-aileave-client.log       Phase 4 クライアントログ
  test/log/doTest-snd-rcv-movetarget-server.log    Phase 5 サーバログ
  test/log/doTest-snd-rcv-movetarget-client.log    Phase 5 クライアントログ
  test/log/doTest-snd-rcv-avatarchange-server.log  Phase 6 サーバログ
  test/log/doTest-snd-rcv-avatarchange-client.log  Phase 6 クライアントログ
  test/log/snd-rcv-YYYYMMDD-HHMMSS.md         Markdownレポート（タイムスタンプ付き）
  test/log/04-snd-rcv.md                       最新レポートへのシンボリックリンク

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
SETBLOCK_CHECK_OUT="/tmp/snd-rcv-setblock-check-$$.txt"
AILEAVE_CHECK_OUT="/tmp/snd-rcv-aileave-check-$$.txt"
MOVETARGET_CHECK_OUT="/tmp/snd-rcv-movetarget-check-$$.txt"
AVATARCHANGE_CHECK_OUT="/tmp/snd-rcv-avatarchange-check-$$.txt"
trap 'rm -f "$SOLO_CHECK_OUT" "$DUO_CHECK_OUT" "$SETBLOCK_CHECK_OUT" "$AILEAVE_CHECK_OUT" "$MOVETARGET_CHECK_OUT" "$AVATARCHANGE_CHECK_OUT"' EXIT

GREP_FILTER="rcv login\|rcv logout\|rcv setBlock\|rcv getWorldMatch\|rcv getServerInfo\
\|rcv getGroundChunk\|rcv syncChunks\|rcv storeLoginTime\|rcv initPos\|rcv AOI_UPDATE\
\|snd AOI_ENTER\|snd AOI_LEAVE\|snd setBlock:signal\
\|rcv moveTarget\|snd moveTarget:signal\
\|rcv avatarChange\|snd avatarChange:signal"

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
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[Phase 3] setBlock テスト"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

SETBLOCK_SERVER_LOG="$LOG_DIR/doTest-snd-rcv-setblock-server.log"
SETBLOCK_CLIENT_LOG="$LOG_DIR/doTest-snd-rcv-setblock-client.log"

restart_server

echo "  サーバログ取得開始..."
SETBLOCK_LOG_PID=$(start_server_log "$SETBLOCK_SERVER_LOG")
echo "  PID=$SETBLOCK_LOG_PID -> $SETBLOCK_SERVER_LOG"

echo "  Vitest 実行 (setBlock テスト)..."
cd "$ROOT_DIR"
set +e
npx vitest run test/nakama-snd-rcv.test.ts -t "setBlock テスト" 2>&1 | tee "$SETBLOCK_CLIENT_LOG"
SETBLOCK_RC=${PIPESTATUS[0]}
set -e

sleep 1
kill "$SETBLOCK_LOG_PID" 2>/dev/null || true

echo ""
echo "  サーバログ: $SETBLOCK_SERVER_LOG"
echo "  -----------------------------------------"
cat "$SETBLOCK_SERVER_LOG"

echo ""
echo "  整合性チェック (setBlock テスト):"
run_consistency_check "$SETBLOCK_CLIENT_LOG" "$SETBLOCK_SERVER_LOG" "--setblock" "$SETBLOCK_CHECK_OUT"

# =========================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[Phase 4] AOI_LEAVE テスト"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

AILEAVE_SERVER_LOG="$LOG_DIR/doTest-snd-rcv-aileave-server.log"
AILEAVE_CLIENT_LOG="$LOG_DIR/doTest-snd-rcv-aileave-client.log"

restart_server

echo "  サーバログ取得開始..."
AILEAVE_LOG_PID=$(start_server_log "$AILEAVE_SERVER_LOG")
echo "  PID=$AILEAVE_LOG_PID -> $AILEAVE_SERVER_LOG"

echo "  Vitest 実行 (AOI_LEAVE テスト)..."
cd "$ROOT_DIR"
set +e
npx vitest run test/nakama-snd-rcv.test.ts -t "AOI_LEAVE テスト" 2>&1 | tee "$AILEAVE_CLIENT_LOG"
AILEAVE_RC=${PIPESTATUS[0]}
set -e

sleep 1
kill "$AILEAVE_LOG_PID" 2>/dev/null || true

echo ""
echo "  サーバログ: $AILEAVE_SERVER_LOG"
echo "  -----------------------------------------"
cat "$AILEAVE_SERVER_LOG"

echo ""
echo "  整合性チェック (AOI_LEAVE テスト):"
run_consistency_check "$AILEAVE_CLIENT_LOG" "$AILEAVE_SERVER_LOG" "--aoi-leave" "$AILEAVE_CHECK_OUT"

# =========================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[Phase 5] opMoveTarget テスト"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

MOVETARGET_SERVER_LOG="$LOG_DIR/doTest-snd-rcv-movetarget-server.log"
MOVETARGET_CLIENT_LOG="$LOG_DIR/doTest-snd-rcv-movetarget-client.log"

restart_server

echo "  サーバログ取得開始..."
MOVETARGET_LOG_PID=$(start_server_log "$MOVETARGET_SERVER_LOG")
echo "  PID=$MOVETARGET_LOG_PID -> $MOVETARGET_SERVER_LOG"

echo "  Vitest 実行 (opMoveTarget テスト)..."
cd "$ROOT_DIR"
set +e
npx vitest run test/nakama-snd-rcv.test.ts -t "opMoveTarget テスト" 2>&1 | tee "$MOVETARGET_CLIENT_LOG"
MOVETARGET_RC=${PIPESTATUS[0]}
set -e

sleep 1
kill "$MOVETARGET_LOG_PID" 2>/dev/null || true

echo ""
echo "  サーバログ: $MOVETARGET_SERVER_LOG"
echo "  -----------------------------------------"
cat "$MOVETARGET_SERVER_LOG"

echo ""
echo "  整合性チェック (opMoveTarget テスト):"
run_consistency_check "$MOVETARGET_CLIENT_LOG" "$MOVETARGET_SERVER_LOG" "--movetarget" "$MOVETARGET_CHECK_OUT"

# =========================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[Phase 6] opAvatarChange テスト"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

AVATARCHANGE_SERVER_LOG="$LOG_DIR/doTest-snd-rcv-avatarchange-server.log"
AVATARCHANGE_CLIENT_LOG="$LOG_DIR/doTest-snd-rcv-avatarchange-client.log"

restart_server

echo "  サーバログ取得開始..."
AVATARCHANGE_LOG_PID=$(start_server_log "$AVATARCHANGE_SERVER_LOG")
echo "  PID=$AVATARCHANGE_LOG_PID -> $AVATARCHANGE_SERVER_LOG"

echo "  Vitest 実行 (opAvatarChange テスト)..."
cd "$ROOT_DIR"
set +e
npx vitest run test/nakama-snd-rcv.test.ts -t "opAvatarChange テスト" 2>&1 | tee "$AVATARCHANGE_CLIENT_LOG"
AVATARCHANGE_RC=${PIPESTATUS[0]}
set -e

sleep 1
kill "$AVATARCHANGE_LOG_PID" 2>/dev/null || true

echo ""
echo "  サーバログ: $AVATARCHANGE_SERVER_LOG"
echo "  -----------------------------------------"
cat "$AVATARCHANGE_SERVER_LOG"

echo ""
echo "  整合性チェック (opAvatarChange テスト):"
run_consistency_check "$AVATARCHANGE_CLIENT_LOG" "$AVATARCHANGE_SERVER_LOG" "--avatarchange" "$AVATARCHANGE_CHECK_OUT"

# =========================================
# ── 最終結果判定 ──
FINAL_RC=0
[ "$SOLO_RC"        -ne 0 ] && FINAL_RC=1
[ "$DUO_RC"         -ne 0 ] && FINAL_RC=1
[ "$SETBLOCK_RC"    -ne 0 ] && FINAL_RC=1
[ "$AILEAVE_RC"     -ne 0 ] && FINAL_RC=1
[ "$MOVETARGET_RC"  -ne 0 ] && FINAL_RC=1
[ "$AVATARCHANGE_RC" -ne 0 ] && FINAL_RC=1
[ "$TOTAL_ERRORS" -gt 0 ] && FINAL_RC=1

echo ""
echo "========================================="
echo "最終結果"
echo "========================================="
[ "$SOLO_RC"        -ne 0 ] && echo "❌ 1人ログインテスト Vitest 失敗 (exit=$SOLO_RC)"
[ "$DUO_RC"         -ne 0 ] && echo "❌ 2人ログインテスト Vitest 失敗 (exit=$DUO_RC)"
[ "$SETBLOCK_RC"    -ne 0 ] && echo "❌ setBlock テスト Vitest 失敗 (exit=$SETBLOCK_RC)"
[ "$AILEAVE_RC"     -ne 0 ] && echo "❌ AOI_LEAVE テスト Vitest 失敗 (exit=$AILEAVE_RC)"
[ "$MOVETARGET_RC"  -ne 0 ] && echo "❌ opMoveTarget テスト Vitest 失敗 (exit=$MOVETARGET_RC)"
[ "$AVATARCHANGE_RC" -ne 0 ] && echo "❌ opAvatarChange テスト Vitest 失敗 (exit=$AVATARCHANGE_RC)"
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

    # ── Phase 3 ──
    echo "## Phase 3: setBlock テスト"
    echo ""
    SETBLOCK_VITEST_RESULT=$([ "$SETBLOCK_RC" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=$SETBLOCK_RC)")
    echo "**Vitest:** ${SETBLOCK_VITEST_RESULT}"
    echo ""
    echo "### 整合性チェック"
    echo ""
    echo '```'
    cat "$SETBLOCK_CHECK_OUT"
    echo '```'
    echo ""
    echo "### サーバログ"
    echo ""
    echo '```'
    cat "$SETBLOCK_SERVER_LOG"
    echo '```'
    echo ""

    # ── Phase 4 ──
    echo "## Phase 4: AOI_LEAVE テスト"
    echo ""
    AILEAVE_VITEST_RESULT=$([ "$AILEAVE_RC" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=$AILEAVE_RC)")
    echo "**Vitest:** ${AILEAVE_VITEST_RESULT}"
    echo ""
    echo "### 整合性チェック"
    echo ""
    echo '```'
    cat "$AILEAVE_CHECK_OUT"
    echo '```'
    echo ""
    echo "### サーバログ"
    echo ""
    echo '```'
    cat "$AILEAVE_SERVER_LOG"
    echo '```'
    echo ""

    # ── Phase 5 ──
    echo "## Phase 5: opMoveTarget テスト"
    echo ""
    MOVETARGET_VITEST_RESULT=$([ "$MOVETARGET_RC" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=$MOVETARGET_RC)")
    echo "**Vitest:** ${MOVETARGET_VITEST_RESULT}"
    echo ""
    echo "### 整合性チェック"
    echo ""
    echo '```'
    cat "$MOVETARGET_CHECK_OUT"
    echo '```'
    echo ""
    echo "### サーバログ"
    echo ""
    echo '```'
    cat "$MOVETARGET_SERVER_LOG"
    echo '```'
    echo ""

    # ── Phase 6 ──
    echo "## Phase 6: opAvatarChange テスト"
    echo ""
    AVATARCHANGE_VITEST_RESULT=$([ "$AVATARCHANGE_RC" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=$AVATARCHANGE_RC)")
    echo "**Vitest:** ${AVATARCHANGE_VITEST_RESULT}"
    echo ""
    echo "### 整合性チェック"
    echo ""
    echo '```'
    cat "$AVATARCHANGE_CHECK_OUT"
    echo '```'
    echo ""
    echo "### サーバログ"
    echo ""
    echo '```'
    cat "$AVATARCHANGE_SERVER_LOG"
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
    echo "### Phase 3: setBlock テスト"
    echo ""
    echo '```'
    cat "$SETBLOCK_CLIENT_LOG" | strip_ansi | grep -E "✓|×|PASS|FAIL|Tests|Duration" || true
    echo '```'
    echo ""
    echo "### Phase 4: AOI_LEAVE テスト"
    echo ""
    echo '```'
    cat "$AILEAVE_CLIENT_LOG" | strip_ansi | grep -E "✓|×|PASS|FAIL|Tests|Duration" || true
    echo '```'
    echo ""
    echo "### Phase 5: opMoveTarget テスト"
    echo ""
    echo '```'
    cat "$MOVETARGET_CLIENT_LOG" | strip_ansi | grep -E "✓|×|PASS|FAIL|Tests|Duration" || true
    echo '```'
    echo ""
    echo "### Phase 6: opAvatarChange テスト"
    echo ""
    echo '```'
    cat "$AVATARCHANGE_CLIENT_LOG" | strip_ansi | grep -E "✓|×|PASS|FAIL|Tests|Duration" || true
    echo '```'
    echo ""
} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$LOG_DIR/04-snd-rcv.md"

echo ""
echo "---"
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: $LOG_DIR/04-snd-rcv.md"

exit $FINAL_RC
