#!/bin/bash
# 全ファイル文法チェック
# Usage: ./test/doLint.sh [-h]
case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  TypeScript, Shell, Go, Docker Compose, YAML の文法チェックを実行します"
        exit 0 ;;
esac

cd "$(dirname "$0")/.."

FAILED=0
PASSED=0
TOTAL=0

run_check() {
    local name="$1"
    shift
    TOTAL=$((TOTAL + 1))
    echo ""
    echo "[$TOTAL] $name"
    if "$@" 2>&1; then
        PASSED=$((PASSED + 1))
        echo "  ✅ PASS"
    else
        FAILED=$((FAILED + 1))
        echo "  ❌ FAIL"
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

# 6. 絶対パス検出（ホームディレクトリへの参照）
TOTAL=$((TOTAL + 1))
echo ""
echo "[$TOTAL] Hardcoded absolute paths"
ABS_HITS=$(grep -rn --include='*.sh' --include='*.ts' --include='*.js' --include='*.yml' --include='*.yaml' --include='*.json' --include='*.md' --include='*.conf' \
    -E '~/|/home/' . \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    | grep -v 'node_modules' | grep -v '.git/' \
    | grep -v 'doLint\.sh' | grep -v 'doSetupTest\.sh' || true)
if [ -z "$ABS_HITS" ]; then
    PASSED=$((PASSED + 1))
    echo "  ✅ PASS"
else
    FAILED=$((FAILED + 1))
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
    exit 1
else
    echo "✅ 全チェック成功"
    exit 0
fi
