#!/bin/bash
# GitHubのPersonal Access Token (classic)を更新するスクリプト
# credential.helper = store 前提（~/.git-credentials）

set -e

CRED_FILE="$HOME/.git-credentials"
HOST="github.com"

echo "=== GitHub Token 更新 ==="
echo ""

# gh CLI の credential helper が設定されている場合は無効化
if git config --get-all credential.https://github.com.helper 2>/dev/null | grep -q "gh auth git-credential"; then
    echo "gh CLI の credential helper を検出しました。無効化します..."
    # gh CLIからログアウト
    if command -v gh >/dev/null 2>&1; then
        GH_USER=$(gh auth status 2>&1 | grep "account" | head -1 | awk '{print $7}')
        if [ -n "$GH_USER" ]; then
            gh auth logout -h github.com -u "$GH_USER" 2>/dev/null || true
            echo "  gh auth logout 完了: $GH_USER"
        fi
    fi
    # gitconfigからgh credential helperを削除
    git config --global --unset-all credential.https://github.com.helper 2>/dev/null || true
    git config --global --unset-all credential.https://gist.github.com.helper 2>/dev/null || true
    echo "  gh credential helper を削除しました。"
    echo "  以降は ~/.git-credentials (store) が使われます。"
    echo ""
fi

# 現在の設定を確認
if [ ! -f "$CRED_FILE" ]; then
    echo "エラー: $CRED_FILE が見つかりません。"
    echo "  git config --global credential.helper store を先に設定してください。"
    exit 1
fi

# 現在のユーザ名を取得
CURRENT_USER=$(grep "$HOST" "$CRED_FILE" 2>/dev/null | head -1 | sed 's|https://\([^:]*\):.*|\1|')
if [ -z "$CURRENT_USER" ]; then
    echo "現在のGitHubユーザ名を入力:"
    read -r CURRENT_USER
else
    echo "現在のユーザ名: $CURRENT_USER"
fi

# 新しいトークンを入力
echo ""
echo "新しいPersonal Access Tokenを入力（ghp_で始まる文字列）:"
read -rs NEW_TOKEN
echo ""

if [ -z "$NEW_TOKEN" ]; then
    echo "エラー: トークンが空です。"
    exit 1
fi

# ghp_ で始まるか確認
if [[ ! "$NEW_TOKEN" =~ ^ghp_ ]]; then
    echo "警告: トークンが ghp_ で始まっていません。続行しますか？ (y/N)"
    read -r CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
        echo "中止しました。"
        exit 0
    fi
fi

# 既存のgithub.comエントリを削除して新しいものを追加
TEMP_FILE=$(mktemp)
grep -v "$HOST" "$CRED_FILE" > "$TEMP_FILE" 2>/dev/null || true
echo "https://${CURRENT_USER}:${NEW_TOKEN}@${HOST}" >> "$TEMP_FILE"
mv "$TEMP_FILE" "$CRED_FILE"
chmod 600 "$CRED_FILE"

echo "トークンを更新しました。"
echo ""

# 接続テスト
echo "接続テスト中..."
if git ls-remote origin HEAD >/dev/null 2>&1; then
    echo "成功: リモートリポジトリに接続できました。"
else
    echo "失敗: 接続できません。トークンやリポジトリURLを確認してください。"
    echo "  現在のリモート: $(git remote get-url origin 2>/dev/null)"
    exit 1
fi
