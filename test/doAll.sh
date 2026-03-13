#!/bin/bash
# 全テスト一括実行
# Usage: ./test/doAll.sh [-v] [-h]
VERBOSE=0
case "${1:-}" in
    -v|--verbose)
        VERBOSE=1
        shift ;;
    -h|--help)
        echo "Usage: $0 [-v] [-h]"
        echo "  全テストスクリプトを順番に実行します"
        echo ""
        echo "  -v, --verbose  全ログ出力（間引きなし）"
        echo ""
        echo "  1. doTest-concurrent-login.sh  同時接続テスト (1/10/100/1000人)"
        echo "  2. doTest-sustain.sh           持続接続テスト (100人×90秒)"
        echo "  3. doTest-ccu-db.sh            同接履歴 DB永続化テスト"
        echo ""
        echo "  前提: nakama サーバが 127.0.0.1:7350 で起動していること"
        exit 0 ;;
esac

SCRIPT_DIR="$(dirname "$0")"
FAILED=0
PASSED=0
TOTAL=0
TOTAL_TESTS=3
RESULTS=()
CHILD_PID=0
OUTPUT_TIMEOUT=15  # 秒間ログ出力がなければタイムアウト
WARN_INTERVAL=5    # 無出力警告の表示間隔（秒）
GREEN=$'\e[32m'
RESET=$'\e[0m'
CURRENT_TEST=""
CURRENT_STATUS=""
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
    m=$(grep -oP '\d+(?=人が全員ログイン成功)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人ログイン成功"
    m=$(grep -oP 'createPlayers: \K\d+/\d+(?=人成功)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続成功"
    m=$(grep -oP 'ログイン \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人ログイン成功"
    m=$(grep -oP '\d+(?=人接続)' "$f" | tail -1) && [ -n "$m" ] && last_pass_count="${m}人接続"
    m=$(grep -oP '同時接続 \K\d+(?=人)' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="${m}人テスト中"
    grep -q '接続維持テスト' "$f" && CURRENT_STATUS="接続維持テスト中"
    m=$(grep -oP '維持 \K[^:]+' "$f" | tail -1) && [ -n "$m" ] && CURRENT_STATUS="維持 $m"
    grep -q 'DB永続化' "$f" && CURRENT_STATUS="DB永続化テスト中"
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

    local rc=0
    local timed_out=0
    last_pass_count=""

    if [ "$VERBOSE" -eq 1 ]; then
        # verbose: 全ログ出力（間引きなし）
        bash "$SCRIPT_DIR/$name" "$@"
        rc=$?
    else
        > "$TMPLOG"
        local start_time=$SECONDS

        # setsid で新プロセスグループを作成（グループ kill 用）
        setsid bash "$SCRIPT_DIR/$name" "$@" >> "$TMPLOG" 2>&1 &
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
                if ((silent_sec > 0 && silent_sec % WARN_INTERVAL == 0)); then
                    local remaining=$((OUTPUT_TIMEOUT - silent_sec))
                    if [ $remaining -le 0 ]; then
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
                    echo "  ⏳ ${silent_sec}秒間ログ出力なし (あと${remaining}秒でタイムアウト)"
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
    fi

    if [ $timed_out -eq 1 ]; then
        rc=124  # timeout の慣例的な終了コード
    fi

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
    return $rc
}

# ── メイン ──────────────────────────────────────────────

# 1. 同時接続テスト
run_test "doTest-concurrent-login.sh"

# サーバ側の切断処理完了を待つ
echo "  テスト間クールダウン (3秒)..."
sleep 3

# 2. 持続接続テスト
run_test "doTest-sustain.sh"

# サーバ側の切断処理完了を待つ
echo "  テスト間クールダウン (3秒)..."
sleep 3

# 3. 同接履歴 DB永続化テスト
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

if [ $FAILED -gt 0 ]; then
    echo "❌ ${FAILED}件のテストが失敗しました"
    exit 1
else
    echo "✅ 全テスト成功"
    exit 0
fi
