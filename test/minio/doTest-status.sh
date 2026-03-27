#!/bin/bash
# MinIO ステータス表示（バケット一覧・ポリシー・容量）
# Usage: ./test/minio/doTest-status.sh [-h]
#
# MinIO コンテナが起動している状態で実行する。

cd "$(dirname "$0")/../.."

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    cat <<'EOF'
Usage: ./test/minio/doTest-status.sh [-h]

MinIO の現在の設定・状態を表示します。

表示内容:
  1. コンテナ状態
  2. バケット一覧
  3. 各バケットのアクセスポリシー
  4. 各バケットのファイル数・容量
  5. ディスク使用量

前提:
  docker compose -f nakama/docker-compose.yml up -d minio を実行済みであること
EOF
    exit 0
fi

COMPOSE="docker compose -f nakama/docker-compose.yml"

# ── 1. コンテナ状態 ──
echo "=== MinIO ステータス ==="
echo ""
MINIO_CONTAINER=$($COMPOSE ps --format '{{.Names}}' 2>/dev/null | grep minio | head -1)
if [ -z "$MINIO_CONTAINER" ]; then
    echo "❌ MinIO コンテナが起動していません"
    exit 1
fi
STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$MINIO_CONTAINER" 2>/dev/null)
echo "コンテナ: ${MINIO_CONTAINER} (${STATUS})"
echo ""

# ── alias 設定 ──
$COMPOSE exec -T minio mc alias set local http://localhost:9000 minioadmin minioadmin >/dev/null 2>&1

# ── 2. バケット一覧 ──
echo "--- バケット一覧 ---"
BUCKETS=$($COMPOSE exec -T minio mc ls local/ 2>/dev/null)
if [ -z "$BUCKETS" ]; then
    echo "  (バケットなし)"
    echo ""
    echo "=== 完了 ==="
    exit 0
fi
echo "$BUCKETS" | while IFS= read -r line; do
    echo "  $line"
done
echo ""

# ── 3. アクセスポリシー ──
echo "--- アクセスポリシー ---"
BUCKET_NAMES=$($COMPOSE exec -T minio mc ls local/ 2>/dev/null | awk '{print $NF}' | tr -d '/')
for bucket in $BUCKET_NAMES; do
    POLICY=$($COMPOSE exec -T minio mc anonymous get "local/${bucket}" 2>/dev/null | grep -oE 'none|download|upload|public' | head -1)
    printf "  %-20s %s\n" "$bucket" "${POLICY:-private}"
done
echo ""

# ── 4. ファイル数・容量 ──
echo "--- ファイル数・容量 ---"
for bucket in $BUCKET_NAMES; do
    DU=$($COMPOSE exec -T minio mc du "local/${bucket}" 2>/dev/null | tail -1)
    if [ -n "$DU" ]; then
        SIZE=$(echo "$DU" | awk '{print $1}')
        COUNT=$(echo "$DU" | awk '{print $2}')
        printf "  %-20s %s (%s)\n" "$bucket" "$SIZE" "$COUNT"
    else
        printf "  %-20s (空)\n" "$bucket"
    fi
done
echo ""

# ── 5. ディスク使用量 ──
echo "--- ディスク使用量 ---"
$COMPOSE exec -T minio mc admin info local 2>/dev/null | grep -E "Used|Total|Free|Drives" | while IFS= read -r line; do
    echo "  $line"
done
echo ""

echo "=== 完了 ==="
