/**
 * オセロ対戦 WebSocket 通知テスト
 *
 * 2プレイヤーで対局し、OP_OTHELLO_UPDATE (18) が
 * 購読者に正しく配信されることを検証する。
 *
 * 前提: nakama サーバが起動していること
 * 実行: npx vitest run test/nakama-othello.test.ts
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket, MatchData } from '@heroiclabs/nakama-js';
import { trackUserId, deleteCreatedUsers } from './test-helpers';

const HOST       = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT       = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'tommie-chat';

const OP_INIT_POS        = 1;
const OP_AOI_UPDATE      = 5;
const OP_OTHELLO_UPDATE  = 18;
const OP_OTHELLO_SUB     = 19;

const CHUNK_SIZE  = 16;
const CHUNK_COUNT = 64;
const WORLD_SIZE  = 1024;
const AOI_RADIUS  = 48;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── AOI 計算 ──
function calcAOI(x: number, z: number) {
    const half = WORLD_SIZE / 2;
    const px = x + half, pz = z + half;
    const r = AOI_RADIUS;
    return {
        minCX: Math.max(0,              Math.floor((px - r) / CHUNK_SIZE)),
        minCZ: Math.max(0,              Math.floor((pz - r) / CHUNK_SIZE)),
        maxCX: Math.min(CHUNK_COUNT-1,  Math.floor((px + r) / CHUNK_SIZE)),
        maxCZ: Math.min(CHUNK_COUNT-1,  Math.floor((pz + r) / CHUNK_SIZE)),
    };
}

// ── プレイヤー接続 ──
interface OthelloUpdate {
    type?: string;
    gameId: string;
    board: number[];
    black: string;
    white: string;
    turn: number;
    status: string;
    lastMove: number;
    winner: number;
    blackCount: number;
    whiteCount: number;
}

interface OthelloListUpdate {
    type: "list";
    games: { gameId: string; black: string; blackName: string; white: string; whiteName: string; status: string; turn: number; blackCount: number; whiteCount: number }[];
}

interface PlayerConn {
    name: string;
    client: Client;
    session: Session;
    socket: Socket;
    matchId: string;
    userId: string;
    othelloUpdates: OthelloUpdate[];
    othelloListUpdates: OthelloListUpdate[];
}

async function loginAndJoin(name: string): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const suffix = Date.now();
    const testId = `oth_${name}_${suffix}`;
    const testUname = `oth_${name}_${suffix}`;

    const session = await client.authenticateCustom(testId, true, testUname);
    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);

    // getWorldMatch
    const wmResult = await socket.rpc('getWorldMatch');
    const wmData = JSON.parse(wmResult.payload ?? '{}') as { matchId?: string };
    if (!wmData.matchId) throw new Error(`getWorldMatch failed for ${name}`);

    const othelloUpdates: OthelloUpdate[] = [];
    const othelloListUpdates: OthelloListUpdate[] = [];

    // マッチデータ受信ハンドラ
    socket.onmatchdata = (md: MatchData) => {
        if (md.op_code === OP_OTHELLO_UPDATE) {
            try {
                const payload = JSON.parse(new TextDecoder().decode(md.data));
                if (payload.type === "list") {
                    othelloListUpdates.push(payload as OthelloListUpdate);
                } else {
                    othelloUpdates.push(payload as OthelloUpdate);
                }
            } catch { /* ignore */ }
        }
    };

    // joinMatch
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await socket.joinMatch(wmData.matchId);
            break;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : JSON.stringify(e);
            if (msg.includes('too many logins') && attempt < 4) {
                await sleep(500 + Math.random() * 500);
                continue;
            }
            throw e;
        }
    }

    trackUserId(session.user_id!);

    // initPos + AOI_UPDATE（ブロック更新の受信に必要）
    await socket.sendMatchState(wmData.matchId, OP_INIT_POS, JSON.stringify({
        x: 0, z: 0, ry: 0, lt: new Date().toISOString(), dn: name, tx: '/textures/pic1.ktx2',
    }));
    const aoi = calcAOI(0, 0);
    await socket.sendMatchState(wmData.matchId, OP_AOI_UPDATE, JSON.stringify(aoi));

    // オセロ購読
    await socket.sendMatchState(wmData.matchId, OP_OTHELLO_SUB, JSON.stringify({ subscribe: true }));

    return {
        name, client, session, socket,
        matchId: wmData.matchId,
        userId: session.user_id!,
        othelloUpdates,
        othelloListUpdates,
    };
}

function waitForOthelloUpdate(
    conn: PlayerConn,
    predicate: (u: OthelloUpdate) => boolean,
    timeoutMs = 5000,
): Promise<OthelloUpdate> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = setInterval(() => {
            const found = conn.othelloUpdates.find(predicate);
            if (found) { clearInterval(check); resolve(found); return; }
            if (Date.now() > deadline) { clearInterval(check); reject(new Error('timeout waiting for othelloUpdate')); }
        }, 50);
    });
}

// ── テスト ──

describe('オセロ WebSocket 通知テスト', { timeout: 30_000 }, () => {
    let playerA: PlayerConn;
    let playerB: PlayerConn;
    let gameId: string;

    beforeAll(async () => {
        playerA = await loginAndJoin('othA');
        await sleep(200);
        playerB = await loginAndJoin('othB');
        await sleep(500);
    });

    afterAll(async () => {
        try { playerA?.socket.disconnect(true); } catch { /* */ }
        try { playerB?.socket.disconnect(true); } catch { /* */ }
        await deleteCreatedUsers();
    }, 30_000);

    it('購読時にゲーム一覧が配信される', async () => {
        // loginAndJoin 内で OP_OTHELLO_SUB を送信済み → 初期リストが届いているはず
        expect(playerA.othelloListUpdates.length).toBeGreaterThanOrEqual(1);
        const list = playerA.othelloListUpdates[playerA.othelloListUpdates.length - 1];
        expect(list.type).toBe('list');
        expect(Array.isArray(list.games)).toBe(true);
    });

    it('othelloCreate → 待機中ゲームが作成される', async () => {
        playerA.othelloListUpdates.length = 0;
        playerB.othelloListUpdates.length = 0;

        const result = await playerA.socket.rpc('othelloCreate', JSON.stringify({ worldId: 0 }));
        const data = JSON.parse(result.payload ?? '{}') as OthelloUpdate;
        expect(data.gameId).toBeTruthy();
        expect(data.status).toBe('waiting');
        expect(data.black).toBe(playerA.userId);
        gameId = data.gameId;

        // 購読者にゲーム一覧が配信される
        await sleep(500);
        const listA = playerA.othelloListUpdates.find(l => l.games.some(g => g.gameId === gameId));
        expect(listA, 'playerA にゲーム一覧が配信される').toBeTruthy();
        const listB = playerB.othelloListUpdates.find(l => l.games.some(g => g.gameId === gameId));
        expect(listB, 'playerB にゲーム一覧が配信される').toBeTruthy();
    });

    it('othelloJoin → 両者に OP_OTHELLO_UPDATE が配信される', async () => {
        // playerB がゲームに参加
        const result = await playerB.socket.rpc('othelloJoin', JSON.stringify({ gameId }));
        const data = JSON.parse(result.payload ?? '{}') as OthelloUpdate;
        expect(data.status).toBe('playing');
        expect(data.turn).toBe(1);

        // WebSocket 通知を待つ
        const updateA = await waitForOthelloUpdate(playerA, u => u.status === 'playing');
        expect(updateA.gameId).toBe(gameId);
        expect(updateA.white).toBe(playerB.userId);

        const updateB = await waitForOthelloUpdate(playerB, u => u.status === 'playing');
        expect(updateB.gameId).toBe(gameId);
    });

    it('othelloMove(黒) → 両者に盤面更新が配信される', async () => {
        // playerA（黒）が (2,3) に着手
        playerA.othelloUpdates.length = 0;
        playerB.othelloUpdates.length = 0;

        const result = await playerA.socket.rpc('othelloMove', JSON.stringify({ gameId, row: 2, col: 3 }));
        const data = JSON.parse(result.payload ?? '{}') as OthelloUpdate;
        expect(data.turn).toBe(2); // 白のターンに
        expect(data.lastMove).toBe(2 * 8 + 3); // index = 19

        // 両者に配信される
        const updateA = await waitForOthelloUpdate(playerA, u => u.lastMove === 19);
        expect(updateA.turn).toBe(2);

        const updateB = await waitForOthelloUpdate(playerB, u => u.lastMove === 19);
        expect(updateB.turn).toBe(2);
    });

    it('othelloMove(白) → 両者にターン交代が配信される', async () => {
        playerA.othelloUpdates.length = 0;
        playerB.othelloUpdates.length = 0;

        // playerB（白）が (2,2) に着手
        const result = await playerB.socket.rpc('othelloMove', JSON.stringify({ gameId, row: 2, col: 2 }));
        const data = JSON.parse(result.payload ?? '{}') as OthelloUpdate;
        expect(data.turn).toBe(1); // 黒のターンに

        const updateA = await waitForOthelloUpdate(playerA, u => u.lastMove === 2 * 8 + 2);
        expect(updateA.turn).toBe(1);

        const updateB = await waitForOthelloUpdate(playerB, u => u.lastMove === 2 * 8 + 2);
        expect(updateB.turn).toBe(1);
    });

    it('othelloResign → 両者に終局通知が配信される', async () => {
        playerA.othelloUpdates.length = 0;
        playerB.othelloUpdates.length = 0;

        const result = await playerB.socket.rpc('othelloResign', JSON.stringify({ gameId }));
        const data = JSON.parse(result.payload ?? '{}') as OthelloUpdate;
        expect(data.status).toBe('finished');
        expect(data.winner).toBe(1); // 白が投了 → 黒勝ち

        const updateA = await waitForOthelloUpdate(playerA, u => u.status === 'finished');
        expect(updateA.winner).toBe(1);

        const updateB = await waitForOthelloUpdate(playerB, u => u.status === 'finished');
        expect(updateB.winner).toBe(1);
    });

    it('購読解除後は通知を受信しない', async () => {
        // 新しいゲームを作成
        playerA.othelloUpdates.length = 0;
        playerB.othelloUpdates.length = 0;

        // playerB が購読解除
        await playerB.socket.sendMatchState(playerB.matchId, OP_OTHELLO_SUB, JSON.stringify({ subscribe: false }));
        await sleep(200);

        // playerA が新しいゲーム作成
        const createResult = await playerA.socket.rpc('othelloCreate', JSON.stringify({ worldId: 0 }));
        const createData = JSON.parse(createResult.payload ?? '{}') as OthelloUpdate;
        const newGameId = createData.gameId;

        // playerB が購読なしで参加
        await playerB.socket.rpc('othelloJoin', JSON.stringify({ gameId: newGameId }));
        await sleep(1000);

        // playerA は購読中なので受信する
        const updateA = playerA.othelloUpdates.find(u => u.gameId === newGameId && u.status === 'playing');
        expect(updateA, 'playerA（購読中）は通知を受信する').toBeTruthy();

        // playerB は購読解除済みなので受信しない
        const updateB = playerB.othelloUpdates.find(u => u.gameId === newGameId);
        expect(updateB, 'playerB（購読解除）は通知を受信しない').toBeUndefined();

        // クリーンアップ: 投了して終了
        await playerA.socket.rpc('othelloResign', JSON.stringify({ gameId: newGameId })).catch(() => {});
    });
});
