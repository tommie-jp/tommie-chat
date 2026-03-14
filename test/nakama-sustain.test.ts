/**
 * Nakama 同時接続維持テスト
 *
 * 100人が同時接続した状態を一定時間維持し、
 * 定期的に移動メッセージを送信して正常性を確認する。
 * 切断時は自動リコネクトする。
 *
 * 前提: nakama サーバが 127.0.0.1:7350 で起動していること
 *   cd nakama && docker compose up -d
 *
 * 実行: npx vitest run test/nakama-sustain.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket } from '@heroiclabs/nakama-js';

const HOST = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';
const OP_INIT_POS = 1;
const OP_MOVE_TARGET = 2;
const OP_AOI_UPDATE = 5;
const PLAYER_COUNT = parseInt(process.env.SUSTAIN_PLAYER_COUNT ?? '100', 10);

interface PlayerConn {
    client: Client;
    session: Session;
    socket: Socket;
    matchId: string;
    sessionId: string;
    name: string;
    connected: boolean;
    reconnecting: boolean;
    reconnectCount: number;
}

let totalReconnects = 0;
let globalPlayers: PlayerConn[] = [];

// Ctrl+C で強制終了された場合、全プレイヤーをクリーンに切断してから終了する
process.on('SIGINT', () => {
    console.log(`\n  SIGINT: ${globalPlayers.length}人を切断中...`);
    for (const p of globalPlayers) {
        try { p.socket.disconnect(true); } catch { /* ignore */ }
    }
    console.log('  切断完了');
    setTimeout(() => process.exit(1), 500);
});

// ── ヘルパー ──

async function connectSocket(p: PlayerConn): Promise<void> {
    const socket = p.client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(p.session, true);
    await socket.joinChat('world', 1, true, false);

    // joinMatch リトライ（レートリミット対応）
    let match;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            match = await socket.joinMatch(p.matchId);
            break;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : JSON.stringify(e);
            if (msg.includes('too many logins') && attempt < 9) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                continue;
            }
            throw e;
        }
    }
    p.socket = socket;
    p.sessionId = match!.self?.session_id ?? '';
    p.connected = true;

    // 切断検知ハンドラを設定
    socket.ondisconnect = () => {
        p.connected = false;
    };
}

async function createPlayer(name: string): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const session = await client.authenticateCustom(name, true, name);
    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);
    await socket.joinChat('world', 1, true, false);

    const result = await socket.rpc('getWorldMatch');
    const data = JSON.parse(result.payload ?? '{}') as { matchId?: string };
    if (!data.matchId) throw new Error(`getWorldMatch failed for ${name}`);

    // joinMatch リトライ（レートリミット対応）
    let match;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            match = await socket.joinMatch(data.matchId);
            break;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : JSON.stringify(e);
            if (msg.includes('too many logins') && attempt < 9) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
                continue;
            }
            throw e;
        }
    }
    const sessionId = match!.self?.session_id ?? '';

    const p: PlayerConn = {
        client, session, socket, matchId: data.matchId, sessionId, name,
        connected: true, reconnecting: false, reconnectCount: 0,
    };

    // 切断検知ハンドラを設定
    socket.ondisconnect = () => {
        p.connected = false;
    };

    return p;
}

async function reconnectPlayer(p: PlayerConn): Promise<boolean> {
    if (p.reconnecting) return false;
    p.reconnecting = true;
    try {
        await connectSocket(p);
        p.reconnectCount++;
        totalReconnects++;
        return true;
    } catch {
        p.connected = false;
        return false;
    } finally {
        p.reconnecting = false;
    }
}

/**
 * 切断されたプレイヤーをバッチでリコネクトする
 */
async function reconnectDisconnected(players: PlayerConn[], concurrency = 20): Promise<number> {
    const disconnected = players.filter(p => !p.connected && !p.reconnecting);
    if (disconnected.length === 0) return 0;

    let reconnected = 0;
    for (let offset = 0; offset < disconnected.length; offset += concurrency) {
        const batch = disconnected.slice(offset, offset + concurrency);
        const results = await Promise.allSettled(batch.map(p => reconnectPlayer(p)));
        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) reconnected++;
        }
    }
    return reconnected;
}

async function cleanup(p: PlayerConn): Promise<void> {
    // leaveMatch を待たずに disconnect — サーバ側で自動的に match から除外される
    try { p.socket.disconnect(true); } catch { /* ignore */ }
    p.connected = false;
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

async function createPlayers(prefix: string, count: number, batchSize = 40): Promise<PlayerConn[]> {
    const players: PlayerConn[] = [];
    for (let offset = 0; offset < count; offset += batchSize) {
        const batch = Math.min(batchSize, count - offset);
        const promises: Promise<PlayerConn>[] = [];
        for (let i = 0; i < batch; i++) {
            promises.push(createPlayer(`${prefix}_${offset + i}`));
        }
        const results = await Promise.allSettled(promises);
        let rejected = 0;
        for (const r of results) {
            if (r.status === 'fulfilled') {
                players.push(r.value);
            } else {
                rejected++;
                const err = r.reason;
                const msg = err instanceof Error ? err.message : JSON.stringify(err);
                if (msg.includes('too many logins')) {
                    console.error(`⚠️ RATE LIMITED: ${msg}`);
                } else {
                    console.error(`❌ LOGIN ERROR: ${msg}`);
                }
            }
        }
        if (rejected > 0) {
            console.error(`⚠️ バッチ ${offset}〜${offset + batch}: ${rejected}人失敗`);
        }
        // 大人数テスト時は進捗を表示（doAll.shのタイムアウト防止）
        if (count >= 100 && (offset + batchSize) < count) {
            console.log(`  接続中: ${players.length}/${count}人`);
        }
        if (offset + batchSize < count) await sleep(1000);
    }
    console.log(`  createPlayers: ${players.length}/${count}人成功`);
    return players;
}

async function cleanupAll(players: PlayerConn[]): Promise<void> {
    await Promise.allSettled(players.map(p => cleanup(p)));
}

async function batchSend(
    players: PlayerConn[],
    buildPayload: (p: PlayerConn, i: number) => { opCode: number; data: string },
    batchSize = 50
): Promise<{ sent: number; errors: number }> {
    let sent = 0, errors = 0;
    for (let offset = 0; offset < players.length; offset += batchSize) {
        const batch = players.slice(offset, offset + batchSize);
        const results = await Promise.allSettled(
            batch.map((p, bi) => {
                if (!p.connected) return Promise.reject(new Error('disconnected'));
                const { opCode, data } = buildPayload(p, offset + bi);
                return p.socket.sendMatchState(p.matchId, opCode, data);
            })
        );
        for (let ri = 0; ri < results.length; ri++) {
            if (results[ri].status === 'fulfilled') {
                sent++;
            } else {
                errors++;
                // 送信失敗したプレイヤーをdisconnected扱いにする（reconnect対象にする）
                batch[ri].connected = false;
            }
        }
    }
    return { sent, errors };
}

function fmtDuration(sec: number): string {
    if (sec >= 60) return `${Math.floor(sec / 60)}分${sec % 60 ? sec % 60 + '秒' : ''}`;
    return `${sec}秒`;
}

/**
 * 一定時間接続を維持しながら定期的に移動メッセージを送信し、正常性を確認する。
 * 3秒ごとに全員がMOVE_TARGETを送信。切断プレイヤーは自動リコネクトする。
 */
async function sustainTest(
    players: PlayerConn[],
    durationSec: number
): Promise<{
    rounds: number; totalSent: number; totalErrors: number; totalReconnects: number;
    roundResults: { elapsed: number; sent: number; errors: number; reconnected: number; connected: number }[];
}> {
    const INTERVAL_MS = 3000;
    const rounds = Math.max(1, Math.floor((durationSec * 1000) / INTERVAL_MS));
    let totalSent = 0, totalErrors = 0, testReconnects = 0;
    const roundResults: { elapsed: number; sent: number; errors: number; reconnected: number; connected: number }[] = [];

    for (let round = 0; round < rounds; round++) {
        const t0 = performance.now();

        // 切断されたプレイヤーをリコネクト
        const reconnected = await reconnectDisconnected(players);
        testReconnects += reconnected;

        const connectedCount = players.filter(p => p.connected).length;

        // 全員がランダム方向に移動（AOI重複を減らすため広く配置）
        const spacing = players.length >= 500 ? 20 : 2;
        const cols = Math.ceil(Math.sqrt(players.length));
        const result = await batchSend(players, (_p, i) => {
            const baseX = (i % cols) * spacing - (cols * spacing) / 2;
            const baseZ = Math.floor(i / cols) * spacing - (cols * spacing) / 2;
            const dx = (Math.random() - 0.5) * 10;
            const dz = (Math.random() - 0.5) * 10;
            return {
                opCode: OP_MOVE_TARGET,
                data: JSON.stringify({ x: baseX + dx, z: baseZ + dz }),
            };
        });

        totalSent += result.sent;
        totalErrors += result.errors;
        const elapsed = performance.now() - t0;
        roundResults.push({ elapsed, sent: result.sent, errors: result.errors, reconnected, connected: connectedCount });

        // 進捗ログ（doAll.shのOUTPUT_TIMEOUT=60s対策）
        // リコネクト中は1ラウンドが長くなるため毎ラウンド出力、それ以外は15秒ごと
        const shouldLog = durationSec >= 30 && round < rounds - 1 &&
            (reconnected > 0 || result.errors > 0 || (round + 1) % 5 === 0);
        if (shouldLog) {
            const elapsedSec = ((round + 1) * INTERVAL_MS / 1000).toFixed(0);
            console.log(`  維持中 ${elapsedSec}/${durationSec}秒 ラウンド=${round + 1}/${rounds} 送信=${totalSent} エラー=${totalErrors}${reconnected > 0 ? ` リコネクト=${reconnected}` : ''}`);
        }

        // 次のラウンドまで待つ（送信時間分を差し引く）
        const waitMs = INTERVAL_MS - elapsed;
        if (waitMs > 0 && round < rounds - 1) {
            await sleep(waitMs);
        }
    }

    return { rounds, totalSent, totalErrors, totalReconnects: testReconnects, roundResults };
}

// ── テスト ──

const ALL_DURATIONS_SEC = [1, 10, 30, 60, 120, 180, 300, 600];
const MAX_DURATION = parseInt(process.env.SUSTAIN_DURATION ?? '90', 10);
const DURATIONS_SEC = ALL_DURATIONS_SEC.filter(d => d <= MAX_DURATION);

describe(`接続維持テスト (${PLAYER_COUNT}人, ${MAX_DURATION}秒)`, { timeout: (MAX_DURATION + 120) * 1000 }, () => {
    let players: PlayerConn[] = [];

    // プレイヤー作成: バッチ40人×1s間隔 → 2000人で約60s必要
    const SETUP_TIMEOUT = Math.max(30_000, Math.ceil(PLAYER_COUNT / 40) * 1500 + 30_000);
    beforeAll(async () => {
        totalReconnects = 0;
        players = await createPlayers('__test_sustain', PLAYER_COUNT);
        globalPlayers = players;
        await sleep(200);

        // 全員の初期位置とAOIを設定
        // 大人数時はAOI重複を減らすため広く配置（間隔20 → AOI112内に最大~25人）
        const spacing = PLAYER_COUNT >= 500 ? 20 : 2;
        const cols = Math.ceil(Math.sqrt(PLAYER_COUNT));
        await batchSend(players, (_p, i) => {
            const x = (i % cols) * spacing - (cols * spacing) / 2;
            const z = Math.floor(i / cols) * spacing - (cols * spacing) / 2;
            return { opCode: OP_INIT_POS, data: JSON.stringify({ x, z, ry: 0 }) };
        });
        await batchSend(players, (_p, i) => {
            const x = (i % cols) * spacing - (cols * spacing) / 2;
            const z = Math.floor(i / cols) * spacing - (cols * spacing) / 2;
            const half = 512;
            const cx = Math.floor((x + half) / 16);
            const cz = Math.floor((z + half) / 16);
            return {
                opCode: OP_AOI_UPDATE,
                data: JSON.stringify({
                    minCX: Math.max(0, cx - 3), minCZ: Math.max(0, cz - 3),
                    maxCX: Math.min(63, cx + 3), maxCZ: Math.min(63, cz + 3),
                }),
            };
        });
        await sleep(300);

        console.log(`  セットアップ完了: ${players.length}人接続`);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
        await cleanupAll(players);
        globalPlayers = [];
        players = [];
        await sleep(500);
    }, 60000);

    for (const sec of DURATIONS_SEC) {
        it(`${fmtDuration(sec)}間の接続維持が正常`, async () => {
            const t0 = performance.now();
            const result = await sustainTest(players, sec);
            const elapsed = performance.now() - t0;

            const successRate = result.totalSent / (result.totalSent + result.totalErrors);

            // ラウンドごとの成功率を集計
            const failedRounds = result.roundResults.filter(r => r.errors > 0).length;
            const avgRoundMs = result.roundResults.reduce((a, r) => a + r.elapsed, 0) / result.roundResults.length;
            const avgConnected = Math.round(result.roundResults.reduce((a, r) => a + r.connected, 0) / result.roundResults.length);

            // 80%以上の成功率を要求（リコネクト有りで高い成功率を期待）
            expect(successRate).toBeGreaterThanOrEqual(0.80);

            console.log(`  維持 ${fmtDuration(sec)}: ${(elapsed / 1000).toFixed(1)}s 実行 ラウンド=${result.rounds} 送信=${result.totalSent} エラー=${result.totalErrors} 成功率=${(successRate * 100).toFixed(1)}% 失敗ラウンド=${failedRounds}/${result.rounds} avg送信=${avgRoundMs.toFixed(0)}ms/回 リコネクト=${result.totalReconnects} avg接続=${avgConnected}人`);
        });
    }
});
