#!/bin/bash
# リモートコンテナ停止（開発環境から VPS のコンテナを停止）
# Usage: ./nakama/doStop-remote.sh <VPSホスト> [SSHユーザー] [-h] [-v]
#
# 開発環境（WSL2 Ubuntu 24.04）から実行する。
SCRIPT_VERSION="2026-04-05"

# ── 引数解析 ──
VPS_HOST=""
SSH_USER="deploy"

for arg in "$@"; do
    case "$arg" in
        -h|--help)
            cat <<'EOF'
Usage: ./nakama/doStop-remote.sh <VPSホスト> [SSHユーザー]

開発環境（WSL2 Ubuntu 24.04）から VPS のコンテナを停止

処理内容:
  1. SSH 接続テスト
  2. VPS 上で docker compose down を実行

引数:
  VPSホスト    SSH接続先（例: mmo.tommie.jp, 123.45.67.89）
  SSHユーザー  SSHユーザー名（デフォルト: deploy）

前提:
  - VPS に SSH 鍵認証で接続可能

例:
  ./nakama/doStop-remote.sh mmo.tommie.jp
  ./nakama/doStop-remote.sh mmo.tommie.jp deploy
EOF
            exit 0 ;;
        -v|--version)
            echo "doStop-remote.sh  version: ${SCRIPT_VERSION}"
            exit 0 ;;
        *)
            if [ -z "$VPS_HOST" ]; then
                VPS_HOST="$arg"
            else
                SSH_USER="$arg"
            fi ;;
    esac
done

if [ -z "$VPS_HOST" ]; then
    echo "Usage: $0 <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)"
    exit 1
fi

SSH_TARGET="${SSH_USER}@${VPS_HOST}"
REMOTE_DIR="~/tommie-chat"

echo "doStop-remote.sh  version: ${SCRIPT_VERSION}"
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
