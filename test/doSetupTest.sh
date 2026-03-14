#!/bin/bash
# ゼロからのセットアップテスト
# GitHubリポジトリをcloneして、READMEの手順で動くか検証する
# Usage: ./test/doSetupTest.sh [-h]
#
# 前提: Docker が起動していること
# 注意: /tmp/tommie-chat-setup-test に一時cloneする（終了時に削除）

case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  GitHubリポジトリをcloneして、セットアップ手順を検証します"
        echo "  前提: Docker が起動していること"
        exit 0 ;;
esac

set -eo pipefail

WORK_DIR="/tmp/tommie-chat-setup-test"
REPO_URL="https://github.com/open-tommie/tommie-chat.git"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$PROJECT_DIR/test/log"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$PROJECT_DIR/test/log/setup-test-${TIMESTAMP}.log"

FAILED=0
PASSED=0
TOTAL=0

run_step() {
    local name="$1"
    shift
    TOTAL=$((TOTAL + 1))
    echo ""
    echo "========================================"
    echo "[$TOTAL] $name"
    echo "========================================"
    if "$@" 2>&1 | tee -a "$LOGFILE"; then
        PASSED=$((PASSED + 1))
        echo "  ✅ PASS" | tee -a "$LOGFILE"
    else
        FAILED=$((FAILED + 1))
        echo "  ❌ FAIL" | tee -a "$LOGFILE"
        return 1
    fi
}

cleanup() {
    echo ""
    echo "クリーンアップ..."
    cd /tmp
    # テスト用サーバーを停止
    if [ -f "$WORK_DIR/nakama/docker-compose.yml" ]; then
        cd "$WORK_DIR/nakama" && docker compose down 2>/dev/null || true
        cd /tmp
    fi
    # root 所有ファイル（Docker で生成）を含む場合があるため docker で削除
    docker run --rm -v /tmp:/tmp alpine rm -rf "$WORK_DIR" 2>/dev/null || rm -rf "$WORK_DIR"
    echo "Done: $WORK_DIR を削除しました"
    # 元のサーバーを再起動
    if [ -f "$PROJECT_DIR/nakama/docker-compose.yml" ]; then
        echo "元のサーバーを再起動します..."
        cd "$PROJECT_DIR/nakama" && docker compose up -d 2>/dev/null || true
    fi
}
trap cleanup EXIT

# 既存の作業ディレクトリを削除
rm -rf "$WORK_DIR"

# 1. clone
run_step "git clone" git clone "$REPO_URL" "$WORK_DIR"
cd "$WORK_DIR"

# 2. npm install
run_step "npm install" npm ci

# 3. tsc --noEmit
run_step "tsc --noEmit" npx tsc --noEmit

# 4. vite build
run_step "npm run build" npm run build

# 5. Shell script syntax
run_step "Shell script syntax" bash -c '
    failed=0
    for f in $(find . -name "*.sh" -not -path "*/node_modules/*"); do
        if ! bash -n "$f"; then
            echo "  ❌ $f"
            failed=1
        fi
    done
    exit $failed
'

# 6. 絶対パス検出
run_step "No hardcoded absolute paths" bash -c '
    hits=$(grep -rn --include="*.sh" --include="*.ts" --include="*.js" --include="*.yml" --include="*.json" --include="*.conf" \
        -E "~/|/home/" . \
        --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
        | grep -v "doLint\.sh" | grep -v "doSetupTest\.sh" || true)
    if [ -n "$hits" ]; then
        echo "$hits"
        exit 1
    fi
'

# 7. 既存サーバーを停止（ポート競合回避）
echo "  既存サーバーを確認..."
if docker compose -f "$PROJECT_DIR/nakama/docker-compose.yml" ps --quiet 2>/dev/null | grep -q .; then
    run_step "Stop existing servers" docker compose -f "$PROJECT_DIR/nakama/docker-compose.yml" down
else
    echo "  既存サーバーなし — スキップ"
fi

# 8. .env設定
run_step "cp .env.example .env" cp nakama/.env.example nakama/.env

# 8. サーバー起動
run_step "docker compose up" bash -c 'cd nakama && docker compose up -d'

# 9. Nakama ヘルスチェック（最大60秒待機）
run_step "Nakama health check" bash -c '
    for i in $(seq 1 30); do
        if curl -sf http://127.0.0.1:7350/healthcheck > /dev/null 2>&1; then
            echo "  Nakama is healthy (${i}s)"
            exit 0
        fi
        sleep 2
    done
    echo "  Nakama did not become healthy within 60s"
    exit 1
'

# 10. Go プラグインビルド
run_step "doBuild.sh --fresh" bash nakama/doBuild.sh --fresh

# 11. ビルド後のヘルスチェック + RPC疎通確認
run_step "Nakama health + RPC after restart" bash -c '
    sleep 5
    for i in $(seq 1 15); do
        if curl -sf http://127.0.0.1:7350/healthcheck > /dev/null 2>&1; then
            echo "  Nakama is healthy (${i}s)"
            break
        fi
        sleep 2
        if [ $i -eq 15 ]; then
            echo "  Nakama did not become healthy after restart"
            docker compose -f nakama/docker-compose.yml logs nakama 2>/dev/null | tail -30
            exit 1
        fi
    done
    # RPC疎通確認（Goプラグインが正しくロードされているか）
    sleep 2
    AUTH=$(echo -n "${NAKAMA_SERVER_KEY:-defaultkey}:" | base64)
    STATUS=$(curl -o /dev/null -w "%{http_code}" -s \
        -H "Authorization: Basic ${AUTH}" \
        http://127.0.0.1:7350/v2/rpc/getWorldMatch? 2>/dev/null || echo "000")
    if [ "$STATUS" = "404" ]; then
        echo "  ❌ RPC getWorldMatch returned HTTP $STATUS — Go plugin not loaded"
        echo "  Nakama logs:"
        docker compose -f nakama/docker-compose.yml logs nakama 2>/dev/null | tail -30
        exit 1
    fi
    echo "  RPC getWorldMatch: HTTP $STATUS — Go plugin loaded"
'

# 12. 統合テスト (doAll.sh)
run_step "doAll.sh" bash test/doAll.sh

# 13. dist/ が nginx で配信されているか
run_step "nginx serves dist/" bash -c '
    status=$(curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:80/ 2>/dev/null || echo "000")
    if [ "$status" = "200" ]; then
        echo "  HTTP 200 OK"
        exit 0
    else
        echo "  HTTP $status"
        exit 1
    fi
'

# サマリー
{
echo ""
echo "========================================"
echo "セットアップテスト結果: ${PASSED}/${TOTAL} passed"
echo "========================================"

if [ $FAILED -gt 0 ]; then
    echo "❌ ${FAILED}件のステップが失敗しました"
else
    echo "✅ 全ステップ成功 — READMEの手順で正常にセットアップできます"
fi
} | tee -a "$LOGFILE"

echo ""
echo "ログ保存先: ${LOGFILE}"

if [ $FAILED -gt 0 ]; then
    exit 1
else
    exit 0
fi
