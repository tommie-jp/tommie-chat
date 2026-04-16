#!/bin/bash
# 初期地面データ投入スクリプト
#
# OP_BLOCK_UPDATE を使い、テスト用の地面データをサーバに書き込む。
#
# 前提: Nakama サーバが起動していること
#
# 使い方:
#   ./test/doSeedGround.sh                    # デフォルト: 広場パターン
#   ./test/doSeedGround.sh --pattern plaza    # 広場パターン
#   ./test/doSeedGround.sh --pattern 4color   # 4色テスト用
#   ./test/doSeedGround.sh --host 127.0.0.1 --port 7350

set -e
cd "$(dirname "$0")/.."
source "$(dirname "$0")/lib/nakama-test-lib.sh"

# 引数パース
OPT_HOST=""
OPT_PORT=""
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            echo "使い方: $0 [オプション]"
            echo ""
            echo "オプション:"
            echo "  -p, --pattern <名前>  地面パターン（デフォルト: plaza）"
            echo "    plaza   広場: 中央白広場 + 芝生 + 十字小道 + 池"
            echo "    4color  4色テスト: 象限ごとに緑/茶/青/灰"
            echo "    clear   地面クリア: plaza 範囲のブロックを全削除"
            echo "  --host <ホスト>    Nakama サーバホスト（デフォルト: 127.0.0.1）"
            echo "  --port <ポート>    Nakama サーバポート（デフォルト: 7350）"
            echo "  -h, --help         このヘルプを表示"
            exit 0
            ;;
        --host) OPT_HOST="$2"; shift 2 ;;
        --port) OPT_PORT="$2"; shift 2 ;;
        -p|--pattern) export SEED_PATTERN="$2"; shift 2 ;;
        *) echo "不明なオプション: $1（-h でヘルプ表示）"; exit 1 ;;
    esac
done

load_nakama_config

PATTERN="${SEED_PATTERN:-plaza}"
echo "=== 地面データ投入（パターン: ${PATTERN}） ==="
npx vitest run test/seed-ground.test.ts 2>&1
echo ""
echo "⚠️  サーバのメモリ上には反映済みです（再起動不要）"
