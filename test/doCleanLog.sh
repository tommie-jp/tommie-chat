#!/bin/bash
# test/log/ のログファイルを削除するスクリプト
# Usage: bash test/doCleanLog.sh [-h]
#
# 番号付きテンプレート（00-all.md 等）は残し、
# タイムスタンプ付きログ（all-20260314-*.md 等）を削除します。
# --all オプションですべて削除します。

case "${1:-}" in
    -h|--help)
        echo "Usage: $0 [--all]"
        echo "  test/log/ のログファイルを削除します"
        echo ""
        echo "  （引数なし） タイムスタンプ付きログのみ削除"
        echo "  --all        テンプレートも含めすべて削除"
        exit 0 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/log"

if [ ! -d "$LOG_DIR" ]; then
    echo "log/ ディレクトリが見つかりません"
    exit 1
fi

BEFORE=$(du -sh "$LOG_DIR" | awk '{print $1}')

if [ "${1:-}" = "--all" ]; then
    rm -f "$LOG_DIR"/*.md
    echo "すべてのログを削除しました（$BEFORE → 解放）"
else
    # 番号付きテンプレート（00-*.md 〜 09-*.md）以外を削除
    find "$LOG_DIR" -name '*.md' ! -regex '.*/[0-9][0-9]-[^/]*' -delete
    AFTER=$(du -sh "$LOG_DIR" | awk '{print $1}')
    echo "タイムスタンプ付きログを削除しました（$BEFORE → $AFTER）"
fi
