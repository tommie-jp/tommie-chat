#!/bin/bash
set -e

docker compose down
docker compose up -d --scale prometheus=0

# 起動確認（最大30秒待機）
echo "nakamaコンテナ起動確認中..."
for i in $(seq 1 30); do
    if docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -q 'nakama.*running'; then
        echo "✅ nakama 起動成功"
        exit 0
    fi
    sleep 1
done

echo "❌ nakama 起動失敗（30秒以内に起動しませんでした）"
echo "--- docker compose ps ---"
docker compose ps
echo "--- nakama ログ (最後の30行) ---"
docker compose logs --tail=30 nakama
exit 1
