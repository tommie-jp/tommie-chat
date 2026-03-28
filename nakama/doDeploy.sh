#!/bin/bash
# デプロイスクリプト（Docker インストール〜アプリ起動）
# Usage: ./nakama/doDeploy.sh [-h]
#
# 前提:
#   - Ubuntu 22.04 / 24.04
#   - sudo 権限を持つユーザーで実行
#   - SSH 鍵認証・ファイアウォールは手動設定済み（doc/40-デプロイ手順.md 参照）

case "${1:-}" in
    -h|--help)
        echo "Usage: $0"
        echo "  VPS に tommieChat をデプロイします"
        echo ""
        echo "実行内容:"
        echo "  1. ファイアウォール設定"
        echo "  2. スワップ設定（2GB 以下の場合）"
        echo "  3. Docker インストール"
        echo "  4. Node.js インストール"
        echo "  5. 環境変数・セキュリティ設定（パスワード・キー自動生成）"
        echo "  6. フロントエンドビルド（server_key 自動設定）"
        echo "  7. Docker ログローテーション設定"
        echo "  8. サーバー起動（Go プラグインはビルド済み前提）"
        exit 0 ;;
esac

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
if [ "$(id -u)" -eq 0 ]; then
    fail "root で実行しないでください。sudo 権限を持つ一般ユーザーで実行してください"
fi

# ── 既存コンテナの停止（ポート競合防止） ──
# docker compose down -v で確実にコンテナ・ネットワーク・ボリュームを削除
cd "$SCRIPT_DIR"
if [ -f docker-compose.prod.yml ]; then
    docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v 2>/dev/null || true
fi
docker compose -f docker-compose.yml -f docker-compose.dev.yml down -v 2>/dev/null || true
docker compose down -v 2>/dev/null || true
# 名前ベースでも残留コンテナを削除
EXISTING=$(docker ps -aq --filter "name=nakama" 2>/dev/null; docker ps -aq --filter "name=tommchat-prod" 2>/dev/null)
EXISTING=$(echo "$EXISTING" | sort -u | grep -v '^$' || true)
if [ -n "$EXISTING" ]; then
    warn "残留コンテナを削除します"
    echo "$EXISTING" | xargs -r docker rm -f
fi

# ── 1. ファイアウォール ──
step "1. ファイアウォール設定"
if ! command -v ufw &>/dev/null; then
    warn "ufw が見つかりません。手動でファイアウォールを設定してください"
elif sudo ufw status | grep -q "Status: active"; then
    echo "ファイアウォール既に有効（スキップ）"
    sudo ufw status
else
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22/tcp
    sudo ufw allow 80/tcp
    sudo ufw allow 443/tcp
    echo "y" | sudo ufw enable
    sudo ufw status
    echo "✅ ファイアウォール設定完了"
fi

# ── 2. スワップ設定 ──
step "2. スワップ設定"
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [ "$TOTAL_MEM_KB" -le 2097152 ] && [ ! -f /swapfile ]; then
    echo "メモリ ${TOTAL_MEM_KB}KB — スワップ 2GB を作成"
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    if ! grep -q '/swapfile' /etc/fstab; then
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    fi
    echo "✅ スワップ設定完了"
else
    echo "スキップ（メモリ十分 or スワップ既存）"
fi

# ── 3. Docker インストール ──
step "3. Docker インストール"
if command -v docker &>/dev/null; then
    echo "Docker 既にインストール済み: $(docker --version)"
else
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg lsb-release

    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

    sudo usermod -aG docker "$USER"
    echo "✅ Docker インストール完了"
    warn "docker グループの反映には再ログインが必要です"
fi

# ── 4. Node.js インストール ──
step "4. Node.js インストール"
if command -v node &>/dev/null; then
    echo "Node.js 既にインストール済み: $(node --version)"
else
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "✅ Node.js インストール完了: $(node --version)"
fi

# ── 5. 環境変数の自動生成 ──
step "5. 環境変数の設定"
ENV_FILE="$SCRIPT_DIR/.env"
# ボリュームを毎回削除するため、パスワードも毎回再生成する
PG_PASS=$(openssl rand -hex 16)
SERVER_KEY=tommie-chat
CONSOLE_PASS=$(openssl rand -hex 12)
cat > "$ENV_FILE" <<EOV
POSTGRES_PASSWORD=$PG_PASS
NAKAMA_SERVER_KEY=$SERVER_KEY
NAKAMA_CONSOLE_USER=admin
NAKAMA_CONSOLE_PASS=$CONSOLE_PASS
EOV
# シェル環境にも export（docker compose が確実に参照できるようにする）
set -a; source "$ENV_FILE"; set +a
echo "✅ .env 生成完了（パスワード・キー自動生成済み）"

echo ""
echo "  server_key:       $SERVER_KEY"
echo "  console.username: admin"
echo "  console.password: $CONSOLE_PASS"

# ── 6. フロントエンドビルド ──
step "6. フロントエンドビルド"
cd "$ROOT_DIR"
npm install

# server_key をフロントエンドに埋め込んでビルド
cat > "$ROOT_DIR/.env" <<EOV2
VITE_SERVER_KEY=$SERVER_KEY
VITE_DEFAULT_HOST=mmo.tommie.jp
VITE_DEFAULT_PORT=443
EOV2
NODE_OPTIONS="--max-old-space-size=3072" npm run build
rm -f "$ROOT_DIR/.env"  # ビルド後は不要（server_key は dist/ に埋め込み済み）
echo "✅ ビルド完了（server_key 自動設定済み）"

# ── 7. Docker ログローテーション ──
step "7. Docker ログローテーション設定"
DAEMON_JSON="/etc/docker/daemon.json"
if [ ! -f "$DAEMON_JSON" ]; then
    sudo tee "$DAEMON_JSON" > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF
    sudo systemctl restart docker
    echo "✅ ログローテーション設定完了"
else
    echo "daemon.json 既存（スキップ）"
fi

# ── 8. サーバー起動 ──
step "8. サーバー起動"
cd "$SCRIPT_DIR"
echo "  NAKAMA_SERVER_KEY=${NAKAMA_SERVER_KEY}"
echo "  .env server_key: $(grep NAKAMA_SERVER_KEY "$ENV_FILE" | cut -d= -f2)"
# Go プラグイン（world.so）は開発環境でビルド済み（git に含まれる）
if [ ! -f "$SCRIPT_DIR/modules/world.so" ]; then
    echo "⚠️  nakama/modules/world.so が見つかりません。"
    echo "   開発環境で doBuild.sh を実行してから git push してください。"
    exit 1
fi
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  デプロイ完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "  Web:       http://$(hostname -I | awk '{print $1}')"
echo "  Console:   http://127.0.0.1:7351 (admin / $CONSOLE_PASS)"
echo ""
echo "次のステップ:"
echo "  HTTPS を設定: ./nakama/doSetupHTTPS.sh <ドメイン名>"
echo ""
echo "詳細: doc/40-デプロイ手順.md"
