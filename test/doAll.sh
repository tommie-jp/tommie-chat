#!/bin/bash
# 全テスト一括実行（人数段階的増加対応）
# Usage: ./test/doAll.sh [-n N] [-s S] [--step D] [--counts C] [-v] [-h]
VERBOSE=0
PLAYERS_OPT="-n 100"  # デフォルト100人（-n N で変更可能）
START_N=""         # -s S: 段階モード開始人数
STEP_N=""          # --step D: 増加幅
COUNTS_STR=""      # --counts: カンマ区切り人数リスト
OPT_HOST=""
OPT_PORT=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -v|--verbose)
            VERBOSE=1
            shift ;;
        -n|--players)
            PLAYERS_OPT="-n ${2:-}"
            shift 2 ;;
        -s|--start)
            START_N="${2:-100}"
            shift 2 ;;
        --step)
            STEP_N="${2:-}"
            shift 2 ;;
        --counts)
            COUNTS_STR="${2:-}"
            shift 2 ;;
        --host)
            OPT_HOST="${2:-}"; shift 2 ;;
        --port)
            OPT_PORT="${2:-}"; shift 2 ;;
        -h|--help)
            cat <<'EOF'
Usage: ./test/doAll.sh [-n N] [-s S] [--step D] [--counts C] [-v] [-h]

全テストスクリプトを順番に実行します。
人数を段階的に増やして繰り返し実行できます。

モード:
  (引数なし)           100人で1回実行
  -n N, --players N    N人で1回実行
  --counts 100,500,2000  指定した人数リストで順に実行（失敗で停止）
  -s S [--step D]      S人から開始しD人ずつ増加（失敗で停止）
                        --step省略時: 100,500,1000,1500,2000,3000...

テスト項目（実行時間の短い順）:
  1. doTest-security.sh          セキュリティテスト
  2. doTest-reconnect.sh         再接続テスト
  3. doTest-concurrent-login.sh  同時接続テスト
  4. doTest-snd-rcv.sh           送受信整合性テスト
  5. doTest-player-list.sh       プレイヤーリスト通知テスト
  6. doTest-sustain.sh           持続接続テスト
  7. doTest-ccu-db.sh            同接履歴 DB永続化テスト

例:
  ./test/doAll.sh --counts 100,500,1000,2000
  ./test/doAll.sh -s 100 --step 100
  ./test/doAll.sh -n 2000

ログ出力先:
  test/log/doAll-<テスト名>-YYYYMMDD-HHMMSS.log  各テストの全出力
  test/log/all-YYYYMMDD-HHMMSS.md                Markdownレポート
  test/log/00-all.md                             最新レポートへのシンボリックリンク
EOF
            exit 0 ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# .env から NAKAMA_SERVER_KEY 等を自動読み込み（未設定の場合のみ）
ENV_FILE="$ROOT_DIR/nakama/.env"
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f "$ENV_FILE" ]; then
    set -a; source "$ENV_FILE"; set +a
fi
# .env が無い場合、docker-compose.yml から server_key を自動取得
if [ -z "${NAKAMA_SERVER_KEY:-}" ]; then
    _KEY=$(grep -oP '(?<=--socket\.server_key\s)\S+' "$ROOT_DIR/nakama/docker-compose.yml" 2>/dev/null | head -1)
    [ -n "$_KEY" ] && export NAKAMA_SERVER_KEY="$_KEY"
fi
# --host/--port 優先 > 環境変数 > デフォルト
export NAKAMA_HOST="${OPT_HOST:-${NAKAMA_HOST:-127.0.0.1}}"
export NAKAMA_PORT="${OPT_PORT:-${NAKAMA_PORT:-7350}}"
HOST_PORT_OPT=""
if [ "$NAKAMA_HOST" != "127.0.0.1" ] && [ "$NAKAMA_HOST" != "localhost" ]; then
    HOST_PORT_OPT="--host $NAKAMA_HOST"
fi
if [ "$NAKAMA_PORT" != "7350" ]; then
    HOST_PORT_OPT="$HOST_PORT_OPT --port $NAKAMA_PORT"
fi
# ── 疎通テスト（server_key 認証確認） ──
bash "$SCRIPT_DIR/doTest-ping.sh" $HOST_PORT_OPT || exit 1

LOG_DIR="$SCRIPT_DIR/log"
mkdir -p "$LOG_DIR"
CHILD_PID=0
OUTPUT_TIMEOUT=60
GREEN=$'\e[32m'
RESET=$'\e[0m'
CURRENT_TEST=""
CURRENT_STATUS=""
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TMPLOG="/tmp/doAll-out-$$"
TMPCHUNK="/tmp/doAll-chunk-$$"

# ── 人数リスト構築 ──
# 段階モードのデフォルトシーケンス
DEFAULT_COUNTS=(100 500 1000 1500 2000 3000 4000 5000)

build_count_list() {
    if [ -n "$COUNTS_STR" ]; then
        # --counts: カンマ区切り
        IFS=',' read -ra PLAYER_COUNTS <<< "$COUNTS_STR"
    elif [ -n "$START_N" ]; then
        if [ -n "$STEP_N" ]; then
            # -s S --step D: S, S+D, S+2D, ...（上限なし、失敗で停止）
            PLAYER_COUNTS=()
            local n="$START_N"
            # 初期リストとして十分な数を生成（実際は失敗で停止）
            for _ in $(seq 1 50); do
                PLAYER_COUNTS+=("$n")
                n=$((n + STEP_N))
            done
        else
            # -s S のみ: デフォルトシーケンスから S 以上を使用
            PLAYER_COUNTS=()
            for c in "${DEFAULT_COUNTS[@]}"; do
                [ "$c" -ge "$START_N" ] && PLAYER_COUNTS+=("$c")
            done
            # 空なら START_N のみ
            [ ${#PLAYER_COUNTS[@]} -eq 0 ] && PLAYER_COUNTS=("$START_N")
        fi
    else
        # 段階モードでない → 空リスト（単一実行）
        PLAYER_COUNTS=()
    fi
}
build_count_list

# ── Ctrl+C ハンドラ ─────────────────────────────────────

cleanup_and_exit() {
    echo ""
    echo "⚠️ Ctrl+C: テスト中断"
    if [ $CHILD_PID -ne 0 ]; then
        kill -TERM -- -$CHILD_PID 2>/dev/null
        sleep 0.5
        kill -KILL -- -$CHILD_PID 2>/dev/null
    fi
    rm -f "$TMPLOG" "$TMPCHUNK"
    exit 130
}
trap cleanup_and_exit INT

# ── ファイルベースのパターン抽出・表示 ──────────────────

extract_patterns() {
    local f="$1"
    local m
    m=$(grep -oP '\d+(?=人が全員ログイン成功)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人ログイン成功"
    m=$(grep -oP 'createPlayers: \K\d+/\d+(?=人成功)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続成功"
    m=$(grep -oP '接続中: \K\d+/\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続中"
    m=$(grep -oP 'ログイン \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人ログイン成功"
    m=$(grep -oP '\d+(?=人接続)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続"
    m=$(grep -oP '同時接続 \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    m=$(grep -oP '\[Phase \d+\] \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    m=$(grep -oP '\[P\d+-[^\]]+\] \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    m=$(grep -oP '> \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    m=$(grep -oP '接続維持テスト \(\K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人 接続維持テスト中"
    m=$(grep -oP '維持 \K[^:]+' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="維持 $m"
    grep -q 'DB永続化' "$f" && CURRENT_STATUS="DB永続化テスト中"
    m=$(grep -oP '\d+(?=人 接続完了)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="DB永続化 ${m}人"
    return 0
}

display_important() {
    local f="$1"
    grep -E '✅|❌|⚠|PASS|FAIL|[Ee]rror|Tests |成功|失敗|レート|timeout|タイムアウト|passed|failed' "$f" | head -n 20 || true
}

print_tick() {
    local elapsed="$1"
    local info="[${TEST_IDX}/${TOTAL_TESTS}] ${CURRENT_TEST} ${elapsed}s"
    [ -n "$CURRENT_ROUND_LABEL" ] && info="${CURRENT_ROUND_LABEL} $info"
    [ -n "$CURRENT_STATUS" ] && info="$info $CURRENT_STATUS"
    [ -n "$last_pass_count" ] && info="$info $last_pass_count"
    echo "${GREEN}${info}${RESET}"
}

# 秒数を人間が読める形式に変換
format_duration() {
    local s="$1"
    if [ "$s" -ge 3600 ]; then
        echo "$((s / 3600))h$((s % 3600 / 60))m$((s % 60))s"
    elif [ "$s" -ge 60 ]; then
        echo "$((s / 60))m$((s % 60))s"
    else
        echo "${s}s"
    fi
}

# ── テスト実行 ──────────────────────────────────────────

# 全ラウンドにわたるメタデータ
declare -a ALL_TEST_NAMES ALL_TEST_RCS ALL_TEST_DURATIONS ALL_TEST_LOGS ALL_TEST_ROUNDS
TOTAL_FAILED=0
TOTAL_PASSED=0
TOTAL_RUN=0
TEST_IDX=0
TOTAL_TESTS=7
CURRENT_ROUND_LABEL=""

run_test() {
    local name="$1"
    shift
    TEST_IDX=$((TEST_IDX + 1))
    TOTAL_RUN=$((TOTAL_RUN + 1))
    CURRENT_TEST="$name"
    CURRENT_STATUS="実行中"
    echo ""
    echo "========================================"
    echo "${CURRENT_ROUND_LABEL} [${TEST_IDX}/${TOTAL_TESTS}] $name"
    echo "========================================"
    echo ""

    local base="${name%.sh}"
    local test_log="$LOG_DIR/doAll-${base}-${TIMESTAMP}.log"

    local rc=0
    local timed_out=0
    local start_time=$SECONDS
    last_pass_count=""

    if [ "$VERBOSE" -eq 1 ]; then
        bash "$SCRIPT_DIR/$name" "$@" 2>&1 | tee >(sed 's/\x1b\[[0-9;]*[mGKHF]//g' > "$test_log")
        rc=${PIPESTATUS[0]}
    else
        > "$TMPLOG"
        setsid stdbuf -oL bash "$SCRIPT_DIR/$name" "$@" >> "$TMPLOG" 2>&1 &
        CHILD_PID=$!

        local silent_sec=0
        local last_bytes=0

        while kill -0 "$CHILD_PID" 2>/dev/null; do
            sleep 1
            local cur_bytes
            cur_bytes=$(wc -c < "$TMPLOG")

            if [ "$cur_bytes" -gt "$last_bytes" ]; then
                tail -c +"$((last_bytes + 1))" "$TMPLOG" > "$TMPCHUNK"
                extract_patterns "$TMPCHUNK"
                display_important "$TMPCHUNK"
                last_bytes=$cur_bytes
                silent_sec=0
            else
                silent_sec=$((silent_sec + 1))
                if [ "$silent_sec" -ge "$OUTPUT_TIMEOUT" ]; then
                    timed_out=1
                    echo ""
                    echo "⚠️ ${OUTPUT_TIMEOUT}秒間ログ出力なし — タイムアウトで中断: $name"
                    [ -n "$last_pass_count" ] && echo "  最後に成功: $last_pass_count"
                    kill -TERM -- -$CHILD_PID 2>/dev/null
                    sleep 1
                    kill -KILL -- -$CHILD_PID 2>/dev/null
                    break
                fi
            fi

            print_tick $((SECONDS - start_time))
        done

        local final_bytes
        final_bytes=$(wc -c < "$TMPLOG")
        if [ "$final_bytes" -gt "$last_bytes" ]; then
            tail -c +"$((last_bytes + 1))" "$TMPLOG" > "$TMPCHUNK"
            extract_patterns "$TMPCHUNK"
            display_important "$TMPCHUNK"
        fi

        wait $CHILD_PID 2>/dev/null
        rc=$?
        CHILD_PID=0

        sed 's/\x1b\[[0-9;]*[mGKHF]//g' "$TMPLOG" > "$test_log"
    fi

    local elapsed=$((SECONDS - start_time))

    if [ $timed_out -eq 1 ]; then
        rc=124
    fi

    ALL_TEST_NAMES+=("$name")
    ALL_TEST_RCS+=("$rc")
    ALL_TEST_DURATIONS+=("$elapsed")
    ALL_TEST_LOGS+=("$test_log")
    ALL_TEST_ROUNDS+=("${CURRENT_ROUND_LABEL}")

    if [ $rc -eq 0 ]; then
        TOTAL_PASSED=$((TOTAL_PASSED + 1))
    else
        TOTAL_FAILED=$((TOTAL_FAILED + 1))
    fi

    echo "  ログ: $test_log"
    return $rc
}

# ── 1ラウンドの全テスト実行 ──
# 引数: players_opt（例: "-n 2000" or ""）
# 戻り値: 0=全PASS, 1=失敗あり
run_one_round() {
    local players_opt="$1"
    local round_failed=0
    TEST_IDX=0

    # 1. セキュリティテスト（人数不要・短時間）
    set +e
    run_test "doTest-security.sh" $HOST_PORT_OPT
    [ $? -ne 0 ] && round_failed=$((round_failed + 1))
    set -e

    echo "  テスト間クールダウン (3秒)..."
    sleep 3

    # 2. 再接続テスト（人数不要・短時間）
    set +e
    run_test "doTest-reconnect.sh"
    [ $? -ne 0 ] && round_failed=$((round_failed + 1))
    set -e

    echo "  テスト間クールダウン (3秒)..."
    sleep 3

    # 3. 同時接続テスト
    set +e
    run_test "doTest-concurrent-login.sh" $players_opt $HOST_PORT_OPT
    [ $? -ne 0 ] && round_failed=$((round_failed + 1))
    set -e

    echo "  テスト間クールダウン (3秒)..."
    sleep 3

    # 4. 送受信整合性テスト
    set +e
    run_test "doTest-snd-rcv.sh" $players_opt $HOST_PORT_OPT
    [ $? -ne 0 ] && round_failed=$((round_failed + 1))
    set -e

    echo "  テスト間クールダウン (3秒)..."
    sleep 3

    # 5. プレイヤーリスト通知テスト
    set +e
    run_test "doTest-player-list.sh" $players_opt $HOST_PORT_OPT
    [ $? -ne 0 ] && round_failed=$((round_failed + 1))
    set -e

    echo "  テスト間クールダウン (3秒)..."
    sleep 3

    # 6. 持続接続テスト
    set +e
    run_test "doTest-sustain.sh" $players_opt $HOST_PORT_OPT
    [ $? -ne 0 ] && round_failed=$((round_failed + 1))
    set -e

    echo "  テスト間クールダウン (3秒)..."
    sleep 3

    # 7. 同接履歴 DB永続化テスト
    set +e
    run_test "doTest-ccu-db.sh" $HOST_PORT_OPT
    [ $? -ne 0 ] && round_failed=$((round_failed + 1))
    set -e

    return $round_failed
}

# ── メイン ──────────────────────────────────────────────

# ラウンド結果: "N人|pass_count|fail_count|elapsed"
declare -a ROUND_RESULTS

if [ ${#PLAYER_COUNTS[@]} -gt 0 ]; then
    # ── 段階モード ──
    echo "========================================="
    echo "全テスト一括実行（段階モード）"
    echo "  server_key: ${NAKAMA_SERVER_KEY:-tommie-chat}"
    echo "  endpoint:   ${NAKAMA_HOST}:${NAKAMA_PORT:-7350}"
    echo "  人数: ${PLAYER_COUNTS[*]}"
    echo "  テスト: security / reconnect / concurrent / snd-rcv / player-list / sustain / ccu-db"
    echo "========================================="

    last_ok=0
    for count_n in "${PLAYER_COUNTS[@]}"; do
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ">>> ${count_n}人 全テスト実行"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        CURRENT_ROUND_LABEL="[${count_n}人]"
        round_start=$SECONDS

        set +e
        run_one_round "-n $count_n"
        round_failed=$?
        set -e

        round_elapsed=$((SECONDS - round_start))

        if [ $round_failed -eq 0 ]; then
            last_ok=$count_n
            ROUND_RESULTS+=("${count_n}|${TOTAL_TESTS}|0|${round_elapsed}")
            echo ""
            echo "✅ ${count_n}人: 全テスト PASS"
        else
            round_passed=$((TOTAL_TESTS - round_failed))
            ROUND_RESULTS+=("${count_n}|${round_passed}|${round_failed}|${round_elapsed}")
            echo ""
            echo "❌ ${count_n}人: ${round_failed}件失敗 — 停止"
            break
        fi
    done

    echo ""
    echo "========================================="
    if [ "$last_ok" -gt 0 ]; then
        echo "最終結果: ✅ 最大 ${last_ok}人 全テスト PASS"
    else
        echo "最終結果: ❌ 最初の人数から失敗"
    fi
    echo "========================================="
else
    # ── 単一モード（従来互換） ──
    echo "server_key: ${NAKAMA_SERVER_KEY:-tommie-chat}"
    echo "endpoint:   ${NAKAMA_HOST}:${NAKAMA_PORT:-7350}"
    CURRENT_ROUND_LABEL=""
    [ -n "$PLAYERS_OPT" ] && CURRENT_ROUND_LABEL="[$(echo "$PLAYERS_OPT" | grep -oP '\d+')人]"

    set +e
    run_one_round "$PLAYERS_OPT"
    round_failed=$?
    set -e

    echo ""
    echo "========================================"
    echo "全テスト結果: ${TOTAL_PASSED}/${TOTAL_RUN} passed"
    echo "========================================"
fi

# 後始末
rm -f "$TMPLOG" "$TMPCHUNK"

# ── Markdown レポート生成 ──────────────────────────────

LOGFILE="$LOG_DIR/all-${TIMESTAMP}.md"
TOTAL_ELAPSED=$SECONDS
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')

if [ ${#PLAYER_COUNTS[@]} -gt 0 ]; then
    RESULT_LABEL=$([ "$last_ok" -gt 0 ] && echo "✅ 最大 ${last_ok}人" || echo "❌ 最初から失敗")
    MODE_LABEL="段階モード: $(IFS=,; echo "${PLAYER_COUNTS[*]}")"
else
    RESULT_LABEL=$([ "$TOTAL_FAILED" -eq 0 ] && echo "✅ ALL PASS" || echo "❌ ${TOTAL_FAILED} FAILED")
    MODE_LABEL="${PLAYERS_OPT}"
fi

{
    echo "# 全テスト一括実行 レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| サーバ | ${NAKAMA_HOST}:${NAKAMA_PORT:-7350} |"
    echo "| テスト人数 | ${MODE_LABEL} |"
    echo "| 結果 | ${RESULT_LABEL} (${TOTAL_PASSED}/${TOTAL_RUN}) |"
    echo "| 実行時間 | $(format_duration $TOTAL_ELAPSED) |"
    echo ""

    # ── 段階モード: ラウンドサマリー ──
    if [ ${#ROUND_RESULTS[@]} -gt 0 ]; then
        echo "## ラウンドサマリー"
        echo ""
        echo "| 人数 | 結果 | PASS/FAIL | 時間 |"
        echo "|------|------|-----------|-----:|"
        for entry in "${ROUND_RESULTS[@]}"; do
            IFS='|' read -r rn rpass rfail relapsed <<< "$entry"
            if [ "$rfail" -eq 0 ]; then
                rmark="✅ ALL PASS"
            else
                rmark="❌ ${rfail} FAILED"
            fi
            echo "| ${rn}人 | ${rmark} | ${rpass}pass/${rfail}fail | $(format_duration "$relapsed") |"
        done
        echo ""
    fi

    echo "## テスト結果"
    echo ""
    echo "| # | ラウンド | テスト | 結果 | 時間 |"
    echo "|--:|----------|--------|------|-----:|"

    for i in "${!ALL_TEST_NAMES[@]}"; do
        t_name="${ALL_TEST_NAMES[$i]}"
        t_rc="${ALL_TEST_RCS[$i]}"
        t_dur="${ALL_TEST_DURATIONS[$i]}"
        t_round="${ALL_TEST_ROUNDS[$i]}"
        if [ "$t_rc" -eq 0 ]; then
            icon="✅ PASS"
        elif [ "$t_rc" -eq 124 ]; then
            icon="❌ TIMEOUT"
        else
            icon="❌ FAIL (exit=${t_rc})"
        fi
        echo "| $((i + 1)) | ${t_round:-—} | ${t_name} | ${icon} | $(format_duration "$t_dur") |"
    done

    echo ""
    echo "## テスト別ログ"
    echo ""

    for i in "${!ALL_TEST_NAMES[@]}"; do
        t_name="${ALL_TEST_NAMES[$i]}"
        t_rc="${ALL_TEST_RCS[$i]}"
        t_log="${ALL_TEST_LOGS[$i]}"
        t_round="${ALL_TEST_ROUNDS[$i]}"
        t_icon=$([ "$t_rc" -eq 0 ] && echo "✅" || echo "❌")

        echo "### ${t_icon} [$((i + 1))] ${t_round} ${t_name}"
        echo ""

        sub_report=""
        if [ -f "$t_log" ]; then
            sub_report=$(grep -oP 'レポート: \K.+\.md' "$t_log" | tail -1)
        fi

        echo "| ログ | リンク |"
        echo "|------|--------|"
        echo "| 全出力 | [$(basename "$t_log")](${t_log}) |"
        [ -n "$sub_report" ] && echo "| 詳細レポート | [$(basename "$sub_report")](${sub_report}) |"
        echo ""

        if [ -f "$t_log" ]; then
            if [ "$t_rc" -ne 0 ]; then
                echo "#### エラー詳細"
                echo ""
                echo '```'
                grep -E 'AssertionError|Error:|FAIL|❌|expected|received|assert|timeout|タイムアウト|at .*\.ts:' "$t_log" \
                  | head -n 30 || true
                echo '```'
                echo ""
                echo "#### 結果サマリー"
                echo ""
            fi
            echo '```'
            grep -E '✅|❌|⚠|PASS|FAIL|Tests |成功|失敗|エラー|timeout|タイムアウト|passed|failed|レポート|結果|人が全員|createPlayers|維持 |DB永続化|整合性' "$t_log" \
              | head -n 50 || echo "(重要行なし)"
            echo '```'
        else
            echo "(ログなし)"
        fi
        echo ""
    done
} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$LOG_DIR/00-all.md"

echo ""
echo "---"
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: $LOG_DIR/00-all.md"

if [ "$TOTAL_FAILED" -gt 0 ]; then
    echo "❌ ${TOTAL_FAILED}件のテストが失敗しました"
    exit 1
else
    echo "✅ 全テスト成功"
    exit 0
fi
