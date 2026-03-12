#!/bin/bash
# 最大同時接続人数探索スクリプト
# 150人から10人ずつ増やして、失敗するまで実行する
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

START=150
STEP=10

# ── ANSI除去 ──
strip_ansi() { sed 's/\x1b\[[0-9;]*[mGKHF]//g'; }

echo "========================================="
echo "最大同時接続人数探索"
echo "  開始: ${START}人  増加幅: ${STEP}人"
echo "  レポート: $LOGFILE"
echo "========================================="
echo ""

# 結果を配列で保持: "N|rc|sub_report_path"
RESULTS=()
last_ok=0
n=$START

while true; do
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ">>> ${n}人テスト 実行中..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # 実行前の最新レポートを記録
    prev_report=$(ls -t "$LOG_DIR"/snd-rcv-*.md 2>/dev/null | head -1 || true)

    set +e
    "$SCRIPT_DIR/doTest-snd-rcv.sh" -n "$n"
    rc=$?
    set -e

    # 実行後に新しく生成されたレポートを取得
    new_report=$(ls -t "$LOG_DIR"/snd-rcv-*.md 2>/dev/null | head -1 || true)
    if [ "$new_report" != "$prev_report" ] && [ -f "$new_report" ]; then
        sub_report="$new_report"
    else
        sub_report=""
    fi

    RESULTS+=("${n}|${rc}|${sub_report}")

    if [ "$rc" -eq 0 ]; then
        last_ok=$n
        echo ""
        echo "✅ ${n}人: PASS"
        echo ""
        n=$((n + STEP))
    else
        echo ""
        echo "❌ ${n}人: FAILED (exit=${rc})"
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
    echo "| **最大成功人数** | **${FINAL_LABEL}** |"
    echo ""

    echo "## 結果サマリー"
    echo ""
    echo "| 人数 | 結果 | レポート |"
    echo "|------|------|---------|"
    for entry in "${RESULTS[@]}"; do
        IFS='|' read -r num rc sub_rep <<< "$entry"
        if [ "$rc" -eq 0 ]; then
            mark="✅ PASS"
        else
            mark="❌ FAILED (exit=${rc})"
        fi
        rep_link=$([ -n "$sub_rep" ] && echo "[詳細]($(basename "$sub_rep"))" || echo "—")
        echo "| ${num}人 | ${mark} | ${rep_link} |"
    done
    echo ""

    # 各テストの詳細セクション
    idx=1
    for entry in "${RESULTS[@]}"; do
        IFS='|' read -r num rc sub_rep <<< "$entry"
        echo "---"
        echo ""
        echo "## テスト ${idx}: ${num}人ログイン"
        echo ""
        if [ "$rc" -eq 0 ]; then
            echo "**結果:** ✅ PASS"
        else
            echo "**結果:** ❌ FAILED (exit=${rc})"
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
