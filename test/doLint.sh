#!/bin/bash
# 全ファイル文法チェック
# Usage: ./test/doLint.sh [-h]
case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  TypeScript, Shell, Go, Docker Compose, YAML の文法チェックを実行します"
        echo ""
        echo "ログ出力先:"
        echo "  test/log/lint-YYYYMMDD-HHMMSS.md  Markdownレポート"
        echo "  test/log/06-lint.md               最新レポートへのシンボリックリンク"
        exit 0 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$SCRIPT_DIR/log"
mkdir -p "$LOG_DIR"
cd "$ROOT_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LOG_DIR/lint-${TIMESTAMP}.md"

FAILED=0
PASSED=0
TOTAL=0

# チェック結果を配列で保持: "name|rc|output"
declare -a CHECK_NAMES CHECK_RCS CHECK_OUTPUTS CHECK_DURATIONS

run_check() {
    local name="$1"
    shift
    TOTAL=$((TOTAL + 1))
    echo ""
    echo "[$TOTAL] $name"
    local start_time=$SECONDS
    local output
    output=$("$@" 2>&1) && local rc=0 || local rc=$?
    local elapsed=$((SECONDS - start_time))

    CHECK_NAMES+=("$name")
    CHECK_RCS+=("$rc")
    CHECK_OUTPUTS+=("$output")
    CHECK_DURATIONS+=("$elapsed")

    if [ "$rc" -eq 0 ]; then
        PASSED=$((PASSED + 1))
        echo "  ✅ PASS (${elapsed}s)"
    else
        FAILED=$((FAILED + 1))
        echo "  ❌ FAIL (${elapsed}s)"
        # エラー出力を表示（最大20行）
        echo "$output" | head -n 20 | sed 's/^/    /'
    fi
}

# 1. TypeScript
run_check "TypeScript (tsc --noEmit)" npx tsc --noEmit

# 2. Vite build
run_check "Vite build" npx vite build

# 3. Shell scripts
echo ""
echo "[Shell scripts]"
for f in $(find . -name '*.sh' -not -path '*/node_modules/*'); do
    run_check "bash -n $f" bash -n "$f"
done

# 4. Go (vet) — コンテナ内でチェック
if [ -f nakama/go_src/main.go ]; then
    run_check "Go vet" docker run --rm \
        --entrypoint sh \
        -v "$(pwd)/nakama/go_src":/go_src \
        -v nakama-go-cache:/go/pkg/mod \
        -w /go_src \
        "registry.heroiclabs.com/heroiclabs/nakama-pluginbuilder:3.35.0" \
        -c "go vet ./..."
fi

# 5. Docker Compose
if [ -f nakama/docker-compose.yml ]; then
    run_check "docker-compose.yml" docker compose -f nakama/docker-compose.yml config --quiet
fi

# 6. Python
echo ""
echo "[Python]"
for f in $(find . -name '*.py' -not -path '*/node_modules/*'); do
    run_check "python3 -m py_compile $f" python3 -m py_compile "$f"
done

# 7. JSON（主要設定ファイル）
echo ""
echo "[JSON]"
for f in package.json tsconfig.json tsconfig.node.json; do
    if [ -f "$f" ]; then
        run_check "json $f" python3 -m json.tool "$f" /dev/null
    fi
done

# 8. 絶対パス検出（ホームディレクトリへの参照）
TOTAL=$((TOTAL + 1))
echo ""
echo "[$TOTAL] Hardcoded absolute paths"
local_start=$SECONDS
ABS_HITS=$(grep -rn --include='*.sh' --include='*.ts' --include='*.js' --include='*.yml' --include='*.yaml' --include='*.json' --include='*.md' --include='*.conf' \
    -E '~/|/home/' . \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.claude \
    | grep -v 'node_modules' | grep -v '.git/' \
    | grep -v 'doLint\.sh' | grep -v 'doSetupTest\.sh' \
    | grep -v 'test/log/' | grep -v 'doc/' || true)
local_elapsed=$((SECONDS - local_start))

CHECK_NAMES+=("Hardcoded absolute paths")
CHECK_DURATIONS+=("$local_elapsed")

if [ -z "$ABS_HITS" ]; then
    PASSED=$((PASSED + 1))
    CHECK_RCS+=("0")
    CHECK_OUTPUTS+=("")
    echo "  ✅ PASS (${local_elapsed}s)"
else
    FAILED=$((FAILED + 1))
    CHECK_RCS+=("1")
    CHECK_OUTPUTS+=("$ABS_HITS")
    echo "  ❌ FAIL — 以下に絶対パスが含まれています:"
    echo "$ABS_HITS" | sed 's/^/    /'
fi

# サマリー
echo ""
echo "========================================"
echo "文法チェック結果: ${PASSED}/${TOTAL} passed"
echo "========================================"

if [ $FAILED -gt 0 ]; then
    echo "❌ ${FAILED}件のチェックが失敗しました"
else
    echo "✅ 全チェック成功"
fi

# ── Markdown レポート生成 ──────────────────────────────

RESULT_LABEL=$([ "$FAILED" -eq 0 ] && echo "✅ ALL PASS" || echo "❌ ${FAILED} FAILED")
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')
TOTAL_ELAPSED=$SECONDS

format_duration() {
    local s="$1"
    if [ "$s" -ge 60 ]; then
        echo "$((s / 60))m$((s % 60))s"
    else
        echo "${s}s"
    fi
}

{
    echo "# 文法チェック レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| 結果 | ${RESULT_LABEL} (${PASSED}/${TOTAL}) |"
    echo "| 実行時間 | $(format_duration $TOTAL_ELAPSED) |"
    echo ""
    echo "## チェック結果"
    echo ""
    echo "| # | チェック | 結果 | 時間 |"
    echo "|--:|---------|------|-----:|"

    for i in "${!CHECK_NAMES[@]}"; do
        c_name="${CHECK_NAMES[$i]}"
        c_rc="${CHECK_RCS[$i]}"
        c_dur="${CHECK_DURATIONS[$i]}"
        if [ "$c_rc" -eq 0 ]; then
            icon="✅ PASS"
        else
            icon="❌ FAIL"
        fi
        echo "| $((i + 1)) | ${c_name} | ${icon} | ${c_dur}s |"
    done

    echo ""

    # 失敗項目の詳細
    has_failures=0
    for i in "${!CHECK_NAMES[@]}"; do
        c_rc="${CHECK_RCS[$i]}"
        if [ "$c_rc" -ne 0 ]; then
            has_failures=1
            break
        fi
    done

    if [ "$has_failures" -eq 1 ]; then
        echo "## エラー詳細"
        echo ""
        for i in "${!CHECK_NAMES[@]}"; do
            c_name="${CHECK_NAMES[$i]}"
            c_rc="${CHECK_RCS[$i]}"
            c_output="${CHECK_OUTPUTS[$i]}"
            if [ "$c_rc" -ne 0 ]; then
                echo "### ❌ ${c_name}"
                echo ""
                echo '```'
                echo "$c_output" | head -n 50
                echo '```'
                echo ""
            fi
        done
    fi
} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$LOG_DIR/06-lint.md"

echo ""
echo "---"
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: $LOG_DIR/06-lint.md"

if [ $FAILED -gt 0 ]; then
    exit 1
else
    exit 0
fi
