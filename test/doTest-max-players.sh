#!/bin/bash
# 最大同時接続人数探索スクリプト
# 指定した開始人数から増加幅ずつ増やして、失敗するまで実行する
#
# 使い方: ./test/doTest-max-players.sh [-s S] [--step D] [-r R] [--trials N] [-h]
# 前提: cd nakama && docker compose up -d

# ── 引数パース（set -euo pipefail 前） ──
LOGIN_RATE=40       # 秒あたりのログイン数（0=無制限, サーバ側MAX_LOGIN_RATE_PER_SEC未満にすること）
TRIALS=1            # 試行回数（1=多数決なし）
START=100           # 開始人数
STEP=10             # 増加幅
VERBOSE=0           # 1=全ログ出力（間引きなし）

while [[ $# -gt 0 ]]; do
    case "$1" in
        -r|--rate)
            LOGIN_RATE="${2:-40}"
            shift 2 ;;
        --trials)
            TRIALS="${2:-1}"
            shift 2 ;;
        -s|--start)
            START="${2:-100}"
            shift 2 ;;
        --step)
            STEP="${2:-10}"
            shift 2 ;;
        -v|--verbose)
            VERBOSE=1
            shift ;;
        -h|--help)
            echo "使い方: ./test/doTest-max-players.sh [-r R] [--trials N] [-s S] [--step D] [-v] [-h]"
            echo ""
            echo "各人数で以下の2テストを実行し、両方PASSで合格とします:"
            echo "  1. 送受信整合性テスト (doTest-snd-rcv.sh)"
            echo "  2. プレイヤーリスト通知テスト (doTest-player-list.sh)"
            echo ""
            echo "オプション:"
            echo "  -r R, --rate R     秒あたりのログイン数 (デフォルト: 40)"
            echo "  --trials N         試行回数、過半数PASSで合格 (デフォルト: 1=多数決なし)"
            echo "                     例: --trials 3 → 3回中2回以上PASSで合格"
            echo "  -s S, --start S    開始人数 (デフォルト: 100)"
            echo "  --step D           増加幅 (デフォルト: 10)"
            echo "  -v, --verbose      全ログ出力（間引きなし）"
            echo "  -h                 このヘルプを表示"
            exit 0 ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

set -uo pipefail

# PASS_NEEDED = ceil(TRIALS / 2)
PASS_NEEDED=$(( (TRIALS + 1) / 2 ))

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
# .env から NAKAMA_SERVER_KEY 等を自動読み込み
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f "$ROOT_DIR/nakama/.env" ]; then
    set -a; source "$ROOT_DIR/nakama/.env"; set +a
fi
LOG_DIR="$SCRIPT_DIR/log"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LOG_DIR/max-players-${TIMESTAMP}.md"
SYMLINK="$LOG_DIR/05-max-players.md"

# ── ANSI除去 ──
strip_ansi() { sed 's/\x1b\[[0-9;]*[mGKHF]//g'; }

# ── 出力制御 ──
GREEN=$'\e[32m'
RESET=$'\e[0m'
CHILD_PID=0
_TMP_OUT="/tmp/doTest-max-out-$$"
_TMP_CHUNK="/tmp/doTest-max-chunk-$$"

cleanup_and_exit() {
    echo ""
    echo "⚠️ Ctrl+C: テスト中断"
    if [ $CHILD_PID -ne 0 ]; then
        kill -TERM -- -$CHILD_PID 2>/dev/null
        sleep 0.5
        kill -KILL -- -$CHILD_PID 2>/dev/null
    fi
    rm -f "$_TMP_OUT" "$_TMP_CHUNK"
    exit 130
}
trap cleanup_and_exit INT

# 子プロセスを実行し、出力を間引いて表示（毎秒緑ステータス付き）
# 引数: label est_sec command...
run_with_throttle() {
    local label="$1"
    local est_sec="$2"
    shift 2
    > "$_TMP_OUT"

    setsid "$@" >> "$_TMP_OUT" 2>&1 &
    CHILD_PID=$!

    local last_bytes=0 elapsed=0
    while kill -0 "$CHILD_PID" 2>/dev/null; do
        sleep 1
        elapsed=$((elapsed + 1))

        local cur_bytes
        cur_bytes=$(wc -c < "$_TMP_OUT")

        if [ "$cur_bytes" -gt "$last_bytes" ]; then
            tail -c +"$((last_bytes + 1))" "$_TMP_OUT" > "$_TMP_CHUNK"
            # 重要行のみ表示
            grep -E '✅|❌|⚠|PASS|FAIL|[Ee]rror|Tests |成功|失敗|レート|timeout|タイムアウト|passed|failed|Phase|━━' "$_TMP_CHUNK" | head -n 10 || true
            last_bytes=$cur_bytes
        fi

        # 毎秒緑でステータス表示（予測残り時間付き）
        local remaining=$((est_sec - elapsed))
        if [ $remaining -gt 0 ]; then
            echo "${GREEN}${label} ${elapsed}s (終了まであと${remaining}秒見込み)${RESET}"
        else
            local over=$((elapsed - est_sec))
            echo "${GREEN}${label} ${elapsed}s (予測超過+${over}秒)${RESET}"
        fi
    done

    # 残りの出力から重要行を表示
    local final_bytes
    final_bytes=$(wc -c < "$_TMP_OUT")
    if [ "$final_bytes" -gt "$last_bytes" ]; then
        tail -c +"$((last_bytes + 1))" "$_TMP_OUT" > "$_TMP_CHUNK"
        grep -E '✅|❌|⚠|PASS|FAIL|[Ee]rror|Tests |成功|失敗|レート|timeout|タイムアウト|passed|failed|Phase|━━' "$_TMP_CHUNK" | head -n 10 || true
    fi

    wait $CHILD_PID 2>/dev/null
    local rc=$?
    CHILD_PID=0
    return $rc
}

SCRIPT_VERSION=$(date -r "$0" +%Y-%m-%d_%H:%M:%S)
echo "========================================="
echo "server_key: ${NAKAMA_SERVER_KEY:-defaultkey}"
echo "最大同時接続人数探索  (script: ${SCRIPT_VERSION})"
echo "  開始: ${START}人  増加幅: ${STEP}人"
echo "  試行回数: ${TRIALS}回中${PASS_NEEDED}回以上PASSで合格"
echo "  ログインレート: $([ "${LOGIN_RATE}" -gt 0 ] && echo "${LOGIN_RATE}人/秒" || echo "無制限")"
echo "  レポート: $LOGFILE"
echo "========================================="
echo ""

# 結果を配列で保持: "N|verdict_rc|best_sub_report|pass_count|trials"
RESULTS=()
last_ok=0
n=$START

while true; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ">>> ${n}人テスト（${TRIALS}回試行）"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    pass_count=0
    fail_count=0
    best_sub_report=""
    best_pl_report=""

    for trial in $(seq 1 $TRIALS); do
        echo ""
        echo "  --- 試行 ${trial}/${TRIALS} ---"

        # ── 送受信整合性テスト ──
        prev_report=$(ls -t "$LOG_DIR"/snd-rcv-*.md 2>/dev/null | head -1 || true)

        set +e
        if [ "$VERBOSE" -eq 1 ]; then
            "$SCRIPT_DIR/doTest-snd-rcv.sh" -n "$n" -r "$LOGIN_RATE"
        else
            # 予測時間: ログイン(n/rate) + 固定オーバーヘッド(40秒) + 人数比例オーバーヘッド(n/50秒)
            # AOI処理・logout・整合性チェック等が人数に比例して増加
            est_sec=$(( n / (LOGIN_RATE > 0 ? LOGIN_RATE : 40) + 40 + n / 50 ))
            run_with_throttle "${n}人 snd-rcv 試行${trial}/${TRIALS}" "$est_sec" "$SCRIPT_DIR/doTest-snd-rcv.sh" -n "$n" -r "$LOGIN_RATE"
        fi
        snd_rcv_rc=$?
        set -e

        new_report=$(ls -t "$LOG_DIR"/snd-rcv-*.md 2>/dev/null | head -1 || true)
        if [ "$new_report" != "$prev_report" ] && [ -f "$new_report" ]; then
            cur_report="$new_report"
        else
            cur_report=""
        fi
        if [ -z "$best_sub_report" ] && [ -n "$cur_report" ]; then
            best_sub_report="$cur_report"
        fi

        # ── プレイヤーリスト通知テスト ──
        prev_pl_report=$(ls -t "$LOG_DIR"/player-list-*.md 2>/dev/null | head -1 || true)

        set +e
        if [ "$VERBOSE" -eq 1 ]; then
            "$SCRIPT_DIR/doTest-player-list.sh" -n "$n" -r "$LOGIN_RATE"
        else
            est_pl_sec=$(( n / (LOGIN_RATE > 0 ? LOGIN_RATE : 40) + 30 + n / 50 ))
            run_with_throttle "${n}人 player-list 試行${trial}/${TRIALS}" "$est_pl_sec" "$SCRIPT_DIR/doTest-player-list.sh" -n "$n" -r "$LOGIN_RATE"
        fi
        pl_rc=$?
        set -e

        new_pl_report=$(ls -t "$LOG_DIR"/player-list-*.md 2>/dev/null | head -1 || true)
        if [ "$new_pl_report" != "$prev_pl_report" ] && [ -f "$new_pl_report" ]; then
            cur_pl_report="$new_pl_report"
        else
            cur_pl_report=""
        fi
        if [ -z "$best_pl_report" ] && [ -n "$cur_pl_report" ]; then
            best_pl_report="$cur_pl_report"
        fi

        # ── 試行結果判定（両方PASSで合格） ──
        if [ "$snd_rcv_rc" -eq 0 ] && [ "$pl_rc" -eq 0 ]; then
            pass_count=$((pass_count + 1))
            echo "  ✅ 試行${trial}: PASS (snd-rcv✅ player-list✅)  (累計 ${pass_count}PASS / ${trial}試行)"
        else
            fail_count=$((fail_count + 1))
            local_detail=""
            if [ "$snd_rcv_rc" -ne 0 ]; then local_detail="snd-rcv❌"; fi
            if [ "$pl_rc" -ne 0 ]; then local_detail="${local_detail:+$local_detail }player-list❌"; fi
            echo "  ❌ 試行${trial}: FAILED (${local_detail})  (累計 ${fail_count}FAIL / ${trial}試行)"
        fi

        # 早期終了判定
        remaining=$((TRIALS - trial))
        if [ "$pass_count" -ge "$PASS_NEEDED" ]; then
            echo "  → 合格確定（残り試行スキップ）"
            break
        fi
        if [ "$fail_count" -gt $((TRIALS - PASS_NEEDED)) ]; then
            echo "  → 不合格確定（残り試行スキップ）"
            break
        fi

        # 試行間インターバル（サーバ回復待ち）
        if [ "$trial" -lt "$TRIALS" ]; then
            echo "  (次の試行まで3秒待機...)"
            sleep 3
        fi
    done

    RESULTS+=("${n}|${pass_count}|${best_sub_report}|${TRIALS}|${best_pl_report}")

    if [ "$pass_count" -ge "$PASS_NEEDED" ]; then
        last_ok=$n
        echo ""
        echo "✅ ${n}人: PASS (${pass_count}/${TRIALS})"
        echo ""
        n=$((n + STEP))
    else
        echo ""
        echo "❌ ${n}人: FAILED (${pass_count}/${TRIALS})"
        echo ""
        break
    fi
done

# ── Markdown レポート生成 ──
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')
if [ "$last_ok" -gt 0 ]; then
    FINAL_LABEL="✅ 最大 ${last_ok}人"
else
    FINAL_LABEL="❌ ${START}人から失敗"
fi

{
    echo "# 最大同時接続人数探索レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| サーバ | 127.0.0.1:7350 |"
    echo "| 開始人数 | ${START}人 |"
    echo "| 増加幅 | ${STEP}人 |"
    echo "| 試行方式 | ${TRIALS}回中${PASS_NEEDED}回以上PASSで合格 |"
    echo "| ログインレート | $([ "${LOGIN_RATE}" -gt 0 ] && echo "${LOGIN_RATE}人/秒" || echo "無制限") |"
    echo "| **最大成功人数** | **${FINAL_LABEL}** |"
    echo ""

    echo "## 結果サマリー"
    echo ""
    echo "| 人数 | 結果 | PASS率 | snd-rcvレポート | player-listレポート |"
    echo "|------|------|--------|----------------|-------------------|"
    for entry in "${RESULTS[@]}"; do
        IFS='|' read -r num pass_cnt sub_rep trials pl_rep <<< "$entry"
        if [ "$pass_cnt" -ge "$PASS_NEEDED" ]; then
            mark="✅ PASS"
        else
            mark="❌ FAILED"
        fi
        sr_link=$([ -n "$sub_rep" ] && echo "[詳細]($(basename "$sub_rep"))" || echo "—")
        pl_link=$([ -n "$pl_rep" ] && echo "[詳細]($(basename "$pl_rep"))" || echo "—")
        echo "| ${num}人 | ${mark} | ${pass_cnt}/${trials} | ${sr_link} | ${pl_link} |"
    done
    echo ""

    # 各テストの詳細セクション
    idx=1
    for entry in "${RESULTS[@]}"; do
        IFS='|' read -r num pass_cnt sub_rep trials pl_rep <<< "$entry"
        echo "---"
        echo ""
        echo "## テスト ${idx}: ${num}人ログイン"
        echo ""
        if [ "$pass_cnt" -ge "$PASS_NEEDED" ]; then
            echo "**結果:** ✅ PASS (${pass_cnt}/${trials})"
        else
            echo "**結果:** ❌ FAILED (${pass_cnt}/${trials})"
        fi
        echo ""

        echo "### 送受信整合性テスト (snd-rcv)"
        echo ""
        if [ -n "$sub_rep" ] && [ -f "$sub_rep" ]; then
            awk '
                /^### サーバログ/ { in_server=1; next }
                /^### / && in_server { in_server=0 }
                /^## Phase / { in_server=0 }
                !in_server { print }
            ' "$sub_rep"
        else
            echo "*(サブレポートなし)*"
        fi
        echo ""

        echo "### プレイヤーリスト通知テスト (player-list)"
        echo ""
        if [ -n "$pl_rep" ] && [ -f "$pl_rep" ]; then
            awk '
                /^### サーバログ/ { in_server=1; next }
                /^### / && in_server { in_server=0 }
                /^## P[0-9]/ { in_server=0 }
                !in_server { print }
            ' "$pl_rep"
        else
            echo "*(サブレポートなし)*"
        fi
        echo ""
        idx=$((idx + 1))
    done

} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$SYMLINK"
rm -f "$_TMP_OUT" "$_TMP_CHUNK"

echo "========================================="
echo "最終結果: ${FINAL_LABEL}"
echo "========================================="
echo ""
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: ${SYMLINK}"
