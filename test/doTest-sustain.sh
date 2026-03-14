#!/bin/bash
# Nakama 持続接続テスト
# Usage: ./test/doTest-sustain.sh [-n NUM] [-t SEC] [--host HOST] [--port PORT] [-h]
PLAYERS=100
DURATION=90
OPT_HOST=""
OPT_PORT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--players)
            PLAYERS="$2"; shift 2 ;;
        -t|--time)
            DURATION="$2"; shift 2 ;;
        --host)
            OPT_HOST="${2:-}"; shift 2 ;;
        --port)
            OPT_PORT="${2:-}"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [-n NUM] [-t SEC] [--host HOST] [--port PORT]"
            echo "  -n, --players NUM  接続数 (デフォルト: 100)"
            echo "  -t, --time SEC     テスト最大時間（秒） (デフォルト: 90)"
            echo "  --host HOST        接続先ホスト (デフォルト: NAKAMA_HOST or 127.0.0.1)"
            echo "  --port PORT        Nakama API ポート (デフォルト: NAKAMA_PORT or 7350)"
            echo ""
            echo "  Nakama 持続接続テスト (N人×指定秒)"
            echo "  接続維持・リコネクト回数・移動成功率を検証"
            exit 0 ;;
        *)  echo "Usage: $0 [-n NUM] [-t SEC] [--host HOST] [--port PORT] (-h for help)"; exit 1 ;;
    esac
done
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
# docker compose コマンド（実行中のコンテナから dev/prod を自動検出）
COMPOSE="docker compose"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'tommchat-prod'; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
elif [ -f nakama/docker-compose.dev.yml ]; then
    COMPOSE="docker compose -f docker-compose.yml -f docker-compose.dev.yml"
fi

mkdir -p test/log
echo "========================================="
echo "Nakama 接続維持テスト"
echo "========================================="
echo "server_key: ${NAKAMA_SERVER_KEY:-defaultkey}"
echo "endpoint:   ${NAKAMA_HOST}:${NAKAMA_PORT:-7350}"
echo ""

if [ "$IS_LOCAL" = true ]; then
    echo "--- Go プラグインビルド ---"
    ./nakama/doBuild.sh

    echo ""
    echo "--- nakama サーバ再起動 ---"
    cd nakama
    $COMPOSE restart -t 3 nakama
    for _i in $(seq 1 30); do
        if $COMPOSE logs --tail 5 nakama 2>/dev/null | grep -q "Startup"; then
            echo "  起動確認 (${_i}s)"
            break
        fi
        sleep 1
    done
    sleep 1
    cd ..
else
    echo "--- リモートホスト: ビルド・再起動スキップ ---"
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOGFILE="test/log/sustain-${TIMESTAMP}.md"

# vitest実行（コンソール出力とJSON結果を同時に取得）
SUSTAIN_PLAYER_COUNT=${PLAYERS} SUSTAIN_DURATION=${DURATION} npx vitest run test/nakama-sustain.test.ts --reporter=default --reporter=json --outputFile.json=/tmp/vitest-sustain-result.json 2>&1 | stdbuf -oL tee /tmp/vitest-sustain-console.txt
EXIT_CODE=${PIPESTATUS[0]}

# JSONからMarkdownレポート生成
node -e "
const fs = require('fs');

let json;
try {
    json = JSON.parse(fs.readFileSync('/tmp/vitest-sustain-result.json', 'utf8'));
} catch {
    const raw = fs.readFileSync('/tmp/vitest-sustain-console.txt', 'utf8');
    const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
    fs.writeFileSync('${LOGFILE}', '# Nakama 接続維持テスト レポート\n\n\`\`\`\n' + stripped + '\n\`\`\`\n');
    process.stdout.write(stripped);
    process.exit(0);
}

// コンソール出力から計測値を抽出
const consoleText = fs.readFileSync('/tmp/vitest-sustain-console.txt', 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
const sustainRe = /維持\s+([^\s:]+):\s+([\d.]+)s\s+実行\s+ラウンド=(\d+)\s+送信=(\d+)\s+エラー=(\d+)\s+成功率=([\d.]+)%\s+失敗ラウンド=(\d+)\/(\d+)\s+avg送信=(\d+)ms\/回\s+リコネクト=(\d+)\s+avg接続=(\d+)人/g;
const metrics = {};
let m;
while ((m = sustainRe.exec(consoleText))) {
    metrics[m[1]] = {
        elapsed: parseFloat(m[2]).toFixed(1),
        rounds: parseInt(m[3]),
        sent: parseInt(m[4]),
        errors: parseInt(m[5]),
        successRate: m[6],
        failedRounds: parseInt(m[7]),
        totalRounds: parseInt(m[8]),
        avgSendMs: parseInt(m[9]),
        reconnects: parseInt(m[10]),
        avgConnected: parseInt(m[11]),
    };
}

const lines = [];
const passed = json.numPassedTests;
const failed = json.numFailedTests;
const total = json.numTotalTests;
const durationMs = (json.testResults[0]?.endTime - json.testResults[0]?.startTime) || 0;
const duration = durationMs >= 60000 ? (durationMs / 60000).toFixed(1) + 'min' : (durationMs / 1000).toFixed(1) + 's';
const allPass = failed === 0 && passed > 0;

lines.push('# Nakama 接続維持テスト レポート');
lines.push('');
lines.push('| 項目 | 値 |');
lines.push('|------|-----|');
lines.push('| 日時 | ' + '${TIMESTAMP}'.replace(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/, '\$1/\$2/\$3 \$4:\$5:\$6') + ' |');
lines.push('| サーバ | ' + (process.env.NAKAMA_HOST || '127.0.0.1') + ':' + (process.env.NAKAMA_PORT || '7350') + ' |');
lines.push('| プレイヤー数 | ${PLAYERS} |');
lines.push('| テスト時間 | ${DURATION}秒 |');
lines.push('| 結果 | ' + (allPass ? '✅ ALL PASS' : '❌ ' + failed + ' FAILED') + ' (' + passed + '/' + total + ') |');
lines.push('| 実行時間 | ' + duration + ' |');
lines.push('');
lines.push('## パフォーマンス');
lines.push('');
lines.push('| 維持時間 | 実行時間 | ラウンド | 送信 | エラー | 成功率 | 失敗ラウンド | avg送信 | リコネクト | avg接続 |');
lines.push('|---------:|--------:|--------:|-----:|-------:|-------:|------------:|--------:|-----------:|--------:|');

for (const dur of Object.keys(metrics)) {
    const d = metrics[dur];
    if (!d) continue;
    lines.push('| ' + dur + ' | ' + d.elapsed + 's | ' + d.rounds + ' | ' + d.sent + ' | ' + d.errors + ' | ' + d.successRate + '% | ' + d.failedRounds + '/' + d.totalRounds + ' | ' + d.avgSendMs + 'ms | ' + d.reconnects + ' | ' + d.avgConnected + '人 |');
}

lines.push('');
lines.push('## テスト詳細');
lines.push('');

const suites = json.testResults[0]?.assertionResults || [];
for (const t of suites) {
    const icon = t.status === 'passed' ? '✅' : t.status === 'skipped' ? '⏭️' : '❌';
    const durMs = t.duration;
    const dur = durMs == null || isNaN(durMs) ? '-' : durMs >= 60000 ? (durMs / 60000).toFixed(1) + 'min' : durMs >= 1000 ? (durMs / 1000).toFixed(1) + 's' : Math.round(durMs) + 'ms';
    lines.push('- ' + icon + ' **' + t.ancestorTitles.join(' > ') + '** > ' + t.title + ' (' + dur + ')');
}

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

ln -sf "$(basename "$LOGFILE")" test/log/02-sustain.md

echo ""
echo "---"
echo "ログ保存先: ${LOGFILE}"
echo "シンボリックリンク: test/log/02-sustain.md"
exit $EXIT_CODE
