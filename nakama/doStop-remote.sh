#!/bin/bash
# リモートコンテナ停止（開発環境から VPS のコンテナを停止）
# Usage: ./nakama/doStop-remote.sh [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー] [-h] [-v]
#
# 開発環境（WSL2 Ubuntu 24.04）から実行する。
SCRIPT_VERSION="2026-04-05"

# ── .env.deploy 読み込み（任意、git 管理外） ──
# 形式は doc/40-デプロイ手順.md 参照: DEPLOY_SSH_USER, DEPLOY_SSH_HOST
ENV_DEPLOY="$(cd "$(dirname "$0")" && pwd)/.env.deploy"
if [ -f "$ENV_DEPLOY" ]; then
    # shellcheck source=/dev/null
    set -a; . "$ENV_DEPLOY"; set +a
fi

# ── 引数解析 ──
# 解決順: 引数 > .env.deploy > デフォルト
VPS_HOST="${DEPLOY_SSH_HOST:-}"
SSH_USER="${DEPLOY_SSH_USER:-deploy}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-}"

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./nakama/doStop-remote.sh [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー]

開発環境（WSL2 Ubuntu 24.04）から VPS のコンテナを停止

処理内容:
  1. SSH 接続テスト
  2. VPS 上で docker compose down を実行

引数:
  -d DIR       リモートディレクトリ
               解決順: 引数 > .env.deploy(DEPLOY_REMOTE_DIR) > "~/<VPSホスト>"
  VPSホスト    SSH接続先（例: mmo.tommie.jp, 123.45.67.89）
               nakama/.env.deploy の DEPLOY_SSH_HOST で省略可
  SSHユーザー  SSHユーザー名（解決順: 引数 > .env.deploy > デフォルト "deploy"）

前提:
  - VPS に SSH 鍵認証で接続可能
  - 推奨: nakama/.env.deploy に DEPLOY_SSH_USER / DEPLOY_REMOTE_DIR を設定
    （形式は doc/40-デプロイ手順.md 参照）

例:
  ./nakama/doStop-remote.sh mmo.tommie.jp
  ./nakama/doStop-remote.sh mmo.tommie.jp myuser
  ./nakama/doStop-remote.sh -d ~/mydir mmo.tommie.jp
EOF
            exit 0 ;;
        -v|--version)
            echo "doStop-remote.sh  version: ${SCRIPT_VERSION}"
            exit 0 ;;
        -d)
            REMOTE_DIR="$2"; shift 2 ;;
        --dir=*)
            REMOTE_DIR="${1#--dir=}"; shift ;;
        *)
            if [ -z "$VPS_HOST" ]; then
                VPS_HOST="$1"
            else
                SSH_USER="$1"
            fi; shift ;;
    esac
done

if [ -z "$VPS_HOST" ]; then
    echo "Usage: $0 [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)"
    exit 1
fi

# REMOTE_DIR 未指定時は VPS ホスト名と同じディレクトリをデフォルトにする
if [ -z "$REMOTE_DIR" ]; then
    REMOTE_DIR="~/${VPS_HOST}"
fi

SSH_TARGET="${SSH_USER}@${VPS_HOST}"

echo "doStop-remote.sh  version: ${SCRIPT_VERSION}"
echo "  remote dir: ${REMOTE_DIR}"
echo ""

set -euo pipefail

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# ── 1. SSH 接続テスト ──
step "1. SSH 接続テスト"
echo "  接続先: ${SSH_TARGET}"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_TARGET}"
fi
echo "  ✅ SSH 接続 OK"

# ── 2. コンテナ停止 ──
step "2. コンテナ停止"
ssh "${SSH_TARGET}" "cd ${REMOTE_DIR}/nakama && bash doStop.sh --prod"

# ── 3. 状態確認 ──
step "3. 状態確認"
ssh "${SSH_TARGET}" "docker ps --filter 'name=tommchat-prod' --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || true"
REMAINING=$(ssh "${SSH_TARGET}" "docker ps -q --filter 'name=tommchat-prod' 2>/dev/null | wc -l")
if [ "$REMAINING" -eq 0 ]; then
    echo "  ✅ tommieChat コンテナはすべて停止しました"
else
    echo "  ⚠️  ${REMAINING} 個のコンテナがまだ動いています"
fi

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  リモートコンテナ停止完了${RESET}"
echo "${GREEN}=========================================${RESET}"
