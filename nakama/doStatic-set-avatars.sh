#!/bin/bash
# nakama/doStatic-set-avatars.sh
# nakama/avatars.json に列挙されたローカル PNG ファイルを
# public/avatars/ にコピーする（静的アセットとして dist/ に同梱される）。
# enable != true のエントリが public/avatars/ に残っていれば削除する。
#
# public/avatars/ は git 管理外。`npm run build` で dist/avatars/ に入り
# doDeploy.sh 経由で本番に配布される（MinIO 障害でも読める）。
#
# Usage:
#   ./nakama/doStatic-set-avatars.sh              # コピー実行
#   ./nakama/doStatic-set-avatars.sh --prune      # ミラーモード（ローカルに無いファイルを全削除）
SCRIPT_VERSION="2026-04-18b"

PRUNE=false

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage:
  ./nakama/doStatic-set-avatars.sh              # コピー実行
  ./nakama/doStatic-set-avatars.sh --prune      # ミラーモード

nakama/avatars.json の png_paths に列挙されたローカル PNG を
public/avatars/ にコピーする。enable != true のエントリは削除する。

オプション:
  -p, --prune  ローカルに無い public/avatars/ 内ファイルを全て削除し、
               ローカルに存在するファイルだけが残る状態にする。

パス解決:
  - 絶対パス (/ で始まる)  → そのまま使用
  - ~/ で始まるパス         → $HOME に展開
  - それ以外の相対パス      → nakama/ ディレクトリからの相対

命名規則:
  doS3-set-avatars.sh と同じ `NNN-<filename>.png` 形式（親ディレクトリの
  先頭数字を 3 桁ゼロ埋めしてファイル名先頭に付与）。

前提:
  - ローカルに jq がインストール済み
EOF
            exit 0 ;;
        -v|--version)
            echo "doStatic-set-avatars.sh  version: ${SCRIPT_VERSION}"
            exit 0 ;;
        -p|--prune)
            PRUNE=true
            shift ;;
        *)
            echo "❌ 不明な引数: $1" >&2
            exit 1 ;;
    esac
done

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
JSON_FILE="$SCRIPT_DIR/avatars.json"
PUBLIC_DIR="$PROJECT_DIR/public/avatars"

RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

echo "doStatic-set-avatars.sh  version: ${SCRIPT_VERSION}  target: ${PUBLIC_DIR}"
if [ "$PRUNE" = true ]; then
    echo "  mode: prune (ローカル以外の public/avatars/ ファイルは削除されます)"
fi

[ -f "$JSON_FILE" ] || fail "avatars.json が見つかりません: $JSON_FILE"
command -v jq >/dev/null 2>&1 || fail "jq が必要です。apt install jq を実行してください"

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

mapfile -t DISABLED_PATHS < <(jq -r '
    if type == "array" then .[] | select(.enable != true) | .png_paths[]?
    else select(.enable != true) | .png_paths[]?
    end
' "$JSON_FILE")

# ── パス解決 ──
RESOLVED=()
shopt -s nullglob
for p in "${PATHS[@]}"; do
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

# ── S3 と同じ命名規則（NNN-<filename>.png） ──
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

mkdir -p "$PUBLIC_DIR"

# ── enable なファイルをコピー（差分のみ） ──
ENABLED_BASENAMES=()
COPIED=0
SKIPPED=0
for f in "${RESOLVED[@]}"; do
    target=$(s3_name_for "$f") || {
        warn "ディレクトリ名から数字プレフィックスを抽出できません: $(dirname -- "$f")"
        continue
    }
    ENABLED_BASENAMES+=("$target")
    dst="$PUBLIC_DIR/$target"
    if [ -f "$dst" ] && cmp -s "$f" "$dst"; then
        SKIPPED=$((SKIPPED + 1))
        continue
    fi
    cp -- "$f" "$dst"
    COPIED=$((COPIED + 1))
done
EXPECTED=${#ENABLED_BASENAMES[@]}
echo "  差分検出: スキップ ${SKIPPED} / コピー ${COPIED} / 合計 ${EXPECTED}"

# ── 削除対象（enable != true 側の basename、または prune 時は全差分） ──
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

if [ "$PRUNE" = true ]; then
    # public/avatars/ に存在するが ENABLED にないファイルを全て削除候補に
    EXISTING=()
    shopt -s nullglob
    for f in "$PUBLIC_DIR"/*.png "$PUBLIC_DIR"/*.jpg "$PUBLIC_DIR"/*.jpeg; do
        [ -f "$f" ] && EXISTING+=("$(basename -- "$f")")
    done
    shopt -u nullglob
    if [ ${#EXISTING[@]} -gt 0 ]; then
        mapfile -t DISABLED_BASENAMES < <(
            {
                printf 'E\t%s\n' "${ENABLED_BASENAMES[@]}"
                printf 'X\t%s\n' "${EXISTING[@]}"
            } | awk -F'\t' '$1=="E" {skip[$2]=1; next} $1=="X" && !skip[$2] && !seen[$2]++ {print $2}'
        )
    fi
elif [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    # ENABLED に含まれるものは削除対象から除外（重複を排除）
    mapfile -t DISABLED_BASENAMES < <(
        {
            printf 'D\t%s\n' "${DISABLED_BASENAMES[@]}"
            printf 'E\t%s\n' "${ENABLED_BASENAMES[@]}"
        } | awk -F'\t' '$1=="E" {skip[$2]=1; next} $1=="D" && !skip[$2] && !seen[$2]++ {print $2}'
    )
fi

ACTUALLY_DELETED=0
if [ ${#DISABLED_BASENAMES[@]} -gt 0 ]; then
    DEL_TOTAL=${#DISABLED_BASENAMES[@]}
    echo "  削除候補: ${DEL_TOTAL} 件"
    for name in "${DISABLED_BASENAMES[@]}"; do
        [ -z "$name" ] && continue
        case "$name" in */*|*..*) continue ;; esac
        dst="$PUBLIC_DIR/$name"
        if [ -f "$dst" ]; then
            rm -f -- "$dst"
            ACTUALLY_DELETED=$((ACTUALLY_DELETED + 1))
        fi
    done
    echo "  削除完了: ${ACTUALLY_DELETED}/${DEL_TOTAL} 件"
fi

# ── 結果検証（ENABLED が全部 public/avatars/ に揃っているか） ──
ACTUAL=0
for n in "${ENABLED_BASENAMES[@]}"; do
    [ -f "$PUBLIC_DIR/$n" ] && ACTUAL=$((ACTUAL + 1))
done
if [ "$ACTUAL" -lt "$EXPECTED" ]; then
    fail "コピーされたファイル数が期待より少ないです (public: ${ACTUAL} / enable: ${EXPECTED})"
fi

# 全体ハッシュ（sha256 of sorted "md5  name" 行）
LOCAL_AGG=$(
    for n in "${ENABLED_BASENAMES[@]}"; do
        h=$(md5sum -- "$PUBLIC_DIR/$n" | awk '{print $1}')
        printf '%s\t%s\n' "$h" "$n"
    done | LC_ALL=C sort | sha256sum | awk '{print $1}'
)

# manifest.json を生成（クライアントはこの JSON でアバター一覧を取得する）
# 空白を含むファイル名（例: "012-Cat 01-1.png"）を正しく扱うため、
# `for n in $(...)` ではなく `while read` でNL区切りに固定する。
MANIFEST="$PUBLIC_DIR/manifest.json"
{
    printf '{"files":['
    first=true
    while IFS= read -r n; do
        [ -z "$n" ] && continue
        [ -f "$PUBLIC_DIR/$n" ] || continue
        if [ "$first" = true ]; then first=false; else printf ','; fi
        printf '"%s"' "$n"
    done < <(printf '%s\n' "${ENABLED_BASENAMES[@]}" | LC_ALL=C sort -u)
    printf ']}\n'
} > "$MANIFEST"

if [ "$ACTUALLY_DELETED" -gt 0 ]; then
    echo "  ✅ public/avatars/: enable ${ACTUAL}/${EXPECTED}, disable ${ACTUALLY_DELETED} 削除  hash: ${LOCAL_AGG:0:16}..."
else
    echo "  ✅ public/avatars/: ${ACTUAL}/${EXPECTED}  hash: ${LOCAL_AGG:0:16}..."
fi
