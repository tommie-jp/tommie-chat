#!/usr/bin/env bash
# ./doStartDev.sh で起動した `npm run dev` とその子プロセス (vite) を kill する

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "$1" == "-h" || "$1" == "--help" ]]; then
  cat <<'HELP'
dev サーバ停止スクリプト

Usage: ./doKillDev.sh [OPTIONS]

Options:
  -h, --help   このヘルプを表示

動作:
  ./doStartDev.sh でバックグラウンド起動した `npm run dev` および
  その子プロセス (vite / node) を kill する。

  対象の絞り込み:
    - `pgrep -f "npm run dev"` と `pgrep -f "node .*vite"` で候補を抽出
    - /proc/<pid>/cwd が本リポジトリ配下のプロセスのみを対象とする
      （他プロジェクトで起動中の dev サーバは kill しない）

  停止手順:
    1. SIGTERM を送る
    2. 1秒待って残っていれば SIGKILL で強制終了
HELP
  exit 0
fi

pids=$(pgrep -f "npm run dev" | tr '\n' ' ')
vite_pids=$(pgrep -f "node .*vite" | tr '\n' ' ')

if [[ -z "$pids" && -z "$vite_pids" ]]; then
  echo "no dev process found"
  exit 0
fi

for pid in $pids $vite_pids; do
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo "")
  if [[ -n "$cwd" && "$cwd" != "$SCRIPT_DIR"* ]]; then
    continue
  fi
  echo "kill $pid ($(ps -p "$pid" -o comm= 2>/dev/null))"
  kill "$pid" 2>/dev/null
done

sleep 1

for pid in $pids $vite_pids; do
  if kill -0 "$pid" 2>/dev/null; then
    echo "kill -9 $pid"
    kill -9 "$pid" 2>/dev/null
  fi
done

# Vite は interactive キー入力用に端末を raw モードにしており、
# 途中で kill するとエコー等が戻らないので復元する
if [[ -t 0 ]]; then
  stty sane 2>/dev/null
fi
