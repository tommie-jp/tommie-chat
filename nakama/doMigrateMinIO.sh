#!/bin/bash
# MinIO データマイグレーション（ローカル ↔ さくらVPS）
# Usage: ./nakama/doMigrateMinIO.sh <VPSホスト> [--pull] [SSHユーザー] [-h]
#
# ローカルと VPS の MinIO データディレクトリ（Bind mount）をコピーする。
# tar.gz にエクスポートし、SCP で転送してインポートする。
#
# 前提:
#   - さくらVPS に SSH 接続可能（鍵認証）
#   - 開発環境（WSL2 Ubuntu 24.04）から実行する
#
# デフォルト: ローカル → VPS（push）
# --pull:     VPS → ローカル（pull）

case "${1:-}" in
    -h|--help|"")
        cat <<'EOF'
Usage: ./nakama/doMigrateMinIO.sh <VPSホスト> [--pull] [SSHユーザー]

開発環境（WSL2 Ubuntu 24.04）から実行する。
ローカルと VPS の MinIO データをコピーする。

引数:
  VPSホスト    SSH接続先（例: mmo.tommie.jp）
  --pull       VPS → ローカル（デフォルトはローカル → VPS）
  SSHユーザー  SSHユーザー名（デフォルト: deploy）

処理内容:
  1. 転送元の MinIO データディレクトリを tar.gz にエクスポート
  2. SCP で転送先に送信
  3. 転送先に展開
  4. 転送先の MinIO を自動再起動

バックアップ:
  push 時、エクスポートした tar.gz を nakama/backup/ にも保存
  3世代まで保持（それ以前は自動削除）

前提:
  - さくらVPS に SSH 鍵認証で接続可能
  - データは Bind mount（nakama/data/minio/）で永続化

例:
  ./nakama/doMigrateMinIO.sh mmo.tommie.jp                # ローカル → VPS
  ./nakama/doMigrateMinIO.sh mmo.tommie.jp --pull          # VPS → ローカル
  ./nakama/doMigrateMinIO.sh mmo.tommie.jp --pull ubuntu   # ユーザー指定
EOF
        exit 0 ;;
esac

set -euo pipefail

VPS_HOST="$1"
shift

# オプション解析
DIRECTION="push"
SSH_USER="deploy"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --pull) DIRECTION="pull"; shift ;;
        *) SSH_USER="$1"; shift ;;
    esac
done

SSH_TARGET="${SSH_USER}@${VPS_HOST}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR=$(mktemp -d)
TMP_FILE="${TMP_DIR}/minio-data.tar.gz"

LOCAL_DATA="$SCRIPT_DIR/data/minio"
REMOTE_DATA="~/tommie-chat/nakama/data/minio"

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# スクリプト終了時に一時ファイルを削除
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── 前提チェック ──
step "0. 前提チェック"

# SSH 接続テスト
echo "  SSH 接続テスト: ${SSH_TARGET}"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_TARGET}"
fi
echo "  ✅ SSH 接続 OK"

if [ "$DIRECTION" = "push" ]; then
    # ── ローカル → VPS ──
    step "1. ローカルの MinIO データを確認"
    if [ ! -d "$LOCAL_DATA" ] || [ -z "$(ls -A "$LOCAL_DATA" 2>/dev/null)" ]; then
        fail "ローカルに MinIO データがありません: ${LOCAL_DATA}"
    fi
    LOCAL_SIZE=$(du -sh "$LOCAL_DATA" | cut -f1)
    echo "  データ: ${LOCAL_DATA}（${LOCAL_SIZE}）"

    step "2. エクスポート"
    tar czf "$TMP_FILE" -C "$SCRIPT_DIR/data" minio
    DUMP_SIZE=$(du -h "$TMP_FILE" | cut -f1)
    echo "  ✅ エクスポート完了（${DUMP_SIZE}）"

    # ローカルにもバックアップを保存
    BACKUP_DIR="$SCRIPT_DIR/backup"
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/minio-data-$(date +%Y%m%d-%H%M%S).tar.gz"
    cp "$TMP_FILE" "$BACKUP_FILE"
    # 3世代まで保持
    ls -t "$BACKUP_DIR"/minio-data-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
    echo "  バックアップ保存: ${BACKUP_FILE}"

    step "3. VPS に転送（SCP）"
    REMOTE_TMP=$(ssh "${SSH_TARGET}" "mktemp -d")
    scp "$TMP_FILE" "${SSH_TARGET}:${REMOTE_TMP}/minio-data.tar.gz"
    echo "  ✅ 転送完了"

    step "4. VPS の MinIO を停止 → 展開 → 再起動"
    # MinIO を停止してからデータを上書き
    ssh "${SSH_TARGET}" "cd ~/tommie-chat/nakama && \
        docker compose -f docker-compose.yml -f docker-compose.prod.yml stop minio 2>/dev/null || \
        docker compose stop minio 2>/dev/null || true"
    echo "  MinIO 停止"

    ssh "${SSH_TARGET}" "mkdir -p ~/tommie-chat/nakama/data && \
        sudo rm -rf ~/tommie-chat/nakama/data/minio && \
        tar xzf ${REMOTE_TMP}/minio-data.tar.gz -C ~/tommie-chat/nakama/data && \
        rm -rf ${REMOTE_TMP}"
    echo "  ✅ 展開完了"

    ssh "${SSH_TARGET}" "cd ~/tommie-chat/nakama && \
        docker compose -f docker-compose.yml -f docker-compose.prod.yml start minio 2>/dev/null || \
        docker compose start minio 2>/dev/null || true"
    echo "  ✅ VPS の MinIO を再起動しました"

else
    # ── VPS → ローカル ──
    step "1. VPS の MinIO データを確認"
    REMOTE_EXISTS=$(ssh "${SSH_TARGET}" "[ -d ${REMOTE_DATA} ] && ls -A ${REMOTE_DATA} 2>/dev/null | head -1")
    if [ -z "$REMOTE_EXISTS" ]; then
        fail "VPS に MinIO データがありません: ${REMOTE_DATA}"
    fi
    REMOTE_SIZE=$(ssh "${SSH_TARGET}" "du -sh ${REMOTE_DATA} | cut -f1")
    echo "  データ: ${REMOTE_DATA}（${REMOTE_SIZE}）"

    step "2. VPS からエクスポート"
    REMOTE_TMP=$(ssh "${SSH_TARGET}" "mktemp -d")
    ssh "${SSH_TARGET}" "tar czf ${REMOTE_TMP}/minio-data.tar.gz -C ~/tommie-chat/nakama/data minio"
    echo "  ✅ エクスポート完了"

    step "3. ローカルに転送（SCP）"
    scp "${SSH_TARGET}:${REMOTE_TMP}/minio-data.tar.gz" "$TMP_FILE"
    ssh "${SSH_TARGET}" "rm -rf ${REMOTE_TMP}"
    DUMP_SIZE=$(du -h "$TMP_FILE" | cut -f1)
    echo "  ✅ 転送完了（${DUMP_SIZE}）"

    step "4. ローカルの MinIO を停止 → 展開 → 再起動"
    cd "$SCRIPT_DIR"
    docker compose -f docker-compose.yml -f docker-compose.prod.yml stop minio 2>/dev/null || \
        docker compose stop minio 2>/dev/null || true
    echo "  MinIO 停止"

    rm -rf "$SCRIPT_DIR/data/minio"
    mkdir -p "$SCRIPT_DIR/data"
    tar xzf "$TMP_FILE" -C "$SCRIPT_DIR/data"
    echo "  ✅ 展開完了"

    docker compose -f docker-compose.yml -f docker-compose.prod.yml start minio 2>/dev/null || \
        docker compose start minio 2>/dev/null || true
    echo "  ✅ ローカルの MinIO を再起動しました"
fi

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  MinIO データコピー完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
if [ "$DIRECTION" = "push" ]; then
    echo "  方向: ローカル → VPS (${SSH_TARGET})"
else
    echo "  方向: VPS (${SSH_TARGET}) → ローカル"
fi
