#!/bin/bash
# 地面データマイグレーション（さくらVPS → ローカル開発環境）
# Usage: ./nakama/doMigrateGround.sh <VPSホスト> [SSHユーザー] [-h]
#
# さくらVPS の PostgreSQL から地面データ (world_data コレクション) を
# SQL ダンプし、ローカル開発環境の PostgreSQL にインポートする。
#
# 前提:
#   - さくらVPS に SSH 接続可能（鍵認証）
#   - さくらVPS で PostgreSQL コンテナが起動中
#   - ローカルで docker compose (dev) が起動中
#
# 処理の流れ:
#   1. SSH 経由でさくらVPS の PostgreSQL から地面データを SQL ダンプ
#      (pg_dump --data-only --column-inserts --where)
#   2. ローカルの PostgreSQL の既存地面データを削除
#   3. SQL をローカルの PostgreSQL にインポート

case "${1:-}" in
    -h|--help|"")
        echo "Usage: $0 <VPSホスト> [SSHユーザー]"
        echo "  さくらVPS の地面データをローカル開発環境に移行します"
        echo ""
        echo "引数:"
        echo "  VPSホスト    SSH接続先（例: mmo.tommie.jp, 123.45.67.89）"
        echo "               nakama/.env.deploy の DEPLOY_SSH_HOST で省略可"
        echo "  SSHユーザー  SSHユーザー名（解決順: 引数 > .env.deploy > デフォルト \"deploy\"）"
        echo ""
        echo "推奨: nakama/.env.deploy に DEPLOY_SSH_USER / DEPLOY_SSH_HOST を設定"
        echo "      （形式は doc/40-デプロイ手順.md 参照）"
        echo ""
        echo "例:"
        echo "  $0 mmo.tommie.jp"
        echo "  $0 mmo.tommie.jp myuser"
        echo ""
        echo "データ内容:"
        echo "  Nakama Storage: collection='world_data', key='chunk_X_Z'"
        echo "  64x64 チャンク × 16x16 セル の地面ブロックID"
        exit 0 ;;
esac

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── .env.deploy 読み込み（任意、git 管理外） ──
# 形式は doc/40-デプロイ手順.md 参照: DEPLOY_SSH_USER, DEPLOY_SSH_HOST
ENV_DEPLOY="${SCRIPT_DIR}/.env.deploy"
if [ -f "$ENV_DEPLOY" ]; then
    # shellcheck source=/dev/null
    set -a; . "$ENV_DEPLOY"; set +a
fi

# 解決順: 引数 > .env.deploy(DEPLOY_SSH_*) > デフォルト
VPS_HOST="${1:-${DEPLOY_SSH_HOST:-}}"
SSH_USER="${2:-${DEPLOY_SSH_USER:-deploy}}"

if [ -z "$VPS_HOST" ]; then
    echo "Usage: $0 <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)"
    exit 1
fi
DUMP_FILE="/tmp/ground_data_$(date +%Y%m%d-%H%M%S).sql"

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# ── 前提チェック ──
# ローカルの PostgreSQL コンテナが起動しているか
LOCAL_PG=$(docker ps --format '{{.Names}}' --filter "name=postgres" 2>/dev/null | head -1)
if [ -z "$LOCAL_PG" ]; then
    fail "ローカルの PostgreSQL コンテナが起動していません。docker compose up -d postgres を実行してください"
fi

# SSH 接続テスト
echo "SSH 接続テスト: ${SSH_USER}@${VPS_HOST}"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_USER}@${VPS_HOST}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_USER}@${VPS_HOST}"
fi

# ── 1. さくらVPS から地面データを SQL ダンプ ──
step "1. さくらVPS から地面データを SQL ダンプ"

# VPS 上の PostgreSQL コンテナを検出
echo "VPS 上の PostgreSQL コンテナを検出中..."
REMOTE_PG_CONTAINER=$(ssh "${SSH_USER}@${VPS_HOST}" \
    "docker ps --format '{{.Names}}' --filter 'name=postgres' 2>/dev/null | head -1")

if [ -z "$REMOTE_PG_CONTAINER" ]; then
    fail "VPS 上に PostgreSQL コンテナが見つかりません"
fi
echo "  コンテナ: ${REMOTE_PG_CONTAINER}"

# チャンク数を確認
REMOTE_COUNT=$(ssh "${SSH_USER}@${VPS_HOST}" \
    "docker exec ${REMOTE_PG_CONTAINER} psql -U nakama -d nakama -t -c \
     \"SELECT count(*) FROM storage WHERE collection = 'world_data';\"" | tr -d ' \r\n')

echo "  チャンク数: ${REMOTE_COUNT}"

if [ "${REMOTE_COUNT:-0}" -eq 0 ]; then
    warn "地面データがありません（0チャンク）"
    exit 0
fi

# pg_dump で地面データのみ SQL ダンプ（INSERT 文形式）
echo "SQL ダンプ中..."
ssh "${SSH_USER}@${VPS_HOST}" \
    "docker exec ${REMOTE_PG_CONTAINER} pg_dump -U nakama -d nakama \
     -t storage --data-only --column-inserts \
     --where=\"collection = 'world_data'\"" > "$DUMP_FILE"

DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
INSERT_COUNT=$(grep -c '^INSERT' "$DUMP_FILE" || echo 0)
echo "  ダンプ完了: ${DUMP_FILE} (${DUMP_SIZE}, ${INSERT_COUNT} INSERT文)"

if [ "$INSERT_COUNT" -eq 0 ]; then
    fail "SQL ダンプに INSERT 文が含まれていません。ダンプ内容を確認してください: ${DUMP_FILE}"
fi

# ── 2. ローカルの既存地面データを確認・削除 ──
step "2. ローカルの既存地面データを確認"

cd "$SCRIPT_DIR"
LOCAL_COUNT=$(docker exec "$LOCAL_PG" psql -U nakama -d nakama -t -c \
    "SELECT count(*) FROM storage WHERE collection = 'world_data';" | tr -d ' \r\n')

echo "  ローカルのチャンク数: ${LOCAL_COUNT}"

if [ "${LOCAL_COUNT:-0}" -gt 0 ]; then
    echo ""
    echo "${YELLOW}ローカルに既存の地面データが ${LOCAL_COUNT} チャンクあります。${RESET}"
    echo "  上書き (replace): VPS のデータで置換"
    echo "  中止   (cancel):  何もしない"
    echo ""
    read -p "上書きしますか？ (y/N): " ans
    if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
        echo "中止しました"
        rm -f "$DUMP_FILE"
        exit 0
    fi

    echo "既存の地面データを削除中..."
    docker exec "$LOCAL_PG" psql -U nakama -d nakama -c \
        "DELETE FROM storage WHERE collection = 'world_data';"
    echo "  削除完了"
fi

# ── 3. ローカルの PostgreSQL にインポート ──
step "3. ローカルの PostgreSQL にインポート"

# SQL ファイルをコンテナ内にコピーして実行
docker cp "$DUMP_FILE" "${LOCAL_PG}:/tmp/ground_data.sql"

docker exec "$LOCAL_PG" psql -U nakama -d nakama -f /tmp/ground_data.sql

# コンテナ内の一時ファイルを削除
docker exec "$LOCAL_PG" rm -f /tmp/ground_data.sql

# インポート後の確認
IMPORTED_COUNT=$(docker exec "$LOCAL_PG" psql -U nakama -d nakama -t -c \
    "SELECT count(*) FROM storage WHERE collection = 'world_data';" | tr -d ' \r\n')

echo "  インポート完了: ${IMPORTED_COUNT} チャンク"

# ── 後始末 ──
rm -f "$DUMP_FILE"

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  地面データ マイグレーション完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "  VPS:     ${SSH_USER}@${VPS_HOST} (${REMOTE_COUNT} チャンク)"
echo "  ローカル: ${IMPORTED_COUNT} チャンク"
echo ""
echo "確認:"
echo "  Nakama を再起動して地面データが反映されるか確認してください"
echo "  bash nakama/doRestart.sh"
