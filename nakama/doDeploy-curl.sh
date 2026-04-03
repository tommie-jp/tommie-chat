#!/bin/bash
# 本番デプロイ（curl でリポジトリを取得して doDeploy.sh を実行）
# Usage: ./doDeploy-curl.sh [-h] [-v]
#
# さくらVPS 上で実行する。
# git clone → doDeploy.sh を一括で行う。
# フロントエンド（dist/）は開発環境から rsync で事前に転送しておくこと。
SCRIPT_VERSION="2026-04-03"

case "${1:-}" in
    -h|--help)
        cat <<'EOF'
Usage: ./doDeploy-curl.sh [-h] [-v]

さくらVPS への本番デプロイ（VPS 上で実行）

git clone して doDeploy.sh を実行します。
任意のディレクトリに配置して使えます。

処理内容:
  1. tommie-chat リポジトリを git clone
  2. nakama/doDeploy.sh（Docker 環境構築・サーバー起動・MinIO 初期化）

前提:
  - VPS に deploy ユーザーで SSH ログイン済み
  - フロントエンド（dist/）を開発環境から rsync 済み
    （rsync -avz --delete dist/ deploy@<VPS>:~/tommie-chat/dist/）

セットアップ:
  curl -fsSL https://raw.githubusercontent.com/open-tommie/tommie-chat/main/nakama/doDeploy-curl.sh -o doDeploy-curl.sh
  chmod +x doDeploy-curl.sh
  ./doDeploy-curl.sh
EOF
        exit 0 ;;
    -v|--version)
        echo "doDeploy-curl.sh  version: ${SCRIPT_VERSION}"
        exit 0 ;;
esac

echo "doDeploy-curl.sh  version: ${SCRIPT_VERSION}"
echo ""

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── 既存ディレクトリの処理 ──
if [ -d "tommie-chat" ]; then
    read -p "tommie-chat ディレクトリが既に存在します。削除しますか？ (y/N): " ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
        # 既存コンテナ・ボリュームを停止・削除
        echo "既存のコンテナを停止・削除します..."
        cd tommie-chat/nakama 2>/dev/null && {
            docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v 2>/dev/null || true
            docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v 2>/dev/null || true
            docker compose down -v 2>/dev/null || true
            cd "$SCRIPT_DIR"
        } || true
        # 残留コンテナがあれば強制削除
        REMAINING=$(docker ps -aq --filter "name=nakama" 2>/dev/null; docker ps -aq --filter "name=tommchat-prod" 2>/dev/null)
        REMAINING=$(echo "$REMAINING" | sort -u | grep -v '^$' || true)
        if [ -n "$REMAINING" ]; then
            echo "$REMAINING" | xargs -r docker rm -f
        fi
        rm -rf tommie-chat
        echo "削除しました"
    else
        echo "中止します"
        exit 1
    fi
fi

# ── git clone ──
git clone https://github.com/open-tommie/tommie-chat.git

# ── dist/ の確認（rsync 済みか） ──
if [ ! -d "tommie-chat/dist" ] || [ ! -f "tommie-chat/dist/index.html" ]; then
    echo ""
    echo "⚠️  dist/ が見つかりません。"
    echo "   開発環境（WSL2）で以下を実行してから再度このスクリプトを実行してください:"
    echo ""
    echo "   npm run build"
    echo "   rsync -avz --delete dist/ deploy@$(hostname -I | awk '{print $1}'):${SCRIPT_DIR}/tommie-chat/dist/"
    echo ""
    exit 1
fi

# ── doDeploy.sh 実行 ──
cd tommie-chat/nakama
bash doDeploy.sh
