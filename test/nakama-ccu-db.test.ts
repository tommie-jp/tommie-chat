/**
 * Nakama 同接履歴 DB永続化テスト
 *
 * 環境変数 CCU_TEST_LEVEL で実行レベルを制御:
 *   1m  — 1分以内: 1sサンプリング確認 + 基本的なRPC疎通
 *   5m  — 5分以内: 1mフラッシュ待ち + 再起動 + 履歴復元（デフォルト）
 *   30m — 30分以内: 複数回再起動で履歴が累積することを検証
 *   1h  — 1時間以内: 長時間安定稼働 + 複数レンジの整合性確認
 *
 * 前提:
 *   - nakama サーバが 127.0.0.1:7350 で起動していること
 *   - nakama/go_src/build.sh でプラグインがビルド済みであること
 *
 * 実行: CCU_TEST_LEVEL=5m npx vitest run test/nakama-ccu-db.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket } from '@heroiclabs/nakama-js';
import { execSync } from 'child_process';

const HOST = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';
const PLAYER_COUNT = 5;
const NAKAMA_DIR = new URL('../nakama', import.meta.url).pathname;

const TEST_LEVEL = (process.env.CCU_TEST_LEVEL ?? '5m') as '1m' | '5m' | '30m' | '1h';
const LEVEL_ORDER = ['1m', '5m', '30m', '1h'] as const;
const levelIndex = LEVEL_ORDER.indexOf(TEST_LEVEL);
const levelAtLeast = (min: typeof LEVEL_ORDER[number]) => levelIndex >= LEVEL_ORDER.indexOf(min);

interface PlayerConn {
    client: Client;
    session: Session;
    socket: Socket;
    matchId: string;
    name: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

async function createPlayer(name: string): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const session = await client.authenticateCustom(name, true, name);
    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);
    await socket.joinChat('world', 1, true, false);

    // joinMatch リトライ（レートリミット対応）
    let matchId = '';
    for (let attempt = 0; attempt < 10; attempt++) {
        const result = await socket.rpc('getWorldMatch');
        const data = JSON.parse(result.payload ?? '{}') as { matchId?: string };
        if (!data.matchId) throw new Error(`getWorldMatch failed for ${name}`);
        matchId = data.matchId;
        try {
            await socket.joinMatch(matchId);
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
    return { client, session, socket, matchId, name };
}

async function cleanup(p: PlayerConn): Promise<void> {
    try { p.socket.disconnect(true); } catch { /* ignore */ }
}

async function rpcGetPlayerCount(socket: Socket, range?: string): Promise<{ count: number; history: number[]; timestamps?: number[] }> {
    const payload = range ? JSON.stringify({ range }) : undefined;
    const result = await socket.rpc('getPlayerCount', payload);
    const data = JSON.parse(result.payload ?? '{}') as { count?: number; history?: number[]; timestamps?: number[] };
    return { count: data.count ?? 0, history: data.history ?? [], timestamps: data.timestamps };
}

async function waitForServer(maxMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        let sock: Socket | null = null;
        try {
            const c = new Client(SERVER_KEY, HOST, PORT, false);
            const s = await c.authenticateCustom('__test_health_check', true, '__test_health_check');
            sock = c.createSocket(false, false);
            await sock.connect(s, true);
            await sock.rpc('ping');
            sock.disconnect(true);
            return;
        } catch {
            try { sock?.disconnect(true); } catch { /* ignore */ }
            await sleep(1000);
        }
    }
    throw new Error(`Server did not respond within ${maxMs}ms`);
}

async function restartServer(): Promise<void> {
    try {
        execSync('docker compose down', { cwd: NAKAMA_DIR, stdio: 'pipe', timeout: 30000 });
    } catch (e) {
        console.warn('docker compose down warning:', (e as Error).message);
    }
    await sleep(2000);
    try {
        execSync('docker compose up -d --scale prometheus=0', { cwd: NAKAMA_DIR, stdio: 'pipe', timeout: 30000 });
    } catch (e) {
        console.warn('docker compose up warning:', (e as Error).message);
    }
    await waitForServer(60000);
}

async function newAdmin(): Promise<{ client: Client; session: Session; socket: Socket }> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const session = await client.authenticateCustom('__test_ccu_admin', true, '__test_ccu_admin');
    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);
    return { client, session, socket };
}

/** 1mフラッシュをポーリングで待つ。既存件数より増えたら成功 */
async function waitFor1mFlush(socket: Socket, minCount: number, maxWaitMs = 70000): Promise<{ count: number; history: number[] }> {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        const result = await rpcGetPlayerCount(socket, '1h');
        if (result.history.length > minCount) return result;
        await sleep(5000);
    }
    // 最終取得
    return rpcGetPlayerCount(socket, '1h');
}

// ============================================================
describe(`同接履歴 DB永続化 [${TEST_LEVEL}]`, () => {
    const players: PlayerConn[] = [];

    afterAll(async () => {
        await Promise.allSettled(players.map(p => cleanup(p)));
    });

    // ── 1m: 1sサンプリング確認 ──
    it('1sサンプリングが動作する', async () => {
        console.log(`[1s] ${PLAYER_COUNT}人 接続中...`);
        for (let i = 0; i < PLAYER_COUNT; i++) {
            players.push(await createPlayer(`__test_ccu_${i}`));
        }
        console.log(`[1s] ${players.length}人 接続完了`);

        const { socket } = await newAdmin();

        // サンプリングタイミングによりcountが0になる場合があるためポーリング
        let result = { count: 0, history: [] as number[] };
        for (let attempt = 0; attempt < 10; attempt++) {
            await sleep(1000);
            result = await rpcGetPlayerCount(socket, '5m');
            console.log(`[1s] attempt=${attempt} 1s履歴: ${result.history.length}件, count=${result.count}`);
            if (result.count >= 1 && result.history.length > 0) break;
        }
        expect(result.count).toBeGreaterThanOrEqual(1);
        expect(result.history.length).toBeGreaterThan(0);
    }, 30000);

    // ── 1m: 切断/再接続で同接数が正しく増減する ──
    it('切断/再接続でcountが正しく増減する', async () => {
        const { socket } = await newAdmin();

        // 現在のcount取得（前のテストのplayersが接続中）
        const before = await rpcGetPlayerCount(socket);
        const baseCount = before.count;
        console.log(`[reconn] ベースcount=${baseCount} (${players.length}人接続中)`);
        expect(baseCount).toBeGreaterThanOrEqual(players.length);

        // 半数を切断
        const half = Math.floor(players.length / 2);
        const disconnected: PlayerConn[] = [];
        for (let i = 0; i < half; i++) {
            players[i].socket.disconnect(true);
            disconnected.push(players[i]);
        }
        console.log(`[reconn] ${half}人を切断`);

        // count が減ったことをポーリングで確認
        const expectAfterDisconnect = baseCount - half;
        let afterDisconnect = { count: 0 };
        for (let attempt = 0; attempt < 10; attempt++) {
            await sleep(1000);
            afterDisconnect = await rpcGetPlayerCount(socket);
            console.log(`[reconn] 切断後 attempt=${attempt} count=${afterDisconnect.count} (期待: ${expectAfterDisconnect})`);
            if (afterDisconnect.count >= expectAfterDisconnect - 1 && afterDisconnect.count <= expectAfterDisconnect + 1) break;
        }
        expect(afterDisconnect.count).toBeLessThanOrEqual(expectAfterDisconnect + 1);
        expect(afterDisconnect.count).toBeGreaterThanOrEqual(expectAfterDisconnect - 1);

        // 切断した分を再接続
        for (let i = 0; i < half; i++) {
            const name = disconnected[i].name;
            players[i] = await createPlayer(name);
        }
        console.log(`[reconn] ${half}人を再接続`);

        // count が戻ったことをポーリングで確認
        let afterReconnect = { count: 0 };
        for (let attempt = 0; attempt < 10; attempt++) {
            await sleep(1000);
            afterReconnect = await rpcGetPlayerCount(socket);
            console.log(`[reconn] 再接続後 attempt=${attempt} count=${afterReconnect.count} (期待: ${baseCount})`);
            if (afterReconnect.count >= baseCount - 1 && afterReconnect.count <= baseCount + 1) break;
        }
        expect(afterReconnect.count).toBeGreaterThanOrEqual(baseCount - 1);
        expect(afterReconnect.count).toBeLessThanOrEqual(baseCount + 1);
    }, 60000);

    // ── 1m: RPC各レンジ疎通 ──
    it('RPC全レンジが応答する', async () => {
        const { socket } = await newAdmin();
        for (const range of ['1m', '5m', '1h', '12h', '1d', '10d'] as const) {
            const result = await rpcGetPlayerCount(socket, range);
            console.log(`[rpc] range=${range} history=${result.history.length}件`);
            expect(result.count).toBeGreaterThanOrEqual(0);
            expect(Array.isArray(result.history)).toBe(true);
        }
    }, 30000);

    // ── 5m: 1mフラッシュ + 再起動 + 復元 ──
    it.skipIf(!levelAtLeast('5m'))('1mフラッシュ → 再起動 → 履歴復元', async () => {
        const { socket } = await newAdmin();

        console.log('[5m-1] 1分フラッシュを待機...');
        const before1m = await waitFor1mFlush(socket, 0);
        console.log(`[5m-1] 1m履歴: ${before1m.history.length}件, 値=[${before1m.history.join(',')}]`);
        expect(before1m.history.length).toBeGreaterThan(0);

        const savedLen = before1m.history.length;
        const savedLast = before1m.history[before1m.history.length - 1];

        // プレイヤー切断
        for (const p of players) cleanup(p);
        players.length = 0;

        // 再起動
        console.log('[5m-2] サーバ再起動中...');
        await restartServer();
        console.log('[5m-2] サーバ応答OK');

        // 復元確認
        const admin2 = await newAdmin();
        const after1m = await rpcGetPlayerCount(admin2.socket, '1h');
        console.log(`[5m-3] 復元後1m履歴: ${after1m.history.length}件, 値=[${after1m.history.join(',')}]`);
        expect(after1m.history.length).toBeGreaterThanOrEqual(savedLen);
        expect(after1m.history).toContain(savedLast);

        console.log(`[5m-3] ✅ 保存${savedLen}件 → 復元${after1m.history.length}件`);
    }, 180000);

    // ── 5m: 再起動後にタイムスタンプ重複がないこと ──
    it.skipIf(!levelAtLeast('5m'))('再起動後にタイムスタンプ重複がない', async () => {
        // 前のテストで既に再起動済み。もう一度再起動して重複蓄積が発生しないことを確認
        console.log('[dedup-1] サーバ再起動（重複テスト用）...');
        await restartServer();

        const { socket } = await newAdmin();

        // 1mフラッシュを待つ（新規データが追加されるよう接続）
        for (let i = 0; i < 3; i++) {
            players.push(await createPlayer(`__test_ccu_dedup_${i}`));
        }
        console.log('[dedup-2] 1分フラッシュ待ち...');
        await waitFor1mFlush(socket, 0);

        // 再度再起動してロード
        for (const p of players) cleanup(p);
        players.length = 0;
        console.log('[dedup-3] 再度再起動...');
        await restartServer();

        const admin2 = await newAdmin();
        const result = await rpcGetPlayerCount(admin2.socket, '10d');
        const ts = result.timestamps;
        expect(ts).toBeDefined();
        expect(ts!.length).toBe(result.history.length);

        // タイムスタンプに重複がないことを確認
        const uniqueTs = new Set(ts);
        const dupeCount = ts!.length - uniqueTs.size;
        console.log(`[dedup-4] タイムスタンプ: ${ts!.length}件, ユニーク: ${uniqueTs.size}件, 重複: ${dupeCount}件`);
        expect(dupeCount).toBe(0);

        console.log(`[dedup-4] ✅ 重複タイムスタンプなし`);
    }, 300000);

    // ── 5m: 1dレンジが24時間以内のデータのみ返す ──
    it.skipIf(!levelAtLeast('5m'))('1dレンジは24時間以内のデータのみ返す', async () => {
        const { socket } = await newAdmin();
        const result = await rpcGetPlayerCount(socket, '1d');
        const ts = result.timestamps;

        if (!ts || ts.length === 0) {
            console.log('[range-1d] タイムスタンプなし（データ不足でスキップ）');
            return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const cutoff = nowSec - 24 * 3600;
        const outOfRange = ts.filter(t => t < cutoff);

        console.log(`[range-1d] データ: ${ts.length}件, 最古: ${new Date(ts[0] * 1000).toISOString()}, 最新: ${new Date(ts[ts.length - 1] * 1000).toISOString()}`);
        console.log(`[range-1d] 24h前カットオフ: ${new Date(cutoff * 1000).toISOString()}, 期間外: ${outOfRange.length}件`);

        expect(outOfRange.length).toBe(0);

        console.log(`[range-1d] ✅ 全データが24時間以内`);
    }, 30000);

    // ── 30m: 複数回再起動で履歴が累積 ──
    it.skipIf(!levelAtLeast('30m'))('複数回再起動で履歴が累積する', async () => {
        const RESTART_CYCLES = 3;
        let prevLen = 0;

        for (let cycle = 1; cycle <= RESTART_CYCLES; cycle++) {
            console.log(`[30m] サイクル ${cycle}/${RESTART_CYCLES} 開始`);

            // プレイヤー接続
            for (let i = 0; i < PLAYER_COUNT; i++) {
                players.push(await createPlayer(`__test_ccu_30m_c${cycle}_${i}`));
            }

            const { socket } = await newAdmin();

            // 1分フラッシュを2回分待つ（2分以上の履歴蓄積）
            console.log(`[30m] サイクル ${cycle}: フラッシュ待ち (最大130秒)...`);
            const result = await waitFor1mFlush(socket, prevLen, 130000);
            console.log(`[30m] サイクル ${cycle}: 1m履歴=${result.history.length}件 (前回=${prevLen}件)`);
            expect(result.history.length).toBeGreaterThan(prevLen);

            prevLen = result.history.length;

            // プレイヤー切断
            for (const p of players) cleanup(p);
            players.length = 0;

            // 再起動
            if (cycle < RESTART_CYCLES) {
                console.log(`[30m] サイクル ${cycle}: 再起動中...`);
                await restartServer();
                console.log(`[30m] サイクル ${cycle}: サーバ応答OK`);

                // 復元確認
                const admin2 = await newAdmin();
                const restored = await rpcGetPlayerCount(admin2.socket, '1h');
                console.log(`[30m] サイクル ${cycle}: 復元後=${restored.history.length}件`);
                expect(restored.history.length).toBeGreaterThanOrEqual(prevLen);
                prevLen = restored.history.length;
            }
        }

        console.log(`[30m] ✅ ${RESTART_CYCLES}サイクル完了: 最終履歴=${prevLen}件`);
    }, 1800000); // 30分

    // ── 1h: 長時間安定稼働 + レンジ整合性 ──
    it.skipIf(!levelAtLeast('1h'))('長時間稼働: 履歴蓄積とレンジ整合性', async () => {
        const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分ごと
        const TOTAL_DURATION_MS = 50 * 60 * 1000; // 50分
        const checks: { elapsed: string; h1s: number; h1m: number; count: number }[] = [];

        // プレイヤー接続
        for (let i = 0; i < PLAYER_COUNT; i++) {
            players.push(await createPlayer(`__test_ccu_1h_${i}`));
        }

        const start = Date.now();
        let prevH1m = 0;

        while (Date.now() - start < TOTAL_DURATION_MS) {
            await sleep(CHECK_INTERVAL_MS);

            const { socket } = await newAdmin();
            const r1s = await rpcGetPlayerCount(socket, '5m');
            const r1m = await rpcGetPlayerCount(socket, '1h');
            const elapsed = ((Date.now() - start) / 60000).toFixed(1) + 'min';

            checks.push({ elapsed, h1s: r1s.history.length, h1m: r1m.history.length, count: r1s.count });
            console.log(`[1h] ${elapsed}: count=${r1s.count} 1s=${r1s.history.length}件 1m=${r1m.history.length}件`);

            // 1m履歴は時間経過とともに増加する
            expect(r1m.history.length).toBeGreaterThanOrEqual(prevH1m);
            prevH1m = r1m.history.length;

            // countが正の値であること
            expect(r1s.count).toBeGreaterThanOrEqual(1);
        }

        // レンジ間の整合性: 1h の件数 <= 10d の件数
        const { socket } = await newAdmin();
        const r1h = await rpcGetPlayerCount(socket, '1h');
        const r10d = await rpcGetPlayerCount(socket, '10d');
        console.log(`[1h] レンジ整合性: 1h=${r1h.history.length}件, 10d=${r10d.history.length}件`);
        expect(r10d.history.length).toBeGreaterThanOrEqual(r1h.history.length);

        // 最終再起動テスト
        for (const p of players) cleanup(p);
        players.length = 0;

        console.log('[1h] 最終再起動...');
        const beforeLen = r1h.history.length;
        await restartServer();
        const admin2 = await newAdmin();
        const after = await rpcGetPlayerCount(admin2.socket, '1h');
        console.log(`[1h] 最終復元: ${beforeLen}件 → ${after.history.length}件`);
        expect(after.history.length).toBeGreaterThanOrEqual(beforeLen);

        console.log(`[1h] ✅ 長時間テスト完了: チェック${checks.length}回, 最終1m履歴=${after.history.length}件`);
        console.table(checks);
    }, 3600000); // 1時間
});
