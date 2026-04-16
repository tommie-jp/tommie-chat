#!/bin/bash
# テストスクリプト共通ライブラリ
#
# Nakama 接続設定の読み込み・引数パース・docker compose 検出などの
# 共通処理を提供する。各テストスクリプトから source して使用する。
#
# 使い方:
#   source "$(dirname "$0")/lib/nakama-test-lib.sh"
#   load_nakama_config           # .env + docker-compose.yml から設定読み込み
#   detect_compose               # docker compose コマンドを自動検出
#
# 提供する関数:
#   load_nakama_config   .env / docker-compose.yml から NAKAMA_* を設定
#   detect_compose       dev/prod の docker compose コマンドを COMPOSE に設定
#   detect_api_base      API_BASE / IS_LOCAL / PROTO を設定
#   check                テスト結果の OK/NG 出力 + カウント
#
# 提供する変数（load_nakama_config 後）:
#   NAKAMA_HOST, NAKAMA_PORT, NAKAMA_SERVER_KEY, SERVER_KEY
#
# 提供する変数（detect_compose 後）:
#   COMPOSE
#
# 提供する変数（detect_api_base 後）:
#   API_BASE, IS_LOCAL, PROTO
#
# 提供する変数（check 使用時）:
#   PASS, FAILED, TOTAL

# ── ルートディレクトリ解決 ──
# source 元スクリプトが cd する前に呼ばれる場合があるため、
# このファイル自身のパスから算出する。
_TESTLIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TESTLIB_ROOT="$(cd "$_TESTLIB_DIR/../.." && pwd)"

# ── load_nakama_config ──
# .env → docker-compose.yml → デフォルト値 の優先順で Nakama 接続設定を読み込む。
# OPT_HOST / OPT_PORT が設定されていればそれを最優先にする。
#
# 使い方:
#   OPT_HOST="mmo.tommie.jp"  # 引数パースで設定（任意）
#   OPT_PORT="443"            # 引数パースで設定（任意）
#   load_nakama_config
load_nakama_config() {
    # .env から読み込み（未設定の場合のみ）
    local env_file="$_TESTLIB_ROOT/nakama/.env"
    if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f "$env_file" ]; then
        set -a
        # shellcheck source=/dev/null
        source "$env_file"
        set +a
    fi

    # docker-compose.yml からフォールバック取得
    local compose_file="$_TESTLIB_ROOT/nakama/docker-compose.yml"
    if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f "$compose_file" ]; then
        local _key
        _key=$(grep -oP '(?<=--socket\.server_key\s)\S+' "$compose_file" 2>/dev/null | head -1)
        [ -n "$_key" ] && NAKAMA_SERVER_KEY="$_key"
    fi

    # 優先順位: OPT_* > 環境変数 > デフォルト
    export NAKAMA_HOST="${OPT_HOST:-${NAKAMA_HOST:-127.0.0.1}}"
    export NAKAMA_PORT="${OPT_PORT:-${NAKAMA_PORT:-7350}}"
    export NAKAMA_SERVER_KEY="${NAKAMA_SERVER_KEY:-tommie-chat}"
    SERVER_KEY="$NAKAMA_SERVER_KEY"
}

# ── detect_compose ──
# 実行中のコンテナから dev/prod を自動検出し、COMPOSE 変数を設定する。
# nakama/ ディレクトリへの cd は不要（-f でフルパスを使用）。
detect_compose() {
    local nakama_dir="$_TESTLIB_ROOT/nakama"
    COMPOSE="docker compose"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'tommchat-prod'; then
        COMPOSE="docker compose -f $nakama_dir/docker-compose.yml -f $nakama_dir/docker-compose.prod.yml"
    elif [ -f "$nakama_dir/docker-compose.dev.yml" ]; then
        COMPOSE="docker compose -f $nakama_dir/docker-compose.yml -f $nakama_dir/docker-compose.dev.yml"
    fi
}

# ── detect_api_base ──
# NAKAMA_HOST / NAKAMA_PORT から IS_LOCAL, PROTO, API_BASE を設定する。
# load_nakama_config の後に呼ぶこと。
detect_api_base() {
    IS_LOCAL=false
    if [ "$NAKAMA_HOST" = "127.0.0.1" ] || [ "$NAKAMA_HOST" = "localhost" ]; then
        IS_LOCAL=true
    fi

    PROTO="http"
    if [ "$NAKAMA_PORT" = "443" ]; then
        PROTO="https"
    fi

    if [ "$IS_LOCAL" = true ]; then
        API_BASE="${PROTO}://${NAKAMA_HOST}:${NAKAMA_PORT}"
    else
        # リモート: HTTPS/443 はポート省略
        if [ "$PROTO" = "https" ]; then
            API_BASE="${PROTO}://${NAKAMA_HOST}"
        else
            API_BASE="${PROTO}://${NAKAMA_HOST}:${NAKAMA_PORT}"
        fi
    fi
}

# ── build_host_port_opt ──
# 子スクリプトに渡す --host / --port オプション文字列を生成する。
# デフォルト値（127.0.0.1:7350）の場合は空文字を返す。
build_host_port_opt() {
    HOST_PORT_OPT=""
    if [ "$NAKAMA_HOST" != "127.0.0.1" ] && [ "$NAKAMA_HOST" != "localhost" ]; then
        HOST_PORT_OPT="--host $NAKAMA_HOST"
    fi
    if [ "$NAKAMA_PORT" != "7350" ]; then
        HOST_PORT_OPT="$HOST_PORT_OPT --port $NAKAMA_PORT"
    fi
}

# ── check ──
# テスト結果の OK/NG を出力し、PASS/FAILED/TOTAL をカウントする。
#
# 使い方:
#   PASS=0; FAILED=0; TOTAL=0
#   check "テスト名" 0 ""        # result=0 → OK
#   check "テスト名" 1 "詳細"    # result!=0 → NG
PASS=0
FAILED=0
TOTAL=0

check() {
    local label="$1"
    local result="$2"
    local detail="${3:-}"
    TOTAL=$((TOTAL + 1))
    if [ "$result" = "0" ]; then
        echo "  OK $label"
        PASS=$((PASS + 1))
    else
        echo "  NG $label"
        [ -n "$detail" ] && echo "     $detail"
        FAILED=$((FAILED + 1))
    fi
}
