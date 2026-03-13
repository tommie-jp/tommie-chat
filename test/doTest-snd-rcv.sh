#!/bin/bash
# snd/rcv 整合性テスト実行スクリプト
# サーバログとクライアントログを並行取得し、整合性を確認する
#
# 使い方: ./test/doTest-snd-rcv.sh [-n N] [--1000] [-h]
# 前提: cd nakama && docker compose up -d

# ── 引数パース（set -euo pipefail 前） ──
PLAYERS_FILTER=""   # 指定人数のみ実行（空=全フェーズ）
WITH_1000=0
LOGIN_RATE=40       # 秒あたりのログイン数（0=無制限, サーバ側MAX_LOGIN_RATE_PER_SEC未満にすること）
TIMEOUT_SEC=0       # テストタイムアウト秒（0=デフォルト値を使用）

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
使い方: ./test/doTest-snd-rcv.sh [-n N] [-r R] [--1000] [-h]

snd/rcv 整合性テストを実行します。
サーバログとクライアントログを並行取得し、各 snd/rcv ペアの整合性を確認します。

オプション:
  -n N, --players N   N人ログインテストのみ実行 (N: 1|2|3|10|100|1000)
  -r R, --rate R      秒あたりのログイン数を指定 (デフォルト: 100)
                      例: -r 50 → 50人/秒でバッチログイン
  -t T, --timeout T   テストタイムアウトを秒単位で指定 (デフォルト: 人数に応じて自動)
                      例: -t 600 → 600秒タイムアウト
  --1000              1000人テストをデフォルト実行に追加
  -h                  このヘルプを表示して終了

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

  [Phase 7: 3人ログインテスト]
    3クライアントが同時にログインし、互いに AOI_ENTER を受信することを検証します。

  [Phase 8: 10人ログインテスト]
    10クライアントが同時にログインし、互いに AOI_ENTER を受信することを検証します。

  [Phase 9: 100人ログインテスト]
    100クライアントが並列ログインし、AOI_ENTER を受信することを検証します。

  [Phase 10: 1000人ログインテスト (--1000 または -n 1000 で実行)]
    1000クライアントが並列ログインし、ログイン成功を検証します。

  各テストの前に nakama サーバを再起動してクリーンな状態で実行します。

デフォルト実行フェーズ: 1, 2, 3, 4, 5, 6, 7, 8, 9 (1000人は --1000 で追加)

整合性チェック対象:
  [共通]
  Login            クライアント snd Login        ↔ サーバ rcv login
  storeLoginTime   クライアント snd storeLoginTime ↔ サーバ rcv storeLoginTime
  getWorldMatch    クライアント snd getWorldMatch  ↔ サーバ rcv getWorldMatch
  initPos          クライアント snd initPos        ↔ サーバ rcv initPos
  AOI_UPDATE       クライアント snd AOI_UPDATE     ↔ サーバ rcv AOI_UPDATE
  syncChunks       クライアント snd syncChunks     ↔ サーバ rcv syncChunks
  getServerInfo    クライアント snd getServerInfo  ↔ サーバ rcv getServerInfo
  [Phase 2, 7, 8, 9, 10]
  AOI_ENTER(双方向) クライアント rcv AOI_ENTER     ↔ サーバ snd AOI_ENTER
  [Phase 3 のみ]
  setBlock/getGroundChunk/setBlock:signal
  [Phase 4 のみ]
  AOI_LEAVE
  [Phase 5 のみ]
  moveTarget/moveTarget:signal
  [Phase 6 のみ]
  avatarChange/avatarChange:signal

ログ出力先:
  test/log/doTest-snd-rcv-*-server.log  各フェーズのサーバログ
  test/log/doTest-snd-rcv-*-client.log  各フェーズのクライアントログ
  test/log/snd-rcv-YYYYMMDD-HHMMSS.md  Markdownレポート（タイムスタンプ付き）
  test/log/04-snd-rcv.md               最新レポートへのシンボリックリンク

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
        --1000)
            WITH_1000=1
            shift ;;
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
MULTI3_CHECK_OUT="/tmp/snd-rcv-multi3-check-$$.txt"
MULTI10_CHECK_OUT="/tmp/snd-rcv-multi10-check-$$.txt"
MULTI100_CHECK_OUT="/tmp/snd-rcv-multi100-check-$$.txt"
MULTI1000_CHECK_OUT="/tmp/snd-rcv-multi1000-check-$$.txt"
CUSTOM_CHECK_OUT="/tmp/snd-rcv-custom-check-$$.txt"
trap 'rm -f "$SOLO_CHECK_OUT" "$DUO_CHECK_OUT" "$SETBLOCK_CHECK_OUT" "$AILEAVE_CHECK_OUT" \
          "$MOVETARGET_CHECK_OUT" "$AVATARCHANGE_CHECK_OUT" \
          "$MULTI3_CHECK_OUT" "$MULTI10_CHECK_OUT" "$MULTI100_CHECK_OUT" "$MULTI1000_CHECK_OUT" \
          "$CUSTOM_CHECK_OUT"' EXIT

GREP_FILTER="rcv login\|rcv logout\|rcv setBlock\|rcv getWorldMatch\|rcv getServerInfo\
\|rcv getGroundChunk\|rcv syncChunks\|rcv storeLoginTime\|rcv initPos\|rcv AOI_UPDATE\
\|snd AOI_ENTER\|snd AOI_LEAVE\|snd setBlock:signal\
\|rcv moveTarget\|snd moveTarget:signal\
\|rcv avatarChange\|snd avatarChange:signal"

TOTAL_ERRORS=0

# ── 実行フェーズ決定 ──
# PLAYERS_FILTER が指定された場合はそのN人ログインフェーズのみ実行
# 未指定の場合はデフォルト（P1-P9）を実行、--1000 があれば P10 も追加
if [ -n "$PLAYERS_FILTER" ]; then
    case "$PLAYERS_FILTER" in
        1)    PHASES_TO_RUN="P1" ;;
        2)    PHASES_TO_RUN="P2" ;;
        3)    PHASES_TO_RUN="P7" ;;
        10)   PHASES_TO_RUN="P8" ;;
        100)  PHASES_TO_RUN="P9" ;;
        1000) PHASES_TO_RUN="P10" ;;
        *)
            if ! [[ "$PLAYERS_FILTER" =~ ^[0-9]+$ ]] || [ "$PLAYERS_FILTER" -lt 1 ]; then
                echo "無効な人数: $PLAYERS_FILTER (1以上の整数)"; exit 1
            fi
            PHASES_TO_RUN="PCUSTOM" ;;
    esac
else
    PHASES_TO_RUN="P1 P2 P3 P4 P5 P6 P7 P8 P9"
    [ "$WITH_1000" -eq 1 ] && PHASES_TO_RUN="$PHASES_TO_RUN P10"
fi

should_run() { [[ " $PHASES_TO_RUN " == *" $1 "* ]]; }

# フェーズ終了コード初期化（-1=未実行, 0=成功, >0=失敗）
SOLO_RC=-1; DUO_RC=-1; SETBLOCK_RC=-1; AILEAVE_RC=-1
MOVETARGET_RC=-1; AVATARCHANGE_RC=-1
MULTI3_RC=-1; MULTI10_RC=-1; MULTI100_RC=-1; MULTI1000_RC=-1; CUSTOM_RC=-1

echo "========================================="
echo "snd/rcv 整合性テスト"
echo "========================================="
echo "実行フェーズ: $PHASES_TO_RUN"

# ── Go プラグインビルド ──
echo ""
echo "--- Go プラグインビルド ---"
"$ROOT_DIR/nakama/doBuild.sh"

# ── サーバ再起動 ──
restart_server() {
    echo "  nakama サーバ再起動..."
    cd "$ROOT_DIR/nakama"
    docker compose restart -t 3 nakama
    # ヘルスチェック（最大30秒）
    local i
    for i in $(seq 1 30); do
        if docker compose logs --tail 5 nakama 2>/dev/null | grep -q "Startup"; then
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

# ── フェーズ実行ヘルパー ──
run_phase() {
    local phase_id="$1"   # P1..P10
    local phase_num="$2"  # 表示番号
    local label="$3"      # 表示ラベル
    local server_log="$4"
    local client_log="$5"
    local vitest_filter="$6"
    local check_args="$7"
    local check_out="$8"
    local rc_var="$9"
    local wait_extra="${10:-1}"  # kill前の追加wait秒数

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "[Phase ${phase_num}] ${label}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    restart_server

    echo "  サーバログ取得開始..."
    local log_pid
    log_pid=$(start_server_log "$server_log")
    echo "  PID=$log_pid -> $server_log"

    echo "  Vitest 実行 (${label})..."
    cd "$ROOT_DIR"
    set +e
    npx vitest run test/nakama-snd-rcv.test.ts -t "$vitest_filter" 2>&1 | tee "$client_log"
    local rc=${PIPESTATUS[0]}
    set -e

    sleep "$wait_extra"
    kill "$log_pid" 2>/dev/null || true

    echo ""
    echo "  サーバログ: $server_log"
    echo "  -----------------------------------------"
    cat "$server_log"

    echo ""
    echo "  整合性チェック (${label}):"
    run_consistency_check "$client_log" "$server_log" "$check_args" "$check_out"

    # rc_var に結果を格納
    printf -v "$rc_var" '%d' "$rc"
}

# =========================================
if should_run P1; then
    run_phase P1 1 "1人ログインテスト" \
        "$LOG_DIR/doTest-snd-rcv-solo-server.log" \
        "$LOG_DIR/doTest-snd-rcv-solo-client.log" \
        "1人ログインテスト" "" "$SOLO_CHECK_OUT" SOLO_RC
fi

if should_run P2; then
    run_phase P2 2 "2人ログインテスト" \
        "$LOG_DIR/doTest-snd-rcv-duo-server.log" \
        "$LOG_DIR/doTest-snd-rcv-duo-client.log" \
        "2人ログインテスト" "--duo" "$DUO_CHECK_OUT" DUO_RC
fi

if should_run P3; then
    run_phase P3 3 "setBlock テスト" \
        "$LOG_DIR/doTest-snd-rcv-setblock-server.log" \
        "$LOG_DIR/doTest-snd-rcv-setblock-client.log" \
        "setBlock テスト" "--setblock" "$SETBLOCK_CHECK_OUT" SETBLOCK_RC
fi

if should_run P4; then
    run_phase P4 4 "AOI_LEAVE テスト" \
        "$LOG_DIR/doTest-snd-rcv-aileave-server.log" \
        "$LOG_DIR/doTest-snd-rcv-aileave-client.log" \
        "AOI_LEAVE テスト" "--aoi-leave" "$AILEAVE_CHECK_OUT" AILEAVE_RC
fi

if should_run P5; then
    run_phase P5 5 "opMoveTarget テスト" \
        "$LOG_DIR/doTest-snd-rcv-movetarget-server.log" \
        "$LOG_DIR/doTest-snd-rcv-movetarget-client.log" \
        "opMoveTarget テスト" "--movetarget" "$MOVETARGET_CHECK_OUT" MOVETARGET_RC
fi

if should_run P6; then
    run_phase P6 6 "opAvatarChange テスト" \
        "$LOG_DIR/doTest-snd-rcv-avatarchange-server.log" \
        "$LOG_DIR/doTest-snd-rcv-avatarchange-client.log" \
        "opAvatarChange テスト" "--avatarchange" "$AVATARCHANGE_CHECK_OUT" AVATARCHANGE_RC
fi

if should_run P7; then
    run_phase P7 7 "3人ログインテスト" \
        "$LOG_DIR/doTest-snd-rcv-multi3-server.log" \
        "$LOG_DIR/doTest-snd-rcv-multi3-client.log" \
        "3人ログインテスト" "--duo" "$MULTI3_CHECK_OUT" MULTI3_RC
fi

if should_run P8; then
    run_phase P8 8 "10人ログインテスト" \
        "$LOG_DIR/doTest-snd-rcv-multi10-server.log" \
        "$LOG_DIR/doTest-snd-rcv-multi10-client.log" \
        "10人ログインテスト" "--duo" "$MULTI10_CHECK_OUT" MULTI10_RC 2
fi

if should_run P9; then
    run_phase P9 9 "100人ログインテスト" \
        "$LOG_DIR/doTest-snd-rcv-multi100-server.log" \
        "$LOG_DIR/doTest-snd-rcv-multi100-client.log" \
        "100人ログインテスト" "--duo" "$MULTI100_CHECK_OUT" MULTI100_RC 6
fi

if should_run P10; then
    run_phase P10 10 "1000人ログインテスト" \
        "$LOG_DIR/doTest-snd-rcv-multi1000-server.log" \
        "$LOG_DIR/doTest-snd-rcv-multi1000-client.log" \
        "1000人ログインテスト" "" "$MULTI1000_CHECK_OUT" MULTI1000_RC 5
fi

if should_run PCUSTOM; then
    _cn="$PLAYERS_FILTER"
    _cargs=$([ "$_cn" -le 100 ] && echo "--duo" || echo "")
    if [ "$_cn" -le 10 ]; then _cwait=1; elif [ "$_cn" -le 100 ]; then _cwait=6; else _cwait=5; fi
    export MULTI_N_COUNT="$_cn"
    run_phase PCUSTOM "$_cn" "${_cn}人ログインテスト（カスタム）" \
        "$LOG_DIR/doTest-snd-rcv-custom${_cn}-server.log" \
        "$LOG_DIR/doTest-snd-rcv-custom${_cn}-client.log" \
        "${_cn}人ログインテスト" "$_cargs" "$CUSTOM_CHECK_OUT" CUSTOM_RC "$_cwait"
    unset MULTI_N_COUNT
fi

# =========================================
# ── 最終結果判定（-1=未実行、0=成功、>0=失敗） ──
FINAL_RC=0
[ "$SOLO_RC"         -gt 0 ] && FINAL_RC=1
[ "$DUO_RC"          -gt 0 ] && FINAL_RC=1
[ "$SETBLOCK_RC"     -gt 0 ] && FINAL_RC=1
[ "$AILEAVE_RC"      -gt 0 ] && FINAL_RC=1
[ "$MOVETARGET_RC"   -gt 0 ] && FINAL_RC=1
[ "$AVATARCHANGE_RC" -gt 0 ] && FINAL_RC=1
[ "$MULTI3_RC"       -gt 0 ] && FINAL_RC=1
[ "$MULTI10_RC"      -gt 0 ] && FINAL_RC=1
[ "$MULTI100_RC"     -gt 0 ] && FINAL_RC=1
[ "$MULTI1000_RC"    -gt 0 ] && FINAL_RC=1
[ "$CUSTOM_RC"       -gt 0 ] && FINAL_RC=1
[ "$TOTAL_ERRORS" -gt 0 ] && FINAL_RC=1

echo ""
echo "========================================="
echo "最終結果"
echo "========================================="
[ "$SOLO_RC"         -gt 0 ] && echo "❌ 1人ログインテスト Vitest 失敗 (exit=$SOLO_RC)"
[ "$DUO_RC"          -gt 0 ] && echo "❌ 2人ログインテスト Vitest 失敗 (exit=$DUO_RC)"
[ "$SETBLOCK_RC"     -gt 0 ] && echo "❌ setBlock テスト Vitest 失敗 (exit=$SETBLOCK_RC)"
[ "$AILEAVE_RC"      -gt 0 ] && echo "❌ AOI_LEAVE テスト Vitest 失敗 (exit=$AILEAVE_RC)"
[ "$MOVETARGET_RC"   -gt 0 ] && echo "❌ opMoveTarget テスト Vitest 失敗 (exit=$MOVETARGET_RC)"
[ "$AVATARCHANGE_RC" -gt 0 ] && echo "❌ opAvatarChange テスト Vitest 失敗 (exit=$AVATARCHANGE_RC)"
[ "$MULTI3_RC"       -gt 0 ] && echo "❌ 3人ログインテスト Vitest 失敗 (exit=$MULTI3_RC)"
[ "$MULTI10_RC"      -gt 0 ] && echo "❌ 10人ログインテスト Vitest 失敗 (exit=$MULTI10_RC)"
[ "$MULTI100_RC"     -gt 0 ] && echo "❌ 100人ログインテスト Vitest 失敗 (exit=$MULTI100_RC)"
[ "$MULTI1000_RC"    -gt 0 ] && echo "❌ 1000人ログインテスト Vitest 失敗 (exit=$MULTI1000_RC)"
[ "$CUSTOM_RC"       -gt 0 ] && echo "❌ ${PLAYERS_FILTER:-?}人ログインテスト Vitest 失敗 (exit=$CUSTOM_RC)"
[ "$TOTAL_ERRORS" -gt 0 ] && echo "❌ 整合性エラー: ${TOTAL_ERRORS}件"
[ "$FINAL_RC" -eq 0 ]     && echo "✅ 全チェック通過"

# =========================================
# ── Markdown レポート生成 ──
RESULT_LABEL=$([ "$FINAL_RC" -eq 0 ] && echo "✅ ALL PASS" || echo "❌ FAILED")
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')

# フェーズセクション出力ヘルパー（rc=-1=スキップ）
md_phase() {
    local phase_num="$1" label="$2" rc="$3"
    local check_out="$4" server_log="$5" client_log="$6"
    echo "## Phase ${phase_num}: ${label}"
    echo ""
    if [ "$rc" -lt 0 ]; then
        echo "*(スキップ)*"
        echo ""
        return
    fi
    local result
    result=$([ "$rc" -eq 0 ] && echo "✅ PASS" || echo "❌ FAILED (exit=${rc})")
    echo "**Vitest:** ${result}"
    echo ""
    echo "### 整合性チェック"
    echo ""
    echo '```'
    [ -f "$check_out" ] && cat "$check_out" || echo "(チェック未実行)"
    echo '```'
    echo ""
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
}

{
    echo "# snd/rcv 整合性テスト レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| サーバ | 127.0.0.1:7350 |"
    echo "| 実行フェーズ | ${PHASES_TO_RUN} |"
    echo "| ログインレート | $([ "${LOGIN_RATE_PER_SEC}" -gt 0 ] && echo "${LOGIN_RATE_PER_SEC}人/秒" || echo "無制限") |"
    echo "| タイムアウト | $([ "${TEST_TIMEOUT_MS}" -gt 0 ] && echo "$((TEST_TIMEOUT_MS / 1000))秒" || echo "自動") |"
    echo "| 結果 | ${RESULT_LABEL} |"
    echo ""

    md_phase 1  "1人ログインテスト"      "$SOLO_RC"         "$SOLO_CHECK_OUT"         "$LOG_DIR/doTest-snd-rcv-solo-server.log"        "$LOG_DIR/doTest-snd-rcv-solo-client.log"
    md_phase 2  "2人ログインテスト"      "$DUO_RC"          "$DUO_CHECK_OUT"          "$LOG_DIR/doTest-snd-rcv-duo-server.log"         "$LOG_DIR/doTest-snd-rcv-duo-client.log"
    md_phase 3  "setBlock テスト"        "$SETBLOCK_RC"     "$SETBLOCK_CHECK_OUT"     "$LOG_DIR/doTest-snd-rcv-setblock-server.log"    "$LOG_DIR/doTest-snd-rcv-setblock-client.log"
    md_phase 4  "AOI_LEAVE テスト"       "$AILEAVE_RC"      "$AILEAVE_CHECK_OUT"      "$LOG_DIR/doTest-snd-rcv-aileave-server.log"     "$LOG_DIR/doTest-snd-rcv-aileave-client.log"
    md_phase 5  "opMoveTarget テスト"    "$MOVETARGET_RC"   "$MOVETARGET_CHECK_OUT"   "$LOG_DIR/doTest-snd-rcv-movetarget-server.log"  "$LOG_DIR/doTest-snd-rcv-movetarget-client.log"
    md_phase 6  "opAvatarChange テスト"  "$AVATARCHANGE_RC" "$AVATARCHANGE_CHECK_OUT" "$LOG_DIR/doTest-snd-rcv-avatarchange-server.log" "$LOG_DIR/doTest-snd-rcv-avatarchange-client.log"
    md_phase 7  "3人ログインテスト"      "$MULTI3_RC"       "$MULTI3_CHECK_OUT"       "$LOG_DIR/doTest-snd-rcv-multi3-server.log"      "$LOG_DIR/doTest-snd-rcv-multi3-client.log"
    md_phase 8  "10人ログインテスト"     "$MULTI10_RC"      "$MULTI10_CHECK_OUT"      "$LOG_DIR/doTest-snd-rcv-multi10-server.log"     "$LOG_DIR/doTest-snd-rcv-multi10-client.log"
    md_phase 9  "100人ログインテスト"    "$MULTI100_RC"     "$MULTI100_CHECK_OUT"     "$LOG_DIR/doTest-snd-rcv-multi100-server.log"    "$LOG_DIR/doTest-snd-rcv-multi100-client.log"
    md_phase 10 "1000人ログインテスト"   "$MULTI1000_RC"    "$MULTI1000_CHECK_OUT"    "$LOG_DIR/doTest-snd-rcv-multi1000-server.log"   "$LOG_DIR/doTest-snd-rcv-multi1000-client.log"
    if [ "$CUSTOM_RC" -ge 0 ]; then
        _cn="${PLAYERS_FILTER:-?}"
        md_phase "N" "${_cn}人ログインテスト（カスタム）" "$CUSTOM_RC" "$CUSTOM_CHECK_OUT" \
            "$LOG_DIR/doTest-snd-rcv-custom${_cn}-server.log" \
            "$LOG_DIR/doTest-snd-rcv-custom${_cn}-client.log"
    fi
} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$LOG_DIR/04-snd-rcv.md"

echo ""
echo "---"
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: $LOG_DIR/04-snd-rcv.md"

exit $FINAL_RC
