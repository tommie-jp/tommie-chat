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

docker compose down

echo "✅ 全コンテナ停止完了"
