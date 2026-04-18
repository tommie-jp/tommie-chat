#!/usr/bin/env bash
# Vite dev サーバをバックグラウンドで起動する

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  cat <<'HELP'
dev サーバ起動スクリプト

Usage: ./doStartDev.sh [OPTIONS]

Options:
  -h, --help   このヘルプを表示

動作:
  `npm run dev` をバックグラウンド (&) で起動する。
  Vite dev サーバ (HMR 付き) が立ち上がり、デフォルトで
  http://localhost:5173 で待ち受ける。

  停止するには ./doKillDev.sh を実行する。
HELP
  exit 0
fi

npm run dev &
