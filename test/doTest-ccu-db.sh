#!/bin/bash
# 同接履歴 DB永続化テスト
# Usage: ./test/doTest-ccu-db.sh [--1m|--5m|--30m|--1h] [--host HOST] [--port PORT]
#   --1m  1分以内: 1sサンプリング + RPC疎通（デフォルト）
#   --5m  5分以内: 1mフラッシュ + 再起動 + 履歴復元
#   --30m 30分以内: 複数回再起動で履歴累積
#   --1h  1時間以内: 長時間安定稼働 + レンジ整合性
OPT_HOST=""
OPT_PORT=""
# --host/--port を先に抽出（後で positional args を処理するため）
_ARGS=()
_prev=""
for _a in "$@"; do
    if [ "$_prev" = "--host" ]; then OPT_HOST="$_a"; _prev=""; continue; fi
    if [ "$_prev" = "--port" ]; then OPT_PORT="$_a"; _prev=""; continue; fi
    if [ "$_a" = "--host" ]; then _prev="--host"; continue; fi
    if [ "$_a" = "--port" ]; then _prev="--port"; continue; fi
    _ARGS+=("$_a")
done
set -- "${_ARGS[@]}"

cd "$(dirname "$0")/.."
# .env から NAKAMA_SERVER_KEY 等を自動読み込み
if [ -z "${NAKAMA_SERVER_KEY:-}" ] && [ -f nakama/.env ]; then
    set -a; source nakama/.env; set +a
fi
# --host/--port 優先 > 環境変数 > デフォルト
export NAKAMA_HOST="${OPT_HOST:-${NAKAMA_HOST:-127.0.0.1}}"
export NAKAMA_PORT="${OPT_PORT:-${NAKAMA_PORT:-7350}}"
IS_LOCAL=false
if [ "$NAKAMA_HOST" = "127.0.0.1" ] || [ "$NAKAMA_HOST" = "localhost" ]; then
    IS_LOCAL=true
fi
mkdir -p test/log
echo "========================================="
echo "同接履歴 DB永続化テスト"
echo "========================================="
echo "server_key: ${NAKAMA_SERVER_KEY:-defaultkey}"
echo "endpoint:   ${NAKAMA_HOST}:${NAKAMA_PORT:-7350}"
echo ""
if [ "$IS_LOCAL" = true ]; then
    echo "--- Go プラグインビルド ---"
    ./nakama/doBuild.sh
else
    echo "--- リモートホスト: ビルドスキップ ---"
fi

# フラグ解析
LEVEL="1m"
case "${1:-}" in
    --1m)  LEVEL="1m" ;;
    --5m)  LEVEL="5m" ;;
    --30m) LEVEL="30m" ;;
    --1h)  LEVEL="1h" ;;
    -h|--help)
        echo "Usage: $0 [--1m|--5m|--30m|--1h]"
        echo "  --1m   1分以内: 1sサンプリング + RPC疎通（デフォルト）"
        echo "  --5m   5分以内: 1mフラッシュ + 再起動 + 履歴復元"
        echo "  --30m  30分以内: 複数回再起動で履歴累積"
        echo "  --1h   1時間以内: 長時間安定稼働 + レンジ整合性"
        exit 0 ;;
    "")    LEVEL="1m" ;;
    *)     echo "Usage: $0 [--1m|--5m|--30m|--1h] (-h for help)"; exit 1 ;;
esac

declare -A LEVEL_DESC=(
    ["1m"]="1分以内: 1sサンプリング + RPC疎通"
    ["5m"]="5分以内: 1mフラッシュ + 再起動 + 履歴復元"
    ["30m"]="30分以内: 複数回再起動で履歴累積"
    ["1h"]="1時間以内: 長時間安定稼働 + レンジ整合性"
)

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="test/log/ccu-db-${TIMESTAMP}.md"

echo "テストレベル: ${LEVEL} — ${LEVEL_DESC[$LEVEL]}"
echo ""

# vitest実行
CCU_TEST_LEVEL=${LEVEL} npx vitest run test/nakama-ccu-db.test.ts --reporter=default --reporter=json --outputFile.json=/tmp/vitest-ccu-db-result.json 2>&1 | stdbuf -oL tee /tmp/vitest-ccu-db-console.txt
EXIT_CODE=${PIPESTATUS[0]}

# JSONからMarkdownレポート生成
node -e "
const fs = require('fs');

let json;
try {
    json = JSON.parse(fs.readFileSync('/tmp/vitest-ccu-db-result.json', 'utf8'));
} catch {
    const raw = fs.readFileSync('/tmp/vitest-ccu-db-console.txt', 'utf8');
    const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
    fs.writeFileSync('${LOGFILE}', '# 同接履歴 DB永続化テスト レポート\n\n\`\`\`\n' + stripped + '\n\`\`\`\n');
    process.exit(0);
}

const lines = [];
const passed = json.numPassedTests;
const failed = json.numFailedTests;
const total = json.numTotalTests;
const durationMs = (json.testResults[0]?.endTime - json.testResults[0]?.startTime) || 0;
const duration = durationMs >= 60000 ? (durationMs / 60000).toFixed(1) + 'min' : (durationMs / 1000).toFixed(1) + 's';
const allPass = failed === 0;

lines.push('# 同接履歴 DB永続化テスト レポート');
lines.push('');
lines.push('| 項目 | 値 |');
lines.push('|------|-----|');
lines.push('| 日時 | ' + '${TIMESTAMP}'.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '\$1/\$2/\$3 \$4:\$5:\$6') + ' |');
lines.push('| テストレベル | ${LEVEL} |');
const skipped = json.numPendingTests || 0;
const ran = total - skipped;
lines.push('| 結果 | ' + (allPass ? '✅ PASS' : '❌ FAIL') + ' (' + passed + '/' + ran + ' passed' + (skipped > 0 ? ', ' + skipped + ' skipped' : '') + ') |');
lines.push('| 実行時間 | ' + duration + ' |');
lines.push('');

const suites = json.testResults[0]?.assertionResults || [];
for (const t of suites) {
    const icon = t.status === 'passed' ? '✅' : t.status === 'pending' || t.status === 'skipped' ? '⏭' : '❌';
    if (t.status === 'pending' || t.status === 'skipped') {
        lines.push('- ' + icon + ' ' + t.title + ' (skipped)');
    } else {
        const durMs = t.duration;
        const dur = durMs >= 60000 ? (durMs / 60000).toFixed(1) + 'min' : durMs >= 1000 ? (durMs / 1000).toFixed(1) + 's' : Math.round(durMs) + 'ms';
        lines.push('- ' + icon + ' ' + t.title + ' (' + dur + ')');
    }
}

const failures = suites.filter(t => t.status === 'failed');
if (failures.length > 0) {
    lines.push('');
    lines.push('## 失敗詳細');
    for (const t of failures) {
        lines.push('');
        lines.push('### ❌ ' + t.title);
        lines.push('\`\`\`');
        for (const msg of t.failureMessages || []) {
            if (msg) lines.push(msg.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 10).join('\n'));
        }
        lines.push('\`\`\`');
    }
}

// コンソール出力から主要ログを抽出
const consoleText = fs.readFileSync('/tmp/vitest-ccu-db-console.txt', 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
const logLines = consoleText.split('\n').filter(l => /^\[\d/.test(l.trim()) || /stdout/.test(l));
if (logLines.length > 0) {
    lines.push('');
    lines.push('## テストログ');
    lines.push('\`\`\`');
    for (const l of logLines.slice(0, 30)) lines.push(l.trim());
    lines.push('\`\`\`');
}

lines.push('');
const report = lines.join('\n');
fs.writeFileSync('${LOGFILE}', report);
process.stdout.write('\n' + report);
"

ln -sf "$(basename "$LOGFILE")" test/log/03-ccu-db.md

echo ""
echo "---"
echo "ログ保存先: ${LOGFILE}"
echo "シンボリックリンク: test/log/03-ccu-db.md"
exit $EXIT_CODE
