#!/bin/bash
# デプロイテスト（git clone → ビルド → doDeploy.sh → 疎通テスト + MinIO テスト）
# Usage: ./test/doDeployTest.sh [-h] [-v]
#
# 本番デプロイ前にローカル環境（WSL2 Ubuntu 24.04）で一括テストする。
# 別ディレクトリに git clone し、ビルド → デプロイ → テストを順に実行する。

case "${1:-}" in
    -h|--help)
        cat <<'EOF'
Usage: ./test/doDeployTest.sh [-h] [-v]

本番デプロイ前のローカル一括テスト（WSL2 Ubuntu 24.04 で実行）

処理内容:
  1. tommie-chat リポジトリを git clone
  2. npm install && npm run build（フロントエンドビルド）
  3. nakama/doDeploy.sh（Docker 環境構築・サーバー起動）
  4. doTest-ping.sh（疎通テスト 5項目）
  5. doTest-minio.sh（MinIO 疎通テスト 11項目）

前提:
  - Docker がインストール済み
  - Node.js がインストール済み
  - スクリプトと同じディレクトリに tommie-chat/ がクローンされる

例:
  mkdir -p ~/deploy-test && cd ~/deploy-test
  curl -fsSL https://raw.githubusercontent.com/open-tommie/tommie-chat/main/test/doDeployTest.sh -o doDeployTest.sh
  chmod +x doDeployTest.sh
  ./doDeployTest.sh
EOF
        exit 0 ;;
    -v|--version)
        SELF="${BASH_SOURCE[0]:-$0}"
        echo "doDeployTest.sh  最終変更: $(date -r "$SELF" '+%Y-%m-%d %H:%M:%S')"
        exit 0 ;;
esac

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -d "tommie-chat" ]; then
    read -p "tommie-chat ディレクトリが既に存在します。削除しますか？ (y/N): " ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
        # 既存コンテナを停止・削除（Bind mount のデータは保持される）
        echo "既存のコンテナを停止・削除します..."
        cd tommie-chat/nakama 2>/dev/null && {
            docker compose -f docker-compose.yml -f docker-compose.prod.yml down 2>/dev/null || true
            docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>/dev/null || true
            docker compose down 2>/dev/null || true
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

git clone https://github.com/open-tommie/tommie-chat.git
cd tommie-chat

# フロントエンドビルド（本番では開発環境で事前ビルドする想定だが、テストではここで実行）
npm install
npm run build

cd nakama
bash doDeploy.sh

# デプロイ後テスト
echo ""
echo "━━━ テスト実行 ━━━"
cd ../test
set -a
source ../nakama/.env
set +a
./doTest-ping.sh
echo ""
echo "━━━ MinIO テスト ━━━"
./minio/doTest-minio.sh
