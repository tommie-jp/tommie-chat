#!/bin/bash
# E2E テスト (Playwright)
# Usage: ./test/doTest-e2e.sh [--trace] [-h]
#
# Playwright でブラウザ E2E テストを実行する。
# Vite dev サーバは Playwright が自動起動する（起動済みなら再利用）。
#
# 前提: Nakama サーバが起動済み (docker compose up -d)

SCRIPT_VERSION="2026-04-16"

# ── オプション解析 ──
TRACE=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./test/doTest-e2e.sh [--trace] [-h]

Playwright でブラウザ E2E テストを実行します。

オプション:
  --trace   トレース付きで実行（操作の詳細を記録）
            結果は test/e2e/results/ に保存され、
            npx playwright show-trace <trace.zip> で閲覧可能
  -h        このヘルプを表示

テスト内容:
  [login-flow]         自動ログイン / 手動ログイン（?login）
  [chat-send-receive]  2ページ間のチャット送受信
  [logout-relogin]     ログアウト → 再ログイン
  [room-move]          部屋作成 → 移動 → 帰還

前提:
  Nakama サーバが起動済み (docker compose up -d)
  Vite dev サーバは Playwright が自動起動（起動済みなら再利用）

レポート:
  test/e2e/results/    スクリーンショット・動画・トレース
  test/e2e/report/     HTML レポート（npx playwright show-report test/e2e/report）
EOF
            exit 0 ;;
        --trace)
            TRACE=1; shift ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
START_SEC=$SECONDS

echo "========================================="
echo "E2E テスト (Playwright)"
echo "========================================="
echo "スクリプトバージョン: $SCRIPT_VERSION"

# ── Playwright インストール確認 ──
if ! npx playwright --version > /dev/null 2>&1; then
    echo "エラー: @playwright/test がインストールされていません"
    echo "  npm install --save-dev @playwright/test"
    echo "  npx playwright install chromium"
    exit 1
fi

# ── テスト実行 ──
cd "$ROOT_DIR"

ARGS=()
if [ "$TRACE" -eq 1 ]; then
    ARGS+=(--trace on)
    echo "モード: トレース付き"
else
    echo "モード: 通常（--trace でトレース付き実行）"
fi
echo ""

npx playwright test "${ARGS[@]}"
RC=$?

ELAPSED=$(( SECONDS - START_SEC ))

echo ""
echo "========================================="
if [ "$RC" -eq 0 ]; then
    echo "✅ 全 E2E テスト通過  (${ELAPSED}秒)"
else
    echo "❌ E2E テスト失敗 (exit=$RC)  (${ELAPSED}秒)"
    echo ""
    echo "詳細レポート:"
    echo "  npx playwright show-report test/e2e/report"
    if [ "$TRACE" -eq 1 ]; then
        echo ""
        echo "トレース閲覧:"
        echo "  npx playwright show-trace test/e2e/results/<テスト名>/trace.zip"
    fi
fi
echo "========================================="

exit $RC
