#!/usr/bin/env bash
# test/reversi/scenarios/*.txt を一括で CPU replay テストに流す。
# 失敗は即座に exit code 1 で終了。
set -eu
cd "$(dirname "$0")"

fail=0
for scn in scenarios/*.txt; do
    echo "=== $scn ==="
    if ! python3 reversi_cpu.py --replay "$scn" >/dev/null; then
        echo "  FAIL: $scn" >&2
        fail=$((fail + 1))
    fi
done

if [ "$fail" -gt 0 ]; then
    echo "$fail scenario(s) failed" >&2
    exit 1
fi
echo "all scenarios passed"
