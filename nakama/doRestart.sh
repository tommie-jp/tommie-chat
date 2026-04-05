#!/bin/bash
set -e

# prod コンテナが動いていればポート競合を避けるため停止
PROD_COMPOSE="docker compose -p tommchat-prod -f docker-compose.yml -f docker-compose.prod.yml"
if docker ps --format '{{.Names}}' | grep -q 'tommchat-prod'; then
    echo "prod コンテナを停止中..."
    $PROD_COMPOSE down || true
fi

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
$COMPOSE down
$COMPOSE up -d --scale prometheus=0

# 起動確認（最大60秒待機）
# prometheus はスケール0で除外
EXPECTED_SERVICES="postgres nakama web"
echo "コンテナ起動確認中..."
FAILED=0
for svc in $EXPECTED_SERVICES; do
    echo -n "  $svc ... "
    FOUND=false
    for i in $(seq 1 60); do
        if $COMPOSE ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -q "$svc.*running"; then
            echo "OK (${i}s)"
            FOUND=true
            break
        fi
        sleep 1
    done
    if [ "$FOUND" = false ]; then
        echo "FAIL"
        FAILED=1
    fi
done

if [ "$FAILED" -eq 0 ]; then
    echo "✅ 全コンテナ起動成功"
    exit 0
else
    echo "❌ 起動失敗（上記を確認してください）"
    echo "--- docker compose ps ---"
    $COMPOSE ps
    echo "--- ログ (最後の30行) ---"
    $COMPOSE logs --tail=30
    exit 1
fi
