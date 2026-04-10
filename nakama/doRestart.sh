#!/bin/bash
set -e

# 本番判定（優先順位）:
#   1. 環境変数 TOMMIE_PROD=1
#   2. マーカーファイル /etc/tommie-chat-prod が存在
#   それ以外は dev 環境
#
# 旧来は whoami=deploy で判定していたが、ユーザー名と本番判定が密結合し
# ユーザー名変更で本番に dev compose が起動するリスクがあったため変更。
# 既存環境を本番化するには VPS で次を 1 回実行:
#   sudo touch /etc/tommie-chat-prod
if [ "${TOMMIE_PROD:-}" = "1" ] || [ -f /etc/tommie-chat-prod ]; then
    IS_PROD=true
else
    IS_PROD=false
fi

if [ "$IS_PROD" = true ]; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
    echo "本番環境で再起動します..."
    $COMPOSE down
    $COMPOSE up -d
else
    # dev: prod コンテナが動いていればポート競合を避けるため停止
    PROD_COMPOSE="docker compose -p tommchat-prod -f docker-compose.yml -f docker-compose.prod.yml"
    if docker ps --format '{{.Names}}' | grep -q 'tommchat-prod'; then
        echo "prod コンテナを停止中..."
        $PROD_COMPOSE down || true
    fi
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
    $COMPOSE down
    $COMPOSE up -d --scale prometheus=0
fi

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
