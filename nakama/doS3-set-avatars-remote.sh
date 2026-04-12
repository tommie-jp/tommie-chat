#!/bin/bash
# nakama/doS3-set-avatars-remote.sh
# nakama/avatars.json に列挙されたローカル PNG ファイルを
# VPS の MinIO の local/avatars バケットにアップロードする。
# Usage: ./nakama/doS3-set-avatars-remote.sh <VPSホスト> [SSHユーザー]
#
# パス解決はローカルで行い、PNG 本体を rsync で VPS の一時ディレクトリに転送、
# SSH 経由で VPS 上の minio コンテナに投入する（VPS 側 jq/curl 不要）。
SCRIPT_VERSION="2026-04-12a"

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
Usage: ./nakama/doS3-set-avatars-remote.sh [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー]

nakama/avatars.json の png_paths に列挙されたローカル PNG ファイルを
VPS の MinIO の local/avatars/ バケットに投入する。

引数:
  VPSホスト    SSH接続先（例: mmo.tommie.jp, mmo-test.tommie.jp）
               nakama/.env.deploy の DEPLOY_SSH_HOST で省略可
  SSHユーザー  SSHユーザー名
               解決順: 引数 > .env.deploy > "deploy"

オプション:
  -d, --dir <PATH>  VPS 上のインストール先ディレクトリ
                    解決順: 引数 > .env.deploy(DEPLOY_REMOTE_DIR) > "~/<VPSホスト>"

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
        -d|--dir)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                echo "❌ -d/--dir にはディレクトリパスが必要です" >&2
                exit 1
            fi
            REMOTE_DIR="$2"
            shift 2 ;;
        --dir=*)
            REMOTE_DIR="${1#--dir=}"
            shift ;;
        -d*)
            REMOTE_DIR="${1#-d}"
            shift ;;
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
# 表示は控えめに。エラー系 (warn/fail) のみ目立たせる。
step() { :; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

echo "doS3-set-avatars-remote.sh  version: ${SCRIPT_VERSION}  target: ${SSH_TARGET}"

[ -f "$JSON_FILE" ] || fail "avatars.json が見つかりません: $JSON_FILE"
command -v jq    >/dev/null 2>&1 || fail "jq が必要です。apt install jq を実行してください"
command -v rsync >/dev/null 2>&1 || fail "rsync が必要です"

# ── JSON 検証 & パス抽出 ──
# avatars.json はサイト単位のエントリを並べた配列。
# enable == true のエントリのみを対象にし、png_paths を連結して 1 本のリストにする。
# enable が true 以外（false / 未設定 / null）のエントリはスキップする。
# 旧形式（単一オブジェクト）との互換も残す。
jq empty "$JSON_FILE" 2>/dev/null || fail "avatars.json の JSON 形式が不正です"
mapfile -t PATHS < <(jq -r '
    if type == "array" then .[] | select(.enable == true) | .png_paths[]?
    else select(.enable == true) | .png_paths[]?
    end
' "$JSON_FILE")
mapfile -t ENABLED_TITLES < <(jq -r '
    if type == "array" then .[] | select(.enable == true) | .title // .site_url // "(no title)"
    else select(.enable == true) | (.title // .site_url // "(no title)")
    end
' "$JSON_FILE")
for t in "${ENABLED_TITLES[@]}"; do
    echo "  ✔ $t"
done

# enable != true エントリの png_paths（S3 から削除する候補）
mapfile -t DISABLED_PATHS < <(jq -r '
    if type == "array" then .[] | select(.enable != true) | .png_paths[]?
    else select(.enable != true) | .png_paths[]?
    end
' "$JSON_FILE")

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
# 重複パスを除去（複数サイトで同じファイルを参照した場合の保険）
if [ ${#RESOLVED[@]} -gt 0 ]; then
    mapfile -t RESOLVED < <(printf '%s\n' "${RESOLVED[@]}" | awk '!seen[$0]++')
fi
if [ ${#RESOLVED[@]} -eq 0 ]; then
    fail "avatars.json の png_paths に有効な PNG がありません（プレースホルダのまま?）"
fi
echo "  PNG count: ${#RESOLVED[@]}"

# enable != true 側のパスを解決して basename を集める（S3 からの削除候補）
DISABLED_BASENAMES=()
shopt -s nullglob
for p in "${DISABLED_PATHS[@]}"; do
    [ -z "$p" ] && continue
    case "$p" in
        *'<'*|*'>'*) continue ;;
        /*)    abs="$p" ;;
        '~/'*) abs="${HOME}/${p#\~/}" ;;
        ~)     abs="${HOME}" ;;
        *)     abs="${SCRIPT_DIR}/${p}" ;;
    esac
    case "$abs" in
        *'*'*|*'?'*|*'['*)
            matched=($abs)
            for m in "${matched[@]}"; do
                case "$(basename -- "$m")" in
                    *.png) [ -f "$m" ] && DISABLED_BASENAMES+=("$(basename -- "$m")") ;;
                esac
            done
            continue ;;
    esac
    case "$(basename -- "$abs")" in
        *.png) DISABLED_BASENAMES+=("$(basename -- "$abs")") ;;
    esac
done
shopt -u nullglob
# 有効側の basename に含まれるものは削除対象から除外（同一 PNG を enable/disable 両方で参照した場合の保険）
if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    ENABLED_BASENAMES=()
    for f in "${RESOLVED[@]}"; do
        ENABLED_BASENAMES+=("$(basename -- "$f")")
    done
    mapfile -t DISABLED_BASENAMES < <(
        {
            printf 'D %s\n' "${DISABLED_BASENAMES[@]}"
            printf 'E %s\n' "${ENABLED_BASENAMES[@]}"
        } | awk '$1=="E"{skip[$2]=1; next} $1=="D" && !skip[$2] && !seen[$2]++ {print $2}'
    )
fi
if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    echo "  disable count: ${#DISABLED_BASENAMES[@]}"
fi

# ── 0. SSH 接続テスト ──
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_TARGET}"
fi

# ── 1. VPS に rsync ──
REMOTE_TMP=$(ssh "${SSH_TARGET}" "mktemp -d")
case "$REMOTE_TMP" in
    /tmp/*) : ;;
    *) fail "リモート mktemp が想定外のパスを返しました: ${REMOTE_TMP}" ;;
esac
trap 'ssh "${SSH_TARGET}" "rm -rf ${REMOTE_TMP}" 2>/dev/null || true' EXIT
rsync -az "${RESOLVED[@]}" "${SSH_TARGET}:${REMOTE_TMP}/"

# 削除対象 basename 一覧をリモートに転送（enable != true のエントリ）
LOCAL_DEL_LIST=""
if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    LOCAL_DEL_LIST=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '${LOCAL_DEL_LIST}'; ssh '${SSH_TARGET}' 'rm -rf ${REMOTE_TMP}' 2>/dev/null || true" EXIT
    printf '%s\n' "${DISABLED_BASENAMES[@]}" > "$LOCAL_DEL_LIST"
    rsync -az "$LOCAL_DEL_LIST" "${SSH_TARGET}:${REMOTE_TMP}/disabled.txt"
fi

EXPECTED=${#RESOLVED[@]}

# ── 2. VPS の minio コンテナに投入 ──
# heredoc の \$ はリモート bash に渡り、その先の sh -c '...' 内の $VAR は
# minio コンテナの環境変数を参照する。
# 注意: docker compose exec -T は STDIN を継承するため、</dev/null で
# 切り離さないと heredoc 本体を読み込んでしまい、以降のコマンドが実行されない。
ssh "${SSH_TARGET}" bash <<REMOTE_EOF >/dev/null
set -eu
cd ${REMOTE_DIR}/nakama
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if ! \$COMPOSE ps --status running 2>/dev/null | grep -q minio; then
    echo "❌ ${VPS_HOST} の MinIO コンテナが起動していません" >&2
    exit 1
fi
\$COMPOSE exec -T minio sh -c 'mkdir -p /tmp/avatars-restore && rm -f /tmp/avatars-restore/*.png' </dev/null
n=0
total=${EXPECTED}
for f in ${REMOTE_TMP}/*.png; do
    n=\$((n + 1))
    pct=\$((n * 100 / total))
    printf '\r\033[K  %2d%% %03d/%03d %s' "\$pct" "\$n" "\$total" "\$(basename -- "\$f")" >&2
    \$COMPOSE cp "\$f" minio:/tmp/avatars-restore/ </dev/null >/dev/null 2>&1
done
printf '\r\033[K' >&2
\$COMPOSE exec -T minio sh -c '
    mc alias set local http://localhost:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing local/avatars >/dev/null
    mc cp /tmp/avatars-restore/*.png local/avatars/ >/dev/null
    rm -rf /tmp/avatars-restore
' </dev/null

REMOTE_EOF

# ── 2b. enable != true のエントリを S3 から削除 ──
ACTUALLY_DELETED=0
if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    ACTUALLY_DELETED=$(ssh "${SSH_TARGET}" bash <<REMOTE_EOF2
set -eu
cd ${REMOTE_DIR}/nakama
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
\$COMPOSE cp "${REMOTE_TMP}/disabled.txt" minio:/tmp/avatars-disabled.txt </dev/null >/dev/null 2>&1
\$COMPOSE exec -T minio sh -c '
    mc alias set local http://localhost:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null
    removed=0
    while IFS= read -r name; do
        [ -z "\$name" ] && continue
        case "\$name" in */*|*..*) continue ;; esac
        if mc stat "local/avatars/\$name" >/dev/null 2>&1; then
            mc rm "local/avatars/\$name" >/dev/null && removed=\$((removed + 1))
        fi
    done < /tmp/avatars-disabled.txt
    rm -f /tmp/avatars-disabled.txt
    echo "\$removed"
' </dev/null
REMOTE_EOF2
)
    ACTUALLY_DELETED=$(echo "$ACTUALLY_DELETED" | tr -dc '0-9')
    : "${ACTUALLY_DELETED:=0}"
fi

# ── 3. 投入結果の確認 ──
LS_OUTPUT=$(ssh "${SSH_TARGET}" bash <<REMOTE_EOF
set -eu
cd ${REMOTE_DIR}/nakama
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
\$COMPOSE exec -T minio sh -c '
    mc alias set local http://localhost:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null
    mc ls local/avatars/
' </dev/null
REMOTE_EOF
)
ACTUAL=$(echo "$LS_OUTPUT" | grep -c '\.png$' || true)
if [ "$ACTUAL" -lt "$EXPECTED" ]; then
    fail "投入されたファイル数が期待より少ないです (S3: ${ACTUAL} / enable: ${EXPECTED})"
fi
if [ "$ACTUALLY_DELETED" -gt 0 ]; then
    echo "  ✅ MinIO アバター: enable ${ACTUAL}/${EXPECTED}, disable ${ACTUALLY_DELETED} 削除"
else
    echo "  ✅ MinIO アバター: ${ACTUAL}/${EXPECTED}"
fi
