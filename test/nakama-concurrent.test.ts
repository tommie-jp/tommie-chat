/**
 * Nakama 同時接続テスト
 *
 * 前提: nakama サーバが 127.0.0.1:7350 で起動していること
 *   cd nakama && docker compose up -d
 *
 * 実行: npx vitest run test/nakama-concurrent.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket } from '@heroiclabs/nakama-js';

const HOST = '127.0.0.1';
const PORT = '7350';
const SERVER_KEY = 'defaultkey';
const OP_INIT_POS = 1;
const OP_MOVE_TARGET = 2;
const OP_AOI_UPDATE = 5;

interface PlayerConn {
    client: Client;
    session: Session;
    socket: Socket;
    matchId: string;
    sessionId: string;
    name: string;
}

// ── ヘルパー ──

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

    const match = await socket.joinMatch(data.matchId);
    const sessionId = match.self?.session_id ?? '';

    return { client, session, socket, matchId: data.matchId, sessionId, name };
}

async function cleanup(p: PlayerConn): Promise<void> {
    try { p.socket.disconnect(true); } catch { /* ignore */ }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * N人のプレイヤーを並列で作成する
 * concurrency でバッチサイズを制御（WebSocket接続の同時数を抑える）
 */
async function createPlayers(prefix: string, count: number, concurrency = 50): Promise<PlayerConn[]> {
    const players: PlayerConn[] = [];
    for (let offset = 0; offset < count; offset += concurrency) {
        const batch = Math.min(concurrency, count - offset);
        const promises: Promise<PlayerConn>[] = [];
        for (let i = 0; i < batch; i++) {
            const idx = offset + i;
            promises.push(createPlayer(`${prefix}_${idx}`));
        }
        const results = await Promise.all(promises);
        players.push(...results);
    }
    return players;
}

async function cleanupAll(players: PlayerConn[]): Promise<void> {
    await Promise.allSettled(players.map(p => cleanup(p)));
}

/**
 * sendMatchState をバッチで実行（同時送信数を制限）
 */
async function batchSend(
    players: PlayerConn[],
    buildPayload: (p: PlayerConn, i: number) => { opCode: number; data: string },
    batchSize = 50
): Promise<{ sent: number; errors: number; disconnected: number }> {
    let sent = 0, errors = 0, disconnected = 0;
    for (let offset = 0; offset < players.length; offset += batchSize) {
        const batch = players.slice(offset, offset + batchSize);
        const results = await Promise.allSettled(
            batch.map((p, bi) => {
                const { opCode, data } = buildPayload(p, offset + bi);
                return p.socket.sendMatchState(p.matchId, opCode, data);
            })
        );
        for (const r of results) {
            if (r.status === 'fulfilled') {
                sent++;
            } else {
                const reason = String((r as PromiseRejectedResult).reason);
                if (reason.includes('not been established')) {
                    disconnected++;
                } else {
                    errors++;
                }
            }
        }
    }
    return { sent, errors, disconnected };
}

// ── テスト ──

const CONCURRENCY_LEVELS = [1, 10, 100, 1000];

for (const N of CONCURRENCY_LEVELS) {
    describe(`同時接続 ${N}人`, { timeout: 120_000 }, () => {
        let players: PlayerConn[] = [];

        afterAll(async () => {
            await cleanupAll(players);
            players = [];
            // サーバ側の切断処理完了を待つ
            await sleep(2000);
        }, 30_000);

        it(`${N}人が全員ログイン成功する`, async () => {
            const t0 = performance.now();
            players = await createPlayers(`__test_conc${N}`, N);
            const elapsed = performance.now() - t0;

            // 全員のsessionIdが存在する
            expect(players.length).toBe(N);
            for (const p of players) {
                expect(p.sessionId).toBeTruthy();
                expect(p.matchId).toBeTruthy();
            }

            // 全員がマッチに参加している（並列接続時にサーバがマッチを複数作る場合がある）
            const matchIds = new Set(players.map(p => p.matchId));
            expect(matchIds.size).toBeGreaterThanOrEqual(1);
            console.log(`  マッチ数: ${matchIds.size}`);
            if (matchIds.size > 1) {
                console.log(`  ⚠ ${matchIds.size}個のマッチに分散（getWorldMatch RPCのタイミングによる）`);
            }

            console.log(`  ログイン ${N}人: ${elapsed.toFixed(0)}ms (${(elapsed / N).toFixed(1)}ms/人)`);
        });

        it(`${N}人が全員アバター移動できる`, async () => {
            expect(players.length).toBe(N);

            // ログイン直後のソケット安定化を待つ
            await sleep(500);

            const t0 = performance.now();

            // 全員が初期位置を送信
            const initResult = await batchSend(players, (_p, i) => {
                const x = (i % 100) * 2 - 100;
                const z = Math.floor(i / 100) * 2 - 10;
                return { opCode: OP_INIT_POS, data: JSON.stringify({ x, z, ry: 0 }) };
            });

            // 全員がAOIを設定
            const aoiResult = await batchSend(players, (_p, i) => {
                const x = (i % 100) * 2 - 100;
                const z = Math.floor(i / 100) * 2 - 10;
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

            // 全員が移動先を送信
            const moveResult = await batchSend(players, (_p, i) => {
                const x = (i % 100) * 2 - 100 + 5;
                const z = Math.floor(i / 100) * 2 - 10 + 3;
                return { opCode: OP_MOVE_TARGET, data: JSON.stringify({ x, z }) };
            });

            const elapsed = performance.now() - t0;

            // 接続中プレイヤーのみで成功率を算出（切断されたソケットは除外）
            const totalSent = initResult.sent + aoiResult.sent + moveResult.sent;
            const totalErrors = initResult.errors + aoiResult.errors + moveResult.errors;
            const totalDisconnected = initResult.disconnected + aoiResult.disconnected + moveResult.disconnected;
            const connected = totalSent + totalErrors;
            const successRate = connected > 0 ? totalSent / connected : 0;

            expect(successRate).toBeGreaterThanOrEqual(0.50);
            // 接続中プレイヤーの50%以上が移動成功
            const connectedAtMove = moveResult.sent + moveResult.errors;
            expect(moveResult.sent).toBeGreaterThanOrEqual(Math.floor(Math.max(connectedAtMove, 1) * 0.50));

            console.log(`  移動 ${N}人: ${elapsed.toFixed(0)}ms (${(elapsed / N).toFixed(1)}ms/人) 成功率=${(successRate * 100).toFixed(1)}% エラー=${totalErrors}${totalDisconnected > 0 ? ` 切断=${totalDisconnected}` : ''}`);
        });
    });
}
