#!/bin/bash
# 再接続テスト
# WebSocket切断→再接続後の状態復元を検証する。
#
# Usage: ./test/doTest-reconnect.sh [-h]

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./test/doTest-reconnect.sh [-h]

WebSocket切断→再接続後の状態復元を検証するテストです。

テスト内容:
  1. 切断→再接続で新sessionIdを取得
  2. 再接続後に他プレイヤーのAOI_ENTERを受信
  3. 再接続後に他プレイヤーが新セッションのAOI_ENTERを受信
  4. 再接続後にプロフィール取得が正常動作（自分・他プレイヤー双方向）
  5. 古いsessionIdでプロフィール取得すると空で返る
  6. 3回連続再接続しても正常動作

オプション:
  -h    このヘルプを表示

環境変数:
  NAKAMA_HOST         接続先ホスト (デフォルト: 127.0.0.1)
  NAKAMA_PORT         Nakama API ポート (デフォルト: 7350)
  NAKAMA_SERVER_KEY   サーバキー (docker-compose.yml から自動取得)

前提:
  nakama サーバが起動していること
    cd nakama && docker compose up -d

例:
  ./test/doTest-reconnect.sh
  NAKAMA_HOST=mmo.tommie.jp ./test/doTest-reconnect.sh
EOF
            exit 0 ;;
        *)
            echo "不明なオプション: $1  (-h でヘルプ表示)"; exit 1 ;;
    esac
done

cd "$(dirname "$0")/.."

# .env から NAKAMA_SERVER_KEY 等を自動読み込み
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f nakama/.env ]; then
    set -a; source nakama/.env; set +a
fi

# .env が無い場合、docker-compose.yml から server_key を自動取得
if [ -z "${NAKAMA_SERVER_KEY:-}" ]; then
    KEY=$(grep -oP '(?<=--socket\.server_key\s)\S+' nakama/docker-compose.yml 2>/dev/null | head -1)
    if [ -n "$KEY" ]; then
        export NAKAMA_SERVER_KEY="$KEY"
    fi
fi

echo "--- 再接続テスト ---"
echo "host: ${NAKAMA_HOST:-127.0.0.1}:${NAKAMA_PORT:-7350}"
echo ""

npx vitest run test/nakama-reconnect.test.ts --reporter=verbose 2>&1
EXIT_CODE=$?

echo ""
if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ 再接続テスト成功"
else
    echo "❌ 再接続テスト失敗"
fi
exit $EXIT_CODE
