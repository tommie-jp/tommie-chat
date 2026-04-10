#!/bin/bash
# public/js/app-init.js と package.json のバージョン・日付を更新するスクリプト
# Usage: ./nakama/doVersion.sh <new-version>
#   例: ./nakama/doVersion.sh 0.1.21
#
# 更新対象:
#   public/js/app-init.js — APP_VERSION, APP_DATE
#   package.json          — "version"

set -euo pipefail
cd "$(dirname "$0")/.."

# ---------- ヘルプ ----------
show_help() {
    echo "public/js/app-init.js と package.json のバージョン・日付を更新するスクリプト"
    echo ""
    echo "Usage: $0 [new-version]"
    echo "  引数なし — マイナーバージョンを +1 (例: 0.1.20 → 0.1.21)"
    echo "  引数あり — 指定バージョンに更新 (例: $0 0.2.0)"
    echo ""
    echo "更新対象:"
    echo "  public/js/app-init.js — APP_VERSION, APP_DATE (今日の日付)"
    echo "  package.json          — \"version\""
    echo ""
    echo "更新後「コミットして良いですか？」と確認し、Y なら"
    echo "  git commit -m \"Ver. <new-version>\" を実行する"
    echo ""
    echo "オプション:"
    echo "  -h    この説明を表示"
}

if [[ "${1:-}" == "-h" ]]; then
    show_help
    exit 0
fi

# ---------- 引数チェック ----------
if [ $# -gt 1 ]; then
    show_help
    exit 1
fi

APP_INIT="public/js/app-init.js"

if [ $# -eq 0 ]; then
    # 引数なし: app-init.js の APP_VERSION からマイナーバージョンを +1
    cur_ver=$(grep -oP 'APP_VERSION\s*=\s*"\K[^"]+' "$APP_INIT")
    major=$(echo "$cur_ver" | cut -d. -f1)
    minor=$(echo "$cur_ver" | cut -d. -f2)
    patch=$(echo "$cur_ver" | cut -d. -f3)
    NEW_VER="${major}.${minor}.$((patch + 1))"
else
    NEW_VER="$1"
fi
NEW_DATE=$(date +"%Y/%m/%d")

# ---------- バリデーション ----------
if ! [[ "$NEW_VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "エラー: バージョンは X.Y.Z 形式で指定してください (例: 0.1.21)"
    exit 1
fi

# ---------- 現在の値を表示 ----------
OLD_JS_VER=$(grep -oP 'APP_VERSION\s*=\s*"\K[^"]+' "$APP_INIT")
OLD_JS_DATE=$(grep -oP 'APP_DATE\s*=\s*"\K[^"]+' "$APP_INIT")
OLD_PKG_VER=$(grep -oP '"version"\s*:\s*"\K[^"]+' package.json)

echo "=== バージョン更新 ==="
echo ""
echo "$APP_INIT:"
echo "  APP_VERSION: \"$OLD_JS_VER\" → \"$NEW_VER\""
echo "  APP_DATE:    \"$OLD_JS_DATE\" → \"$NEW_DATE\""
echo ""
echo "package.json:"
echo "  version:     \"$OLD_PKG_VER\" → \"$NEW_VER\""
echo ""

# ---------- 更新実行 ----------
# app-init.js — APP_VERSION
sed -i "s/var APP_VERSION = \"[^\"]*\"/var APP_VERSION = \"$NEW_VER\"/" "$APP_INIT"

# app-init.js — APP_DATE
sed -i "s|var APP_DATE    = \"[^\"]*\"|var APP_DATE    = \"$NEW_DATE\"|" "$APP_INIT"

# package.json — version (2行目付近の "version": "..." のみ)
sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VER\"/" package.json

# ---------- 確認表示 ----------
echo "✅ 更新完了"
echo ""
grep -n 'APP_VERSION\|APP_DATE' "$APP_INIT" | head -2
grep -n '"version"' package.json
echo ""

# ---------- コミット確認 ----------
read -rp "コミットして良いですか？ [Y/n] " ans
if [[ "$ans" =~ ^[Yy]$ || -z "$ans" ]]; then
    git add "$APP_INIT" package.json
    git commit -m "Ver. $NEW_VER"
    echo ""
    echo "✅ コミット完了: Ver. $NEW_VER"
else
    echo "コミットをスキップしました"
fi
