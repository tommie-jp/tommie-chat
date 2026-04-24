#!/usr/bin/env bash
# Nakama プラグイン (Go) の単体テストを実行する。
# reversi_rules_test.go / reversi_cpu_test.go / othello_test.go 等。
# WSL2 Ubuntu から直接実行する想定 (ホスト Go が必要)。
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

if ! command -v go >/dev/null 2>&1; then
    echo "❌ go コマンドが見つかりません (apt install golang-go 等で入れてください)" >&2
    exit 2
fi

cd "$REPO_ROOT/nakama/go_src"
go test -count=1 ./...
