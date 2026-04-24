#!/bin/bash
# Nakama Go プラグインを再ビルドするスクリプト
# Nakama サーバと同じ Go バージョンでコンパイルするために、nakama-pluginbuilder イメージを使用する
# Usage: ./nakama/doBuild.sh [--fresh|--force] [--test] [-h]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
GO_SRC="$SCRIPT_DIR/go_src"
TARGET="$SCRIPT_DIR/modules/world.so"
FORCE=0
RUN_TESTS=0

usage() {
    cat <<EOF
Usage: $0 [--fresh|--force] [--test] [-h]

  Goプラグインをビルドし、nakamaコンテナを再起動します。
  ソースが変更されていなければビルドをスキップします。

  --force    ソース未変更でも強制ビルド
  --fresh    全キャッシュをクリアして強制ビルド
  --test     ビルド後に test/doAll.sh を実行（100人×1ラウンド、3〜5分）
  -h, --help このヘルプを表示
EOF
}

for arg in "$@"; do
    case "$arg" in
        -h|--help) usage; exit 0 ;;
        --fresh)
            echo "キャッシュをクリアします..."
            rm -f "$GO_SRC/.protobuf-version-cache"
            docker volume rm nakama-go-cache 2>/dev/null || true
            docker volume rm nakama-go-build-cache 2>/dev/null || true
            echo "Done"
            FORCE=1
            ;;
        --force) FORCE=1 ;;
        --test)  RUN_TESTS=1 ;;
        "") ;;
        *) echo "不明なオプション: $arg" >&2; usage >&2; exit 1 ;;
    esac
done

# ソースが変更されていなければスキップ
if [ "$FORCE" -eq 0 ] && [ -f "$TARGET" ]; then
    NEWER=$(find "$GO_SRC" -name '*.go' -o -name 'go.mod' -o -name 'go.sum' | xargs -I{} find {} -newer "$TARGET" 2>/dev/null)
    if [ -z "$NEWER" ]; then
        echo "world.so is up to date — スキップ ($(date -r "$TARGET" '+%Y/%m/%d %H:%M:%S'))"
        exit 0
    fi
fi

# prod override があればそちらを使う
COMPOSE="docker compose"
if [ -f "$SCRIPT_DIR/docker-compose.prod.yml" ]; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
fi
cd "$GO_SRC" && bash build.sh && cd "$SCRIPT_DIR" && $COMPOSE restart nakama
echo "world.so updated — $(date -r "$TARGET" '+%Y/%m/%d %H:%M:%S')"

# --test 指定時のみ統合テスト (test/doAll.sh) を実行する。
# doAll.sh の中でリバーシ単体 (reversi/doTest-all.sh = Python replay + Vitest + Go 単体) も走る。
# 実行時間は 1 ラウンド (100 人) でおおよそ 3〜5 分。
if [ "$RUN_TESTS" -eq 1 ]; then
    DOALL="$PROJECT_DIR/test/doAll.sh"
    if [ -x "$DOALL" ] || [ -f "$DOALL" ]; then
        echo ""
        echo "=== post-build: test/doAll.sh (--test) ==="
        bash "$DOALL"
        exit $?
    else
        echo "⚠️  $DOALL が見つからないためスキップ"
    fi
fi
