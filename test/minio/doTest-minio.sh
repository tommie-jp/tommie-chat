#!/bin/bash
# MinIO 疎通テスト（起動確認・バケット作成・アップロード・参照・削除）
# Usage: ./test/minio/doTest-minio.sh [-h]
#
# MinIO コンテナが起動している状態で実行する。
# テスト用バケット・ファイルは終了時に自動削除される。

cd "$(dirname "$0")/../.."

# ── オプション解析 ──
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    cat <<'EOF'
Usage: ./test/minio/doTest-minio.sh [-h]

MinIO の疎通テストを実行します。

テスト内容:
  1. MinIO コンテナの起動確認 (healthcheck)
  2. mc alias 設定
  3. テスト用バケット作成
  4. ファイルアップロード
  5. ファイル参照 (S3 API)
  6. ファイル一覧
  7. HTTP: 非公開状態でアクセス拒否 (curl, 403)
  8. バケットを公開設定に変更
  9. HTTP: 公開状態でアクセス可能 (curl, 200 + 内容一致)
  10. ファイル削除
  11. バケット削除 (クリーンアップ)

前提:
  docker compose up -d minio を実行済みであること
EOF
    exit 0
fi

FAILED=0
TEST_BUCKET="test-minio-tmp"
TEST_FILE="test-upload.txt"
COMPOSE="docker compose -f nakama/docker-compose.yml"

# .env から MinIO 認証情報を読み込み
if [ -f nakama/.env ]; then
    set -a; source nakama/.env; set +a
fi
MINIO_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_PASS="${MINIO_ROOT_PASSWORD:-minioadmin}"

echo "--- MinIO 疎通テスト ---"

# ── 1. コンテナ起動確認 ──
echo -n "  [1/11] container  ... "
MINIO_CONTAINER=$($COMPOSE ps --format '{{.Names}}' 2>/dev/null | grep minio | head -1)
if [ -z "$MINIO_CONTAINER" ]; then
    echo "FAIL (not running)"
    echo "❌ MinIO コンテナが見つかりません。docker compose up -d minio を実行してください。"
    exit 1
fi
for i in $(seq 1 30); do
    STATUS=$(docker inspect --format '{{.State.Health.Status}}' "$MINIO_CONTAINER" 2>/dev/null)
    if [ "$STATUS" = "healthy" ]; then
        echo "healthy (${i}s)"
        break
    fi
    sleep 1
done
if [ "$STATUS" != "healthy" ]; then
    echo "FAIL (status: ${STATUS:-unknown})"
    echo "❌ MinIO が healthy になりません。docker logs $MINIO_CONTAINER を確認してください。"
    exit 1
fi

# ── 2. mc alias 設定 ──
echo -n "  [2/11] mc alias   ... "
ALIAS_OUT=$($COMPOSE exec -T minio mc alias set local http://localhost:9000 "$MINIO_USER" "$MINIO_PASS" 2>&1)
if echo "$ALIAS_OUT" | grep -q "successfully"; then
    echo "OK"
else
    echo "FAIL"
    echo "  $ALIAS_OUT"
    FAILED=1
fi

# ── 3. バケット作成 ──
echo -n "  [3/11] create bucket ... "
$COMPOSE exec -T minio mc mb --ignore-existing "local/${TEST_BUCKET}" >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "OK (${TEST_BUCKET})"
else
    echo "FAIL"
    FAILED=1
fi

# ── 4. ファイルアップロード ──
echo -n "  [4/11] upload     ... "
$COMPOSE exec -T minio sh -c "echo 'hello minio test' > /tmp/${TEST_FILE}" 2>/dev/null
$COMPOSE exec -T minio mc cp "/tmp/${TEST_FILE}" "local/${TEST_BUCKET}/${TEST_FILE}" >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "OK (${TEST_FILE})"
else
    echo "FAIL"
    FAILED=1
fi

# ── 5. ファイル参照 (S3 API) ──
echo -n "  [5/11] read (S3)  ... "
CONTENT=$($COMPOSE exec -T minio mc cat "local/${TEST_BUCKET}/${TEST_FILE}" 2>/dev/null)
if [ "$CONTENT" = "hello minio test" ]; then
    echo "OK"
else
    echo "FAIL (content: '${CONTENT}')"
    FAILED=1
fi

# ── 6. ファイル一覧 ──
echo -n "  [6/11] list       ... "
LIST_OUT=$($COMPOSE exec -T minio mc ls "local/${TEST_BUCKET}/" 2>/dev/null)
if echo "$LIST_OUT" | grep -q "${TEST_FILE}"; then
    echo "OK"
else
    echo "FAIL"
    echo "  $LIST_OUT"
    FAILED=1
fi

# ── 7. HTTP: 非公開状態でアクセス拒否を確認 ──
echo -n "  [7/11] HTTP deny  ... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:9000/${TEST_BUCKET}/${TEST_FILE}" --connect-timeout 3 --max-time 5 2>/dev/null)
if [ "$HTTP_CODE" = "403" ]; then
    echo "OK (403 Access Denied)"
else
    echo "FAIL (expected 403, got ${HTTP_CODE})"
    FAILED=1
fi

# ── 8. バケットを公開設定に変更 ──
echo -n "  [8/11] set public ... "
$COMPOSE exec -T minio mc anonymous set download "local/${TEST_BUCKET}" >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "OK (download)"
else
    echo "FAIL"
    FAILED=1
fi

# ── 9. HTTP: 公開状態でアクセス可能を確認 ──
echo -n "  [9/11] HTTP read  ... "
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:9000/${TEST_BUCKET}/${TEST_FILE}" --connect-timeout 3 --max-time 5 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
    BODY=$(curl -s "http://localhost:9000/${TEST_BUCKET}/${TEST_FILE}" --connect-timeout 3 --max-time 5 2>/dev/null)
    if [ "$BODY" = "hello minio test" ]; then
        echo "OK (200, content match)"
    else
        echo "FAIL (200, content mismatch: '${BODY}')"
        FAILED=1
    fi
else
    echo "FAIL (expected 200, got ${HTTP_CODE})"
    FAILED=1
fi

# ── 10. ファイル削除 ──
echo -n "  [10/11] delete file ... "
$COMPOSE exec -T minio mc rm "local/${TEST_BUCKET}/${TEST_FILE}" >/dev/null 2>&1
VERIFY=$($COMPOSE exec -T minio mc ls "local/${TEST_BUCKET}/${TEST_FILE}" 2>&1)
if echo "$VERIFY" | grep -q "Object does not exist" || [ -z "$(echo "$VERIFY" | grep "${TEST_FILE}")" ]; then
    echo "OK"
else
    echo "FAIL"
    FAILED=1
fi

# ── 11. バケット削除 (クリーンアップ) ──
echo -n "  [11/11] cleanup    ... "
$COMPOSE exec -T minio mc rb --force "local/${TEST_BUCKET}" >/dev/null 2>&1
if [ $? -eq 0 ]; then
    echo "OK"
else
    echo "FAIL (manual cleanup needed: mc rb local/${TEST_BUCKET})"
    FAILED=1
fi

# ── 結果 ──
echo ""
if [ "$FAILED" -eq 0 ]; then
    echo "✅ MinIO 疎通テスト成功"
    exit 0
else
    echo "❌ MinIO 疎通テスト失敗（上記のエラーを確認してください）"
    exit 1
fi
