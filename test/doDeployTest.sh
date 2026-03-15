#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -d "tommie-chat" ]; then
    read -p "tommie-chat ディレクトリが既に存在します。削除しますか？ (y/N): " ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
        # 既存コンテナ・ボリュームを停止・削除
        echo "既存のコンテナを停止・削除します..."
        cd tommie-chat/nakama 2>/dev/null && {
            docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v 2>/dev/null || true
            docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v 2>/dev/null || true
            docker compose down -v 2>/dev/null || true
            cd "$SCRIPT_DIR"
        } || true
        # 残留コンテナがあれば強制削除
        REMAINING=$(docker ps -aq --filter "name=nakama" 2>/dev/null; docker ps -aq --filter "name=tommchat-prod" 2>/dev/null)
        REMAINING=$(echo "$REMAINING" | sort -u | grep -v '^$' || true)
        if [ -n "$REMAINING" ]; then
            echo "$REMAINING" | xargs -r docker rm -f
        fi
        rm -rf tommie-chat
        echo "削除しました"
    else
        echo "中止します"
        exit 1
    fi
fi

git clone https://github.com/open-tommie/tommie-chat.git
cd tommie-chat/nakama
bash doDeploy.sh

# デプロイ後テスト
echo ""
echo "━━━ テスト実行 ━━━"
cd ../test
set -a
source ../nakama/.env
set +a
./doTest-ping.sh
