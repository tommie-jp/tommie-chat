#!/bin/bash
# 初期地面データ投入スクリプト
#
# OP_BLOCK_UPDATE を使い、テスト用の地面データをサーバに書き込む。
# 中央付近に 32x32 の地面パターンを生成する。
#
# 前提: Nakama サーバが起動していること
#
# 使い方:
#   ./test/doSeedGround.sh
#   ./test/doSeedGround.sh --host 127.0.0.1 --port 7350

set -e
cd "$(dirname "$0")/.."

# 引数をそのまま vitest に渡す環境変数に変換
while [[ $# -gt 0 ]]; do
    case $1 in
        --host) export NAKAMA_HOST="$2"; shift 2 ;;
        --port) export NAKAMA_PORT="$2"; shift 2 ;;
        *) shift ;;
    esac
done

echo "=== 地面データ投入 ==="
npx vitest run test/seed-ground.test.ts 2>&1
echo ""
echo "⚠️  サーバのメモリ上には反映済みです（再起動不要）"
