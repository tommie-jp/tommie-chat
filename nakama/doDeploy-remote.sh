#!/bin/bash
# リモートデプロイ（開発環境から VPS へ一括デプロイ）
# Usage: ./nakama/doDeploy-remote.sh [-y] [-d <REMOTE_DIR>] <VPSホスト> [SSHユーザー]
#
# 開発環境（WSL2 Ubuntu 24.04）から実行する。
# フロントエンドビルド → git clone → dist/ 転送 → doDeploy.sh を一括で行う。
SCRIPT_VERSION="2026-04-11g"

# ── .env.deploy 読み込み（任意、git 管理外） ──
# 形式は doc/40-デプロイ手順.md 参照:
#   DEPLOY_SSH_USER / DEPLOY_SSH_HOST / DEPLOY_REMOTE_DIR / DEPLOY_GOOGLE_CLIENT_ID
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
#   Client ID差替 : 引数(-c) > .env.deploy(DEPLOY_GOOGLE_CLIENT_ID) > 差替なし（ソースの meta のまま）
VPS_HOST="${DEPLOY_SSH_HOST:-}"
SSH_USER="${DEPLOY_SSH_USER:-deploy}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-}"
GOOGLE_CLIENT_ID_OVERRIDE="${DEPLOY_GOOGLE_CLIENT_ID:-}"
FORCE_YES=false

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            cat <<'EOF'
Usage: ./nakama/doDeploy-remote.sh [-y] [-d <REMOTE_DIR>] [-c <CLIENT_ID>] <VPSホスト> [SSHユーザー]

開発環境（WSL2 Ubuntu 24.04）から VPS へ一括デプロイ

処理内容:
  1. フロントエンドビルド（npm run build）
  1b. -c 指定時: dist/index.html の Google OAuth Client ID を差し替え
  2. VPS に git clone（既存があれば削除確認）
  3. dist/ を VPS に rsync
  4. VPS 上で doDeploy.sh を実行（SSH 経由）

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
  -c, --client-id <ID>     本番用 Google OAuth Client ID（doc/55 §4-5）
                           指定時は dist/index.html の <meta> を書き換えてから転送する。
                           ソースの index.html (dev/staging 用 Client ID) は変更しない。
                           解決順: 引数 > .env.deploy(DEPLOY_GOOGLE_CLIENT_ID) > 差替なし
  -h, --help               このヘルプを表示
  -v, --version            バージョンを表示

前提:
  - VPS に SSH 鍵認証で接続可能
  - Node.js がインストール済み（開発環境）
  - 推奨: nakama/.env.deploy に DEPLOY_SSH_USER / DEPLOY_SSH_HOST /
    DEPLOY_REMOTE_DIR / DEPLOY_GOOGLE_CLIENT_ID を設定
    （形式は doc/40-デプロイ手順.md 参照）

例:
  # ステージング (~/mmo-test.tommie.jp にデプロイ、dev/staging 用 Client ID そのまま)
  ./nakama/doDeploy-remote.sh mmo-test.tommie.jp
  ./nakama/doDeploy-remote.sh -y mmo-test.tommie.jp

  # ディレクトリ名を明示的に指定
  ./nakama/doDeploy-remote.sh -d ~/tommie-chat-custom mmo-test.tommie.jp

  # 本番 (~/mmo.tommie.jp にデプロイ、prod 用 Client ID で差し替え)
  ./nakama/doDeploy-remote.sh -c 999-prod.apps.googleusercontent.com mmo.tommie.jp

  # フル指定
  ./nakama/doDeploy-remote.sh -y -d /opt/tommie-chat \
      -c 999-prod.apps.googleusercontent.com mmo.tommie.jp deploy
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
        -c|--client-id)
            if [ $# -lt 2 ] || [ -z "$2" ]; then
                echo "❌ -c/--client-id には Client ID が必要です" >&2
                exit 1
            fi
            GOOGLE_CLIENT_ID_OVERRIDE="$2"
            shift 2 ;;
        --client-id=*)
            GOOGLE_CLIENT_ID_OVERRIDE="${1#--client-id=}"
            if [ -z "$GOOGLE_CLIENT_ID_OVERRIDE" ]; then
                echo "❌ --client-id= には Client ID が必要です" >&2
                exit 1
            fi
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

# Client ID の形式チェック（指定時のみ）
# Google OAuth Web クライアントの ID は必ず .apps.googleusercontent.com で終わる
if [ -n "$GOOGLE_CLIENT_ID_OVERRIDE" ]; then
    case "$GOOGLE_CLIENT_ID_OVERRIDE" in
        *.apps.googleusercontent.com) : ;;
        *)
            echo "❌ Client ID の形式が不正です: '${GOOGLE_CLIENT_ID_OVERRIDE}'" >&2
            echo "   '.apps.googleusercontent.com' で終わる必要があります" >&2
            exit 1 ;;
    esac
    # 引用符・スペース等を含まないことを確認（sed 注入対策）
    case "$GOOGLE_CLIENT_ID_OVERRIDE" in
        *[\"\'\ \&\|\<\>\`\$\\]*)
            echo "❌ Client ID に不正な文字が含まれています" >&2
            exit 1 ;;
    esac
fi

if [ -z "$VPS_HOST" ]; then
    echo "Usage: $0 [-y] [-d <REMOTE_DIR>] [-c <CLIENT_ID>] <VPSホスト> [SSHユーザー]  (-h でヘルプ表示)"
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
if [ -n "$GOOGLE_CLIENT_ID_OVERRIDE" ]; then
    echo "  client ID:  ${GOOGLE_CLIENT_ID_OVERRIDE} (override)"
else
    echo "  client ID:  (ソース index.html の値を使用)"
fi
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

cat > .env <<'EOF'
VITE_SERVER_KEY=tommie-chat
VITE_DEFAULT_HOST=mmo.tommie.jp
VITE_DEFAULT_PORT=443
EOF

npm install --silent
npm run build
rm -f .env

DIST_FILES=$(find dist -type f | wc -l)
echo "✅ ビルド完了（${DIST_FILES} ファイル）"

# ── 1b. Google OAuth Client ID を本番用に差し替え（任意） ──
# doc/55 §4-5 参照: 本番とステージングで OAuth クライアントを分離する運用。
# ソース index.html は dev/staging 用の Client ID を保持したままにし、
# dist/index.html のみを本番用に書き換えることで、ビルドフローを変えずに分離する。
if [ -n "$GOOGLE_CLIENT_ID_OVERRIDE" ]; then
    step "1b. Google OAuth Client ID を差し替え"
    INDEX_FILE="$ROOT_DIR/dist/index.html"
    if [ ! -f "$INDEX_FILE" ]; then
        fail "dist/index.html が見つかりません"
    fi
    if ! grep -q 'name="google-oauth-client-id"' "$INDEX_FILE"; then
        fail "dist/index.html に <meta name=\"google-oauth-client-id\"> が見つかりません"
    fi
    # 既存の Client ID を取得して差分を確認
    OLD_ID=$(sed -n -E 's|.*name="google-oauth-client-id"[[:space:]]+content="([^"]*)".*|\1|p' "$INDEX_FILE" | head -n1)
    echo "  旧: ${OLD_ID}"
    echo "  新: ${GOOGLE_CLIENT_ID_OVERRIDE}"
    if [ "$OLD_ID" = "$GOOGLE_CLIENT_ID_OVERRIDE" ]; then
        echo "  ℹ️  同一のため差し替え不要"
    else
        sed -i -E "s|(<meta[[:space:]]+name=\"google-oauth-client-id\"[[:space:]]+content=\")[^\"]*(\")|\\1${GOOGLE_CLIENT_ID_OVERRIDE}\\2|" "$INDEX_FILE"
        # 差し替え成功を検証
        if ! grep -qF "content=\"${GOOGLE_CLIENT_ID_OVERRIDE}\"" "$INDEX_FILE"; then
            fail "Client ID の差し替えに失敗しました"
        fi
        echo "  ✅ dist/index.html を書き換えました"
    fi
fi

# ── 2. VPS に git clone ──
step "2. VPS に git clone"

# 既存ディレクトリの確認
if ssh "${SSH_TARGET}" "[ -d ${REMOTE_DIR} ]" 2>/dev/null; then
    echo "  ${REMOTE_DIR} が既に存在します"
    ans="n"
    if [ "$FORCE_YES" = true ]; then
        ans="y"
        echo "  -y 指定: 自動削除"
    else
        read -p "  削除して再クローンしますか？ (y/N): " ans
    fi
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
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
    else
        echo "  既存ディレクトリを使用します（git pull）"
        ssh "${SSH_TARGET}" "cd ${REMOTE_DIR} && git pull"
    fi
fi

# clone（ディレクトリがない場合のみ）
if ! ssh "${SSH_TARGET}" "[ -d ${REMOTE_DIR} ]" 2>/dev/null; then
    ssh "${SSH_TARGET}" "git clone https://github.com/open-tommie/tommie-chat.git ${REMOTE_DIR}"
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
rsync -avz --delete "$ROOT_DIR/dist/" "${SSH_TARGET}:${REMOTE_DIR}/dist/"
echo "✅ dist/ 転送完了"

# ── 4. VPS で doDeploy.sh 実行 ──
step "4. VPS で doDeploy.sh 実行（SSH 経由）"
# DEPLOY_HOSTNAME を伝達し、リモート側 nginx.conf の Origin 検査を
# デプロイ先ホスト名に合わせて生成させる（本番/ステージングで共通スクリプトを使うため）
ssh -t "${SSH_TARGET}" "cd ${REMOTE_DIR}/nakama && DEPLOY_HOSTNAME=${VPS_HOST} bash doDeploy.sh"

# ── 5. アバター PNG を MinIO に投入 ──
# doDeploy.sh で MinIO コンテナが起動した後に実行する。
# nakama/avatars.json の png_paths で指定されたローカル PNG を
# VPS の MinIO の local/avatars/ バケットに投入する。
# avatars.json がプレースホルダのままや PNG ファイルが不在の場合は
# スクリプトが失敗するが、デプロイ全体は継続する（best-effort）。
step "5. アバター PNG を MinIO に投入"
S3_SCRIPT="$SCRIPT_DIR/doS3-set-avatars-remote.sh"
if [ ! -x "$S3_SCRIPT" ]; then
    warn "doS3-set-avatars-remote.sh が見つかりません（スキップ）"
else
    if ! "$S3_SCRIPT" -d "$REMOTE_DIR" "$VPS_HOST" "$SSH_USER"; then
        warn "アバター PNG の投入に失敗しました（デプロイは継続）"
    fi
fi

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  リモートデプロイ完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "次のステップ:"
echo "  HTTPS 設定:  ssh ${SSH_TARGET} 'cd ${REMOTE_DIR}/nakama && bash doSetupHTTPS.sh ${VPS_HOST}'"
echo "  疎通テスト:  ./test/doTest-ping-remote.sh ${VPS_HOST}"
