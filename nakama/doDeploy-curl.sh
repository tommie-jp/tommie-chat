#!/bin/bash
# 本番デプロイ（curl でリポジトリを取得して doDeploy.sh を実行）
# Usage: ./doDeploy-curl.sh [-h] [-v]
#
# さくらVPS 上で実行する。
# git clone 後、開発環境から dist/ を rsync してもらい、doDeploy.sh を実行する。
SCRIPT_VERSION="2026-04-03"

case "${1:-}" in
    -h|--help)
        cat <<'EOF'
Usage: ./doDeploy-curl.sh [-h] [-v]

さくらVPS 本番デプロイ（VPS 上で実行）

git clone → dist/ 転送待ち → doDeploy.sh を実行します。
任意のディレクトリに配置して使えます。

処理内容:
  1. tommie-chat リポジトリを git clone
  2. dist/ の転送を待機（開発環境から rsync）
  3. nakama/doDeploy.sh（Docker 環境構築・サーバー起動・MinIO 初期化）

前提:
  - VPS に deploy ユーザーで SSH ログイン済み
  - 開発環境（WSL2 Ubuntu 24.04）に Node.js がインストール済み

手順:
  # --- VPS で実行 ---
  curl -fsSL https://raw.githubusercontent.com/open-tommie/tommie-chat/main/nakama/doDeploy-curl.sh -o doDeploy-curl.sh
  chmod +x doDeploy-curl.sh
  ./doDeploy-curl.sh
  # → git clone 後に rsync コマンドが表示される

  # --- 開発環境（WSL2）で実行 ---
  cd ~/24-mmo-Tommie-chat
  npm run build
  rsync -avz --delete dist/ deploy@<VPS_IP>:~/tommie-chat/dist/

  # → VPS 側で Enter を押すとデプロイが続行される
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

# ── git clone ──
git clone https://github.com/open-tommie/tommie-chat.git

# ── dist/ の転送待ち ──
VPS_IP=$(hostname -I | awk '{print $1}')
DIST_DIR="${SCRIPT_DIR}/tommie-chat/dist"

if [ ! -d "$DIST_DIR" ] || [ ! -f "$DIST_DIR/index.html" ]; then
    echo ""
    echo "━━━ dist/ の転送待ち ━━━"
    echo ""
    echo "開発環境（WSL2）で以下を実行してください:"
    echo ""
    echo "  cd ~/24-mmo-Tommie-chat"
    echo "  cat > .env <<'EOF'"
    echo "  VITE_SERVER_KEY=tommie-chat"
    echo "  VITE_DEFAULT_HOST=mmo.tommie.jp"
    echo "  VITE_DEFAULT_PORT=443"
    echo "  EOF"
    echo "  npm run build"
    echo "  rm .env"
    echo "  rsync -avz --delete dist/ deploy@${VPS_IP}:${DIST_DIR}/"
    echo ""
    read -p "rsync 完了後、Enter を押してください..."

    if [ ! -f "$DIST_DIR/index.html" ]; then
        echo "❌ dist/index.html が見つかりません。rsync が正しく実行されたか確認してください。"
        exit 1
    fi
fi

DIST_FILES=$(find "$DIST_DIR" -type f | wc -l)
echo "✅ dist/ 確認完了（${DIST_FILES} ファイル）"

# ── doDeploy.sh 実行 ──
cd tommie-chat/nakama
bash doDeploy.sh
