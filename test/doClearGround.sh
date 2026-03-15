#!/bin/bash
# 地面データ初期化スクリプト
#
# PostgreSQL の storage テーブルから world_data チャンクを全削除する。
# 削除後はサーバ再起動が必要（メモリ上のチャンクデータはサーバ起動時にDBから読み込まれるため）。
#
# 使い方:
#   ./test/doClearGround.sh

set -e
cd "$(dirname "$0")/../nakama"

# dev/prod 自動検出
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'tommchat-prod'; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
fi

echo "=== 地面データ初期化 ==="

# 削除前の件数
COUNT=$($COMPOSE exec -T postgres psql -U nakama -d nakama -tAc \
    "SELECT count(*) FROM storage WHERE collection = 'world_data';")
echo "  現在のチャンク数: ${COUNT}"

if [ "$COUNT" = "0" ]; then
    echo "  既にクリア済みです。"
    exit 0
fi

# 確認
read -p "  ${COUNT}チャンクを全て削除しますか？ (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "  キャンセルしました。"
    exit 0
fi

# 削除
$COMPOSE exec -T postgres psql -U nakama -d nakama -c \
    "DELETE FROM storage WHERE collection = 'world_data';"

echo "  ${COUNT}チャンク削除完了"
echo ""
echo "⚠️  サーバを再起動してください:"
echo "   cd nakama && ./doRestart.sh"
