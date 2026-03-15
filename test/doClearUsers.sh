#!/bin/bash
# ユーザー・デバイス認証データ初期化スクリプト
#
# PostgreSQL から全ユーザーとデバイス認証データを削除する。
# 削除後はサーバ再起動が必要。
#
# 使い方:
#   ./test/doClearUsers.sh

set -e
cd "$(dirname "$0")/../nakama"

# dev/prod 自動検出
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'tommchat-prod'; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
fi

echo "=== ユーザーデータ初期化 ==="

# system user（ストレージ所有者）は除外
SYSTEM_USER="00000000-0000-0000-0000-000000000000"

# 現在のユーザー数（system user 除外）
COUNT=$($COMPOSE exec -T postgres psql -U nakama -d nakama -tAc \
    "SELECT count(*) FROM users WHERE id != '${SYSTEM_USER}';")
echo "  現在のユーザー数: ${COUNT}"

if [ "$COUNT" = "0" ]; then
    echo "  既にクリア済みです。"
    exit 0
fi

# ユーザー名のプレフィックス別サマリ
echo ""
echo "  ユーザー内訳:"
$COMPOSE exec -T postgres psql -U nakama -d nakama -c \
    "SELECT regexp_replace(username, '[0-9_]+$', '*') AS pattern, count(*) AS count, min(create_time)::date AS created FROM users WHERE id != '${SYSTEM_USER}' GROUP BY pattern ORDER BY count DESC LIMIT 20;"

# 手動作成のユーザー（テスト以外）
echo "  手動ユーザー:"
$COMPOSE exec -T postgres psql -U nakama -d nakama -c \
    "SELECT u.username, d.id AS device_id, u.create_time::date AS created FROM users u LEFT JOIN user_device d ON u.id = d.user_id WHERE u.id != '${SYSTEM_USER}' AND u.username NOT LIKE '%\_%' ORDER BY u.username;"
echo ""

# 確認
read -p "  ${COUNT}ユーザーを全て削除しますか？ (y/N): " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "  キャンセルしました。"
    exit 0
fi

# 削除（外部キー制約があるため関連テーブルから先に削除）
$COMPOSE exec -T postgres psql -U nakama -d nakama -c "
    DELETE FROM user_device WHERE user_id != '${SYSTEM_USER}';
    DELETE FROM user_edge WHERE source_id != '${SYSTEM_USER}' AND destination_id != '${SYSTEM_USER}';
    DELETE FROM user_tombstone;
    DELETE FROM users_notes;
    DELETE FROM storage WHERE user_id != '${SYSTEM_USER}';
    DELETE FROM users WHERE id != '${SYSTEM_USER}';
"

echo "  ${COUNT}ユーザー削除完了"
echo ""
echo "⚠️  サーバを再起動してください:"
echo "   cd nakama && ./doRestart.sh"
