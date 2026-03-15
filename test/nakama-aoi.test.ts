/**
 * Nakama AOI 統合テスト
 *
 * 前提: nakama サーバが 127.0.0.1:7350 で起動していること
 *   cd nakama && docker compose up -d
 *
 * 実行: npx vitest run test/nakama-aoi.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as ws from 'ws';
// Node.js にはブラウザの WebSocket がないので ws パッケージで補う
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket, MatchData } from '@heroiclabs/nakama-js';
import { trackUserId, deleteCreatedUsers } from './test-helpers';

const HOST = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';
const CHUNK_SIZE = 16;
const OP_INIT_POS = 1;
const OP_MOVE_TARGET = 2;
const OP_BLOCK_UPDATE = 4;
const OP_AOI_UPDATE = 5;
const OP_AOI_ENTER = 6;
const OP_AOI_LEAVE = 7;

interface PlayerConn {
    client: Client;
    session: Session;
    socket: Socket;
    matchId: string;
    sessionId: string;
}

async function createPlayer(name: string): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const session = await client.authenticateCustom(name, true, name);
    const socket = client.createSocket(false, false);
    await socket.connect(session, true);
    await socket.joinChat('world', 1, true, false);

    // getWorldMatch RPC (WebSocket) + joinMatch リトライ（レートリミット対応）
    let matchId = '';
    let sessionId = '';
    for (let attempt = 0; attempt < 10; attempt++) {
        const result = await socket.rpc('getWorldMatch');
        const data = JSON.parse(result.payload ?? '{}') as { matchId?: string };
        expect(data.matchId).toBeTruthy();
        matchId = data.matchId!;
        try {
            const match = await socket.joinMatch(matchId);
            sessionId = match.self?.session_id ?? '';
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

    trackUserId(session.user_id!);
    return { client, session, socket, matchId, sessionId };
}

async function sendAOI(p: PlayerConn, minCX: number, minCZ: number, maxCX: number, maxCZ: number): Promise<void> {
    await p.socket.sendMatchState(p.matchId, OP_AOI_UPDATE, JSON.stringify({ minCX, minCZ, maxCX, maxCZ }));
}

async function cleanup(p: PlayerConn): Promise<void> {
    try { await p.socket.leaveMatch(p.matchId); } catch { /* ignore */ }
    try { p.socket.disconnect(true); } catch { /* ignore */ }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ─── テスト ───

describe('Nakama AOI 統合テスト', () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        p1 = await createPlayer('__test_aoi_p1');
        await sleep(500); // MatchList インデックス反映待ち
        p2 = await createPlayer('__test_aoi_p2');
    });

    afterAll(async () => {
        await cleanup(p1);
        await cleanup(p2);
    });

    it('サーバ接続とマッチ参加', () => {
        expect(p1.matchId).toBeTruthy();
        expect(p2.matchId).toBeTruthy();
        expect(p1.matchId).toBe(p2.matchId);
    });

    it('AOI送信が正常に完了する', async () => {
        // エラーなく送信できることを確認
        await sendAOI(p1, 0, 0, 7, 7);
        await sendAOI(p2, 32, 32, 63, 63);
        await sleep(200); // サーバ側のMatchLoop処理待ち
    });

    it('AOI内のブロック更新を受信する', async () => {
        // p1のAOI: (0,0)-(7,7) → チャンク(0,0)のブロック更新を受信するはず
        await sendAOI(p1, 0, 0, 7, 7);
        await sleep(200);

        const received: { gx: number; gz: number; blockId: number }[] = [];
        p1.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_BLOCK_UPDATE) {
                const payload = JSON.parse(new TextDecoder().decode(md.data));
                received.push(payload);
            }
        };

        // チャンク(0,0)内のブロックを設置 (gx=1, gz=1)
        await p1.socket.rpc('setBlock', JSON.stringify({ gx: 1, gz: 1, blockId: 1, r: 255, g: 0, b: 0, a: 255 }));
        await sleep(500);

        expect(received.length).toBeGreaterThanOrEqual(1);
        expect(received[0].gx).toBe(1);
        expect(received[0].gz).toBe(1);

        // 後片付け: ブロックを削除
        await p1.socket.rpc('setBlock', JSON.stringify({ gx: 1, gz: 1, blockId: 0, r: 0, g: 0, b: 0, a: 0 }));
    });

    it('AOI外のブロック更新を受信しない', async () => {
        // p2のAOI: (32,32)-(63,63) → チャンク(0,0)のブロック更新は受信しないはず
        await sendAOI(p2, 32, 32, 63, 63);
        await sleep(200);

        const received: unknown[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_BLOCK_UPDATE) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // チャンク(0,0)内のブロックを設置
        await p1.socket.rpc('setBlock', JSON.stringify({ gx: 2, gz: 2, blockId: 1, r: 0, g: 255, b: 0, a: 255 }));
        await sleep(500);

        expect(received.length).toBe(0);

        // 後片付け
        await p1.socket.rpc('setBlock', JSON.stringify({ gx: 2, gz: 2, blockId: 0, r: 0, g: 0, b: 0, a: 0 }));
    });

    it('AOI変更後に新しいAOI内のブロック更新を受信する', async () => {
        // p2のAOIを(0,0)-(63,63)に広げる
        await sendAOI(p2, 0, 0, 63, 63);
        await sleep(200);

        const received: unknown[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_BLOCK_UPDATE) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // チャンク(0,0)内のブロックを設置 → 今度はp2も受信するはず
        await p1.socket.rpc('setBlock', JSON.stringify({ gx: 3, gz: 3, blockId: 1, r: 0, g: 0, b: 255, a: 255 }));
        await sleep(500);

        expect(received.length).toBeGreaterThanOrEqual(1);

        // 後片付け
        await p1.socket.rpc('setBlock', JSON.stringify({ gx: 3, gz: 3, blockId: 0, r: 0, g: 0, b: 0, a: 0 }));
    });

    it('syncChunks RPC（AOIベース）が正常に応答する', async () => {
        // AOI範囲とハッシュマップを送信
        const hashes: Record<string, string> = {};
        for (let cx = 0; cx <= 3; cx++) {
            for (let cz = 0; cz <= 3; cz++) {
                hashes[`${cx}_${cz}`] = '0';
            }
        }
        const result = await p1.socket.rpc('syncChunks', JSON.stringify({ minCX: 0, minCZ: 0, maxCX: 3, maxCZ: 3, hashes }));
        expect(result.payload).toBeTruthy();
        const data = JSON.parse(result.payload!) as { chunks?: { cx: number; cz: number; hash: string; table: number[] }[] };
        expect(data.chunks).toBeDefined();
        expect(Array.isArray(data.chunks)).toBe(true);
        // 返却されるチャンクはすべて指定範囲内
        for (const ch of data.chunks ?? []) {
            expect(ch.cx).toBeGreaterThanOrEqual(0);
            expect(ch.cx).toBeLessThanOrEqual(3);
            expect(ch.cz).toBeGreaterThanOrEqual(0);
            expect(ch.cz).toBeLessThanOrEqual(3);
        }
    });

    it('getGroundChunk RPCが正常に応答する', async () => {
        const result = await p1.socket.rpc('getGroundChunk', JSON.stringify({ cx: 0, cz: 0 }));
        expect(result.payload).toBeTruthy();
        const data = JSON.parse(result.payload!) as { cx: number; cz: number; table: number[] };
        expect(data.cx).toBe(0);
        expect(data.cz).toBe(0);
        expect(Array.isArray(data.table)).toBe(true);
        expect(data.table.length).toBe(CHUNK_SIZE * CHUNK_SIZE * 6);
    });

    it('ping RPCが正常に応答する', async () => {
        const t0 = performance.now();
        await p1.socket.rpc('ping');
        const elapsed = performance.now() - t0;
        expect(elapsed).toBeLessThan(5000);
    });
});

describe('Nakama AOI 移動フィルタリングテスト', () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        p1 = await createPlayer('__test_move_p1');
        await sleep(500);
        p2 = await createPlayer('__test_move_p2');
    });

    afterAll(async () => {
        await cleanup(p1);
        await cleanup(p2);
    });

    it('AOI内の移動メッセージを受信する', async () => {
        // p1のAOIをチャンク(0,0)付近に設定（ワールド中心=512, チャンク32付近）
        // p2もp1と同じ範囲
        await sendAOI(p1, 30, 30, 34, 34);
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        // p1の初期位置をp2のAOI内に設定（ワールド座標0,0 → チャンク32,32）
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sleep(200);

        const received: { x: number; z: number }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_MOVE_TARGET) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1がAOI内で移動（ワールド座標0付近→チャンク32）
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 1, z: 1 }));
        await sleep(300);

        expect(received.length).toBeGreaterThanOrEqual(1);
        expect(received[0].x).toBe(1);
        expect(received[0].z).toBe(1);
    });

    it('AOI外の移動メッセージを受信しない', async () => {
        // p2のAOIを遠くに設定（チャンク60付近）
        await sendAOI(p2, 58, 58, 63, 63);
        await sleep(200);

        // p1の位置はチャンク32付近のまま
        const received: unknown[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_MOVE_TARGET || md.op_code === OP_INIT_POS) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1がチャンク32付近で移動 → p2のAOI(58-63)には含まれない
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 2, z: 2 }));
        await sleep(300);

        expect(received.length).toBe(0);
    });

    it('AOI変更時にAOI_ENTERを受信する', async () => {
        // p1はチャンク32付近にいる
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 1.5 }));
        await sleep(200);

        // p2のAOIはチャンク58-63（p1は見えない）
        await sendAOI(p2, 58, 58, 63, 63);
        await sleep(200);

        const enterEvents: { sessionId: string; x: number; z: number }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_AOI_ENTER) {
                enterEvents.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p2のAOIをp1がいるチャンク32を含む範囲に拡大
        await sendAOI(p2, 30, 30, 63, 63);
        await sleep(300);

        expect(enterEvents.length).toBeGreaterThanOrEqual(1);
        // p1のsessionIdが含まれるはず
        const p1Entry = enterEvents.find(e => e.sessionId === p1.sessionId);
        expect(p1Entry).toBeDefined();
        expect(p1Entry!.x).toBe(0);
        expect(p1Entry!.z).toBe(0);
    });

    it('プレイヤーがAOI外へ移動するとAOI_LEAVEを受信する', async () => {
        // p2のAOIをp1のいるチャンク32付近に設定
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const leaveEvents: { sessionId: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_AOI_LEAVE) {
                leaveEvents.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1がAOI外（チャンク0付近）へ移動
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: -500, z: -500 }));
        await sleep(300);

        expect(leaveEvents.length).toBeGreaterThanOrEqual(1);
        expect(leaveEvents[0].sessionId).toBeTruthy();
    });

    it('AOI縮小時にAOI_LEAVEを受信する', async () => {
        // p1をチャンク32付近に戻す
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sleep(200);

        // p2のAOIをp1が見える範囲に拡大
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const leaveEvents: { sessionId: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_AOI_LEAVE) {
                leaveEvents.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p2のAOIをp1がいないチャンク60付近に縮小
        await sendAOI(p2, 58, 58, 63, 63);
        await sleep(300);

        expect(leaveEvents.length).toBeGreaterThanOrEqual(1);
    });
});

describe('Nakama AOI 表示/非表示テスト', () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        p1 = await createPlayer('__test_vis_p1');
        await sleep(500);
        p2 = await createPlayer('__test_vis_p2');
    });

    afterAll(async () => {
        await cleanup(p1);
        await cleanup(p2);
    });

    it('AOI内のプレイヤーにINIT_POSが届く', async () => {
        // 両者のAOIをチャンク32付近に設定
        await sendAOI(p1, 30, 30, 34, 34);
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const received: { x: number; z: number; ry?: number }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_INIT_POS && md.presence?.session_id === p1.sessionId) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 3, z: 4, ry: 1.0 }));
        await sleep(300);

        expect(received.length).toBe(1);
        expect(received[0].x).toBe(3);
        expect(received[0].z).toBe(4);
    });

    it('AOI外のプレイヤーにINIT_POSが届かない', async () => {
        // p2のAOIを遠くに設定
        await sendAOI(p2, 58, 58, 63, 63);
        await sleep(200);

        const received: unknown[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_INIT_POS && md.presence?.session_id === p1.sessionId) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1はチャンク32付近で初期位置送信
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sleep(300);

        expect(received.length).toBe(0);
    });

    it('AOI内のプレイヤーにAVATAR_CHANGEが届く', async () => {
        // p1をチャンク32、p2のAOIも32を含む
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const received: { textureUrl: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === 3 && md.presence?.session_id === p1.sessionId) { // OP_AVATAR_CHANGE=3
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        await p1.socket.sendMatchState(p1.matchId, 3, JSON.stringify({ textureUrl: '/textures/pic2.ktx2' }));
        await sleep(300);

        expect(received.length).toBe(1);
        expect(received[0].textureUrl).toBe('/textures/pic2.ktx2');
    });

    it('AOI外のプレイヤーにAVATAR_CHANGEが届かない', async () => {
        // p2のAOIを遠くに
        await sendAOI(p2, 58, 58, 63, 63);
        await sleep(200);

        const received: unknown[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === 3 && md.presence?.session_id === p1.sessionId) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        await p1.socket.sendMatchState(p1.matchId, 3, JSON.stringify({ textureUrl: '/textures/pic3.ktx2' }));
        await sleep(300);

        expect(received.length).toBe(0);
    });

    it('プレイヤーがAOI内に移動するとAOI_ENTERを受信する', async () => {
        // p1をAOI外へ
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: -500, z: -500, ry: 0 }));
        // p2のAOIをチャンク32付近
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const enterEvents: { sessionId: string; x: number; z: number; textureUrl?: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_AOI_ENTER) {
                enterEvents.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1がチャンク32（AOI内）へ移動
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 0, z: 0 }));
        await sleep(300);

        const p1Enter = enterEvents.find(e => e.sessionId === p1.sessionId);
        expect(p1Enter).toBeDefined();
        expect(p1Enter!.x).toBe(0);
        expect(p1Enter!.z).toBe(0);
    });

    it('AOI_ENTERにtextureUrlが含まれる', async () => {
        // p1にテクスチャ設定してからAOI外へ
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sleep(100);
        await p1.socket.sendMatchState(p1.matchId, 3, JSON.stringify({ textureUrl: '/textures/test.ktx2' }));
        await sleep(100);
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: -500, z: -500 }));
        await sleep(200);

        // p2のAOIはチャンク32
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const enterEvents: { sessionId: string; textureUrl?: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_AOI_ENTER) {
                enterEvents.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1がAOI内へ移動
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 0, z: 0 }));
        await sleep(300);

        const p1Enter = enterEvents.find(e => e.sessionId === p1.sessionId);
        expect(p1Enter).toBeDefined();
        expect(p1Enter!.textureUrl).toBe('/textures/test.ktx2');
    });

    it('AOI_LEAVE後にMOVE_TARGETが届かない', async () => {
        // p1をチャンク32に配置
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const events: { op: number; data: unknown }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_LEAVE) {
                const e = payload as { sessionId: string };
                if (e.sessionId === p1.sessionId) events.push({ op: OP_AOI_LEAVE, data: payload });
            }
            if (md.op_code === OP_MOVE_TARGET && md.presence?.session_id === p1.sessionId) {
                events.push({ op: OP_MOVE_TARGET, data: payload });
            }
        };

        // p1がAOI外へ移動 → LEAVE受信
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: -500, z: -500 }));
        await sleep(300);

        expect(events.some(e => e.op === OP_AOI_LEAVE)).toBe(true);

        // LEAVEの後にp1がAOI外でさらに移動 → MOVE_TARGETは届かない
        events.length = 0;
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: -499, z: -499 }));
        await sleep(300);

        const moveAfterLeave = events.filter(e => e.op === OP_MOVE_TARGET);
        expect(moveAfterLeave.length).toBe(0);
    });

    it('AOI_LEAVE後にAVATAR_CHANGEが届かない', async () => {
        // p1はAOI外(-500,-500)にいる（前のテストから）
        // p2のAOIはチャンク32付近
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(200);

        const received: unknown[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === 3 && md.presence?.session_id === p1.sessionId) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1がAOI外でアバター変更 → 届かない
        await p1.socket.sendMatchState(p1.matchId, 3, JSON.stringify({ textureUrl: '/textures/invisible.ktx2' }));
        await sleep(300);

        expect(received.length).toBe(0);
    });

    it('AOI境界をまたいで往復するとENTER/LEAVEが正しく交互に届く', async () => {
        // p2のAOIをチャンク32のみ（狭い）
        await sendAOI(p2, 32, 32, 32, 32);
        await sleep(200);

        // p1をAOI外に配置
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: -500, z: -500, ry: 0 }));
        await sleep(200);

        const events: { type: 'ENTER' | 'LEAVE'; sessionId: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER && payload.sessionId === p1.sessionId) {
                events.push({ type: 'ENTER', sessionId: payload.sessionId });
            }
            if (md.op_code === OP_AOI_LEAVE && payload.sessionId === p1.sessionId) {
                events.push({ type: 'LEAVE', sessionId: payload.sessionId });
            }
        };

        // 往復1: AOI内へ
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 0, z: 0 }));
        await sleep(300);
        // 往復1: AOI外へ
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: -500, z: -500 }));
        await sleep(300);
        // 往復2: AOI内へ
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 0, z: 0 }));
        await sleep(300);

        // ENTER → LEAVE → ENTER の順序を確認
        expect(events.length).toBeGreaterThanOrEqual(3);
        expect(events[0].type).toBe('ENTER');
        expect(events[1].type).toBe('LEAVE');
        expect(events[2].type).toBe('ENTER');
    });

    it('AOI未登録のプレイヤーにもINIT_POSが届く', async () => {
        // p3を新規作成（AOI未登録状態=MatchJoinのデフォルト全域AOI）
        const p3 = await createPlayer('__test_vis_p3');
        await sleep(200);

        const received: { x: number; z: number }[] = [];
        p3.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_INIT_POS && md.presence?.session_id === p1.sessionId) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // p1が初期位置送信 → AOI未設定のp3にも届くはず
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 5, z: 5, ry: 0 }));
        await sleep(300);

        expect(received.length).toBe(1);
        expect(received[0].x).toBe(5);
        expect(received[0].z).toBe(5);

        cleanup(p3);
    });

    it('双方向: p1のAOI変更でp2のENTER/LEAVEを受信', async () => {
        // p2をチャンク32に配置
        await p2.socket.sendMatchState(p2.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sleep(200);

        // p1のAOIをp2が見えない範囲に
        await sendAOI(p1, 58, 58, 63, 63);
        await sleep(200);

        const events: { type: 'ENTER' | 'LEAVE'; sessionId: string }[] = [];
        p1.socket.onmatchdata = (md: MatchData) => {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER && payload.sessionId === p2.sessionId) {
                events.push({ type: 'ENTER', sessionId: payload.sessionId });
            }
            if (md.op_code === OP_AOI_LEAVE && payload.sessionId === p2.sessionId) {
                events.push({ type: 'LEAVE', sessionId: payload.sessionId });
            }
        };

        // p1のAOIをp2が見える範囲に拡大 → ENTER
        await sendAOI(p1, 30, 30, 34, 34);
        await sleep(300);
        expect(events.length).toBe(1);
        expect(events[0].type).toBe('ENTER');

        // p1のAOIをp2が見えない範囲に縮小 → LEAVE
        await sendAOI(p1, 58, 58, 63, 63);
        await sleep(300);
        expect(events.length).toBe(2);
        expect(events[1].type).toBe('LEAVE');
    });
});

describe('Nakama AOI 連続移動テスト', () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        p1 = await createPlayer('__test_contmove_p1');
        await sleep(500);
        p2 = await createPlayer('__test_contmove_p2');
    });

    afterAll(async () => {
        await cleanup(p1);
        await cleanup(p2);
    });

    it('連続MOVE_TARGETでチャンクをまたぐとAOI_ENTERが届く', async () => {
        // p1をAOI外(チャンク0付近)に配置
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: -500, z: -500, ry: 0 }));
        // p2のAOIをチャンク32付近に設定
        await sendAOI(p2, 31, 31, 33, 33);
        await sleep(200);

        const events: { type: 'ENTER' | 'LEAVE'; sessionId: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER && payload.sessionId === p1.sessionId) {
                events.push({ type: 'ENTER', sessionId: payload.sessionId });
            }
            if (md.op_code === OP_AOI_LEAVE && payload.sessionId === p1.sessionId) {
                events.push({ type: 'LEAVE', sessionId: payload.sessionId });
            }
        };

        // p1がチャンク境界をまたいで少しずつ移動（クリック移動のシミュレーション）
        // チャンク0→16→32 と段階的に移動
        const steps = [-400, -300, -200, -100, 0];
        for (const x of steps) {
            await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x, z: 0 }));
            await sleep(100);
        }
        await sleep(300);

        // p1がチャンク32に到達した時点でENTERが届くはず
        const enters = events.filter(e => e.type === 'ENTER');
        expect(enters.length).toBeGreaterThanOrEqual(1);
    });

    it('連続MOVE_TARGETでAOI外へ出るとAOI_LEAVEが届く', async () => {
        // p1をチャンク32(AOI内)に配置
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        await sendAOI(p2, 31, 31, 33, 33);
        await sleep(200);

        const events: { type: 'ENTER' | 'LEAVE'; sessionId: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER && payload.sessionId === p1.sessionId) {
                events.push({ type: 'ENTER', sessionId: payload.sessionId });
            }
            if (md.op_code === OP_AOI_LEAVE && payload.sessionId === p1.sessionId) {
                events.push({ type: 'LEAVE', sessionId: payload.sessionId });
            }
        };

        // p1がチャンク32からAOI外へ段階的に移動
        const steps = [50, 100, 200, 300, 500];
        for (const x of steps) {
            await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x, z: 0 }));
            await sleep(100);
        }
        await sleep(300);

        // p1がAOI外に出た時点でLEAVEが届くはず
        const leaves = events.filter(e => e.type === 'LEAVE');
        expect(leaves.length).toBeGreaterThanOrEqual(1);
    });

    it('連続移動中にAOI更新してもENTER/LEAVEが正しく届く', async () => {
        // p1をチャンク32に配置
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: 0, z: 0, ry: 0 }));
        // p2のAOIをp1が見えない位置に
        await sendAOI(p2, 58, 58, 63, 63);
        await sleep(200);

        const events: { type: 'ENTER' | 'LEAVE'; sessionId: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER && payload.sessionId === p1.sessionId) {
                events.push({ type: 'ENTER', sessionId: payload.sessionId });
            }
            if (md.op_code === OP_AOI_LEAVE && payload.sessionId === p1.sessionId) {
                events.push({ type: 'LEAVE', sessionId: payload.sessionId });
            }
        };

        // p1が移動しながらp2がAOIを変更（移動中のAOI更新シミュレーション）
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 10, z: 10 }));
        await sleep(50);
        // p2のAOIをp1のいるチャンク32を含むように拡大 → ENTER
        await sendAOI(p2, 30, 30, 34, 34);
        await sleep(300);

        expect(events.filter(e => e.type === 'ENTER').length).toBeGreaterThanOrEqual(1);

        // p1が移動しながらp2がAOIを縮小 → LEAVE
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 5, z: 5 }));
        await sleep(50);
        await sendAOI(p2, 58, 58, 63, 63);
        await sleep(300);

        expect(events.filter(e => e.type === 'LEAVE').length).toBeGreaterThanOrEqual(1);
    });

    it('毎チャンクAOI更新を送るとENTER/LEAVEの漏れがない', async () => {
        // BUG再現: クリック移動中にAOI更新が送られない問題
        // 正しい動作: 各チャンク通過時にAOI更新+MOVE_TARGETが送られる

        // p2のAOIをチャンク32のみ（狭い）
        await sendAOI(p2, 32, 32, 32, 32);
        await sleep(200);

        // p1をチャンク30に配置（AOI外）
        await p1.socket.sendMatchState(p1.matchId, OP_INIT_POS, JSON.stringify({ x: -32, z: 0, ry: 0 }));
        await sleep(200);

        const events: { type: 'ENTER' | 'LEAVE'; sessionId: string }[] = [];
        p2.socket.onmatchdata = (md: MatchData) => {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER && payload.sessionId === p1.sessionId) {
                events.push({ type: 'ENTER', sessionId: payload.sessionId });
            }
            if (md.op_code === OP_AOI_LEAVE && payload.sessionId === p1.sessionId) {
                events.push({ type: 'LEAVE', sessionId: payload.sessionId });
            }
        };

        // p1がチャンク30→31→32→33→34 と1チャンクずつ移動
        // 各ステップでMOVE_TARGET + AOI更新を送信（修正後のクライアント動作を再現）
        const positions = [-16, 0, 16, 32]; // チャンク31, 32, 33, 34の中心付近
        for (const x of positions) {
            await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x, z: 0 }));
            // クライアントが各移動時にAOI更新を送る（修正後の動作）
            const half = 512;
            const cx = Math.floor((x + half) / 16);
            const cz = Math.floor((0 + half) / 16);
            const r = 3; // AOI半径3チャンク
            await sendAOI(p1, Math.max(0, cx - r), Math.max(0, cz - r), Math.min(63, cx + r), Math.min(63, cz + r));
            await sleep(100);
        }
        await sleep(300);

        // p1がチャンク32を通過したのでENTERが届くはず
        const enters = events.filter(e => e.type === 'ENTER');
        expect(enters.length).toBeGreaterThanOrEqual(1);

        // p1がチャンク32を通り過ぎたのでLEAVEも届くはず
        const leaves = events.filter(e => e.type === 'LEAVE');
        expect(leaves.length).toBeGreaterThanOrEqual(1);

        // ENTERが先、LEAVEが後
        const firstEnterIdx = events.findIndex(e => e.type === 'ENTER');
        const firstLeaveIdx = events.findIndex(e => e.type === 'LEAVE');
        expect(firstEnterIdx).toBeLessThan(firstLeaveIdx);
    });
});

describe('Nakama AOI 境界値テスト', () => {
    let p1: PlayerConn;

    beforeAll(async () => {
        p1 = await createPlayer('__test_aoi_edge');
    });

    afterAll(async () => {
        await cleanup(p1);
    });

    it('最小AOI (1チャンク) を送信できる', async () => {
        await sendAOI(p1, 32, 32, 32, 32);
        await sleep(200);
    });

    it('全範囲AOIを送信できる', async () => {
        await sendAOI(p1, 0, 0, 63, 63);
        await sleep(200);
    });

    it('範囲外の値はサーバでクランプされる', async () => {
        // 負の値や大きすぎる値を送ってもエラーにならない
        await sendAOI(p1, -5, -5, 70, 70);
        await sleep(200);

        // クランプ後のAOIで全範囲のブロック更新を受信できることを確認
        const received: unknown[] = [];
        p1.socket.onmatchdata = (md: MatchData) => {
            if (md.op_code === OP_BLOCK_UPDATE) {
                received.push(JSON.parse(new TextDecoder().decode(md.data)));
            }
        };

        // 端のチャンク(63,63)内のブロック
        const gx = 63 * CHUNK_SIZE + 1; // = 1009
        const gz = 63 * CHUNK_SIZE + 1;
        await p1.socket.rpc('setBlock', JSON.stringify({ gx, gz, blockId: 1, r: 128, g: 128, b: 128, a: 255 }));
        await sleep(500);

        expect(received.length).toBeGreaterThanOrEqual(1);

        // 後片付け
        await p1.socket.rpc('setBlock', JSON.stringify({ gx, gz, blockId: 0, r: 0, g: 0, b: 0, a: 0 }));
    });
});

// ファイルレベルのクリーンアップ: 全 describe 完了後にユーザー削除
afterAll(async () => {
    await deleteCreatedUsers();
}, 60_000);
