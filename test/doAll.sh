#!/bin/bash
# 全テスト一括実行
# Usage: ./test/doAll.sh [-n N] [-v] [-h]
VERBOSE=0
PLAYERS_OPT=""   # -n N が指定された場合にサブスクリプトへ渡す

while [[ $# -gt 0 ]]; do
    case "$1" in
        -v|--verbose)
            VERBOSE=1
            shift ;;
        -n|--players)
            PLAYERS_OPT="-n ${2:-}"
            shift 2 ;;
        -h|--help)
            echo "Usage: $0 [-n N] [-v] [-h]"
            echo "  全テストスクリプトを順番に実行します"
            echo ""
            echo "  -n N, --players N  テスト人数を指定（サブスクリプトに渡す）"
            echo "  -v, --verbose      全ログ出力（間引きなし）"
            echo ""
            echo "  1. doTest-concurrent-login.sh  同時接続テスト"
            echo "  2. doTest-sustain.sh           持続接続テスト"
            echo "  3. doTest-snd-rcv.sh           送受信整合性テスト"
            echo "  4. doTest-player-list.sh       プレイヤーリスト通知テスト"
            echo "  5. doTest-ccu-db.sh            同接履歴 DB永続化テスト"
            echo ""
            echo "  デフォルト人数: 各スクリプトの既定値（1,10,100,1000,2000）"
            echo "  前提: nakama サーバが 127.0.0.1:7350 で起動していること"
            echo ""
            echo "ログ出力先:"
            echo "  test/log/doAll-<テスト名>-YYYYMMDD-HHMMSS.log  各テストの全出力"
            echo "  test/log/all-YYYYMMDD-HHMMSS.md                Markdownレポート"
            echo "  test/log/00-all.md                             最新レポートへのシンボリックリンク"
            exit 0 ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SCRIPT_DIR/log"
mkdir -p "$LOG_DIR"
FAILED=0
PASSED=0
TOTAL=0
TOTAL_TESTS=5
RESULTS=()
# テスト名, exit_code, 経過秒, ログファイル を記録
declare -a TEST_NAMES TEST_RCS TEST_DURATIONS TEST_LOGS
CHILD_PID=0
OUTPUT_TIMEOUT=60  # 秒間ログ出力がなければタイムアウト（サーバ再起動を含むため余裕を持つ）
GREEN=$'\e[32m'
RESET=$'\e[0m'
CURRENT_TEST=""
CURRENT_STATUS=""
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
TMPLOG="/tmp/doAll-out-$$"
TMPCHUNK="/tmp/doAll-chunk-$$"

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
# bash変数にチャンクを格納しない。全てファイル→パイプで処理。

# チャンクファイルからパターンを grep で高速抽出
extract_patterns() {
    local f="$1"
    local m
    # ── 進捗情報 (last_pass_count) ──
    m=$(grep -oP '\d+(?=人が全員ログイン成功)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人ログイン成功"
    m=$(grep -oP 'createPlayers: \K\d+/\d+(?=人成功)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続成功"
    m=$(grep -oP '接続中: \K\d+/\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続中"
    m=$(grep -oP 'ログイン \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人ログイン成功"
    m=$(grep -oP '\d+(?=人接続)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続"
    # ── 現在のテストフェーズ (CURRENT_STATUS) ──
    # 同時接続テスト: vitest describe "同時接続 N人"
    m=$(grep -oP '同時接続 \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    # snd-rcvテスト: Phase出力 "[Phase N] 1000人ログインテスト"
    m=$(grep -oP '\[Phase \d+\] \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    # player-listテスト: Phase出力 "[P7-prof1000] 1000人 プロフィール通知"
    m=$(grep -oP '\[P\d+-[^\]]+\] \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    # vitest describe出力: "N人ログインテスト" "N人 プロフィール通知" など
    m=$(grep -oP '> \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    # 持続接続テスト: vitest describe "接続維持テスト (100人, 90秒)"
    m=$(grep -oP '接続維持テスト \(\K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人 接続維持テスト中"
    m=$(grep -oP '維持 \K[^:]+' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="維持 $m"
    # DB永続化テスト
    grep -q 'DB永続化' "$f" && CURRENT_STATUS="DB永続化テスト中"
    m=$(grep -oP '\d+(?=人 接続完了)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="DB永続化 ${m}人"
    return 0
}

# チャンクファイルから重要行のみ表示（通常ログは全て抑制）
display_important() {
    local f="$1"
    # テスト結果・エラー・ステータスのみ表示（AOI_ENTERなどの大量ログは全てスキップ）
    grep -E '✅|❌|⚠|PASS|FAIL|[Ee]rror|Tests |成功|失敗|レート|timeout|タイムアウト|passed|failed' "$f" | head -n 20 || true
}

# 1秒毎にテスト項目を緑色で表示
print_tick() {
    local elapsed="$1"
    local info="[${TOTAL}/${TOTAL_TESTS}] ${CURRENT_TEST} ${elapsed}s"
    [ -n "$CURRENT_STATUS" ] && info="$info $CURRENT_STATUS"
    [ -n "$last_pass_count" ] && info="$info $last_pass_count"
    echo "${GREEN}${info}${RESET}"
}

# ── テスト実行 ──────────────────────────────────────────

run_test() {
    local name="$1"
    shift
    TOTAL=$((TOTAL + 1))
    CURRENT_TEST="$name"
    CURRENT_STATUS="実行中"
    echo ""
    echo "========================================"
    echo "[$TOTAL] $name"
    echo "========================================"
    echo ""

    # テストごとのログファイル（ANSI除去済みの全出力を保存）
    local base="${name%.sh}"
    local test_log="$LOG_DIR/doAll-${base}-${TIMESTAMP}.log"

    local rc=0
    local timed_out=0
    local start_time=$SECONDS
    last_pass_count=""

    if [ "$VERBOSE" -eq 1 ]; then
        # verbose: 全ログ出力＋ログファイル保存
        bash "$SCRIPT_DIR/$name" "$@" 2>&1 | tee >(sed 's/\x1b\[[0-9;]*[mGKHF]//g' > "$test_log")
        rc=${PIPESTATUS[0]}
    else
        > "$TMPLOG"

        # setsid で新プロセスグループを作成（グループ kill 用）
        # stdbuf -oL でラインバッファリングを強制（tee のブロックバッファ対策）
        setsid stdbuf -oL bash "$SCRIPT_DIR/$name" "$@" >> "$TMPLOG" 2>&1 &
        CHILD_PID=$!

        local silent_sec=0
        local last_bytes=0

        # 1秒ごとにポーリング
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
                    if [ -n "$last_pass_count" ]; then
                        echo "  最後に成功: $last_pass_count"
                    fi
                    kill -TERM -- -$CHILD_PID 2>/dev/null
                    sleep 1
                    kill -KILL -- -$CHILD_PID 2>/dev/null
                    break
                fi
            fi

            # 毎秒テスト項目を緑色で表示
            print_tick $((SECONDS - start_time))
        done

        # プロセス終了後に残りの出力を表示
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

        # ANSI除去してログファイルに保存
        sed 's/\x1b\[[0-9;]*[mGKHF]//g' "$TMPLOG" > "$test_log"
    fi

    local elapsed=$((SECONDS - start_time))

    if [ $timed_out -eq 1 ]; then
        rc=124  # timeout の慣例的な終了コード
    fi

    # メタデータを記録
    TEST_NAMES+=("$name")
    TEST_RCS+=("$rc")
    TEST_DURATIONS+=("$elapsed")
    TEST_LOGS+=("$test_log")

    if [ $rc -eq 0 ]; then
        PASSED=$((PASSED + 1))
        RESULTS+=("✅ $name")
    else
        FAILED=$((FAILED + 1))
        if [ $timed_out -eq 1 ]; then
            local detail="timeout: ${OUTPUT_TIMEOUT}s無出力"
            [ -n "$last_pass_count" ] && detail="$detail, 最後に成功: $last_pass_count"
            RESULTS+=("❌ $name ($detail)")
        else
            RESULTS+=("❌ $name (exit=$rc)")
        fi
    fi

    echo "  ログ: $test_log"
    return $rc
}

# ── メイン ──────────────────────────────────────────────

# 1. 同時接続テスト
run_test "doTest-concurrent-login.sh" $PLAYERS_OPT

# サーバ側の切断処理完了を待つ
echo "  テスト間クールダウン (3秒)..."
sleep 3

# 2. 持続接続テスト
run_test "doTest-sustain.sh" $PLAYERS_OPT

# サーバ側の切断処理完了を待つ
echo "  テスト間クールダウン (3秒)..."
sleep 3

# 3. 送受信整合性テスト
run_test "doTest-snd-rcv.sh" $PLAYERS_OPT

echo "  テスト間クールダウン (3秒)..."
sleep 3

# 4. プレイヤーリスト通知テスト
run_test "doTest-player-list.sh" $PLAYERS_OPT

echo "  テスト間クールダウン (3秒)..."
sleep 3

# 5. 同接履歴 DB永続化テスト
run_test "doTest-ccu-db.sh"

# 後始末
rm -f "$TMPLOG" "$TMPCHUNK"

# サマリー
echo ""
echo "========================================"
echo "全テスト結果: ${PASSED}/${TOTAL} passed"
echo "========================================"
for r in "${RESULTS[@]}"; do
    echo "  $r"
done
echo ""

# ── Markdown レポート生成 ──────────────────────────────

LOGFILE="$LOG_DIR/all-${TIMESTAMP}.md"
RESULT_LABEL=$([ "$FAILED" -eq 0 ] && echo "✅ ALL PASS" || echo "❌ ${FAILED} FAILED")
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')
TOTAL_ELAPSED=$SECONDS

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

{
    echo "# 全テスト一括実行 レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| サーバ | 127.0.0.1:7350 |"
    echo "| テスト人数 | ${PLAYERS_OPT:-デフォルト (1,10,100,1000,2000)} |"
    echo "| 結果 | ${RESULT_LABEL} (${PASSED}/${TOTAL}) |"
    echo "| 実行時間 | $(format_duration $TOTAL_ELAPSED) |"
    echo ""
    echo "## テスト結果"
    echo ""
    echo "| # | テスト | 結果 | 時間 |"
    echo "|--:|--------|------|-----:|"

    for i in "${!TEST_NAMES[@]}"; do
        local_name="${TEST_NAMES[$i]}"
        local_rc="${TEST_RCS[$i]}"
        local_dur="${TEST_DURATIONS[$i]}"
        if [ "$local_rc" -eq 0 ]; then
            icon="✅ PASS"
        elif [ "$local_rc" -eq 124 ]; then
            icon="❌ TIMEOUT"
        else
            icon="❌ FAIL (exit=${local_rc})"
        fi
        echo "| $((i + 1)) | ${local_name} | ${icon} | $(format_duration "$local_dur") |"
    done

    echo ""
    echo "## テスト別ログ"
    echo ""

    for i in "${!TEST_NAMES[@]}"; do
        local_name="${TEST_NAMES[$i]}"
        local_rc="${TEST_RCS[$i]}"
        local_log="${TEST_LOGS[$i]}"
        local_icon=$([ "$local_rc" -eq 0 ] && echo "✅" || echo "❌")

        echo "### ${local_icon} [$((i + 1))] ${local_name}"
        echo ""

        # サブスクリプト生成の個別レポートを検索
        local sub_report=""
        if [ -f "$local_log" ]; then
            sub_report=$(grep -oP 'レポート: \K.+\.md' "$local_log" | tail -1)
        fi

        # ログファイルへのリンク
        echo "| ログ | リンク |"
        echo "|------|--------|"
        echo "| 全出力 | [$(basename "$local_log")](${local_log}) |"
        [ -n "$sub_report" ] && echo "| 詳細レポート | [$(basename "$sub_report")](${sub_report}) |"
        echo ""

        if [ -f "$local_log" ]; then
            if [ "$local_rc" -ne 0 ]; then
                # ── 失敗時: エラー詳細を優先表示 ──
                echo "#### エラー詳細"
                echo ""
                echo '```'
                # vitest の AssertionError / エラーメッセージ / スタックトレース
                grep -E 'AssertionError|Error:|FAIL|❌|expected|received|assert|timeout|タイムアウト|at .*\.ts:' "$local_log" \
                  | head -n 30 || true
                echo '```'
                echo ""
                echo "#### 結果サマリー"
                echo ""
            fi
            echo '```'
            grep -E '✅|❌|⚠|PASS|FAIL|Tests |成功|失敗|エラー|timeout|タイムアウト|passed|failed|レポート|結果|人が全員|createPlayers|維持 |DB永続化|整合性' "$local_log" \
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

if [ $FAILED -gt 0 ]; then
    echo "❌ ${FAILED}件のテストが失敗しました"
    exit 1
else
    echo "✅ 全テスト成功"
    exit 0
fi
