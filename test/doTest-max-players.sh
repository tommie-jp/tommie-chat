#!/bin/bash
# 最大同時接続人数探索スクリプト
# 150人から10人ずつ増やして、失敗するまで実行する
# 各人数は3回試行し、2/3以上PASSで合格（WSL2の環境ノイズ対策）
#
# 使い方: ./test/doTest-max-players.sh
# 前提: cd nakama && docker compose up -d

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/log"
mkdir -p "$LOG_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="$LOG_DIR/max-players-${TIMESTAMP}.md"
SYMLINK="$LOG_DIR/05-max-players.md"

START=100
STEP=10
TRIALS=3
PASS_NEEDED=2

# ── ANSI除去 ──
strip_ansi() { sed 's/\x1b\[[0-9;]*[mGKHF]//g'; }

echo "========================================="
echo "最大同時接続人数探索"
echo "  開始: ${START}人  増加幅: ${STEP}人"
echo "  試行回数: ${TRIALS}回中${PASS_NEEDED}回以上PASSで合格"
echo "  レポート: $LOGFILE"
echo "========================================="
echo ""

# 結果を配列で保持: "N|verdict_rc|best_sub_report|pass_count|trials"
RESULTS=()
last_ok=0
n=$START

while true; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ">>> ${n}人テスト（${TRIALS}回試行）"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    pass_count=0
    fail_count=0
    best_sub_report=""

    for trial in $(seq 1 $TRIALS); do
        echo ""
        echo "  --- 試行 ${trial}/${TRIALS} ---"

        prev_report=$(ls -t "$LOG_DIR"/snd-rcv-*.md 2>/dev/null | head -1 || true)

        set +e
        "$SCRIPT_DIR/doTest-snd-rcv.sh" -n "$n"
        rc=$?
        set -e

        new_report=$(ls -t "$LOG_DIR"/snd-rcv-*.md 2>/dev/null | head -1 || true)
        if [ "$new_report" != "$prev_report" ] && [ -f "$new_report" ]; then
            cur_report="$new_report"
        else
            cur_report=""
        fi

        if [ "$rc" -eq 0 ]; then
            pass_count=$((pass_count + 1))
            echo "  ✅ 試行${trial}: PASS  (累計 ${pass_count}PASS / ${trial}試行)"
            # 最初のPASSレポートを採用
            if [ -z "$best_sub_report" ] && [ -n "$cur_report" ]; then
                best_sub_report="$cur_report"
            fi
        else
            fail_count=$((fail_count + 1))
            echo "  ❌ 試行${trial}: FAILED (exit=${rc})  (累計 ${fail_count}FAIL / ${trial}試行)"
            # FAILレポートはPASSがない場合のみ採用
            if [ -z "$best_sub_report" ] && [ -n "$cur_report" ]; then
                best_sub_report="$cur_report"
            fi
        fi

        # 早期終了判定
        remaining=$((TRIALS - trial))
        if [ "$pass_count" -ge "$PASS_NEEDED" ]; then
            echo "  → 合格確定（残り試行スキップ）"
            break
        fi
        if [ "$fail_count" -gt $((TRIALS - PASS_NEEDED)) ]; then
            echo "  → 不合格確定（残り試行スキップ）"
            break
        fi

        # 試行間インターバル（サーバ回復待ち）
        if [ "$trial" -lt "$TRIALS" ]; then
            echo "  (次の試行まで3秒待機...)"
            sleep 3
        fi
    done

    RESULTS+=("${n}|${pass_count}|${best_sub_report}|${TRIALS}")

    if [ "$pass_count" -ge "$PASS_NEEDED" ]; then
        last_ok=$n
        echo ""
        echo "✅ ${n}人: PASS (${pass_count}/${TRIALS})"
        echo ""
        n=$((n + STEP))
    else
        echo ""
        echo "❌ ${n}人: FAILED (${pass_count}/${TRIALS})"
        echo ""
        break
    fi
done

# ── Markdown レポート生成 ──
DATE_FMT=$(echo "$TIMESTAMP" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)-\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1\/\2\/\3 \4:\5:\6/')
if [ "$last_ok" -gt 0 ]; then
    FINAL_LABEL="✅ 最大 ${last_ok}人"
else
    FINAL_LABEL="❌ ${START}人から失敗"
fi

{
    echo "# 最大同時接続人数探索レポート"
    echo ""
    echo "| 項目 | 値 |"
    echo "|------|-----|"
    echo "| 日時 | ${DATE_FMT} |"
    echo "| サーバ | 127.0.0.1:7350 |"
    echo "| 開始人数 | ${START}人 |"
    echo "| 増加幅 | ${STEP}人 |"
    echo "| 試行方式 | ${TRIALS}回中${PASS_NEEDED}回以上PASSで合格 |"
    echo "| **最大成功人数** | **${FINAL_LABEL}** |"
    echo ""

    echo "## 結果サマリー"
    echo ""
    echo "| 人数 | 結果 | PASS率 | レポート |"
    echo "|------|------|--------|---------|"
    for entry in "${RESULTS[@]}"; do
        IFS='|' read -r num pass_cnt sub_rep trials <<< "$entry"
        if [ "$pass_cnt" -ge "$PASS_NEEDED" ]; then
            mark="✅ PASS"
        else
            mark="❌ FAILED"
        fi
        rep_link=$([ -n "$sub_rep" ] && echo "[詳細]($(basename "$sub_rep"))" || echo "—")
        echo "| ${num}人 | ${mark} | ${pass_cnt}/${trials} | ${rep_link} |"
    done
    echo ""

    # 各テストの詳細セクション
    idx=1
    for entry in "${RESULTS[@]}"; do
        IFS='|' read -r num pass_cnt sub_rep trials <<< "$entry"
        echo "---"
        echo ""
        echo "## テスト ${idx}: ${num}人ログイン"
        echo ""
        if [ "$pass_cnt" -ge "$PASS_NEEDED" ]; then
            echo "**結果:** ✅ PASS (${pass_cnt}/${trials})"
        else
            echo "**結果:** ❌ FAILED (${pass_cnt}/${trials})"
        fi
        echo ""

        if [ -n "$sub_rep" ] && [ -f "$sub_rep" ]; then
            # サブレポートからサーバログ以外を抽出（サーバログは大きいため除外）
            awk '
                /^### サーバログ/ { in_server=1; next }
                /^### / && in_server { in_server=0 }
                /^## Phase / { in_server=0 }
                !in_server { print }
            ' "$sub_rep"
        else
            echo "*(サブレポートなし)*"
        fi
        echo ""
        idx=$((idx + 1))
    done

} > "$LOGFILE"

ln -sf "$(basename "$LOGFILE")" "$SYMLINK"

echo "========================================="
echo "最終結果: ${FINAL_LABEL}"
echo "========================================="
echo ""
echo "レポート: ${LOGFILE}"
echo "シンボリックリンク: ${SYMLINK}"
