#!/bin/bash
# メンテナンスページ表示テスト
#
# Docker コンテナを一時停止し、502 時にカスタムメンテナンスページが
# 表示されることを確認してから、コンテナを再起動する。
#
# ⚠️  テスト中はサービスが一時停止します。本番環境では注意して実行してください。
#
# 使い方:
#   ./test/doTest-maintenance.sh <ドメイン名>
#   ./test/doTest-maintenance.sh mmo-test.tommie.jp

set -euo pipefail

if [ "$1" = "-h" ] || [ "$1" = "--help" ] || [ -z "${1:-}" ]; then
    echo "使い方: $0 <ドメイン名>"
    echo ""
    echo "メンテナンスページの表示テスト:"
    echo "  1. Docker コンテナを停止"
    echo "  2. HTTPS アクセスでメンテナンスページ（502→maintenance.html）を確認"
    echo "  3. Docker コンテナを再起動"
    echo ""
    echo "⚠️  テスト中はサービスが一時停止します"
    echo ""
    echo "例: $0 mmo-test.tommie.jp"
    exit 0
fi

DOMAIN="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NAKAMA_DIR="$(cd "$SCRIPT_DIR/../nakama" && pwd)"

source "$(dirname "$0")/lib/nakama-test-lib.sh"

GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

echo "=== メンテナンスページ表示テスト（${DOMAIN}） ==="
echo ""
echo "${YELLOW}⚠️  Docker コンテナを一時停止します${RESET}"
echo ""

# ── 1. コンテナ停止 ──
echo "[1/3] Docker コンテナ停止 ..."
cd "$NAKAMA_DIR"
COMPOSE_FILE=""
if [ -f docker-compose.prod.yml ]; then
    COMPOSE_FILE="-f docker-compose.yml -f docker-compose.prod.yml"
else
    COMPOSE_FILE="-f docker-compose.yml -f docker-compose.dev.yml"
fi
# shellcheck disable=SC2086
docker compose $COMPOSE_FILE stop web nakama 2>/dev/null || true
echo "  停止完了（web + nakama）"

# 少し待ってから確認
sleep 2

# ── 2. メンテナンスページ確認 ──
echo "[2/3] メンテナンスページ確認 ..."
MAINT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
MAINT_BODY=$(curl -s "https://${DOMAIN}/" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
MAINT_HAS_CUSTOM=$(echo "$MAINT_BODY" | grep -q "メンテナンス中" && echo "Y" || echo "N")
check "メンテナンスページ (HTTP ${MAINT_CODE}, カスタムHTML: ${MAINT_HAS_CUSTOM})" \
    "$([ "$MAINT_CODE" = "502" ] && [ "$MAINT_HAS_CUSTOM" = "Y" ] && echo 0 || echo 1)" \
    "期待: 502 + 「メンテナンス中」文字列含む。ホスト nginx の error_page 設定を確認してください"

# ── 3. コンテナ再起動 ──
echo "[3/3] Docker コンテナ再起動 ..."
# shellcheck disable=SC2086
docker compose $COMPOSE_FILE start web nakama 2>/dev/null
echo "  再起動完了"

# 復旧確認
sleep 3
RECOVER_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
check "サービス復旧 (HTTP ${RECOVER_CODE})" \
    "$([ "$RECOVER_CODE" = "200" ] && echo 0 || echo 1)" \
    "期待: 200。コンテナが正常に再起動していない可能性があります"

# 結果
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILED" -eq 0 ]; then
    echo "${GREEN}✅ 全テスト成功（${PASS}/${PASS}）${RESET}"
else
    echo "${RED}❌ ${FAILED}件失敗（成功: ${PASS}、失敗: ${FAILED}）${RESET}"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━"
exit $FAILED
