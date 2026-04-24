#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

usage() {
    cat <<EOF
使い方: $(basename "$0") [オプション]

Nakama/関連コンテナを再起動する。TOMMIE_PROD=1 または /etc/tommie-chat-prod の
存在で本番 overlay、それ以外は dev overlay を自動選択する。

オプション:
  -h, --help              この説明を表示して終了
      --fresh, --refresh  再起動前に ./doBuild.sh --fresh を実行（Go プラグインをクリーンビルド）
      --time              処理全体を time コマンドで計測
EOF
}

FRESH_BUILD=false
TIME_MEASURE=false
for arg in "$@"; do
    case "$arg" in
        -h|--help) usage; exit 0 ;;
        --fresh|--refresh) FRESH_BUILD=true ;;
        --time)    TIME_MEASURE=true ;;
        *) echo "不明なオプション: $arg" >&2; usage >&2; exit 2 ;;
    esac
done

run_main() {
if [ "$FRESH_BUILD" = true ]; then
    echo "=== ./doBuild.sh --fresh を実行 ==="
    ./doBuild.sh --fresh
fi

# nakama/.env を事前に読み込む（COMPOSE_PROJECT_NAME 等）。
# docker compose は cwd の .env を自動で読むが、シェル側でも参照するため明示的に読み込む。
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/.env"
    set +a
fi

# ── PORT_OFFSET → 個別ポート変数の補完 ──
# .env に PORT_OFFSET が設定されているが個別ポート変数が未設定の場合、
# base + PORT_OFFSET*100 で算出して export する。
# doDeploy.sh は .env に書き込むが、手動で PORT_OFFSET のみ設定した場合や
# .env.example をコピーした場合にも正しく動作するようにする。
if [ -n "${PORT_OFFSET:-}" ] && [ "$PORT_OFFSET" -gt 0 ] 2>/dev/null; then
    _ensure_port() {
        local key="$1" base="$2"
        local current
        current=$(eval "printf '%s' \"\${${key}:-}\"")
        if [ -z "$current" ]; then
            eval "export ${key}=$((base + PORT_OFFSET * 100))"
        fi
    }
    _ensure_port POSTGRES_PORT        5432
    _ensure_port NAKAMA_PPROF_PORT    6060
    _ensure_port NAKAMA_GRPC_PORT     7349
    _ensure_port NAKAMA_API_PORT      7350
    _ensure_port NAKAMA_CONSOLE_PORT  7351
    _ensure_port WEB_PORT             8081
    _ensure_port PROMETHEUS_PORT      9090
    _ensure_port MINIO_S3_PORT        9000
    _ensure_port MINIO_CONSOLE_PORT   9001
    unset -f _ensure_port
fi

# 本番判定（優先順位）:
#   1. 環境変数 TOMMIE_PROD=1
#   2. マーカーファイル /etc/tommie-chat-prod が存在
#   それ以外は dev 環境
#
# 旧来は whoami=deploy で判定していたが、ユーザー名と本番判定が密結合し
# ユーザー名変更で本番に dev compose が起動するリスクがあったため変更。
# 既存環境を本番化するには VPS で次を 1 回実行:
#   sudo touch /etc/tommie-chat-prod
if [ "${TOMMIE_PROD:-}" = "1" ] || [ -f /etc/tommie-chat-prod ]; then
    IS_PROD=true
else
    IS_PROD=false
fi

# 本番 compose プロジェクト名（.env で上書き可、デフォルトは tommchat-prod）
PROD_PROJECT="${COMPOSE_PROJECT_NAME:-tommchat-prod}"

if [ "$IS_PROD" = true ]; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
    echo "本番環境で再起動します... (project=${PROD_PROJECT})"
    $COMPOSE down
    $COMPOSE up -d
else
    # dev: prod コンテナが動いていればポート競合を避けるため停止
    PROD_COMPOSE="docker compose -p ${PROD_PROJECT} -f docker-compose.yml -f docker-compose.prod.yml"
    if docker ps --format '{{.Names}}' | grep -q "^${PROD_PROJECT}-"; then
        echo "prod コンテナを停止中... (project=${PROD_PROJECT})"
        $PROD_COMPOSE down || true
    fi
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
    $COMPOSE down
    $COMPOSE up -d --scale prometheus=0
fi

# 起動確認（最大60秒待機）
# prometheus はスケール0で除外
EXPECTED_SERVICES="postgres nakama web"
echo "コンテナ起動確認中..."
FAILED=0
for svc in $EXPECTED_SERVICES; do
    echo -n "  $svc ... "
    FOUND=false
    for i in $(seq 1 60); do
        if $COMPOSE ps --format '{{.Service}} {{.State}}' 2>/dev/null | grep -q "$svc.*running"; then
            echo "OK (${i}s)"
            FOUND=true
            break
        fi
        sleep 1
    done
    if [ "$FOUND" = false ]; then
        echo "FAIL"
        FAILED=1
    fi
done

if [ "$FAILED" -eq 0 ]; then
    echo "✅ 全コンテナ起動成功"
    return 0
else
    echo "❌ 起動失敗（上記を確認してください）"
    echo "--- docker compose ps ---"
    $COMPOSE ps
    echo "--- ログ (最後の30行) ---"
    $COMPOSE logs --tail=30
    return 1
fi
}

set +e
if [ "$TIME_MEASURE" = true ]; then
    time run_main
    rc=$?
else
    run_main
    rc=$?
fi
exit $rc
