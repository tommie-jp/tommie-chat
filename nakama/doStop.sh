#!/bin/bash
# Nakama サーバ関連コンテナをすべて停止するスクリプト
# Usage: ./nakama/doStop.sh [-h]

case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  Nakama サーバ関連コンテナをすべて停止します"
        exit 0 ;;
esac

set -e

cd "$(dirname "$0")"

# 開発環境・本番環境どちらのコンテナも停止
if [ -f docker-compose.prod.yml ]; then
    docker compose -f docker-compose.yml -f docker-compose.prod.yml down 2>/dev/null || true
fi
docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>/dev/null || true

echo "✅ 全コンテナ停止完了"
