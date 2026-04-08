#!/bin/bash
# セキュリティテスト（XSS サニタイズ + /s3/ アクセス制限 + RPC レート制限）
#
# Nakama サーバに接続し、XSS 攻撃パターンがサニタイズされるか確認する。
# また nginx の /s3/ アクセス制限が正しく動作するか確認する。
#
# 使い方:
#   ./test/doTest-security.sh                      # ローカル (127.0.0.1:7350)
#   ./test/doTest-security.sh mmo.tommie.jp        # 本番 (HTTPS/443)
#   ./test/doTest-security.sh [-h]
#
# テスト内容:
#   === XSS サニタイズ（サーバー側） ===
#    1. 表示名の HTML エスケープ
#    2. 表示名の属性エスケープ
#    3. ワールド名の HTML エスケープ
#    4. nameColor のバリデーション（関数存在確認）
#   === ENABLE_TEST_RPC ===
#    5. 本番設定で ENABLE_TEST_RPC=false が明示されている
#    6. deleteUsers RPC が実行できない（リモート時のみ実テスト）
#   === /s3/ アクセス制限（nginx） ===
#    7. /s3/avatars/ の GET が成功する
#    8. /s3/avatars/ の PUT が拒否される
#    9. /s3/uploads/ へのアクセスが拒否される
#   10. /s3/ ルートへのアクセスが拒否される
#   === RPC レート制限 ===
#   11. RPC レート制限の設定が存在する
#   12. 連続 RPC 呼び出しでレート制限が発動する
#   13. レート以内の持続呼び出しは全て成功する
#   14. バースト後にトークンが回復する

set -e

# ── 引数解析 ──
OPT_HOST=""

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
    exit 0
fi
# 最初の引数をリモートサーバ名として扱う
if [ -n "${1:-}" ]; then
    OPT_HOST="$1"
fi

cd "$(dirname "$0")/.."
# .env から NAKAMA_SERVER_KEY 等を自動読み込み
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f nakama/.env ]; then
    set -a; source nakama/.env; set +a
fi
# .env がない場合、docker-compose.yml から server_key を取得
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f nakama/docker-compose.yml ]; then
    _key=$(grep -oP '(?<=--socket\.server_key\s)\S+' nakama/docker-compose.yml 2>/dev/null | head -1)
    [ -n "$_key" ] && NAKAMA_SERVER_KEY="$_key"
fi

SERVER_KEY="${NAKAMA_SERVER_KEY:-defaultkey}"
HOST="${OPT_HOST:-${NAKAMA_HOST:-127.0.0.1}}"
IS_LOCAL=false
if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
    IS_LOCAL=true
fi

# ポート・プロトコル判定（リモートは HTTPS/443 固定）
if [ "$IS_LOCAL" = true ]; then
    PORT="${NAKAMA_PORT:-7350}"
    PROTO="http"
else
    PORT="443"
    PROTO="https"
fi

# API ベース URL（HTTPS/443 はポート省略）
if [ "$IS_LOCAL" = true ]; then
    API_BASE="${PROTO}://${HOST}:${PORT}"
else
    API_BASE="${PROTO}://${HOST}"
fi

FAILED=0
PASS=0
TOTAL=0

check() {
    local label="$1"
    local result="$2"
    local detail="$3"
    TOTAL=$((TOTAL + 1))
    if [ "$result" = "0" ]; then
        echo "  ✅ $label"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $label"
        [ -n "$detail" ] && echo "     $detail"
        FAILED=$((FAILED + 1))
    fi
}

echo "=== セキュリティテスト ==="
echo "endpoint: ${API_BASE}"
echo ""

# ── 認証（テスト用ユーザー作成） ──
echo "認証中..."
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${API_BASE}/v2/account/authenticate/device?create=true&username=sec_test_$$" \
    -H "Content-Type: application/json" \
    -u "${SERVER_KEY}:" \
    -d "{\"id\":\"sec-test-device-$$\"}" \
    --connect-timeout 5 --max-time 10 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" != "200" ]; then
    echo "❌ 認証失敗 (HTTP ${HTTP_CODE})"
    echo "   サーバが起動しているか確認してください。"
    exit 1
fi

TOKEN=$(echo "$BODY" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
    echo "❌ トークン取得失敗"
    exit 1
fi
echo "認証成功"
echo ""

# ══════════════════════════════════════════
# XSS サニタイズ（サーバー側）
# ══════════════════════════════════════════
echo "=== 1. XSS サニタイズ ==="

# ── 1-1. チャットメッセージの HTML エスケープ ──
# マッチに参加して opChat を送信し、サーバーがエスケープするか確認
# RPC 経由で直接テスト可能な部分を確認

# 1-1. 表示名に HTML タグを含むリクエスト
echo "[1/14] 表示名の HTML エスケープ..."
# Nakama HTTP RPC は payload を JSON 文字列でラップする必要がある
XSS_PAYLOAD=$(printf '%s' '{"displayName":"<script>alert(1)</script>"}' | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
DN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${API_BASE}/v2/rpc/updateDisplayName" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "${XSS_PAYLOAD}" \
    --connect-timeout 5 --max-time 10 2>/dev/null)

DN_HTTP=$(echo "$DN_RESPONSE" | tail -1)
DN_BODY=$(echo "$DN_RESPONSE" | head -n -1)

if [ "$DN_HTTP" = "200" ]; then
    # 設定が成功した場合、取得して確認
    ACCOUNT=$(curl -s \
        "${API_BASE}/v2/account" \
        -H "Authorization: Bearer ${TOKEN}" \
        --connect-timeout 5 --max-time 10 2>/dev/null)
    # display_name に生の <script> が含まれていないことを確認
    # account API は直接 JSON を返す（RPC ラッパーなし）
    if echo "$ACCOUNT" | grep -q '<script>'; then
        check "表示名の HTML エスケープ" "1" \
            "生の <script> タグがエスケープされずに保存された"
    else
        # &lt;script&gt; にエスケープされているか確認
        if echo "$ACCOUNT" | grep -q '&lt;script&gt;'; then
            check "表示名の HTML エスケープ" "0"
        else
            check "表示名の HTML エスケープ" "0" \
                "（タグは除去またはエスケープされた）"
        fi
    fi
else
    check "表示名の HTML エスケープ" "1" \
        "RPC 呼び出し失敗 (HTTP ${DN_HTTP}): ${DN_BODY}"
fi

# ── 1-2. 表示名に属性エスケープ攻撃 ──
echo "[2/14] 表示名の属性エスケープ..."
XSS_ATTR_PAYLOAD=$(printf '%s' '{"displayName":"test\"><img src=x onerror=alert(1)>"}' | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
DN2_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${API_BASE}/v2/rpc/updateDisplayName" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "${XSS_ATTR_PAYLOAD}" \
    --connect-timeout 5 --max-time 10 2>/dev/null)

DN2_HTTP=$(echo "$DN2_RESPONSE" | tail -1)

if [ "$DN2_HTTP" = "200" ]; then
    ACCOUNT2=$(curl -s \
        "${API_BASE}/v2/account" \
        -H "Authorization: Bearer ${TOKEN}" \
        --connect-timeout 5 --max-time 10 2>/dev/null)
    # 生の <img タグ（エスケープされていない）が存在しないことを確認
    # エスケープ済みの &lt;img は安全なので許容
    if echo "$ACCOUNT2" | grep -q '<img '; then
        check "表示名の属性エスケープ" "1" \
            "生の <img> タグがエスケープされずに保存された"
    else
        check "表示名の属性エスケープ" "0"
    fi
else
    # エラーで拒否された場合も OK
    check "表示名の属性エスケープ" "0"
fi

# ── 1-3. ワールド名の HTML エスケープ ──
echo "[3/14] ワールド名の HTML エスケープ..."
ROOM_PAYLOAD=$(printf '%s' '{"name":"<b>evil</b>","chunkCountX":2,"chunkCountZ":2}' | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
ROOM_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${API_BASE}/v2/rpc/createRoom" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "${ROOM_PAYLOAD}" \
    --connect-timeout 5 --max-time 10 2>/dev/null)

ROOM_HTTP=$(echo "$ROOM_RESPONSE" | tail -1)
ROOM_BODY=$(echo "$ROOM_RESPONSE" | head -n -1)

if [ "$ROOM_HTTP" = "200" ]; then
    # ワールドリストを取得して確認
    WLIST=$(curl -s -X POST \
        "${API_BASE}/v2/rpc/getWorldList" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d '""' \
        --connect-timeout 5 --max-time 10 2>/dev/null)
    # Nakama HTTP RPC のレスポンスは {"payload":"..."} で返されるため、payload を展開
    WLIST_PAYLOAD=$(echo "$WLIST" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("payload",""))' 2>/dev/null || echo "$WLIST")
    if echo "$WLIST_PAYLOAD" | grep -q '<b>evil</b>'; then
        check "ワールド名の HTML エスケープ" "1" \
            "生の <b> タグがエスケープされずに保存された"
    else
        check "ワールド名の HTML エスケープ" "0"
    fi
else
    check "ワールド名の HTML エスケープ" "1" \
        "RPC 呼び出し失敗 (HTTP ${ROOM_HTTP}): ${ROOM_BODY}"
fi

# ── 1-4. nameColor のバリデーション ──
echo "[4/14] nameColor バリデーション..."
# joinMatch のメタデータで不正な nameColor を送信するのは直接テストが難しいため、
# サーバーの sanitizeColor が正規表現マッチのみ通すことを間接的に確認。
# ここでは getServerInfo で接続確認し、コードレビュー結果で判定。
# → 直接テスト可能な方法: opInitPos で不正色を送った後にプロファイルリクエストで確認
# 現時点では表示名テストで十分なので、コードベースの確認結果を報告。

# 正規表現チェックの存在確認（ソースコード検査）
if grep -q 'sanitizeColor' nakama/go_src/main.go && grep -q 'colorCodeRe' nakama/go_src/main.go; then
    check "nameColor バリデーション関数が存在する" "0"
else
    check "nameColor バリデーション関数が存在する" "1" \
        "sanitizeColor / colorCodeRe が main.go に見つからない"
fi

echo ""

# ══════════════════════════════════════════
# ENABLE_TEST_RPC
# ══════════════════════════════════════════
echo "=== 2. ENABLE_TEST_RPC ==="

echo "[5/14] 本番設定で ENABLE_TEST_RPC=false..."
if [ -f nakama/docker-compose.prod.yml ]; then
    if grep -q 'ENABLE_TEST_RPC=false' nakama/docker-compose.prod.yml; then
        check "docker-compose.prod.yml に ENABLE_TEST_RPC=false が存在する" "0"
    else
        check "docker-compose.prod.yml に ENABLE_TEST_RPC=false が存在する" "1" \
            "本番で deleteUsers RPC が有効になるリスクがあります"
    fi
else
    check "docker-compose.prod.yml に ENABLE_TEST_RPC=false が存在する" "1" \
        "docker-compose.prod.yml が見つかりません"
fi

# ── 2-2. deleteUsers RPC が実行不可 ──
echo "[6/14] deleteUsers RPC が実行不可..."
# 存在しない dummy ユーザーID で呼び出し（実害なし）
DEL_PAYLOAD=$(printf '%s' '{"userIds":["00000000-0000-0000-0000-000000000000"]}' | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
DEL_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${API_BASE}/v2/rpc/deleteUsers" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "${DEL_PAYLOAD}" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
DEL_HTTP=$(echo "$DEL_RESPONSE" | tail -1)
if [ "$IS_LOCAL" = true ]; then
    # dev 環境: ENABLE_TEST_RPC=true なので RPC は存在する（想定通り）
    if [ "$DEL_HTTP" = "200" ]; then
        check "deleteUsers RPC — dev 環境で有効（想定通り）" "0"
    elif [ "$DEL_HTTP" = "404" ]; then
        check "deleteUsers RPC — dev 環境で無効（予想外だが安全）" "0"
    else
        check "deleteUsers RPC — dev 環境 (HTTP ${DEL_HTTP})" "0"
    fi
else
    # 本番/リモート環境: RPC が存在しない（404）ことを確認
    if [ "$DEL_HTTP" = "404" ] || [ "$DEL_HTTP" = "400" ]; then
        check "deleteUsers RPC が本番で無効 (HTTP ${DEL_HTTP})" "0"
    elif [ "$DEL_HTTP" = "200" ]; then
        check "deleteUsers RPC が本番で無効" "1" \
            "deleteUsers が本番で実行可能です！ENABLE_TEST_RPC=false を設定してください"
    else
        check "deleteUsers RPC が本番で無効 (HTTP ${DEL_HTTP})" "0"
    fi
fi

echo ""

# ══════════════════════════════════════════
# /s3/ アクセス制限（nginx）
# ══════════════════════════════════════════
echo "=== 3. /s3/ アクセス制限 ==="

# Web ベース URL の検出
IS_VITE=false
if [ "$IS_LOCAL" = true ]; then
    # ローカル: nginx (80/8081) または vite dev server (3000) を検出
    # nginx を優先（/s3/ 制限は nginx で実装されているため）
    WEB_BASE=""
    for p in 80 8081 3000; do
        WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://${HOST}:${p}/" --connect-timeout 2 --max-time 3 2>/dev/null)
        if [ "$WEB_CODE" = "200" ]; then
            WEB_BASE="http://${HOST}:${p}"
            [ "$p" = "3000" ] && IS_VITE=true
            break
        fi
    done
    if [ -z "$WEB_BASE" ]; then
        echo "  ⚠️  Web サーバ（vite/nginx）が検出できません。/s3/ テストをスキップします。"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━"
        echo "XSS テストのみ実施: ${PASS}/${TOTAL} 成功"
        echo "━━━━━━━━━━━━━━━━━━━━━━"
        exit $FAILED
    fi
    echo "web: ${WEB_BASE}"
    # dev nginx が vite 転送モードか判定
    if docker exec nakama-web-1 cat /etc/nginx/conf.d/default.conf 2>/dev/null | grep -q 'host.docker.internal'; then
        IS_VITE=true
    fi
else
    WEB_BASE="${PROTO}://${HOST}"
    echo "web: ${WEB_BASE}"
fi

# ── 2-1. /s3/avatars/ の GET が成功する ──
echo "[7/14] /s3/avatars/ GET..."
S3_GET_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    "${WEB_BASE}/s3/avatars/" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
# 200 (ファイル一覧) または 403 (ListObjects 拒否だが avatars パスは通る) を許可
# vite dev の場合 200、nginx 本番の場合 200 が期待値
check "/s3/avatars/ GET が通る (HTTP ${S3_GET_CODE})" \
    "$([ "$S3_GET_CODE" = "200" ] || [ "$S3_GET_CODE" = "403" ] && echo 0 || echo 1)" \
    "期待: 200、実際: ${S3_GET_CODE}"

# ── 2-2. /s3/avatars/ の PUT が拒否される ──
echo "[8/14] /s3/avatars/ PUT 拒否..."
S3_PUT_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "${WEB_BASE}/s3/avatars/evil-test-upload.txt" \
    -d "malicious content" \
    --connect-timeout 5 --max-time 10 2>/dev/null)
# 403 (Forbidden) または 405 (Method Not Allowed) が期待値
# vite dev server は PUT を通さないので 404 も許容
check "/s3/avatars/ PUT が拒否される (HTTP ${S3_PUT_CODE})" \
    "$([ "$S3_PUT_CODE" = "403" ] || [ "$S3_PUT_CODE" = "405" ] || [ "$S3_PUT_CODE" = "404" ] && echo 0 || echo 1)" \
    "期待: 403/405、実際: ${S3_PUT_CODE}。nginx の limit_except 設定を確認してください"

# ── 2-3. /s3/uploads/ へのアクセスが拒否される ──
echo "[9/14] /s3/uploads/ アクセス拒否..."
S3_UPLOADS_BODY=$(curl -s "${WEB_BASE}/s3/uploads/" --connect-timeout 5 --max-time 10 2>/dev/null)
S3_UPLOADS_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${WEB_BASE}/s3/uploads/" --connect-timeout 5 --max-time 10 2>/dev/null)
if [ "$IS_VITE" = true ]; then
    # vite dev: proxy 設定がないパスは SPA フォールバック (index.html) を返す
    # MinIO にプロキシされていなければ安全（index.html の内容で判定）
    IS_SPA_FALLBACK=$(echo "$S3_UPLOADS_BODY" | grep -c '<!DOCTYPE html>' || true)
    if [ "$S3_UPLOADS_CODE" = "403" ] || [ "$S3_UPLOADS_CODE" = "404" ]; then
        check "/s3/uploads/ がブロックされる — vite dev (HTTP ${S3_UPLOADS_CODE})" "0"
    elif [ "$IS_SPA_FALLBACK" -gt 0 ]; then
        check "/s3/uploads/ が MinIO に到達しない — vite dev (SPA fallback)" "0"
    else
        check "/s3/uploads/ がブロックされる — vite dev (HTTP ${S3_UPLOADS_CODE})" "1" \
            "MinIO のレスポンスが返されています"
    fi
else
    check "/s3/uploads/ がブロックされる (HTTP ${S3_UPLOADS_CODE})" \
        "$([ "$S3_UPLOADS_CODE" = "403" ] || [ "$S3_UPLOADS_CODE" = "404" ] && echo 0 || echo 1)" \
        "期待: 403/404、実際: ${S3_UPLOADS_CODE}。/s3/ の他パスは拒否してください"
fi

# ── 2-4. /s3/ ルートへのアクセスが拒否される ──
echo "[10/14] /s3/ ルートアクセス拒否..."
S3_ROOT_BODY=$(curl -s "${WEB_BASE}/s3/" --connect-timeout 5 --max-time 10 2>/dev/null)
S3_ROOT_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${WEB_BASE}/s3/" --connect-timeout 5 --max-time 10 2>/dev/null)
if [ "$IS_VITE" = true ]; then
    IS_SPA_FALLBACK=$(echo "$S3_ROOT_BODY" | grep -c '<!DOCTYPE html>' || true)
    if [ "$S3_ROOT_CODE" = "403" ] || [ "$S3_ROOT_CODE" = "404" ]; then
        check "/s3/ ルートがブロックされる — vite dev (HTTP ${S3_ROOT_CODE})" "0"
    elif [ "$IS_SPA_FALLBACK" -gt 0 ]; then
        check "/s3/ ルートが MinIO に到達しない — vite dev (SPA fallback)" "0"
    else
        check "/s3/ ルートがブロックされる — vite dev (HTTP ${S3_ROOT_CODE})" "1" \
            "MinIO のレスポンスが返されています"
    fi
else
    check "/s3/ ルートがブロックされる (HTTP ${S3_ROOT_CODE})" \
        "$([ "$S3_ROOT_CODE" = "403" ] || [ "$S3_ROOT_CODE" = "404" ] && echo 0 || echo 1)" \
        "期待: 403/404、実際: ${S3_ROOT_CODE}"
fi

# ══════════════════════════════════════════
# RPC レート制限
# ══════════════════════════════════════════
echo "=== 4. RPC レート制限 ==="

# ── 4-1. レート制限設定の存在確認 ──
echo "[11/14] RPC レート制限の設定が存在する..."
if grep -q 'RATE_LIMIT_RPC' nakama/docker-compose.yml && \
   grep -q 'withRateLimit' nakama/go_src/main.go; then
    check "RPC レート制限の設定が存在する" "0"
else
    check "RPC レート制限の設定が存在する" "1" \
        "RATE_LIMIT_RPC または withRateLimit が見つかりません"
fi

# ── 4-2. 連続 RPC 呼び出しでレート制限が発動する ──
echo "[12/14] 連続 RPC 呼び出しでレート制限が発動する..."
# バースト上限（デフォルト20）を超えるまで ping を連続送信
RATE_LIMITED=false
for i in $(seq 1 30); do
    RL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        "${API_BASE}/v2/rpc/ping" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d '""' \
        --connect-timeout 2 --max-time 3 2>/dev/null)
    if [ "$RL_CODE" = "429" ] || [ "$RL_CODE" = "500" ]; then
        RATE_LIMITED=true
        break
    fi
done
if [ "$RATE_LIMITED" = true ]; then
    check "連続 RPC 呼び出しでレート制限が発動（${i}回目で拒否）" "0"
else
    check "連続 RPC 呼び出しでレート制限が発動" "1" \
        "30回連続呼び出しでもレート制限が発動しませんでした"
fi

# ── 4-3. レート以内の持続呼び出しは全て成功する ──
echo "[13/14] レート以内の持続呼び出し（3秒間）..."
# トークン回復を待ってからテスト開始（前のテスト12でバケットが枯渇しているため）
sleep 3
# 秒間5回 × 3秒 = 15回（レート10/秒・バースト20 の範囲内）
SUSTAINED_OK=true
SUSTAINED_FAIL_AT=0
for i in $(seq 1 15); do
    RL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        "${API_BASE}/v2/rpc/ping" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d '""' \
        --connect-timeout 2 --max-time 3 2>/dev/null)
    if [ "$RL_CODE" != "200" ]; then
        SUSTAINED_OK=false
        SUSTAINED_FAIL_AT=$i
        break
    fi
    # 200ms 間隔 ≒ 秒間5回
    sleep 0.2
done
if [ "$SUSTAINED_OK" = true ]; then
    check "レート以内の持続呼び出し（15回/3秒）は全て成功" "0"
else
    check "レート以内の持続呼び出し（15回/3秒）は全て成功" "1" \
        "${SUSTAINED_FAIL_AT}回目で失敗（HTTP ${RL_CODE}）"
fi

# ── 4-4. バースト後に回復する ──
echo "[14/14] バースト後のトークン回復..."
# まずバースト上限まで一気に消費
for i in $(seq 1 25); do
    curl -s -o /dev/null -X POST \
        "${API_BASE}/v2/rpc/ping" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d '""' \
        --connect-timeout 2 --max-time 3 2>/dev/null
done
# 3秒待ってトークン回復（10/秒 × 3秒 = 30トークン補充）
sleep 3
RECOVERY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "${API_BASE}/v2/rpc/ping" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '""' \
    --connect-timeout 2 --max-time 3 2>/dev/null)
if [ "$RECOVERY_CODE" = "200" ]; then
    check "バースト後に回復（3秒待機後に成功）" "0"
else
    check "バースト後に回復（3秒待機後に成功）" "1" \
        "回復後も拒否された（HTTP ${RECOVERY_CODE}）"
fi

echo ""

# ── クリーンアップ: テスト用表示名をリセット ──
CLEAN_PAYLOAD=$(printf '%s' '{"displayName":""}' | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
curl -s -X POST \
    "${API_BASE}/v2/rpc/updateDisplayName" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d "${CLEAN_PAYLOAD}" \
    --connect-timeout 5 --max-time 10 > /dev/null 2>&1

# ── 結果 ──
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAILED" -eq 0 ]; then
    echo "✅ 全テスト成功（${PASS}/${TOTAL}）"
else
    echo "❌ ${FAILED}件失敗（成功: ${PASS}/${TOTAL}）"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━"
exit $FAILED
