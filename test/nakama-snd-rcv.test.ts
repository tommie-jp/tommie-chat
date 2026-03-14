/**
 * snd/rcv 整合性テスト
 *
 * ブラウザのログイン→参加→AOI通知フローを nakama-js で再現し、
 * snd/rcv の対応が正しいかを検証する。
 *
 * 前提: nakama サーバが 127.0.0.1:7350 で起動していること
 *   cd nakama && docker compose up -d
 *
 * 実行: npx vitest run test/nakama-snd-rcv.test.ts
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket, MatchData } from '@heroiclabs/nakama-js';

const HOST        = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT        = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY  = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';
const TEXTURE_URL = '/textures/pic1.ktx2';
const CHAT_ROOM   = 'world';

const OP_INIT_POS     = 1;
const OP_MOVE_TARGET  = 2;
const OP_AVATAR_CHANGE = 3;
const OP_BLOCK_UPDATE = 4;
const OP_AOI_UPDATE   = 5;
const OP_AOI_ENTER    = 6;
const OP_AOI_LEAVE    = 7;

const CHUNK_SIZE  = 16;
const CHUNK_COUNT = 64;
const WORLD_SIZE  = 1024;
const AOI_RADIUS  = 48;

// ── タイムスタンプ付きログ（ブラウザ console.log に相当） ──

const clientLogs: { player: string; line: string }[] = [];

// 大人数テスト(100人超)ではAOI_ENTERログ・イベント蓄積を抑制しメモリ節約
let _lightMode = false;

function ts(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${Math.floor(d.getMilliseconds() / 100)}`;
}

function clog(player: string, msg: string): void {
    const line = `${ts()} ${msg}`;
    clientLogs.push({ player, line });
    console.log(`[${player}] ${line}`);
}

// ── AOI計算（AOIManager.updateAOI と同一ロジック） ──

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

interface PlayerConn {
    name: string;
    client: Client;
    session: Session;
    socket: Socket;
    matchId: string;
    sessionId: string;
    receivedEvents: { op: number; payload: unknown; senderSid: string | null }[];
}

async function loginAndJoin(name: string, x = 0, z = 0): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    // 既存ユーザとの衝突を避けるためテスト専用ID/usernameを使用
    const suffix = Date.now();
    const testId  = `sndrcv_${name}_${suffix}`;
    const testUname = `${name}_${suffix}`;

    // ── login ──
    clog(name, `snd Login username: ${name}`);
    const session = await client.authenticateCustom(testId, true, testUname);
    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);
    await socket.joinChat(CHAT_ROOM, 1, true, false);

    // ── getWorldMatch ──
    clog(name, 'snd getWorldMatch');
    const wmResult = await socket.rpc('getWorldMatch');
    const wmData = JSON.parse(wmResult.payload ?? '{}') as { matchId?: string };
    if (!wmData.matchId) throw new Error(`getWorldMatch failed for ${name}`);

    const receivedEvents: PlayerConn['receivedEvents'] = [];

    // joinMatch より前に登録（MatchJoin直後のサーバー通知を取りこぼさないため）
    socket.onmatchdata = (md: MatchData) => {
        const senderSid = md.presence?.session_id ?? null;
        if (_lightMode) {
            // 大人数モード: AOI_ENTER は蓄積・ログともにスキップ（メモリ節約）
            if (md.op_code === OP_AOI_ENTER) return;
            const shortSnd = senderSid ? senderSid.slice(0, 8) : '(srv)';
            clog(name, `rcv matchdata op=${md.op_code} sid=${shortSnd}`);
            try {
                const payload = JSON.parse(new TextDecoder().decode(md.data));
                receivedEvents.push({ op: md.op_code, payload, senderSid });
            } catch { /* ignore */ }
            return;
        }
        const shortSnd = senderSid ? senderSid.slice(0, 8) : '(srv)';
        clog(name, `rcv matchdata op=${md.op_code} sid=${shortSnd}`);
        try {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER) {
                // バルク対応: サーバーは配列で送信、後方互換のため単一オブジェクトも受け付ける
                type AoiEnterEntry = { sessionId: string; x: number; z: number; ry?: number; textureUrl?: string; displayName?: string };
                const entries: AoiEnterEntry[] = Array.isArray(payload) ? payload : [payload];
                for (const e of entries) {
                    receivedEvents.push({ op: OP_AOI_ENTER, payload: e, senderSid });
                    clog(name, `rcv AOI_ENTER sid=${e.sessionId.slice(0,8)} x=${e.x.toFixed(1)} z=${e.z.toFixed(1)} dname=${e.displayName ?? ''}`);
                }
            } else {
                receivedEvents.push({ op: md.op_code, payload, senderSid });
            }
        } catch { /* ignore */ }
    };

    const match = await socket.joinMatch(wmData.matchId);
    const selfSid = match.self?.session_id ?? '';

    const conn: PlayerConn = { name, client, session, socket, matchId: wmData.matchId, sessionId: selfSid, receivedEvents };

    // ── initPos ──
    const ry = 0;
    clog(name, `snd initPos x=${x.toFixed(1)} z=${z.toFixed(1)} ry=${ry.toFixed(1)} tx=${TEXTURE_URL}`);
    await socket.sendMatchState(wmData.matchId, OP_INIT_POS, JSON.stringify({
        x, z, ry, lt: new Date().toISOString(), dn: name, tx: TEXTURE_URL,
    }));

    // ── AOI_UPDATE ──
    const aoi = calcAOI(x, z);
    clog(name, `snd AOI_UPDATE (${aoi.minCX},${aoi.minCZ})-(${aoi.maxCX},${aoi.maxCZ})`);
    await socket.sendMatchState(wmData.matchId, OP_AOI_UPDATE, JSON.stringify(aoi));

    // ── syncChunks ──
    clog(name, `snd syncChunks (${aoi.minCX},${aoi.minCZ})-(${aoi.maxCX},${aoi.maxCZ})`);
    await socket.rpc('syncChunks', JSON.stringify({
        minCX: aoi.minCX, minCZ: aoi.minCZ, maxCX: aoi.maxCX, maxCZ: aoi.maxCZ, hashes: {},
    })).catch(() => {});

    // ── getServerInfo ──
    clog(name, 'snd getServerInfo');
    await socket.rpc('getServerInfo').catch(() => {});

    return conn;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function waitForEvent(conn: PlayerConn, op: number, timeoutMs = 3000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = setInterval(() => {
            const ev = conn.receivedEvents.find(e => e.op === op);
            if (ev) { clearInterval(check); resolve(ev.payload); return; }
            if (Date.now() > deadline) { clearInterval(check); reject(new Error(`timeout waiting for op=${op}`)); }
        }, 50);
    });
}

// ── テスト ──

// ── 1人ログインテスト ──
describe('1人ログインテスト', { timeout: 30_000 }, () => {
    let p1: PlayerConn;

    beforeAll(async () => {
        p1 = await loginAndJoin('solo1', 0, 0);
        await sleep(500);
    });

    afterAll(async () => {
        clog('solo1', 'snd logout');
        try { p1?.socket.disconnect(true); } catch { /* */ }
        console.log('\n========== solo1 client log ==========');
        clientLogs.filter(l => l.player === 'solo1').forEach(l => console.log(l.line));
    });

    it('ログイン・マッチ参加・sessionId 取得が成功する', () => {
        expect(p1.sessionId, 'sessionId が存在する').toBeTruthy();
        expect(p1.matchId,   'matchId が存在する').toBeTruthy();
    });

    it('initPos・AOI_UPDATE・syncChunks・getServerInfo が送信できる', () => {
        const logs = clientLogs.filter(l => l.player === 'solo1').map(l => l.line);
        expect(logs.some(l => l.includes('snd initPos')),      'snd initPos ログあり').toBe(true);
        expect(logs.some(l => l.includes('snd AOI_UPDATE')),   'snd AOI_UPDATE ログあり').toBe(true);
        expect(logs.some(l => l.includes('snd syncChunks')),   'snd syncChunks ログあり').toBe(true);
        expect(logs.some(l => l.includes('snd getServerInfo')),'snd getServerInfo ログあり').toBe(true);
    });
});

// ── 2人ログインテスト ──
describe('2人ログインテスト', { timeout: 30_000 }, () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        // tommie1 ログイン（位置 x=0, z=0）
        p1 = await loginAndJoin('tommie1', 0, 0);
        await sleep(200);
        // tommie2 ログイン（位置 x=5, z=1）
        p2 = await loginAndJoin('tommie2', 5, 1);
        // イベント到着を待つ
        await sleep(1000);
    });

    afterAll(async () => {
        clog('tommie1', 'snd logout');
        try { p1?.socket.disconnect(true); } catch { /* */ }
        clog('tommie2', 'snd logout');
        try { p2?.socket.disconnect(true); } catch { /* */ }

        // ── ログ出力 ──
        console.log('\n========== tommie1 client log ==========');
        clientLogs.filter(l => l.player === 'tommie1').forEach(l => console.log(l.line));
        console.log('\n========== tommie2 client log ==========');
        clientLogs.filter(l => l.player === 'tommie2').forEach(l => console.log(l.line));
    });

    it('tommie1 が AOI_UPDATE を送信後に tommie2 の参加で AOI_ENTER を受信する', async () => {
        const ev = p1.receivedEvents.find(e => e.op === OP_AOI_ENTER);
        expect(ev, 'tommie1 should receive AOI_ENTER about tommie2').toBeTruthy();
        const payload = ev!.payload as { sessionId: string };
        expect(payload.sessionId).toBe(p2.sessionId);
    });

    it('tommie2 が AOI_UPDATE を送信後に tommie1 の存在を示す AOI_ENTER を受信する', async () => {
        const ev = p2.receivedEvents.find(e => e.op === OP_AOI_ENTER);
        expect(ev, 'tommie2 should receive AOI_ENTER about tommie1').toBeTruthy();
        const payload = ev!.payload as { sessionId: string };
        expect(payload.sessionId).toBe(p1.sessionId);
    });

    it('双方が互いの sessionId を持つ AOI_ENTER を受信している', () => {
        const p1Got = p1.receivedEvents.filter(e => e.op === OP_AOI_ENTER);
        const p2Got = p2.receivedEvents.filter(e => e.op === OP_AOI_ENTER);
        const p1GotP2 = p1Got.some(e => (e.payload as { sessionId: string }).sessionId === p2.sessionId);
        const p2GotP1 = p2Got.some(e => (e.payload as { sessionId: string }).sessionId === p1.sessionId);
        expect(p1GotP2, 'p1 got AOI_ENTER about p2').toBe(true);
        expect(p2GotP1, 'p2 got AOI_ENTER about p1').toBe(true);
    });
});

// ── setBlock テスト ──
describe('setBlock テスト', { timeout: 30_000 }, () => {
    let p1: PlayerConn;

    beforeAll(async () => {
        // x=0,z=0 → chunk(32,32) が AOI に含まれる
        p1 = await loginAndJoin('block1', 0, 0);
        await sleep(500);
    });

    afterAll(async () => {
        clog('block1', 'snd logout');
        try { p1?.socket.disconnect(true); } catch { /* */ }
        console.log('\n========== block1 client log ==========');
        clientLogs.filter(l => l.player === 'block1').forEach(l => console.log(l.line));
    });

    it('getGroundChunk が成功する', async () => {
        clog('block1', 'snd getGroundChunk cx=32 cz=32');
        const result = await p1.socket.rpc('getGroundChunk', JSON.stringify({ cx: 32, cz: 32 }));
        expect(result.payload, 'getGroundChunk payload exists').toBeTruthy();
        const data = JSON.parse(result.payload ?? '{}') as { cx?: number };
        expect(data.cx, 'cx=32').toBe(32);
    });

    it('setBlock 後に op=4 ブロードキャストを受信する', async () => {
        // gx=512,gz=512 → chunk(32,32) → p1 の AOI 内
        clog('block1', 'snd setBlock gx=512 gz=512 blockId=1 rgba=(255,0,0,255)');
        await p1.socket.sendMatchState(p1.matchId, OP_BLOCK_UPDATE, JSON.stringify({
            gx: 512, gz: 512, blockId: 1, r: 255, g: 0, b: 0, a: 255,
        }));
        const ev = await waitForEvent(p1, OP_BLOCK_UPDATE, 5000);
        expect(ev, 'setBlock broadcast (op=4) received').toBeTruthy();
    });
});

// ── AOI_LEAVE テスト ──
describe('AOI_LEAVE テスト', { timeout: 30_000 }, () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        p1 = await loginAndJoin('leave1', 0, 0);
        await sleep(200);
        p2 = await loginAndJoin('leave2', 5, 1);
        // AOI_ENTER 到着を待つ
        await sleep(1000);
    });

    afterAll(async () => {
        clog('leave1', 'snd logout');
        try { p1?.socket.disconnect(true); } catch { /* */ }
        console.log('\n========== leave1 client log ==========');
        clientLogs.filter(l => l.player === 'leave1').forEach(l => console.log(l.line));
        console.log('\n========== leave2 client log ==========');
        clientLogs.filter(l => l.player === 'leave2').forEach(l => console.log(l.line));
    });

    it('leave2 切断後に leave1 が AOI_LEAVE (op=7) を受信する', async () => {
        clog('leave2', 'snd logout');
        try { p2?.socket.disconnect(true); } catch { /* */ }
        const ev = await waitForEvent(p1, OP_AOI_LEAVE, 5000);
        expect(ev, 'leave1 should receive AOI_LEAVE from leave2').toBeTruthy();
        const payload = ev as { sessionId: string };
        expect(payload.sessionId, 'AOI_LEAVE sessionId matches leave2').toBe(p2.sessionId);
    });
});

// ── opMoveTarget テスト ──
describe('opMoveTarget テスト', { timeout: 30_000 }, () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        p1 = await loginAndJoin('move1', 0, 0);
        await sleep(200);
        p2 = await loginAndJoin('move2', 5, 1);
        await sleep(500);
    });

    afterAll(async () => {
        clog('move1', 'snd logout');
        try { p1?.socket.disconnect(true); } catch { /* */ }
        clog('move2', 'snd logout');
        try { p2?.socket.disconnect(true); } catch { /* */ }
        console.log('\n========== move1 client log ==========');
        clientLogs.filter(l => l.player === 'move1').forEach(l => console.log(l.line));
        console.log('\n========== move2 client log ==========');
        clientLogs.filter(l => l.player === 'move2').forEach(l => console.log(l.line));
    });

    it('move1 が moveTarget を送信すると move2 が op=2 を受信する', async () => {
        clog('move1', 'snd moveTarget x=20.0 z=10.0');
        await p1.socket.sendMatchState(p1.matchId, OP_MOVE_TARGET, JSON.stringify({ x: 20, z: 10 }));
        const ev = await waitForEvent(p2, OP_MOVE_TARGET, 3000);
        expect(ev, 'move2 should receive moveTarget (op=2)').toBeTruthy();
    });
});

// ── opAvatarChange テスト ──
describe('opAvatarChange テスト', { timeout: 30_000 }, () => {
    let p1: PlayerConn;
    let p2: PlayerConn;

    beforeAll(async () => {
        p1 = await loginAndJoin('avatar1', 0, 0);
        await sleep(200);
        p2 = await loginAndJoin('avatar2', 5, 1);
        await sleep(500);
    });

    afterAll(async () => {
        clog('avatar1', 'snd logout');
        try { p1?.socket.disconnect(true); } catch { /* */ }
        clog('avatar2', 'snd logout');
        try { p2?.socket.disconnect(true); } catch { /* */ }
        console.log('\n========== avatar1 client log ==========');
        clientLogs.filter(l => l.player === 'avatar1').forEach(l => console.log(l.line));
        console.log('\n========== avatar2 client log ==========');
        clientLogs.filter(l => l.player === 'avatar2').forEach(l => console.log(l.line));
    });

    it('avatar1 が avatarChange を送信すると avatar2 が op=3 を受信する', async () => {
        clog('avatar1', 'snd avatarChange textureUrl=/textures/pic2.ktx2');
        await p1.socket.sendMatchState(p1.matchId, OP_AVATAR_CHANGE, JSON.stringify({ textureUrl: '/textures/pic2.ktx2' }));
        const ev = await waitForEvent(p2, OP_AVATAR_CHANGE, 3000);
        expect(ev, 'avatar2 should receive avatarChange (op=3)').toBeTruthy();
    });
});

// ── N人ログインテスト（汎用） ──

const _loginRatePerSec = parseInt(process.env['LOGIN_RATE_PER_SEC'] ?? '0', 10);

async function loginNPlayers(label: string, count: number): Promise<PlayerConn[]> {
    // 100人超: AOI_ENTERイベント蓄積を無効化（メモリ節約）
    if (count > 100) _lightMode = true;
    if (count <= 10) {
        const players: PlayerConn[] = [];
        for (let i = 0; i < count; i++) {
            players.push(await loginAndJoin(`${label}${i + 1}`, 0, 0));
            if (i < count - 1) await sleep(50);
        }
        return players;
    }
    // 大人数: レート制限あり → N件/秒バッチ、なし → 全並列
    const batchSize = _loginRatePerSec > 0 ? _loginRatePerSec : count;
    const players: PlayerConn[] = [];
    let rateLimited = 0;
    let otherErrors = 0;
    for (let i = 0; i < count; i += batchSize) {
        const batch = Array.from(
            { length: Math.min(batchSize, count - i) },
            (_, j) => loginAndJoin(`${label}${i + j + 1}`, 0, 0)
        );
        const results = await Promise.allSettled(batch);
        for (const r of results) {
            if (r.status === 'fulfilled') {
                players.push(r.value);
            } else {
                const err = r.reason;
                const msg = err instanceof Error ? err.message : JSON.stringify(err);
                if (msg.includes('too many logins')) {
                    rateLimited++;
                    console.error(`⚠️ RATE LIMITED: ${msg}`);
                } else {
                    otherErrors++;
                    console.error(`❌ LOGIN ERROR: ${msg}`);
                }
            }
        }
        if (i + batchSize < count) await sleep(1000);
    }
    if (rateLimited > 0) {
        console.error(`\n⚠️ レート制限で ${rateLimited}人が拒否されました (サーバ MAX_LOGIN_RATE_PER_SEC=${_loginRatePerSec || '?'}, クライアント batch=${batchSize}人/秒)`);
    }
    if (otherErrors > 0) {
        console.error(`\n❌ その他のログインエラー: ${otherErrors}件`);
    }
    return players;
}

function makeNPlayerLoginTest(count: number): void {
    const label = `multi${count}_`;
    const _envTimeout = parseInt(process.env['TEST_TIMEOUT_MS'] ?? '0', 10);
    const timeoutMs = _envTimeout > 0 ? _envTimeout : count <= 10 ? 90_000 : count <= 100 ? 360_000 : 1_080_000;

    describe(`${count}人ログインテスト`, { timeout: timeoutMs }, () => {
        let players: PlayerConn[] = [];

        beforeAll(async () => {
            players = await loginNPlayers(label, count);
            await sleep(count <= 10 ? 500 : 5000);
        }, timeoutMs);

        afterAll(async () => {
            for (const p of players) {
                clog(p.name, 'snd logout');
                try { p.socket.disconnect(true); } catch { /* */ }
            }
            const loginCount = clientLogs.filter(l => l.player.startsWith(label) && l.line.includes('snd Login')).length;
            console.log(`\n========== ${count}人 client summary: logins=${loginCount} ==========`);
        });

        it(`${count}人全員がログインできる`, () => {
            const missing = count - players.length;
            expect(players.length, `${count}人中${players.length}人のみログイン成功 (${missing}人失敗 — レート制限の可能性あり。-r を下げるか MAX_LOGIN_RATE_PER_SEC を上げてください)`).toBe(count);
            for (const p of players) {
                expect(p.sessionId, `${p.name} sessionId が存在する`).toBeTruthy();
            }
        });

        if (count <= 100) {
            it(`${count}人が互いに AOI_ENTER を受信する`, async () => {
                await sleep(500);
                for (const p of players) {
                    const enters = p.receivedEvents.filter(e => e.op === OP_AOI_ENTER);
                    expect(enters.length, `${p.name} AOI_ENTER >= ${count - 1}`).toBeGreaterThanOrEqual(count - 1);
                }
            });
        }
    });
}

makeNPlayerLoginTest(3);
makeNPlayerLoginTest(10);
makeNPlayerLoginTest(100);
makeNPlayerLoginTest(1000);
makeNPlayerLoginTest(2000);

// 環境変数 MULTI_N_COUNT で任意人数テストを追加（-n N オプション用）
const _customN = parseInt(process.env['MULTI_N_COUNT'] ?? '0', 10);
if (_customN > 0 && ![3, 10, 100, 1000, 2000].includes(_customN)) {
    makeNPlayerLoginTest(_customN);
}
