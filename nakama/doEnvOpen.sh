#!/usr/bin/env bash
# nakama/.env を機微情報マスク済みで標準出力に表示する。
# Slack / Issue / チャット等にコピペする用途。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  cat <<'HELP'
.env マスク表示スクリプト

Usage: ./doEnvOpen.sh [OPTIONS] [ENV_FILE]

Options:
  -h, --help   このヘルプを表示

引数:
  ENV_FILE     対象ファイル (省略時: nakama/.env)

動作:
  .env を読み、機微情報とみなすキーの値を
  "<先頭5文字>XXXX" の形式でマスクして標準出力に書き出す。
  コメント行 (#) と空行はそのまま出力する。

マスク対象キー:
  POSTGRES_PASSWORD
  NAKAMA_SERVER_KEY
  NAKAMA_CONSOLE_PASS
  MINIO_ROOT_USER
  MINIO_ROOT_PASSWORD
  ADMIN_UIDS
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET

使用例:
  ./doEnvOpen.sh                    # 画面に表示
  ./doEnvOpen.sh | xclip -selection clipboard   # クリップボードへコピー
HELP
  exit 0
fi

if [[ -n "$1" ]]; then
  ENV_FILE="$1"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE が見つかりません" >&2
  exit 1
fi

awk '
  BEGIN {
    split("POSTGRES_PASSWORD NAKAMA_SERVER_KEY NAKAMA_CONSOLE_PASS MINIO_ROOT_USER MINIO_ROOT_PASSWORD ADMIN_UIDS GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET", arr, " ")
    for (i in arr) sensitive[arr[i]] = 1
  }
  /^[[:space:]]*#/ { print; next }
  /^[[:space:]]*$/ { print; next }
  {
    eq = index($0, "=")
    if (eq == 0) { print; next }
    key = substr($0, 1, eq - 1)
    val = substr($0, eq + 1)
    if (key in sensitive) {
      if (length(val) > 5) {
        printf "%s=%sXXXX\n", key, substr(val, 1, 5)
      } else {
        printf "%s=XXXX\n", key
      }
    } else {
      print
    }
  }
' "$ENV_FILE"
