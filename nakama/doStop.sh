#!/bin/bash
# Nakama サーバ関連コンテナを停止するスクリプト
# Usage: ./nakama/doStop.sh [--dev|--prod] [-h]

case "${1:-}" in
    -h|--help)
        echo "Usage: $0 [--dev|--prod]"
        echo "  Nakama サーバ関連コンテナを停止します"
        echo ""
        echo "  (引数なし)  開発・本番の両方を停止"
        echo "  --dev       開発環境のみ停止"
        echo "  --prod      本番環境のみ停止"
        exit 0 ;;
esac

set -e

cd "$(dirname "$0")"

case "${1:-}" in
    --dev)
        docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>/dev/null || true
        echo "✅ 開発環境コンテナ停止完了"
        ;;
    --prod)
        docker compose -f docker-compose.yml -f docker-compose.prod.yml down 2>/dev/null || true
        echo "✅ 本番環境コンテナ停止完了"
        ;;
    "")
        if [ -f docker-compose.prod.yml ]; then
            docker compose -f docker-compose.yml -f docker-compose.prod.yml down 2>/dev/null || true
        fi
        docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>/dev/null || true
        echo "✅ 全コンテナ停止完了"
        ;;
    *)
        echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
esac
