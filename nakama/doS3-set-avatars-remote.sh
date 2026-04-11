#!/bin/bash
# nakama/doS3-set-avatars-remote.sh
# nakama/avatars.json に列挙されたローカル PNG ファイルを
# VPS の MinIO の local/avatars バケットにアップロードする。
# Usage: ./nakama/doS3-set-avatars-remote.sh <VPSホスト> [SSHユーザー]
#
# パス解決はローカルで行い、PNG 本体を rsync で VPS の一時ディレクトリに転送、
# SSH 経由で VPS 上の minio コンテナに投入する（VPS 側 jq/curl 不要）。
SCRIPT_VERSION="2026-04-11c"

# ── .env.deploy 読み込み（任意、git 管理外） ──
ENV_DEPLOY="$(cd "$(dirname "$0")" && pwd)/.env.deploy"
if [ -f "$ENV_DEPLOY" ]; then
    # shellcheck source=/dev/null
    set -a; . "$ENV_DEPLOY"; set +a
fi

VPS_HOST="${DEPLOY_SSH_HOST:-}"
SSH_USER="${DEPLOY_SSH_USER:-deploy}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-}"

# ── 引数解析 ──
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./nakama/doS3-set-avatars-remote.sh <VPSホスト> [SSHユーザー]

nakama/avatars.json の png_paths に列挙されたローカル PNG ファイルを
VPS の MinIO の local/avatars/ バケットに投入する。

引数:
  VPSホスト    SSH接続先（例: mmo.tommie.jp, mmo-test.tommie.jp）
               nakama/.env.deploy の DEPLOY_SSH_HOST で省略可
  SSHユーザー  SSHユーザー名
               解決順: 引数 > .env.deploy > "deploy"

リモートディレクトリ:
  ~/<VPSホスト> をデフォルトとする（doDeploy-remote.sh と同じ規約）
  .env.deploy の DEPLOY_REMOTE_DIR で上書き可

パス解決（ローカル側で実施）:
  - 絶対パス（/ で始まる） → そのまま使用
  - ~/ で始まるパス         → $HOME に展開
  - それ以外の相対パス      → nakama/ ディレクトリからの相対

前提:
  - ローカルに jq と rsync がインストール済み
  - VPS 上で MinIO コンテナが起動中

例:
  ./nakama/doS3-set-avatars-remote.sh mmo-test.tommie.jp
  ./nakama/doS3-set-avatars-remote.sh mmo.tommie.jp
EOF
            exit 0 ;;
        -v|--version)
            echo "doS3-set-avatars-remote.sh  version: ${SCRIPT_VERSION}"
            exit 0 ;;
        -*)
            echo "❌ 不明なオプション: $1" >&2
            exit 1 ;;
        *)
            if [ -z "$VPS_HOST" ]; then
                VPS_HOST="$1"
            else
                SSH_USER="$1"
            fi
            shift ;;
    esac
done

if [ -z "$VPS_HOST" ]; then
    echo "Usage: $0 <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)" >&2
    exit 1
fi

# ホスト名の簡易サニタイズ
case "$VPS_HOST" in
    */*|*" "*|..|.|*"~"*)
        echo "❌ VPS ホスト名が不正です: '${VPS_HOST}'" >&2
        exit 1 ;;
esac
if [ -z "$REMOTE_DIR" ]; then
    REMOTE_DIR="~/${VPS_HOST}"
fi
case "$REMOTE_DIR" in
    ""|"/"|"/*"|".."|"../"*)
        echo "❌ REMOTE_DIR が不正です: '${REMOTE_DIR}'" >&2
        exit 1 ;;
esac

set -euo pipefail

SSH_TARGET="${SSH_USER}@${VPS_HOST}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSON_FILE="$SCRIPT_DIR/avatars.json"

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'
step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

echo "doS3-set-avatars-remote.sh  version: ${SCRIPT_VERSION}"
echo "  target:     ${SSH_TARGET}"
echo "  remote dir: ${REMOTE_DIR}"

[ -f "$JSON_FILE" ] || fail "avatars.json が見つかりません: $JSON_FILE"
command -v jq    >/dev/null 2>&1 || fail "jq が必要です。apt install jq を実行してください"
command -v rsync >/dev/null 2>&1 || fail "rsync が必要です"

# ── JSON 検証 & パス抽出 ──
jq empty "$JSON_FILE" 2>/dev/null || fail "avatars.json の JSON 形式が不正です"
mapfile -t PATHS < <(jq -r '.png_paths[]?' "$JSON_FILE")

RESOLVED=()
shopt -s nullglob
for p in "${PATHS[@]}"; do
    [ -z "$p" ] && continue
    case "$p" in
        *'<'*|*'>'*) continue ;;  # プレースホルダ
        /*)   abs="$p" ;;
        '~/'*) abs="${HOME}/${p#\~/}" ;;
        ~)    abs="${HOME}" ;;
        *)    abs="${SCRIPT_DIR}/${p}" ;;
    esac
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
    fail "avatars.json の png_paths に有効な PNG がありません（プレースホルダのまま?）"
fi
echo "  PNG count:  ${#RESOLVED[@]}"

# ── 0. SSH 接続テスト ──
step "0. SSH 接続テスト"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_TARGET}"
fi
echo "  ✅ OK"

# ── 1. VPS に rsync ──
step "1. PNG を VPS に転送（rsync）"
REMOTE_TMP=$(ssh "${SSH_TARGET}" "mktemp -d")
case "$REMOTE_TMP" in
    /tmp/*) : ;;
    *) fail "リモート mktemp が想定外のパスを返しました: ${REMOTE_TMP}" ;;
esac
trap 'ssh "${SSH_TARGET}" "rm -rf ${REMOTE_TMP}" 2>/dev/null || true' EXIT
rsync -avz "${RESOLVED[@]}" "${SSH_TARGET}:${REMOTE_TMP}/"
echo "  ✅ 転送完了"

# ── 2. VPS の minio コンテナに投入 ──
# heredoc の \$ はリモート bash に渡り、その先の sh -c '...' 内の $VAR は
# minio コンテナの環境変数を参照する。
# 注意: docker compose exec -T は STDIN を継承するため、</dev/null で
# 切り離さないと heredoc 本体を読み込んでしまい、以降のコマンドが実行されない。
step "2. VPS の minio コンテナに投入"
ssh "${SSH_TARGET}" bash <<REMOTE_EOF
set -eu
cd ${REMOTE_DIR}/nakama
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if ! \$COMPOSE ps --status running 2>/dev/null | grep -q minio; then
    echo "❌ ${VPS_HOST} の MinIO コンテナが起動していません" >&2
    exit 1
fi
\$COMPOSE exec -T minio sh -c 'mkdir -p /tmp/avatars-restore && rm -f /tmp/avatars-restore/*.png' </dev/null
for f in ${REMOTE_TMP}/*.png; do
    \$COMPOSE cp "\$f" minio:/tmp/avatars-restore/ </dev/null
done
\$COMPOSE exec -T minio sh -c '
    mc alias set local http://localhost:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing local/avatars >/dev/null
    mc cp /tmp/avatars-restore/*.png local/avatars/
    rm -rf /tmp/avatars-restore
' </dev/null
REMOTE_EOF
echo "  ✅ 投入完了"

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  MinIO アバター投入完了 (${VPS_HOST})${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "確認:"
echo "  ssh ${SSH_TARGET} 'cd ${REMOTE_DIR}/nakama && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T minio mc ls local/avatars/'"
