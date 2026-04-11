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
        echo "  4. (予約)"
        echo "  5. 環境変数設定（初回のみ生成、以降は再利用）"
        echo "  6. 本番用 nginx.conf 生成"
        echo "  7. フロントエンド配置（開発環境でビルド済みの dist/ を使用）"
        echo "  8. Docker ログローテーション設定"
        echo "  9. サーバー起動（Go プラグインはビルド済み前提）"
        echo " 10. MinIO バケット初期化"
        exit 0 ;;
esac

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# ── 既存 .env の事前読み込み ──
# docker compose は cwd の .env を自動で読むが、シェル側でも COMPOSE_PROJECT_NAME
# 等を参照したいので明示的に読み込む。まだ存在しない場合は step 5 で生成する。
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/.env"
    set +a
fi

# ── COMPOSE_PROJECT_NAME の自動導出 ──
# 同一 VPS 上で複数ホスト (mmo.tommie.jp / mmo-test.tommie.jp / mmo1.tommie.jp ...)
# を並行運用しても衝突しないよう、プロジェクト名はホスト名ベースで一意にする。
# docker compose の project 名はドット不可なのでドットはダッシュに置換する。
#   mmo.tommie.jp       → mmo-tommie-jp
#   mmo-test.tommie.jp  → mmo-test-tommie-jp
#   mmo1.tommie.jp      → mmo1-tommie-jp
# 既存 .env に COMPOSE_PROJECT_NAME が設定されていればそれを優先する（後方互換）。
# 以前の運用では tommchat-prod / tommchat-test を手動で設定していたため、
# 既存環境の project 名は変わらないまま新規ホストだけ自動導出される。
if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
    _hn="${DEPLOY_HOSTNAME:-$(hostname -f 2>/dev/null || true)}"
    case "$_hn" in
        ""|localhost|localhost.*|.|..|*[!a-zA-Z0-9.-]*) : ;;
        *)
            COMPOSE_PROJECT_NAME=$(echo "$_hn" | tr '.' '-' | tr '[:upper:]' '[:lower:]')
            export COMPOSE_PROJECT_NAME
            ;;
    esac
    unset _hn
fi

# ── 色付き出力 ──
GREEN=$'\e[32m'
RED=$'\e[31m'
YELLOW=$'\e[33m'
RESET=$'\e[0m'

step() { echo ""; echo "${GREEN}━━━ $1 ━━━${RESET}"; }
warn() { echo "${YELLOW}⚠️  $1${RESET}"; }
fail() { echo "${RED}❌ $1${RESET}"; exit 1; }

# ── 別 compose プロジェクトとの bind mount 衝突検査 ──
# 過去、同一 VPS 上で複数環境を並行運用した際に、別ディレクトリから起動した
# にもかかわらず同じ bind mount（./data/postgres-prod/）を掴んで DB が破壊された
# 事故があった。起動前に他プロジェクトが $SCRIPT_DIR 配下を使用していないか検査する。
preflight_bind_mount_check() {
    local script_dir="$1"
    local current_project="$2"
    if ! command -v docker &>/dev/null; then
        return 0  # 初回デプロイでは docker 未インストールのためスキップ
    fi
    local all_containers
    all_containers=$(docker ps -aq 2>/dev/null || true)
    [ -z "$all_containers" ] && return 0

    local collisions="" cn proj
    for cn in $all_containers; do
        proj=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$cn" 2>/dev/null || echo "")
        [ -z "$proj" ] && continue
        [ "$proj" = "$current_project" ] && continue
        local sources
        sources=$(docker inspect --format '{{ range .Mounts }}{{ if eq .Type "bind" }}{{ .Source }}{{"\n"}}{{ end }}{{ end }}' "$cn" 2>/dev/null || true)
        local src
        while IFS= read -r src; do
            [ -z "$src" ] && continue
            case "$src" in
                "$script_dir"|"$script_dir"/*)
                    collisions+="  $cn (project=$proj): $src"$'\n'
                    ;;
            esac
        done <<< "$sources"
    done

    if [ -n "$collisions" ]; then
        echo "${RED}❌ 別 compose プロジェクトが ${script_dir} 配下を bind mount しています:${RESET}"
        printf '%s' "$collisions"
        echo ""
        echo "対処:"
        echo "  1. 衝突している環境を先に停止してください"
        echo "     docker compose -p <project> down"
        echo "  2. 各環境は別ディレクトリ（例: ~/mmo.tommie.jp と ~/mmo-test.tommie.jp）から"
        echo "     異なる COMPOSE_PROJECT_NAME で起動する必要があります"
        exit 1
    fi
}

# ── 前提チェック ──
if [ "$(id -u)" -eq 0 ]; then
    fail "root で実行しないでください。sudo 権限を持つ一般ユーザーで実行してください"
fi

# ── 既存コンテナの停止（ポート競合防止） ──
# Bind mount（./data/）を使用するため、データはコンテナ削除後も保持される
# 複数環境が同一 VPS で動くため、COMPOSE_PROJECT_NAME に紐づくコンテナのみを対象にする。
cd "$SCRIPT_DIR"

# docker compose は cwd の .env を自動で読むので、COMPOSE_PROJECT_NAME は yml の name 解決で使用される
CURRENT_PROJECT="${COMPOSE_PROJECT_NAME:-tommchat-prod}"
echo "  project name: ${CURRENT_PROJECT}"

# ── bind mount 衝突検査（destructive な操作の前に実行） ──
preflight_bind_mount_check "$SCRIPT_DIR" "$CURRENT_PROJECT"

if [ -f docker-compose.prod.yml ]; then
    docker compose -f docker-compose.yml -f docker-compose.prod.yml down 2>/dev/null || true
fi
docker compose -f docker-compose.yml -f docker-compose.dev.yml down 2>/dev/null || true
docker compose down 2>/dev/null || true
# 名前ベースでも残留コンテナを削除（当該プロジェクトのみ）
EXISTING=$(docker ps -aq --filter "name=${CURRENT_PROJECT}-" 2>/dev/null | sort -u | grep -v '^$' || true)
if [ -n "$EXISTING" ]; then
    warn "残留コンテナを削除します (project=${CURRENT_PROJECT})"
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
    sudo apt-get install -y ca-certificates curl gnupg lsb-release jq

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

# ── 4. jq インストール（doS3-set-avatars-remote.sh 等で使用） ──
step "4. jq インストール"
if command -v jq &>/dev/null; then
    echo "jq 既にインストール済み: $(jq --version)"
else
    sudo apt-get update
    sudo apt-get install -y jq
    echo "✅ jq インストール完了"
fi


# ── 5. 環境変数の設定 ──
step "5. 環境変数の設定"
ENV_FILE="$SCRIPT_DIR/.env"
# Bind mount でデータ永続化するため、.env が既にあれば再利用する。
# ただし必須フィールドが欠けていれば都度生成して追記する
# （例: .env に DEPLOY_HOSTNAME だけ書いた状態で実行しても落ちないように）。
if [ -f "$ENV_FILE" ]; then
    echo ".env が既に存在します（再利用）"
    set -a; source "$ENV_FILE"; set +a
else
    echo ".env が存在しません — 初回生成します"
    : > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
fi

# 必須フィールドを 1 項目ずつチェック。未設定・空文字なら生成して .env に追記する。
ensure_env() {
    local key="$1"
    local value="$2"
    local current
    current=$(eval "printf '%s' \"\${${key}:-}\"")
    if [ -n "$current" ]; then
        return 0
    fi
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        # .env には書かれているが空文字 → 警告のみ、上書きはしない
        warn "${key} が .env に存在しますが空です（そのまま使用）"
        eval "export ${key}=\"\$value\""
        return 0
    fi
    echo "${key}=${value}" >> "$ENV_FILE"
    eval "export ${key}=\"\$value\""
    echo "  .env に ${key} を生成・追記"
}

# COMPOSE_PROJECT_NAME はホスト名から自動導出済み（スクリプト冒頭参照）。
# ここで .env に未記載なら追記することで、2 回目以降のデプロイでも同じ名前を
# 再利用できるようにする。
if [ -n "${COMPOSE_PROJECT_NAME:-}" ] && ! grep -q '^COMPOSE_PROJECT_NAME=' "$ENV_FILE" 2>/dev/null; then
    echo "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME" >> "$ENV_FILE"
    echo "  .env に COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME を追記"
fi

ensure_env POSTGRES_PASSWORD    "$(openssl rand -hex 16)"
ensure_env NAKAMA_SERVER_KEY    "tommie-chat"
ensure_env NAKAMA_CONSOLE_USER  "admin"
ensure_env NAKAMA_CONSOLE_PASS  "$(openssl rand -hex 12)"
ensure_env MINIO_ROOT_USER      "minio-$(openssl rand -hex 4)"
ensure_env MINIO_ROOT_PASSWORD  "$(openssl rand -hex 16)"

# ── PORT_OFFSET 決定とポート番号の補完 ──
# 同一 VPS 上で複数環境（prod + test 等）を動かす際のポート衝突を防ぐ。
# 決定順:
#   1. 環境変数 / .env の PORT_OFFSET が指定されていればそれを使用
#   2. COMPOSE_PROJECT_NAME=tommchat-prod なら offset=0（正規のベースポート）
#   3. それ以外はプロジェクト名の cksum から [1..9] を決定論的に算出
# 各ポートは base + PORT_OFFSET*100 で割当てる。
if [ -z "${PORT_OFFSET:-}" ]; then
    if [ "$CURRENT_PROJECT" = "tommchat-prod" ]; then
        PORT_OFFSET=0
    else
        _SUM=$(echo -n "$CURRENT_PROJECT" | cksum | awk '{print $1}')
        PORT_OFFSET=$(( (_SUM % 9) + 1 ))
        unset _SUM
    fi
fi
case "$PORT_OFFSET" in
    ''|*[!0-9]*) fail "PORT_OFFSET が数値ではありません: '${PORT_OFFSET}'" ;;
esac
if [ "$PORT_OFFSET" -lt 0 ] || [ "$PORT_OFFSET" -gt 9 ]; then
    fail "PORT_OFFSET は 0〜9 の範囲で指定してください: ${PORT_OFFSET}"
fi
if ! grep -q '^PORT_OFFSET=' "$ENV_FILE" 2>/dev/null; then
    echo "PORT_OFFSET=$PORT_OFFSET" >> "$ENV_FILE"
    echo "  .env に PORT_OFFSET=$PORT_OFFSET を追記"
fi
export PORT_OFFSET

ensure_port() {
    local key="$1"
    local base="$2"
    local current
    current=$(eval "printf '%s' \"\${${key}:-}\"")
    if [ -n "$current" ]; then
        return 0
    fi
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        warn "${key} が .env に存在しますが空です（そのまま使用）"
        return 0
    fi
    local val=$((base + PORT_OFFSET * 100))
    echo "${key}=${val}" >> "$ENV_FILE"
    eval "export ${key}=${val}"
    echo "  .env に ${key}=${val} を追記"
}

ensure_port POSTGRES_PORT        5432
ensure_port NAKAMA_PPROF_PORT    6060
ensure_port NAKAMA_GRPC_PORT     7349
ensure_port NAKAMA_API_PORT      7350
ensure_port NAKAMA_CONSOLE_PORT  7351
ensure_port WEB_PORT             8081
ensure_port PROMETHEUS_PORT      9090
ensure_port MINIO_S3_PORT        9000
ensure_port MINIO_CONSOLE_PORT   9001

echo "  port offset: ${PORT_OFFSET} (WEB=${WEB_PORT}, POSTGRES=${POSTGRES_PORT}, NAKAMA_API=${NAKAMA_API_PORT})"

# ── DEPLOY_HOSTNAME 解決 ──
# nginx.conf の Origin/Referer 検査で使用する公開ホスト名。
# 解決順: 環境変数 > .env(DEPLOY_HOSTNAME) > `hostname -f`
# 初回に確定した値は .env へ追記し、以降のデプロイで再利用する。
if [ -z "${DEPLOY_HOSTNAME:-}" ]; then
    DETECTED=$(hostname -f 2>/dev/null || true)
    case "$DETECTED" in
        ""|localhost|localhost.*)
            fail "DEPLOY_HOSTNAME が未設定で hostname -f も有効な値を返しません。
   DEPLOY_HOSTNAME=<公開ホスト名> bash doDeploy.sh の形式で指定するか、
   nakama/.env に DEPLOY_HOSTNAME=mmo.tommie.jp 等を追記してください" ;;
    esac
    DEPLOY_HOSTNAME="$DETECTED"
    warn "DEPLOY_HOSTNAME 未指定 — hostname -f から '${DEPLOY_HOSTNAME}' を使用"
fi

# 公開ホスト名は英数字・ドット・ハイフンのみ許可（nginx 設定への注入防止）
case "$DEPLOY_HOSTNAME" in
    *[!a-zA-Z0-9.-]*|""|.|..)
        fail "DEPLOY_HOSTNAME が不正です: '${DEPLOY_HOSTNAME}'" ;;
esac

if ! grep -q '^DEPLOY_HOSTNAME=' "$ENV_FILE" 2>/dev/null; then
    echo "DEPLOY_HOSTNAME=$DEPLOY_HOSTNAME" >> "$ENV_FILE"
    echo "  .env に DEPLOY_HOSTNAME=$DEPLOY_HOSTNAME を追記"
fi
echo "  公開ホスト名: $DEPLOY_HOSTNAME"

SERVER_KEY="${NAKAMA_SERVER_KEY}"
CONSOLE_PASS="${NAKAMA_CONSOLE_PASS}"
MINIO_USER="${MINIO_ROOT_USER}"
MINIO_PASS="${MINIO_ROOT_PASSWORD}"

echo ""
echo "  server_key:       $SERVER_KEY"
echo "  console.username: ${NAKAMA_CONSOLE_USER:-admin}"
echo "  console.password: $CONSOLE_PASS"
echo "  minio.user:       $MINIO_USER"
echo "  minio.password:   $MINIO_PASS"

# ── 6. 本番用 nginx.conf 生成 ──
step "6. 本番用 nginx.conf 生成"
NGINX_CONF="$SCRIPT_DIR/nginx.conf"
# 開発用 nginx.conf をバックアップ（初回のみ）
if [ ! -f "$NGINX_CONF.dev" ]; then
    cp "$NGINX_CONF" "$NGINX_CONF.dev"
fi
# Origin/Referer 正規表現用にホスト名のドットをエスケープ
HOST_REGEX=$(echo "$DEPLOY_HOSTNAME" | sed 's/\./\\./g')
cat > "$NGINX_CONF" <<'NGINX_EOF'
server {
    listen 80;

    root /usr/share/nginx/html;
    index index.html;

    include /etc/nginx/mime.types;
    types {
        image/ktx2 ktx2;
    }

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    # セキュリティヘッダー
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    # CSP: Google OAuth2 用に accounts.google.com / oauth2.googleapis.com を許可
    #   - form-action: 認可リダイレクト先
    #   - connect-src: トークン交換 (サーバ側 RPC 経由なので厳密には不要だが将来的な fetch 用に許可)
    #   - script-src / frame-src: One Tap 併用時用（現状の方式 B のみなら不要）
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.babylonjs.com https://accounts.google.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' wss://*.tommie.jp https://cdn.babylonjs.com https://oauth2.googleapis.com; font-src 'self'; object-src 'none'; frame-ancestors 'none'; frame-src https://accounts.google.com; form-action 'self' https://accounts.google.com" always;

    # SPA フォールバック
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Vite ビルド済みアセット — 長期キャッシュ
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # テクスチャ — 長期キャッシュ
    location /textures/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # MinIO S3 リバースプロキシ（avatars バケットの GET のみ許可）
    location /s3/avatars/ {
        limit_except GET HEAD {
            deny all;
        }
        proxy_pass http://minio:9000/avatars/;
        proxy_http_version 1.1;
        proxy_set_header Host minio:9000;
        proxy_buffering off;
    }

    # /s3/ の他パスは全て拒否
    location /s3/ {
        return 403;
    }

    # Nakama HTTP API（Origin 制限: ブラウザからのリクエストのみ許可）
    location /v2/ {
        # Origin or Referer が自サイト or localhost なら許可
        set $origin_ok "N";
        if ($http_origin ~* "^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($http_origin ~* "^https?://@@HOST_REGEX@@(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($http_referer ~* "^https?://@@HOST_REGEX@@/") { set $origin_ok "Y"; }
        if ($origin_ok = "N") { return 403; }

        proxy_pass http://nakama:7350;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Nakama WebSocket（Origin 制限）
    location /ws {
        set $origin_ok "N";
        if ($http_origin ~* "^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($http_origin ~* "^https?://@@HOST_REGEX@@(:[0-9]+)?$") { set $origin_ok "Y"; }
        if ($origin_ok = "N") { return 403; }

        proxy_pass http://nakama:7350;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
    }
}
NGINX_EOF
# プレースホルダをデプロイ対象ホスト名で置換
sed -i "s|@@HOST_REGEX@@|${HOST_REGEX}|g" "$NGINX_CONF"
if grep -q '@@HOST_REGEX@@' "$NGINX_CONF"; then
    fail "nginx.conf のホスト名置換に失敗しました"
fi
echo "✅ 本番用 nginx.conf 生成完了（ホスト: ${DEPLOY_HOSTNAME} / /s3/ → MinIO プロキシ含む）"

# ── 7. フロントエンド配置 ──
step "7. フロントエンド配置"
if [ ! -d "$ROOT_DIR/dist" ] || [ ! -f "$ROOT_DIR/dist/index.html" ]; then
    fail "dist/ が見つかりません。開発環境で先にビルドしてください:
   npm run build  （開発環境で実行）
   rsync -avz --delete dist/ <deploy_user>@<VPS>:~/tommie-chat/dist/"
fi
DIST_FILES=$(find "$ROOT_DIR/dist" -type f | wc -l)
echo "  dist/ 検出: ${DIST_FILES} ファイル"
echo "✅ フロントエンド配置確認完了（開発環境でビルド済み）"

# ── 8. Docker ログローテーション ──
step "8. Docker ログローテーション設定"
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

# ── 9. サーバー起動 ──
step "9. サーバー起動"
cd "$SCRIPT_DIR"
# Bind mount 用ディレクトリ作成（初回のみ）
mkdir -p "$SCRIPT_DIR/data/postgres-prod" "$SCRIPT_DIR/data/minio"
echo "  NAKAMA_SERVER_KEY=${NAKAMA_SERVER_KEY}"
echo "  .env server_key: $(grep NAKAMA_SERVER_KEY "$ENV_FILE" | cut -d= -f2)"
# Go プラグイン（world.so）は開発環境でビルド済み（git に含まれる）
if [ ! -f "$SCRIPT_DIR/modules/world.so" ]; then
    echo "⚠️  nakama/modules/world.so が見つかりません。"
    echo "   開発環境で doBuild.sh を実行してから git push してください。"
    exit 1
fi
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# ── 10. MinIO バケット初期化 ──
step "10. MinIO バケット初期化"
echo "MinIO の起動を待機中..."
for i in $(seq 1 30); do
    if docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T minio mc ready local 2>/dev/null; then
        break
    fi
    sleep 2
done

# mc エイリアス設定 & バケット作成
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T minio \
    sh -c "mc alias set local http://localhost:9000 '$MINIO_USER' '$MINIO_PASS' && \
           mc mb --ignore-existing local/avatars && \
           mc mb --ignore-existing local/assets && \
           mc mb --ignore-existing local/uploads && \
           mc anonymous set download local/avatars && \
           mc anonymous set download local/assets"
echo "✅ MinIO バケット初期化完了（avatars, assets, uploads）"

echo ""
echo "${GREEN}=========================================${RESET}"
echo "${GREEN}  デプロイ完了${RESET}"
echo "${GREEN}=========================================${RESET}"
echo ""
echo "  Web:       http://$(hostname -I | awk '{print $1}')"
echo "  Console:   http://127.0.0.1:7351 (admin / $CONSOLE_PASS)"
echo "  MinIO:     http://127.0.0.1:9001 ($MINIO_USER / $MINIO_PASS)"
echo ""
echo "次のステップ:"
echo "  HTTPS を設定: ./nakama/doSetupHTTPS.sh <ドメイン名>"
echo ""
echo "詳細: doc/40-デプロイ手順.md"
