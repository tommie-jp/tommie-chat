#!/bin/bash
# Nakama Go プラグインを再ビルドするスクリプト
# Nakama サーバと同じ Go バージョンでコンパイルするために、nakama-pluginbuilder イメージを使用する
# Usage: ./doBuild.sh [--fresh|--force] [-h]

FORCE=0

case "${1:-}" in
    -h|--help)
        echo "Usage: $0 [--fresh|--force] [-h]"
        echo ""
        echo "  Goプラグインをビルドし、nakamaコンテナを再起動します"
        echo "  ソースが変更されていなければビルドをスキップします"
        echo ""
        echo "  --force  ソース未変更でも強制ビルド"
        echo "  --fresh  全キャッシュをクリアして強制ビルド"
        echo "  -h       このヘルプを表示"
        exit 0 ;;
    --fresh)
        echo "キャッシュをクリアします..."
        rm -f ~/24-mmo-Tommie-chat/nakama/go_src/.protobuf-version-cache
        docker volume rm nakama-go-cache 2>/dev/null || true
        echo "Done"
        FORCE=1
        ;;
    --force)
        FORCE=1
        ;;
    "") ;;
    *)  echo "Usage: $0 [--fresh|--force] [-h]"; exit 1 ;;
esac

GO_SRC=~/24-mmo-Tommie-chat/nakama/go_src
TARGET=~/24-mmo-Tommie-chat/nakama/modules/world.so

# ソースが変更されていなければスキップ
if [ "$FORCE" -eq 0 ] && [ -f "$TARGET" ]; then
    NEWER=$(find "$GO_SRC" -name '*.go' -o -name 'go.mod' -o -name 'go.sum' | xargs -I{} find {} -newer "$TARGET" 2>/dev/null)
    if [ -z "$NEWER" ]; then
        echo "world.so is up to date — スキップ"
        exit 0
    fi
fi

cd "$GO_SRC" && bash build.sh && cd ~/24-mmo-Tommie-chat/nakama && docker compose restart nakama
