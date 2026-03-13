#!/bin/bash
# Nakama 同時接続テスト
# Usage: ./test/doTest-concurrent-login.sh [-n N] [-h]
PLAYERS_FILTER=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--players)
            PLAYERS_FILTER="${2:-}"
            shift 2 ;;
        -h|--help)
            echo "Usage: $0 [-n N] [-h]"
            echo "  Nakama 同時接続テスト (デフォルト: 1/10/100/1000/2000人)"
            echo "  -n N, --players N  N人テストのみ実行"
            echo "  ログイン・移動のパフォーマンスを計測"
            echo "  前提: nakama サーバが 127.0.0.1:7350 で起動していること"
            exit 0 ;;
        *)  echo "Usage: $0 [-n N] (-h for help)"; exit 1 ;;
    esac
done

# -n 指定時は環境変数で vitest に通知
if [ -n "$PLAYERS_FILTER" ]; then
    export CONCURRENT_N_COUNT="$PLAYERS_FILTER"
fi
cd "$(dirname "$0")/.."
mkdir -p test/log
echo "========================================="
echo "Nakama 同時接続テスト"
echo "========================================="
echo ""
echo "--- Go プラグインビルド ---"
./nakama/doBuild.sh

echo ""
echo "--- nakama サーバ再起動 ---"
cd nakama
docker compose restart -t 3 nakama
for _i in $(seq 1 30); do
    if docker compose logs --tail 5 nakama 2>/dev/null | grep -q "Startup"; then
        echo "  起動確認 (${_i}s)"
        break
    fi
    sleep 1
done
sleep 1
cd ..

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="test/log/concurrent-${TIMESTAMP}.md"

# vitest実行（コンソール出力とJSON結果を同時に取得）
npx vitest run test/nakama-concurrent.test.ts --reporter=default --reporter=json --outputFile.json=/tmp/vitest-result.json 2>&1 | stdbuf -oL tee /tmp/vitest-console.txt
EXIT_CODE=${PIPESTATUS[0]}

# JSONからMarkdownレポート生成
node -e "
const fs = require('fs');

let json;
try {
    json = JSON.parse(fs.readFileSync('/tmp/vitest-result.json', 'utf8'));
} catch {
    // JSONパース失敗時はコンソール出力をそのまま保存
    const raw = fs.readFileSync('/tmp/vitest-console.txt', 'utf8');
    const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
    fs.writeFileSync('${LOGFILE}', '# Nakama 同時接続テスト レポート\n\n\`\`\`\n' + stripped + '\n\`\`\`\n');
    process.stdout.write(stripped);
    process.exit(0);
}

// コンソール出力から計測値を抽出
const consoleText = fs.readFileSync('/tmp/vitest-console.txt', 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
const loginRe = /ログイン\s+(\d+)人:\s+([\d.]+)ms\s+\(([\d.]+)ms\/人\)/g;
const moveRe = /移動\s+(\d+)人:\s+([\d.]+)ms\s+\(([\d.]+)ms\/人\)\s+成功率=([\d.]+)%\s+エラー=(\d+)/g;
const metrics = {};
let m;
while ((m = loginRe.exec(consoleText))) {
    const n = m[1];
    if (!metrics[n]) metrics[n] = {};
    metrics[n].loginMs = Math.round(parseFloat(m[2]));
    metrics[n].loginPer = parseFloat(m[3]).toFixed(1);
}
while ((m = moveRe.exec(consoleText))) {
    const n = m[1];
    if (!metrics[n]) metrics[n] = {};
    metrics[n].moveMs = Math.round(parseFloat(m[2]));
    metrics[n].movePer = parseFloat(m[3]).toFixed(1);
    metrics[n].successRate = m[4];
    metrics[n].errors = m[5];
}

const lines = [];
const passed = json.numPassedTests;
const failed = json.numFailedTests;
const total = json.numTotalTests;
const durationMs = (json.testResults[0]?.endTime - json.testResults[0]?.startTime) || 0;
const duration = (durationMs / 1000).toFixed(2) + 's';
const allPass = failed === 0;

lines.push('# Nakama 同時接続テスト レポート');
lines.push('');
lines.push('| 項目 | 値 |');
lines.push('|------|-----|');
lines.push('| 日時 | ' + '${TIMESTAMP}'.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '\$1/\$2/\$3 \$4:\$5:\$6') + ' |');
lines.push('| サーバ | 127.0.0.1:7350 |');
lines.push('| 結果 | ' + (allPass ? '✅ ALL PASS' : '❌ ' + failed + ' FAILED') + ' (' + passed + '/' + total + ') |');
lines.push('| 実行時間 | ' + duration + ' |');
lines.push('');
lines.push('## パフォーマンス');
lines.push('');
lines.push('| 接続数 | ログイン | ms/人 | 移動 | ms/人 | 成功率 | エラー |');
lines.push('|-------:|--------:|------:|-----:|------:|-------:|-------:|');

function fmtMs(ms) { return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms'; }

for (const n of ['1', '10', '100', '1000']) {
    const d = metrics[n];
    if (!d) continue;
    lines.push('| ' + n + ' | ' + fmtMs(d.loginMs||0) + ' | ' + (d.loginPer||'-') + ' | ' + fmtMs(d.moveMs||0) + ' | ' + (d.movePer||'-') + ' | ' + (d.successRate||'-') + '% | ' + (d.errors||'-') + ' |');
}

lines.push('');
lines.push('## テスト詳細');
lines.push('');

const suites = json.testResults[0]?.assertionResults || [];
for (const t of suites) {
    const icon = t.status === 'passed' ? '✅' : '❌';
    const durMs = t.duration;
    const dur = durMs >= 1000 ? (durMs / 1000).toFixed(2) + 's' : Math.round(durMs) + 'ms';
    lines.push('- ' + icon + ' **' + t.ancestorTitles.join(' > ') + '** > ' + t.title + ' (' + dur + ')');
}

// 失敗テストの詳細
const failures = suites.filter(t => t.status === 'failed');
if (failures.length > 0) {
    lines.push('');
    lines.push('## 失敗詳細');
    for (const t of failures) {
        lines.push('');
        lines.push('### ❌ ' + t.title);
        lines.push('');
        lines.push('\`\`\`');
        for (const msg of t.failureMessages || []) {
            if (msg) lines.push(msg.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 5).join('\n'));
        }
        lines.push('\`\`\`');
    }
}

lines.push('');

const report = lines.join('\n');
fs.writeFileSync('${LOGFILE}', report);
process.stdout.write(report);
"

ln -sf "$(basename "$LOGFILE")" test/log/01-concurrent.md

echo ""
echo "---"
echo "ログ保存先: ${LOGFILE}"
echo "シンボリックリンク: test/log/01-concurrent.md"
exit $EXIT_CODE
