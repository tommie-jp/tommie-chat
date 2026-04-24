#!/usr/bin/env bash
# Python リプレイシナリオ + Adapter Vitest を順に実行する統合テスト。
# WSL2 Ubuntu から直接実行する想定 (fnm の Node 24 が必要)。
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

fail=0

echo -e "\033[36m=== Phase 1: Python replay scenarios ===\033[0m"
bash "$(pwd)/doTest-replay.sh" || fail=$((fail + 1))

echo ""
echo -e "\033[36m=== Phase 2: Adapter Vitest (SerialReversiAdapter) ===\033[0m"
cd "$REPO_ROOT"
npx vitest run test/SerialReversiAdapter.test.ts || fail=$((fail + 1))

echo ""
echo -e "\033[36m=== Phase 3: Go unit tests (nakama plugin) ===\033[0m"
bash "$REPO_ROOT/test/reversi/doTest-go.sh" || fail=$((fail + 1))

if [ "$fail" -gt 0 ]; then
    echo "$fail phase(s) failed" >&2
    exit 1
fi
echo ""
echo -e "\033[32mall tests passed\033[0m"
