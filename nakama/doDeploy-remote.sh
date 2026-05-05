#!/bin/bash
# リモートデプロイ（開発環境から VPS へ一括デプロイ）
# Usage: ./nakama/doDeploy-remote.sh [-y] [-d <REMOTE_DIR>] [VPSホスト] [SSHユーザー]
#
# 開発環境（WSL2 Ubuntu 24.04）から実行する。
# フロントエンドビルド → git clone → dist/ 転送 → doDeploy.sh を一括で行う。
SCRIPT_VERSION="2026-04-18a"

# ── .env.deploy 読み込み（任意、git 管理外） ──
# 形式は doc/40-デプロイ手順.md 参照:
#   DEPLOY_SSH_USER / DEPLOY_SSH_HOST / DEPLOY_REMOTE_DIR
ENV_DEPLOY="$(cd "$(dirname "$0")" && pwd)/.env.deploy"
if [ -f "$ENV_DEPLOY" ]; then
    # shellcheck source=/dev/null
    set -a; . "$ENV_DEPLOY"; set +a
fi

# ── 引数解析 ──
# 解決順:
#   ホスト        : 引数 > .env.deploy(DEPLOY_SSH_HOST)
#   ユーザー      : 引数 > .env.deploy(DEPLOY_SSH_USER) > "deploy"
#   リモートdir   : 引数(-d) > .env.deploy(DEPLOY_REMOTE_DIR) > "~/<VPSホスト>"
#                   （デフォルトはホスト名と同じディレクトリ。複数 VPS を併設しても衝突しない）
VPS_HOST="${DEPLOY_SSH_HOST:-}"
SSH_USER="${DEPLOY_SSH_USER:-deploy}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-}"
FORCE_YES=false

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./nakama/doDeploy-remote.sh [-y] [-d <REMOTE_DIR>] [VPSホスト] [SSHユーザー]

開発環境（WSL2 Ubuntu 24.04）から VPS へ一括デプロイ

処理内容:
  1. フロントエンドビルド（npm run build）
  2. VPS に git clone（既存があれば削除確認）
  3. dist/ を VPS に rsync
  4. VPS 上で doDeploy.sh を実行（SSH 経由）

Google OAuth Client ID はサーバの nakama/.env から動的に取得されるため、
ビルド時の差し替えは不要です。

引数:
  VPSホスト                SSH接続先（例: mmo.tommie.jp, 123.45.67.89）
                           nakama/.env.deploy の DEPLOY_SSH_HOST で省略可
  SSHユーザー              SSHユーザー名
                           解決順: 引数 > .env.deploy > "deploy"

オプション:
  -y, --yes                既存ディレクトリを確認なしで削除
  -d, --dir <PATH>         VPS 上のインストール先ディレクトリ
                           解決順: 引数 > .env.deploy(DEPLOY_REMOTE_DIR) > "~/<VPSホスト>"
                           （既定は VPS ホスト名と同じディレクトリに展開するので
                            複数 VPS に同じユーザーでデプロイしても衝突しない）
                           例: -d ~/tommie-chat-custom  /  -d /opt/tommie-chat
                           ~ はリモート側シェルで展開されるのでそのまま渡せる
  -h, --help               このヘルプを表示
  -v, --version            バージョンを表示

前提:
  - VPS に SSH 鍵認証で接続可能
  - Node.js がインストール済み（開発環境）
  - 推奨: nakama/.env.deploy に DEPLOY_SSH_USER / DEPLOY_SSH_HOST /
    DEPLOY_REMOTE_DIR を設定
    （形式は doc/40-デプロイ手順.md 参照）

例:
  # ステージング
  ./nakama/doDeploy-remote.sh mmo-test.tommie.jp
  ./nakama/doDeploy-remote.sh -y mmo-test.tommie.jp

  # ディレクトリ名を明示的に指定
  ./nakama/doDeploy-remote.sh -d ~/tommie-chat-custom mmo-test.tommie.jp

  # 本番
  ./nakama/doDeploy-remote.sh mmo.tommie.jp
EOF
            exit 0 ;;
        -v|--version)
            echo "doDeploy-remote.sh  version: ${SCRIPT_VERSION}"
            exit 0 ;;
        -y|--yes)
            FORCE_YES=true
            shift ;;
        -d|--dir)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                echo "❌ -d/--dir にはディレクトリパスが必要です" >&2
                exit 1
            fi
            REMOTE_DIR="$2"
            shift 2 ;;
        --dir=*)
            REMOTE_DIR="${1#--dir=}"
            if [ -z "$REMOTE_DIR" ]; then
                echo "❌ --dir= にはディレクトリパスが必要です" >&2
                exit 1
            fi
            shift ;;
        -d*)
            REMOTE_DIR="${1#-d}"
            shift ;;
        --)
            shift
            break ;;
        -*)
            echo "❌ 不明なオプション: $1" >&2
            echo "Usage: $0 [-y] [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)" >&2
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

# REMOTE_DIR 未指定時は VPS ホスト名と同じディレクトリをデフォルトにする
# （複数 VPS を同じ Linux ユーザーで運用しても衝突しない）
if [ -z "$REMOTE_DIR" ]; then
    if [ -z "$VPS_HOST" ]; then
        # VPS_HOST も未指定 → 後段の Usage チェックでエラーに
        REMOTE_DIR="~/unknown-host"
    else
        # ディレクトリ名に使われうる不正文字を簡易サニタイズ
        # （ホスト名に含まれない文字: スペース / / .. など）
        case "$VPS_HOST" in
            */*|*" "*|..|.|*"~"*)
                echo "❌ VPS ホスト名が不正です: '${VPS_HOST}'" >&2
                exit 1 ;;
        esac
        REMOTE_DIR="~/${VPS_HOST}"
    fi
fi

# 安全性チェック: ルート直下や空パスは rm -rf で事故るので拒否
case "$REMOTE_DIR" in
    ""|"/"|"/*"|".."|"../"*)
        echo "❌ REMOTE_DIR が不正です: '${REMOTE_DIR}'" >&2
        exit 1 ;;
esac

if [ -z "$VPS_HOST" ]; then
    echo "Usage: $0 [-y] [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)"
    exit 1
fi

SSH_TARGET="${SSH_USER}@${VPS_HOST}"

# VPS_HOST から COMPOSE_PROJECT_NAME を導出（ドット → ダッシュ）。
# doDeploy.sh と同じアルゴリズムで、既存 .env に未記載の環境でも
# 同じ名前で残留コンテナを掃除できるようにする。
EXPECTED_PROJECT=$(echo "$VPS_HOST" | tr '.' '-' | tr '[:upper:]' '[:lower:]')

echo "doDeploy-remote.sh  version: ${SCRIPT_VERSION}"
echo "  target:     ${SSH_TARGET}"
echo "  remote dir: ${REMOTE_DIR}"
echo ""

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# ファイル名の連続出力を同一行に上書き表示する
# Usage: some_command | show_progress
show_progress() {
    local count=0
    while IFS= read -r line; do
        count=$((count + 1))
        printf '\r\e[K  %s' "$line"
    done
    printf '\r\e[K'
    echo "  ${count} 行"
}

# ── 前提チェック ──
step "0. 前提チェック"

# SSH 接続テスト
echo "  SSH 接続テスト: ${SSH_TARGET}"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_TARGET}" "echo ok" >/dev/null 2>&1; then
    fail "SSH 接続に失敗しました: ${SSH_TARGET}"
fi
echo "  ✅ SSH 接続 OK"

# Node.js
if ! command -v node &>/dev/null; then
    fail "Node.js がインストールされていません"
fi
echo "  ✅ Node.js $(node --version)"

# ── 1. フロントエンドビルド ──
step "1. フロントエンドビルド（ローカル）"
cd "$ROOT_DIR"

# デフォルトアバター PNG を public/avatars/ に配置して dist/ に同梱する。
# nakama/avatars.json の png_paths を元にコピーし、manifest.json を生成する。
# --prune でローカルに無いファイルは削除（ミラーモード）。
STATIC_AVATAR_SCRIPT="$SCRIPT_DIR/doStatic-set-avatars.sh"
if [ -x "$STATIC_AVATAR_SCRIPT" ]; then
    echo "  デフォルトアバターを public/avatars/ に配置中..."
    if ! "$STATIC_AVATAR_SCRIPT" --prune; then
        fail "doStatic-set-avatars.sh に失敗しました"
    fi
else
    warn "doStatic-set-avatars.sh が見つかりません（スキップ）"
fi

cat > .env <<'EOF'
VITE_SERVER_KEY=tommie-chat
VITE_DEFAULT_HOST=mmo.tommie.jp
VITE_DEFAULT_PORT=443
EOF

npm install --silent
printf '  ビルド中...'
BUILD_LOG=$(mktemp)
npm run build >"$BUILD_LOG" 2>&1 || { echo ""; cat "$BUILD_LOG"; rm -f "$BUILD_LOG"; fail "ビルドに失敗しました"; }
# dist/ 行を抽出してプログレス表示
BUILD_TOTAL=$(grep -c '^  dist/' "$BUILD_LOG" || true)
BUILD_N=0
while IFS= read -r line; do
    BUILD_N=$((BUILD_N + 1))
    PCT=$((BUILD_N * 100 / BUILD_TOTAL))
    printf '\r\e[K  ビルド中... %d%% (%d/%d)' "$PCT" "$BUILD_N" "$BUILD_TOTAL"
done < <(grep '^  dist/' "$BUILD_LOG")
printf '\r\e[K'
rm -f "$BUILD_LOG" .env

echo "  ✅ ビルド完了（${BUILD_TOTAL} ファイル）"

# ── 2. VPS に git clone ──
step "2. VPS に git clone"

# 既存ディレクトリの確認（-y 指定時は常に削除して再クローン）
DO_DELETE=false
if ssh "${SSH_TARGET}" "[ -d ${REMOTE_DIR} ]" 2>/dev/null; then
    echo "  ${REMOTE_DIR} が既に存在します"
    if [ "$FORCE_YES" = true ]; then
        DO_DELETE=true
        echo "  -y 指定: 自動削除"
    else
        read -p "  削除して再クローンしますか？ (y/N): " ans
        if [ "$ans" = "y" ] || [ "$ans" = "Y" ] || [ "$ans" = "ｙ" ] || [ "$ans" = "Ｙ" ] || [ "$ans" = "yes" ] || [ "$ans" = "YES" ]; then
            DO_DELETE=true
        fi
    fi
fi
if [ "$DO_DELETE" = true ]; then
    echo "  既存コンテナを停止・削除中..."
    ssh "${SSH_TARGET}" bash -c "'
        cd ${REMOTE_DIR}/nakama 2>/dev/null && {
            docker compose -f docker-compose.yml -f docker-compose.prod.yml down 2>/dev/null || true
            docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>/dev/null || true
            docker compose down 2>/dev/null || true
        } || true
        # 残留コンテナの強制削除は当該プロジェクトのみを対象にする。
        # プロジェクト名の解決順:
        #   1. .env の COMPOSE_PROJECT_NAME（既存環境との後方互換）
        #   2. VPS ホスト名のドットをダッシュに置換した値（新規環境の既定）
        # 過去に \"name=nakama\" や \"name=tommchat-prod-\" を使っていたが、
        # 前者は部分一致、後者はハードコードのため、逆向きのデプロイで
        # 他プロジェクト (test → prod, prod → test) を巻き込んで停止させた実績がある。
        CURRENT_PROJECT=\"\"
        if [ -f .env ]; then
            CURRENT_PROJECT=\$(sed -n \"s/^COMPOSE_PROJECT_NAME=//p\" .env | tail -n1)
        fi
        if [ -z \"\$CURRENT_PROJECT\" ]; then
            CURRENT_PROJECT=\"${EXPECTED_PROJECT}\"
        fi
        if [ -n \"\$CURRENT_PROJECT\" ]; then
            REMAINING=\$(docker ps -aq --filter \"name=\${CURRENT_PROJECT}-\" 2>/dev/null | sort -u | grep -v \"^\$\" || true)
            if [ -n \"\$REMAINING\" ]; then
                echo \"残留コンテナを削除: project=\$CURRENT_PROJECT\"
                echo \"\$REMAINING\" | xargs -r docker rm -f
            fi
        fi
        # data/ と .env は保持し、それ以外を削除して再クローン
        if [ -d ${REMOTE_DIR}/nakama/data ]; then
            mv ${REMOTE_DIR}/nakama/data /tmp/_tommie_data_bak
        fi
        if [ -f ${REMOTE_DIR}/nakama/.env ]; then
            cp ${REMOTE_DIR}/nakama/.env /tmp/_tommie_env_bak
        fi
        rm -rf ${REMOTE_DIR}
    '"
    echo "  削除しました"
elif ssh "${SSH_TARGET}" "[ -d ${REMOTE_DIR} ]" 2>/dev/null; then
    echo "  既存ディレクトリを使用します（git pull）"
    ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && git pull"
fi

# clone（ディレクトリがない場合のみ）
if ! ssh "${SSH_TARGET}" "[ -d ${REMOTE_DIR} ]" 2>/dev/null; then
    ssh "${SSH_TARGET}" "git clone https://github.com/tommie-jp/tommie-chat.git ${REMOTE_DIR}"
fi

# data/ と .env を復元
ssh "${SSH_TARGET}" bash -c "'
    if [ -d /tmp/_tommie_data_bak ]; then
        mv /tmp/_tommie_data_bak ${REMOTE_DIR}/nakama/data
        echo \"  data/ を復元しました\"
    fi
    if [ -f /tmp/_tommie_env_bak ]; then
        mv /tmp/_tommie_env_bak ${REMOTE_DIR}/nakama/.env
        echo \"  .env を復元しました\"
    fi
'"
echo "✅ リポジトリ準備完了"

# ── 3. dist/ を VPS に転送 ──
step "3. dist/ を VPS に転送（rsync）"
rsync -avz --outbuf=L --delete "$ROOT_DIR/dist/" "${SSH_TARGET}:${REMOTE_DIR}/dist/" | show_progress
echo "✅ dist/ 転送完了"

# ── 4. VPS で doDeploy.sh 実行 ──
step "4. VPS で doDeploy.sh 実行（SSH 経由）"
# DEPLOY_HOSTNAME を伝達し、リモート側 nginx.conf の Origin 検査を
# デプロイ先ホスト名に合わせて生成させる（本番/ステージングで共通スクリプトを使うため）
ssh -t "${SSH_TARGET}" "cd ${REMOTE_DIR}/nakama && DEPLOY_HOSTNAME=${VPS_HOST} bash doDeploy.sh"

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  リモートデプロイ完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "次のステップ:"
echo "  HTTPS 設定:  ssh ${SSH_TARGET} 'cd ${REMOTE_DIR}/nakama && bash doSetupHTTPS.sh ${VPS_HOST}'"
echo "  疎通テスト:  ./test/doTest-ping-remote.sh ${VPS_HOST}"
