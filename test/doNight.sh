#!/bin/bash
# 長時間テスト（深夜バッチ向け）
# Usage: ./test/doNight.sh [--1h|--4h|--8h]
#   --1h  1時間コース: doAll.sh × 25回ループ（デフォルト）
#   --4h  4時間コース: doAll.sh × 25回 + ccu-db --5m × 3回
#   --8h  8時間コース: doAll.sh × 25回 + ccu-db --5m × 3回 + ccu-db --1h × 1回
cd "$(dirname "$0")/.."
mkdir -p test/log

# フラグ解析
COURSE="1h"
case "${1:-}" in
    --1h)  COURSE="1h" ;;
    --4h)  COURSE="4h" ;;
    --8h)  COURSE="8h" ;;
    -h|--help)
        echo "Usage: $0 [--1h|--4h|--8h]"
        echo "  --1h   1時間コース: doAll.sh × 25回ループ（デフォルト）"
        echo "  --4h   4時間コース: doAll.sh × 25回 + ccu-db --5m × 3回"
        echo "  --8h   8時間コース: doAll.sh × 25回 + ccu-db --5m × 3回 + ccu-db --1h × 1回"
        exit 0 ;;
    "")    COURSE="1h" ;;
    *)     echo "Usage: $0 [--1h|--4h|--8h] (-h for help)"; exit 1 ;;
esac

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="test/log/night-${COURSE}-${TIMESTAMP}.md"
START_TIME=$(date +%s)
START_DISPLAY=$(date "+%Y/%m/%d %H:%M:%S")

echo "============================================"
echo "  深夜テスト [${COURSE}コース]"
echo "  開始: ${START_DISPLAY}"
echo "============================================"
echo ""

# カウンター
PHASE_TOTAL=0
PHASE_PASS=0
PHASE_FAIL=0
FAIL_LOG=()

run_phase() {
    local label="$1"
    shift
    PHASE_TOTAL=$((PHASE_TOTAL + 1))
    local phase_start=$(date +%s)
    echo ""
    echo "────────────────────────────────────────"
    echo "[${PHASE_TOTAL}] ${label}"
    echo "────────────────────────────────────────"

    "$@" 2>&1
    local rc=$?
    local phase_end=$(date +%s)
    local phase_dur=$((phase_end - phase_start))

    if [ $rc -eq 0 ]; then
        PHASE_PASS=$((PHASE_PASS + 1))
        echo "  → ✅ PASS (${phase_dur}s)"
    else
        PHASE_FAIL=$((PHASE_FAIL + 1))
        FAIL_LOG+=("${label} (${phase_dur}s)")
        echo "  → ❌ FAIL (${phase_dur}s)"
    fi
    return $rc
}

# ──────────────────────────────────────────────
# Phase 1: doAll.sh × 25回
# ──────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Phase 1: doAll.sh × 25回               ║"
echo "╚══════════════════════════════════════════╝"

for i in $(seq 1 25); do
    run_phase "doAll.sh #${i}/25" bash test/doAll.sh
done

PHASE1_ELAPSED=$(( $(date +%s) - START_TIME ))
echo ""
echo "Phase 1 完了: ${PHASE_PASS}/${PHASE_TOTAL} passed (${PHASE1_ELAPSED}s elapsed)"

# ──────────────────────────────────────────────
# Phase 2: ccu-db --5m × 3回 (4h / 8h のみ)
# ──────────────────────────────────────────────
if [[ "$COURSE" == "4h" || "$COURSE" == "8h" ]]; then
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║  Phase 2: ccu-db --5m × 3回             ║"
    echo "╚══════════════════════════════════════════╝"

    for i in $(seq 1 3); do
        run_phase "ccu-db --5m #${i}/3" bash test/doTest-ccu-db.sh --5m
    done
fi

# ──────────────────────────────────────────────
# Phase 3: ccu-db --1h × 1回 (8h のみ)
# ──────────────────────────────────────────────
if [[ "$COURSE" == "8h" ]]; then
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║  Phase 3: ccu-db --1h × 1回             ║"
    echo "╚══════════════════════════════════════════╝"

    run_phase "ccu-db --1h" bash test/doTest-ccu-db.sh --1h
fi

# ──────────────────────────────────────────────
# レポート生成
# ──────────────────────────────────────────────
END_TIME=$(date +%s)
TOTAL_ELAPSED=$((END_TIME - START_TIME))
ELAPSED_MIN=$((TOTAL_ELAPSED / 60))
ELAPSED_SEC=$((TOTAL_ELAPSED % 60))
END_DISPLAY=$(date "+%Y/%m/%d %H:%M:%S")
ALL_PASS=$( [ $PHASE_FAIL -eq 0 ] && echo "✅ ALL PASS" || echo "❌ ${PHASE_FAIL} FAILED" )

# ターミナル出力
echo ""
echo "============================================"
echo "  深夜テスト結果 [${COURSE}コース]"
echo "============================================"
echo "  結果:     ${ALL_PASS} (${PHASE_PASS}/${PHASE_TOTAL})"
echo "  開始:     ${START_DISPLAY}"
echo "  終了:     ${END_DISPLAY}"
echo "  実行時間: ${ELAPSED_MIN}m${ELAPSED_SEC}s"
if [ ${#FAIL_LOG[@]} -gt 0 ]; then
    echo ""
    echo "  失敗一覧:"
    for f in "${FAIL_LOG[@]}"; do
        echo "    ❌ $f"
    done
fi
echo "============================================"
echo ""

# Markdownレポート
{
    echo "# 深夜テスト レポート [${COURSE}コース]"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 結果 | ${ALL_PASS} |"
    echo "| テスト数 | ${PHASE_PASS}/${PHASE_TOTAL} passed |"
    echo "| 開始 | ${START_DISPLAY} |"
    echo "| 終了 | ${END_DISPLAY} |"
    echo "| 実行時間 | ${ELAPSED_MIN}m${ELAPSED_SEC}s |"
    echo ""
    echo "## コース内容"
    echo ""
    echo "| Phase | 内容 | 状態 |"
    echo "|-------|------|------|"
    echo "| 1 | doAll.sh × 25回 | 実行済み |"
    if [[ "$COURSE" == "4h" || "$COURSE" == "8h" ]]; then
        echo "| 2 | ccu-db --5m × 3回 | 実行済み |"
    fi
    if [[ "$COURSE" == "8h" ]]; then
        echo "| 3 | ccu-db --1h × 1回 | 実行済み |"
    fi
    if [ ${#FAIL_LOG[@]} -gt 0 ]; then
        echo ""
        echo "## 失敗一覧"
        echo ""
        for f in "${FAIL_LOG[@]}"; do
            echo "- ❌ $f"
        done
    fi
    echo ""
} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" test/log/04-night.md

echo "ログ保存先: ${LOGFILE}"
echo "シンボリックリンク: test/log/04-night.md"

if [ $PHASE_FAIL -gt 0 ]; then
    exit 1
else
    exit 0
fi
