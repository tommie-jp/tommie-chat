#!/bin/bash
# nakama/doS3-set-avatars.sh
# nakama/avatars.json に列挙されたローカル PNG ファイルを
# ローカル MinIO の local/avatars バケットにアップロードする。
# Usage: ./nakama/doS3-set-avatars.sh [-h]

case "${1:-}" in
    -h|--help)
        cat <<'EOF'
Usage: ./nakama/doS3-set-avatars.sh
  nakama/avatars.json の png_paths に列挙されたローカル PNG ファイルを
  ローカル MinIO の local/avatars/ バケットに投入する。

  起動中の compose 環境（dev or prod）を自動判定する。

パス解決:
  - 絶対パス（/ で始まる） → そのまま使用
  - ~/ で始まるパス         → $HOME に展開
  - それ以外の相対パス      → nakama/ ディレクトリからの相対

前提:
  - jq がインストール済み
  - ローカル MinIO が起動中（doRestart.sh で起動）
  - nakama/avatars.json の png_paths に PNG ファイルパスが列挙済み
EOF
        exit 0 ;;
esac

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'
step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

JSON_FILE="$SCRIPT_DIR/avatars.json"
[ -f "$JSON_FILE" ] || fail "avatars.json が見つかりません: $JSON_FILE"
command -v jq >/dev/null 2>&1 || fail "jq が必要です。apt install jq を実行してください"

# ── JSON 検証 & パス抽出 ──
jq empty "$JSON_FILE" 2>/dev/null || fail "avatars.json の JSON 形式が不正です"
mapfile -t PATHS < <(jq -r '.png_paths[]?' "$JSON_FILE")

# パスを解決（絶対化）し、プレースホルダと存在しないファイルを除外する
# グロブ（*, ?, [...]）を含む場合は展開して複数ファイルに展開する
RESOLVED=()
shopt -s nullglob
for p in "${PATHS[@]}"; do
    [ -z "$p" ] && continue
    case "$p" in
        *'<'*|*'>'*) continue ;;  # '<PNG のファイルパス>' 等のプレースホルダ
        /*)   abs="$p" ;;
        '~/'*) abs="${HOME}/${p#\~/}" ;;
        ~)    abs="${HOME}" ;;
        *)    abs="${SCRIPT_DIR}/${p}" ;;
    esac
    # グロブを含む場合は展開
    case "$abs" in
        *'*'*|*'?'*|*'['*)
            matched=($abs)
            if [ ${#matched[@]} -eq 0 ]; then
                warn "グロブにマッチするファイルがありません: $p"
                continue
            fi
            for m in "${matched[@]}"; do
                case "$(basename -- "$m")" in
                    *.png) [ -f "$m" ] && RESOLVED+=("$m") ;;
                esac
            done
            continue ;;
    esac
    case "$(basename -- "$abs")" in
        *.png) ;;
        *) warn "PNG 拡張子ではないパスをスキップ: $p"; continue ;;
    esac
    if [ ! -f "$abs" ]; then
        warn "ファイルが存在しません: $abs"
        continue
    fi
    RESOLVED+=("$abs")
done
shopt -u nullglob
if [ ${#RESOLVED[@]} -eq 0 ]; then
    fail "avatars.json の png_paths に有効な PNG がありません（プレースホルダのままでは?）"
fi

SITE_URL=$(jq -r '.site_url // ""' "$JSON_FILE")
echo "  source:    ${SITE_URL:-(none)}"
echo "  PNG count: ${#RESOLVED[@]}"

# ── 起動中の compose 環境を判定 ──
if docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --status running 2>/dev/null | grep -q minio; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
    echo "  環境:      prod"
elif docker compose -f docker-compose.yml -f docker-compose.dev.yml ps --status running 2>/dev/null | grep -q minio; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
    echo "  環境:      dev"
else
    fail "ローカル MinIO が起動していません。doRestart.sh で起動してから再実行してください"
fi

# ── 1. minio コンテナへ転送 ──
step "1. minio コンテナへ転送"
$COMPOSE exec -T minio sh -c 'mkdir -p /tmp/avatars-restore && rm -f /tmp/avatars-restore/*.png'
for f in "${RESOLVED[@]}"; do
    $COMPOSE cp "$f" minio:/tmp/avatars-restore/
done
echo "  ✅ 転送完了 (${#RESOLVED[@]} ファイル)"

# ── 2. mc cp で local/avatars/ に投入 ──
step "2. mc cp で local/avatars/ に投入"
$COMPOSE exec -T minio sh -c '
    mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing local/avatars >/dev/null
    mc cp /tmp/avatars-restore/*.png local/avatars/
    rm -rf /tmp/avatars-restore
'
echo "  ✅ 投入完了"

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  MinIO アバター投入完了（ローカル）${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "確認:"
echo "  $COMPOSE exec -T minio mc ls local/avatars/"
