#!/bin/bash
# リモートデプロイ（開発環境から VPS へ一括デプロイ）
# Usage: ./nakama/doDeploy-remote.sh <VPSホスト> [SSHユーザー] [-h] [-v]
#
# 開発環境（WSL2 Ubuntu 24.04）から実行する。
# フロントエンドビルド → git clone → dist/ 転送 → doDeploy.sh を一括で行う。
SCRIPT_VERSION="2026-04-03"

case "${1:-}" in
    -h|--help)
        cat <<'EOF'
Usage: ./nakama/doDeploy-remote.sh <VPSホスト> [SSHユーザー]

開発環境（WSL2 Ubuntu 24.04）から VPS へ一括デプロイ

処理内容:
  1. フロントエンドビルド（npm run build）
  2. VPS に git clone（既存があれば削除確認）
  3. dist/ を VPS に rsync
  4. VPS 上で doDeploy.sh を実行（SSH 経由）

引数:
  VPSホスト    SSH接続先（例: mmo.tommie.jp, 123.45.67.89）
  SSHユーザー  SSHユーザー名（デフォルト: deploy）

前提:
  - VPS に SSH 鍵認証で接続可能
  - Node.js がインストール済み（開発環境）

例:
  ./nakama/doDeploy-remote.sh mmo.tommie.jp
  ./nakama/doDeploy-remote.sh mmo.tommie.jp deploy
EOF
        exit 0 ;;
    -v|--version)
        echo "doDeploy-remote.sh  version: ${SCRIPT_VERSION}"
        exit 0 ;;
    "")
        echo "Usage: $0 <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)"
        exit 1 ;;
esac

VPS_HOST="$1"
SSH_USER="${2:-deploy}"
SSH_TARGET="${SSH_USER}@${VPS_HOST}"
REMOTE_DIR="~/tommie-chat"

echo "doDeploy-remote.sh  version: ${SCRIPT_VERSION}"
echo ""

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# ── 前提チェック ──
step "0. 前提チェック"

# SSH 接続テスト
echo "  SSH 接続テスト: ${SSH_TARGET}"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_TARGET}"
fi
echo "  ✅ SSH 接続 OK"

# Node.js
if ! command -v node &>/dev/null; then
    fail "Node.js がインストールされていません"
fi
echo "  ✅ Node.js $(node --version)"

# ── 1. フロントエンドビルド ──
step "1. フロントエンドビルド（ローカル）"
cd "$ROOT_DIR"

cat > .env <<'EOF'
VITE_SERVER_KEY=tommie-chat
VITE_DEFAULT_HOST=mmo.tommie.jp
VITE_DEFAULT_PORT=443
EOF

npm install --silent
npm run build
rm -f .env

DIST_FILES=$(find dist -type f | wc -l)
echo "✅ ビルド完了（${DIST_FILES} ファイル）"

# ── 2. VPS に git clone ──
step "2. VPS に git clone"

# 既存ディレクトリの確認
if ssh "${SSH_TARGET}" "[ -d ${REMOTE_DIR} ]" 2>/dev/null; then
    echo "  ${REMOTE_DIR} が既に存在します"
    read -p "  削除して再クローンしますか？ (y/N): " ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
        echo "  既存コンテナを停止・削除中..."
        ssh "${SSH_TARGET}" bash -c "'
            cd ${REMOTE_DIR}/nakama 2>/dev/null && {
                docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v 2>/dev/null || true
                docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v 2>/dev/null || true
                docker compose down -v 2>/dev/null || true
            } || true
            REMAINING=\$(docker ps -aq --filter \"name=nakama\" 2>/dev/null; docker ps -aq --filter \"name=tommchat-prod\" 2>/dev/null)
            REMAINING=\$(echo \"\$REMAINING\" | sort -u | grep -v \"^\$\" || true)
            if [ -n \"\$REMAINING\" ]; then
                echo \"\$REMAINING\" | xargs -r docker rm -f
            fi
            rm -rf ${REMOTE_DIR}
        '"
        echo "  削除しました"
    else
        echo "  既存ディレクトリを使用します（git pull）"
        ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && git pull"
    fi
fi

# clone（ディレクトリがない場合のみ）
if ! ssh "${SSH_TARGET}" "[ -d ${REMOTE_DIR} ]" 2>/dev/null; then
    ssh "${SSH_TARGET}" "git clone https://github.com/open-tommie/tommie-chat.git ${REMOTE_DIR}"
fi
echo "✅ リポジトリ準備完了"

# ── 3. dist/ を VPS に転送 ──
step "3. dist/ を VPS に転送（rsync）"
rsync -avz --delete "$ROOT_DIR/dist/" "${SSH_TARGET}:${REMOTE_DIR}/dist/"
echo "✅ dist/ 転送完了"

# ── 4. VPS で doDeploy.sh 実行 ──
step "4. VPS で doDeploy.sh 実行（SSH 経由）"
ssh -t "${SSH_TARGET}" "cd ${REMOTE_DIR}/nakama && bash doDeploy.sh"

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  リモートデプロイ完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "次のステップ:"
echo "  疎通テスト:  ./test/doTest-ping.sh --host ${VPS_HOST}"
echo "  HTTPS 設定:  ssh ${SSH_TARGET} 'cd ${REMOTE_DIR}/nakama && bash doSetupHTTPS.sh ${VPS_HOST}'"
