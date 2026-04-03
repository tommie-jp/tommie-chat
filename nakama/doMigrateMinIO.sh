#!/bin/bash
# MinIO データマイグレーション（ローカル → さくらVPS / さくらVPS → ローカル）
# Usage: ./nakama/doMigrateMinIO.sh <VPSホスト> [--pull] [SSHユーザー] [-h]
#
# ローカルと VPS の MinIO 間でバケットデータを同期する。
# SSH トンネル経由で VPS の MinIO にアクセスし、mc mirror で差分同期する。
#
# 前提:
#   - さくらVPS に SSH 接続可能（鍵認証）
#   - ローカル・VPS 両方で MinIO コンテナが起動中
#
# デフォルト: ローカル → VPS（push）
# --pull:     VPS → ローカル（pull）

case "${1:-}" in
    -h|--help|"")
        echo "Usage: $0 <VPSホスト> [--pull] [SSHユーザー]"
        echo "  ローカルと VPS の MinIO 間でデータを同期します"
        echo ""
        echo "引数:"
        echo "  VPSホスト    SSH接続先（例: mmo.tommie.jp）"
        echo "  --pull       VPS → ローカル（デフォルトはローカル → VPS）"
        echo "  SSHユーザー  SSHユーザー名（デフォルト: deploy）"
        echo ""
        echo "例:"
        echo "  $0 mmo.tommie.jp                    # ローカル → VPS"
        echo "  $0 mmo.tommie.jp --pull              # VPS → ローカル"
        echo "  $0 mmo.tommie.jp --pull ubuntu        # ユーザー指定"
        echo ""
        echo "同期対象バケット: avatars, assets, uploads"
        echo "差分同期（mc mirror）: 変更・追加ファイルのみ転送"
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUCKETS=("avatars" "assets" "uploads")

# SSH トンネルのローカルポート（VPS の MinIO 9000 をフォワード）
TUNNEL_PORT=19000

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# .env から MinIO 認証情報を読み込み（ローカル用）
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a; source "$SCRIPT_DIR/.env"; set +a
fi
LOCAL_MINIO_USER="${MINIO_ROOT_USER:-minioadmin}"
LOCAL_MINIO_PASS="${MINIO_ROOT_PASSWORD:-minioadmin}"

# ── 前提チェック ──
step "0. 前提チェック"

# ローカルの MinIO が起動しているか
cd "$SCRIPT_DIR"
LOCAL_MINIO=$(docker ps --format '{{.Names}}' --filter "name=minio" 2>/dev/null | head -1)
if [ -z "$LOCAL_MINIO" ]; then
    fail "ローカルの MinIO コンテナが起動していません。docker compose up -d minio を実行してください"
fi
echo "  ローカル MinIO: ${LOCAL_MINIO}"

# SSH 接続テスト
echo "  SSH 接続テスト: ${SSH_USER}@${VPS_HOST}"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_USER}@${VPS_HOST}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_USER}@${VPS_HOST}"
fi

# VPS の MinIO 認証情報を取得
REMOTE_MINIO_USER=$(ssh "${SSH_USER}@${VPS_HOST}" \
    "grep MINIO_ROOT_USER ~/tommie-chat/nakama/.env 2>/dev/null | cut -d= -f2" || echo "")
REMOTE_MINIO_PASS=$(ssh "${SSH_USER}@${VPS_HOST}" \
    "grep MINIO_ROOT_PASSWORD ~/tommie-chat/nakama/.env 2>/dev/null | cut -d= -f2" || echo "")

if [ -z "$REMOTE_MINIO_USER" ] || [ -z "$REMOTE_MINIO_PASS" ]; then
    warn "VPS の .env から MinIO 認証情報を取得できません。デフォルト値を使用します"
    REMOTE_MINIO_USER="minioadmin"
    REMOTE_MINIO_PASS="minioadmin"
fi

# ── 1. SSH トンネル開設 ──
step "1. SSH トンネル開設（VPS MinIO:9000 → localhost:${TUNNEL_PORT}）"

# 既存トンネルがあれば終了
if lsof -i :${TUNNEL_PORT} >/dev/null 2>&1; then
    warn "ポート ${TUNNEL_PORT} が使用中です。既存のトンネルを終了します"
    kill $(lsof -t -i :${TUNNEL_PORT}) 2>/dev/null || true
    sleep 1
fi

ssh -f -N -L ${TUNNEL_PORT}:127.0.0.1:9000 "${SSH_USER}@${VPS_HOST}"
TUNNEL_PID=$(lsof -t -i :${TUNNEL_PORT} 2>/dev/null | head -1)

if [ -z "$TUNNEL_PID" ]; then
    fail "SSH トンネルの開設に失敗しました"
fi
echo "  トンネル開設完了 (PID: ${TUNNEL_PID})"

# スクリプト終了時にトンネルを閉じる
cleanup() {
    if [ -n "${TUNNEL_PID:-}" ]; then
        kill "$TUNNEL_PID" 2>/dev/null || true
        echo "  SSH トンネルを閉じました"
    fi
}
trap cleanup EXIT

# ── 2. mc エイリアス設定 ──
step "2. mc エイリアス設定"

# ローカル MinIO
docker exec "$LOCAL_MINIO" mc alias set local http://localhost:9000 \
    "$LOCAL_MINIO_USER" "$LOCAL_MINIO_PASS" >/dev/null 2>&1
echo "  local  → localhost:9000"

# VPS MinIO（SSH トンネル経由）
docker exec "$LOCAL_MINIO" mc alias set remote http://host.docker.internal:${TUNNEL_PORT} \
    "$REMOTE_MINIO_USER" "$REMOTE_MINIO_PASS" >/dev/null 2>&1
echo "  remote → VPS:9000 (via SSH tunnel :${TUNNEL_PORT})"

# 接続テスト
if ! docker exec "$LOCAL_MINIO" mc ls remote/ >/dev/null 2>&1; then
    fail "VPS の MinIO に接続できません。SSH トンネルまたは認証情報を確認してください"
fi
echo "  接続テスト OK"

# ── 3. バケット同期 ──
if [ "$DIRECTION" = "push" ]; then
    step "3. バケット同期（ローカル → VPS）"
    SRC="local"
    DST="remote"
else
    step "3. バケット同期（VPS → ローカル）"
    SRC="remote"
    DST="local"
fi

TOTAL_SYNCED=0
for bucket in "${BUCKETS[@]}"; do
    echo ""
    echo "  --- ${bucket} ---"

    # 転送元バケットの存在チェック
    if ! docker exec "$LOCAL_MINIO" mc ls "${SRC}/${bucket}/" >/dev/null 2>&1; then
        echo "  スキップ（転送元にバケットなし）"
        continue
    fi

    # 転送先バケットがなければ作成
    docker exec "$LOCAL_MINIO" mc mb --ignore-existing "${DST}/${bucket}" >/dev/null 2>&1

    # ドライラン（転送量の確認）
    DRY_OUTPUT=$(docker exec "$LOCAL_MINIO" mc mirror --dry-run "${SRC}/${bucket}/" "${DST}/${bucket}/" 2>&1 || true)
    FILE_COUNT=$(echo "$DRY_OUTPUT" | grep -c "^http" || echo 0)

    if [ "$FILE_COUNT" -eq 0 ]; then
        echo "  同期済み（差分なし）"
        continue
    fi

    echo "  転送ファイル数: ${FILE_COUNT}"

    # 同期実行
    docker exec "$LOCAL_MINIO" mc mirror --overwrite "${SRC}/${bucket}/" "${DST}/${bucket}/" 2>&1 | \
        while IFS= read -r line; do echo "    $line"; done

    TOTAL_SYNCED=$((TOTAL_SYNCED + FILE_COUNT))
    echo "  ✅ ${bucket} 同期完了"
done

# ── 4. 公開ポリシーの設定（push 時のみ） ──
if [ "$DIRECTION" = "push" ]; then
    step "4. 公開ポリシー設定（VPS 側）"
    docker exec "$LOCAL_MINIO" mc anonymous set download remote/avatars >/dev/null 2>&1 && echo "  avatars: public-read" || true
    docker exec "$LOCAL_MINIO" mc anonymous set download remote/assets >/dev/null 2>&1 && echo "  assets:  public-read" || true
    echo "  uploads: private（変更なし）"
fi

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  MinIO データ同期完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
if [ "$DIRECTION" = "push" ]; then
    echo "  方向:   ローカル → VPS (${SSH_USER}@${VPS_HOST})"
else
    echo "  方向:   VPS (${SSH_USER}@${VPS_HOST}) → ローカル"
fi
echo "  転送数: ${TOTAL_SYNCED} ファイル"
echo "  バケット: ${BUCKETS[*]}"
