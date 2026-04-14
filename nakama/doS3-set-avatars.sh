#!/bin/bash
# nakama/doS3-set-avatars.sh
# nakama/avatars.json に列挙されたローカル PNG ファイルを
# MinIO の local/avatars バケットにアップロードする。
# enable != true のエントリが S3 に残っていれば削除する。
#
# Usage:
#   ./nakama/doS3-set-avatars.sh                             # ローカル
#   ./nakama/doS3-set-avatars.sh <VPSホスト> [SSHユーザー]   # リモート
#
# 引数なし: ローカルの docker compose 環境に直接投入する。
# 引数あり: パス解決はローカルで行い、PNG 本体を rsync で VPS に転送、
# SSH 経由で VPS 上の minio コンテナに投入する（VPS 側 jq/curl 不要）。
SCRIPT_VERSION="2026-04-14a"

# 対応する画像拡張子
IMG_EXTS="png jpg jpeg"

# ── .env.deploy 読み込み（任意、git 管理外） ──
ENV_DEPLOY="$(cd "$(dirname "$0")" && pwd)/.env.deploy"
if [ -f "$ENV_DEPLOY" ]; then
    # shellcheck source=/dev/null
    set -a; . "$ENV_DEPLOY"; set +a
fi

VPS_HOST="${DEPLOY_SSH_HOST:-}"
SSH_USER="${DEPLOY_SSH_USER:-deploy}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-}"
PRUNE=false

# ── 引数解析 ──
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage:
  ./nakama/doS3-set-avatars.sh                                # ローカル
  ./nakama/doS3-set-avatars.sh [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー]  # リモート

nakama/avatars.json の png_paths に列挙されたローカル PNG ファイルを
MinIO の local/avatars/ バケットに投入する。
enable != true のエントリが S3 に残っていれば削除する。

モード:
  引数なし       ローカルの MinIO に直接投入
  引数あり       SSH 経由で VPS の MinIO に投入

引数（リモートモード）:
  VPSホスト    SSH接続先（例: mmo.tommie.jp, mmo-test.tommie.jp）
               nakama/.env.deploy の DEPLOY_SSH_HOST で省略可
  SSHユーザー  SSHユーザー名
               解決順: 引数 > .env.deploy > "deploy"

オプション:
  -d, --dir <PATH>  VPS 上のインストール先ディレクトリ（リモートモード）
                    解決順: 引数 > .env.deploy(DEPLOY_REMOTE_DIR) > "~/<VPSホスト>"
  -p, --prune       ミラーモード。ローカルに無い S3 オブジェクトを全て削除し、
                    ローカルに存在するファイルだけが S3 に残る状態にする。
                    （avatars.json の enable 判定に依らず S3 を正とする）

パス解決（ローカル側で実施）:
  - 絶対パス（/ で始まる） → そのまま使用
  - ~/ で始まるパス         → $HOME に展開
  - それ以外の相対パス      → nakama/ ディレクトリからの相対

前提:
  - ローカルに jq がインストール済み
  - リモートモード: rsync がインストール済み、VPS 上で MinIO コンテナが起動中
  - ローカルモード: ローカル MinIO が起動中（doRestart.sh で起動）

例:
  ./nakama/doS3-set-avatars.sh
  ./nakama/doS3-set-avatars.sh --prune
  ./nakama/doS3-set-avatars.sh mmo-test.tommie.jp
  ./nakama/doS3-set-avatars.sh --prune mmo.tommie.jp
EOF
            exit 0 ;;
        -v|--version)
            echo "doS3-set-avatars.sh  version: ${SCRIPT_VERSION}"
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
        -p|--prune)
            PRUNE=true
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

LOCAL_MODE=false
if [ -z "$VPS_HOST" ]; then
    LOCAL_MODE=true
fi

if [ "$LOCAL_MODE" = false ]; then
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
fi

set -euo pipefail

SSH_TARGET="${SSH_USER}@${VPS_HOST}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
JSON_FILE="$SCRIPT_DIR/avatars.json"

# ── 色付き出力 ──
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

if [ "$LOCAL_MODE" = true ]; then
    echo "doS3-set-avatars.sh  version: ${SCRIPT_VERSION}  MinIO: localhost"
else
    echo "doS3-set-avatars.sh  version: ${SCRIPT_VERSION}  MinIO: ${VPS_HOST} (${SSH_TARGET})"
fi
if [ "$PRUNE" = true ]; then
    echo "  mode: prune (ローカル以外の S3 オブジェクトは削除されます)"
fi

[ -f "$JSON_FILE" ] || fail "avatars.json が見つかりません: $JSON_FILE"
command -v jq    >/dev/null 2>&1 || fail "jq が必要です。apt install jq を実行してください"
if [ "$LOCAL_MODE" = false ]; then
    command -v rsync >/dev/null 2>&1 || fail "rsync が必要です"
fi

# ── JSON 検証 & パス抽出 ──
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
        *'<'*|*'>'*) continue ;;
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
                case "${m,,}" in
                    *.png|*.jpg|*.jpeg) [ -f "$m" ] && RESOLVED+=("$m") ;;
                esac
            done
            continue ;;
    esac
    case "${abs,,}" in
        *.png|*.jpg|*.jpeg) ;;
        *) warn "対応外の拡張子をスキップ: $p"; continue ;;
    esac
    if [ ! -f "$abs" ]; then
        warn "ファイルが存在しません: $abs"
        continue
    fi
    RESOLVED+=("$abs")
done
shopt -u nullglob
if [ ${#RESOLVED[@]} -gt 0 ]; then
    mapfile -t RESOLVED < <(printf '%s\n' "${RESOLVED[@]}" | awk '!seen[$0]++')
fi
if [ ${#RESOLVED[@]} -eq 0 ]; then
    fail "avatars.json の png_paths に有効な画像がありません（プレースホルダのまま?）"
fi
echo "  image count: ${#RESOLVED[@]}"

# ── S3 オブジェクト名の生成 ──
# 親ディレクトリ名の先頭数字を 3 桁ゼロ埋めしてファイル名の先頭に付与する。
# 例: nakama/avatars/001-pipoya/pipo-nekonin032.png → 001-pipo-nekonin032.png
s3_name_for() {
    local abs="$1"
    local parent digits
    parent=$(basename -- "$(dirname -- "$abs")")
    digits=$(printf '%s' "$parent" | sed -E 's/^([0-9]+).*$/\1/')
    case "$digits" in
        ''|*[!0-9]*) echo ""; return 1 ;;
    esac
    printf '%03d-%s' "$((10#$digits))" "$(basename -- "$abs")"
}

STAGE_DIR=$(mktemp -d)
# 失敗時のクリーンアップ（リモートモード側で trap を上書きするため一旦ここで設定）
trap 'rm -rf "$STAGE_DIR"' EXIT

STAGED_FILES=()
for f in "${RESOLVED[@]}"; do
    target=$(s3_name_for "$f") || {
        warn "ディレクトリ名から数字プレフィックスを抽出できません: $(dirname -- "$f")"
        continue
    }
    if [ -e "$STAGE_DIR/$target" ]; then
        warn "ステージ重複をスキップ: $target"
        continue
    fi
    # 同一 FS ならハードリンク、ダメならコピー
    ln "$f" "$STAGE_DIR/$target" 2>/dev/null || cp "$f" "$STAGE_DIR/$target"
    STAGED_FILES+=("$STAGE_DIR/$target")
done
if [ ${#STAGED_FILES[@]} -eq 0 ]; then
    fail "S3 に投入するファイルがありません（プレフィックス抽出失敗?）"
fi

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
                case "${m,,}" in
                    *.png|*.jpg|*.jpeg)
                        if [ -f "$m" ]; then
                            name=$(s3_name_for "$m") || continue
                            DISABLED_BASENAMES+=("$name")
                        fi ;;
                esac
            done
            continue ;;
    esac
    case "${abs,,}" in
        *.png|*.jpg|*.jpeg)
            name=$(s3_name_for "$abs") || continue
            DISABLED_BASENAMES+=("$name") ;;
    esac
done
shopt -u nullglob
ENABLED_BASENAMES=()
for f in "${STAGED_FILES[@]}"; do
    ENABLED_BASENAMES+=("$(basename -- "$f")")
done
# ファイル名にスペースが含まれるため awk のフィールド区切りはタブを使う。
if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    mapfile -t DISABLED_BASENAMES < <(
        {
            printf 'D\t%s\n' "${DISABLED_BASENAMES[@]}"
            printf 'E\t%s\n' "${ENABLED_BASENAMES[@]}"
        } | awk -F'\t' '$1=="E"{skip[$2]=1; next} $1=="D" && !skip[$2] && !seen[$2]++ {print $2}'
    )
fi

EXPECTED=${#STAGED_FILES[@]}

# ============================================================
#  ローカルモード
# ============================================================
if [ "$LOCAL_MODE" = true ]; then
    cd "$SCRIPT_DIR"

    # 起動中の compose 環境を判定
    if docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --status running 2>/dev/null | grep -q minio; then
        COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
    elif docker compose -f docker-compose.yml -f docker-compose.dev.yml ps --status running 2>/dev/null | grep -q minio; then
        COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
    else
        fail "ローカル MinIO が起動していません。doRestart.sh で起動してから再実行してください"
    fi

    # ── 1. minio コンテナへ転送 & 投入 ──
    $COMPOSE exec -T minio sh -c 'mkdir -p /tmp/avatars-restore && rm -f /tmp/avatars-restore/*.png /tmp/avatars-restore/*.jpg /tmp/avatars-restore/*.jpeg'
    n=0
    for f in "${STAGED_FILES[@]}"; do
        n=$((n + 1))
        pct=$((n * 100 / EXPECTED))
        printf '\r\033[K  %2d%% %03d/%03d %s' "$pct" "$n" "$EXPECTED" "$(basename -- "$f")"
        $COMPOSE cp "$f" minio:/tmp/avatars-restore/ >/dev/null 2>&1
    done
    printf '\r\033[K'
    $COMPOSE exec -T minio sh -c '
        mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
        mc mb --ignore-existing local/avatars >/dev/null
        for ext in png jpg jpeg; do
            for f in /tmp/avatars-restore/*.$ext; do
                [ -f "$f" ] && mc cp "$f" local/avatars/ >/dev/null
            done
        done
        rm -rf /tmp/avatars-restore
    '

    # ── 2a. prune: S3 側の全オブジェクトから enable 分を引いた差分を削除対象にする ──
    # MinIO コンテナには awk/grep/jq が無いので mc ls --json の生出力をホスト側でパースする。
    # ファイル名にスペースが含まれる場合があるため $NF では壊れる → jq でキー抽出。
    if [ "$PRUNE" = true ]; then
        S3_LS_RAW=$($COMPOSE exec -T minio sh -c '
            mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
            mc ls --json local/avatars/
        ')
        S3_NAMES=$(echo "$S3_LS_RAW" | jq -r 'select(.key != null and (.type // "file") == "file") | .key' 2>/dev/null | grep -E '\.(png|jpg|jpeg)$' || true)
        mapfile -t DISABLED_BASENAMES < <(
            {
                printf 'E\t%s\n' "${ENABLED_BASENAMES[@]}"
                printf '%s\n' "$S3_NAMES" | awk 'NF {print "S\t"$0}'
            } | awk -F'\t' '$1=="E" {skip[$2]=1; next} $1=="S" && !skip[$2] && !seen[$2]++ {print $2}'
        )
    fi

    # ── 2b. enable != true のエントリを S3 から削除 ──
    ACTUALLY_DELETED=0
    if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
        DEL_LIST=$(mktemp)
        trap "rm -f '$DEL_LIST'; rm -rf '$STAGE_DIR'" EXIT
        printf '%s\n' "${DISABLED_BASENAMES[@]}" > "$DEL_LIST"
        $COMPOSE cp "$DEL_LIST" minio:/tmp/avatars-disabled.txt >/dev/null 2>&1
        rm -f "$DEL_LIST"
        ACTUALLY_DELETED=$($COMPOSE exec -T minio sh -c '
            mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
            removed=0
            while IFS= read -r name; do
                [ -z "$name" ] && continue
                case "$name" in */*|*..*) continue ;; esac
                if mc stat "local/avatars/$name" >/dev/null 2>&1; then
                    mc rm "local/avatars/$name" >/dev/null && removed=$((removed + 1))
                fi
            done < /tmp/avatars-disabled.txt
            rm -f /tmp/avatars-disabled.txt
            echo "$removed"
        ')
        ACTUALLY_DELETED=$(echo "$ACTUALLY_DELETED" | tr -dc '0-9')
        : "${ACTUALLY_DELETED:=0}"
    fi

    # ── 3. 投入結果の確認 ──
    LS_OUTPUT=$($COMPOSE exec -T minio sh -c '
        mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
        mc ls local/avatars/
    ')
    ACTUAL=$(echo "$LS_OUTPUT" | grep -cE '\.(png|jpg|jpeg)$' || true)
    if [ "$ACTUAL" -lt "$EXPECTED" ]; then
        fail "投入されたファイル数が期待より少ないです (S3: ${ACTUAL} / enable: ${EXPECTED})"
    fi
    if [ "$ACTUALLY_DELETED" -gt 0 ]; then
        echo "  ✅ MinIO アバター: enable ${ACTUAL}/${EXPECTED}, disable ${ACTUALLY_DELETED} 削除"
    else
        echo "  ✅ MinIO アバター: ${ACTUAL}/${EXPECTED}"
    fi
    exit 0
fi

# ============================================================
#  リモートモード
# ============================================================

# ── 0. SSH 接続テスト ──
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_TARGET}"
fi

# ── 0b. prune: リモート S3 から現状のオブジェクト一覧を取得して削除対象を算出 ──
# MinIO コンテナには awk/grep が無いので mc ls の生出力を受け取ってホスト側でパースする。
if [ "$PRUNE" = true ]; then
    S3_LS_RAW=$(ssh "${SSH_TARGET}" bash <<REMOTE_LS_EOF
set -eu
cd ${REMOTE_DIR}/nakama
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if ! \$COMPOSE ps --status running 2>/dev/null | grep -q minio; then
    echo "__NO_MINIO__"
    exit 0
fi
\$COMPOSE exec -T minio sh -c '
    mc alias set local http://localhost:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null 2>&1 || exit 0
    mc ls --json local/avatars/ 2>/dev/null || true
' </dev/null
REMOTE_LS_EOF
)
    if [ "$S3_LS_RAW" = "__NO_MINIO__" ]; then
        fail "${VPS_HOST} の MinIO コンテナが起動していません"
    fi
    S3_NAMES=$(echo "$S3_LS_RAW" | jq -r 'select(.key != null and (.type // "file") == "file") | .key' 2>/dev/null | grep -E '\.(png|jpg|jpeg)$' || true)
    mapfile -t DISABLED_BASENAMES < <(
        {
            printf 'E\t%s\n' "${ENABLED_BASENAMES[@]}"
            printf '%s\n' "$S3_NAMES" | awk 'NF {print "S\t"$0}'
        } | awk -F'\t' '$1=="E" {skip[$2]=1; next} $1=="S" && !skip[$2] && !seen[$2]++ {print $2}'
    )
fi

# ── 1. VPS に rsync ──
REMOTE_TMP=$(ssh "${SSH_TARGET}" "mktemp -d")
case "$REMOTE_TMP" in
    /tmp/*) : ;;
    *) fail "リモート mktemp が想定外のパスを返しました: ${REMOTE_TMP}" ;;
esac
trap 'rm -rf "$STAGE_DIR"; ssh "${SSH_TARGET}" "rm -rf ${REMOTE_TMP}" 2>/dev/null || true' EXIT
# STAGE_DIR 直下に prefix 付き名前のファイル/ハードリンクが並んでいる。
# ハードリンクでも rsync は実体を送るため追加フラグ不要。
rsync -az "${STAGE_DIR}/" "${SSH_TARGET}:${REMOTE_TMP}/"

# 削除対象 basename 一覧をリモートに転送
if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    LOCAL_DEL_LIST=$(mktemp)
    # shellcheck disable=SC2064
    trap "rm -f '${LOCAL_DEL_LIST}'; rm -rf '${STAGE_DIR}'; ssh '${SSH_TARGET}' 'rm -rf ${REMOTE_TMP}' 2>/dev/null || true" EXIT
    printf '%s\n' "${DISABLED_BASENAMES[@]}" > "$LOCAL_DEL_LIST"
    rsync -az "$LOCAL_DEL_LIST" "${SSH_TARGET}:${REMOTE_TMP}/disabled.txt"
fi

# ── 2. VPS の minio コンテナに投入 ──
# heredoc の \$ はリモート bash に渡り、sh -c '...' 内の $VAR は minio コンテナの環境変数を参照。
# docker compose exec -T は STDIN を継承するため、</dev/null で切り離す。
ssh "${SSH_TARGET}" bash <<REMOTE_EOF >/dev/null
set -eu
cd ${REMOTE_DIR}/nakama
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
if ! \$COMPOSE ps --status running 2>/dev/null | grep -q minio; then
    echo "❌ ${VPS_HOST} の MinIO コンテナが起動していません" >&2
    exit 1
fi
\$COMPOSE exec -T minio sh -c 'mkdir -p /tmp/avatars-restore && rm -f /tmp/avatars-restore/*.png /tmp/avatars-restore/*.jpg /tmp/avatars-restore/*.jpeg' </dev/null
n=0
total=${EXPECTED}
for f in ${REMOTE_TMP}/*.png ${REMOTE_TMP}/*.jpg ${REMOTE_TMP}/*.jpeg; do
    [ -f "\$f" ] || continue
    n=\$((n + 1))
    pct=\$((n * 100 / total))
    printf '\r\033[K  %2d%% %03d/%03d %s' "\$pct" "\$n" "\$total" "\$(basename -- "\$f")" >&2
    \$COMPOSE cp "\$f" minio:/tmp/avatars-restore/ </dev/null >/dev/null 2>&1
done
printf '\r\033[K' >&2
\$COMPOSE exec -T minio sh -c '
    mc alias set local http://localhost:9000 "\$MINIO_ROOT_USER" "\$MINIO_ROOT_PASSWORD" >/dev/null
    mc mb --ignore-existing local/avatars >/dev/null
    for ext in png jpg jpeg; do
        for f in /tmp/avatars-restore/*.\$ext; do
            [ -f "\$f" ] && mc cp "\$f" local/avatars/ >/dev/null
        done
    done
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
ACTUAL=$(echo "$LS_OUTPUT" | grep -cE '\.(png|jpg|jpeg)$' || true)
if [ "$ACTUAL" -lt "$EXPECTED" ]; then
    fail "投入されたファイル数が期待より少ないです (S3: ${ACTUAL} / enable: ${EXPECTED})"
fi
if [ "$ACTUALLY_DELETED" -gt 0 ]; then
    echo "  ✅ MinIO アバター: enable ${ACTUAL}/${EXPECTED}, disable ${ACTUALLY_DELETED} 削除"
else
    echo "  ✅ MinIO アバター: ${ACTUAL}/${EXPECTED}"
fi
