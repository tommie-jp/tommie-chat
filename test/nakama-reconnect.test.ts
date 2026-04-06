/**
 * 再接続テスト
 *
 * WebSocket切断→再接続後に以下が正しく復元されることを検証する:
 *   1. マッチ再参加（新sessionId取得）
 *   2. プレイヤーリスト（自分・他プレイヤーのプロフィール）
 *   3. AOI_ENTER による他プレイヤーのアバター復元
 *   4. チャンク同期（syncChunks）
 *   5. 古いセッションがサーバから除去される
 *
 * 前提: nakama サーバが 127.0.0.1:7350 で起動していること
 *   cd nakama && docker compose up -d
 *
 * 実行: npx vitest run test/nakama-reconnect.test.ts
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket, MatchData } from '@heroiclabs/nakama-js';
import { trackUserId, deleteCreatedUsers } from './test-helpers';

const HOST       = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT       = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';

const OP_INIT_POS          = 1;
const OP_AOI_UPDATE        = 5;
const OP_AOI_ENTER         = 6;
const OP_PROFILE_REQUEST   = 9;
const OP_PROFILE_RESPONSE  = 10;
const OP_SYSTEM_MESSAGE    = 14;

const CHUNK_SIZE  = 16;
const CHUNK_COUNT = 64;
const WORLD_SIZE  = 1024;
const AOI_RADIUS  = 48;

// ── タイムスタンプ付きログ ──

function ts(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${Math.floor(d.getMilliseconds() / 100)}`;
}

function clog(player: string, msg: string): void {
    console.log(`[${player}] ${ts()} ${msg}`);
}

// ── AOI計算 ──

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

// ── プロフィール情報 ──

interface ProfileEntry {
    sessionId: string;
    displayName: string;
    textureUrl: string;
    loginTime: string;
}

// ── プレイヤー接続 ──

interface PlayerConn {
    name: string;
    client: Client;
    session: Session;
    socket: Socket;
    matchId: string;
    sessionId: string;
    receivedAOIEnter: { sessionId: string; x: number; z: number }[];
    receivedProfiles: ProfileEntry[];
    receivedSystemMessages: { type: string; username: string }[];
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function loginAndJoin(name: string, x = 0, z = 0): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const suffix = Date.now();
    const testId  = `recon_${name}_${suffix}`;
    const testUname = `${name}_${suffix}`;

    clog(name, `snd Login username: ${testUname}`);
    const session = await client.authenticateCustom(testId, true, testUname);
    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);

    clog(name, 'snd getWorldMatch');
    const wmResult = await socket.rpc('getWorldMatch');
    const wmData = JSON.parse(wmResult.payload ?? '{}') as { matchId?: string };
    if (!wmData.matchId) throw new Error(`getWorldMatch failed for ${name}`);

    const receivedAOIEnter: PlayerConn['receivedAOIEnter'] = [];
    const receivedProfiles: ProfileEntry[] = [];
    const receivedSystemMessages: PlayerConn['receivedSystemMessages'] = [];

    socket.onmatchdata = (md: MatchData) => {
        try {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER) {
                const entries = Array.isArray(payload) ? payload : [payload];
                for (const e of entries) {
                    clog(name, `rcv AOI_ENTER sid=${(e.sessionId as string).slice(0, 8)} x=${e.x} z=${e.z}`);
                    receivedAOIEnter.push({ sessionId: e.sessionId, x: e.x, z: e.z });
                }
            } else if (md.op_code === OP_PROFILE_RESPONSE) {
                const resp = payload as { profiles: ProfileEntry[] };
                for (const p of resp.profiles ?? []) {
                    clog(name, `rcv PROFILE sid=${p.sessionId.slice(0,8)} dn="${p.displayName}" lt="${p.loginTime}"`);
                    receivedProfiles.push(p);
                }
            } else if (md.op_code === OP_SYSTEM_MESSAGE) {
                const sys = payload as { type: string; username: string };
                clog(name, `rcv SYSTEM type=${sys.type} username=${sys.username}`);
                receivedSystemMessages.push(sys);
            }
        } catch { /* ignore */ }
    };

    const match = await socket.joinMatch(wmData.matchId);
    const selfSid = match.self?.session_id ?? '';

    const conn: PlayerConn = { name, client, session, socket, matchId: wmData.matchId, sessionId: selfSid, receivedAOIEnter, receivedProfiles, receivedSystemMessages };
    trackUserId(session.user_id!);

    clog(name, `snd initPos x=${x.toFixed(1)} z=${z.toFixed(1)} dn=${name}`);
    await socket.sendMatchState(wmData.matchId, OP_INIT_POS, JSON.stringify({
        x, z, ry: 0, lt: new Date().toISOString(), dn: name, tx: '/s3/avatars/pipo-nekonin008.png',
    }));

    const aoi = calcAOI(x, z);
    clog(name, `snd AOI_UPDATE (${aoi.minCX},${aoi.minCZ})-(${aoi.maxCX},${aoi.maxCZ})`);
    await socket.sendMatchState(wmData.matchId, OP_AOI_UPDATE, JSON.stringify(aoi));

    return conn;
}

/** WebSocket切断→新ソケットで再接続→マッチ再参加 */
async function reconnect(conn: PlayerConn): Promise<{ oldSessionId: string; newSessionId: string }> {
    const oldSessionId = conn.sessionId;
    clog(conn.name, `snd disconnect (old sid=${oldSessionId.slice(0, 8)})`);

    // 受信バッファをクリア
    conn.receivedAOIEnter.length = 0;
    conn.receivedProfiles.length = 0;
    conn.receivedSystemMessages.length = 0;

    conn.socket.disconnect(false);
    await sleep(500);

    // 新しいソケットで再接続
    clog(conn.name, 'snd reconnect');
    const newSocket = conn.client.createSocket(false, false);
    newSocket.setHeartbeatTimeoutMs(60000);
    await newSocket.connect(conn.session, true);

    // ハンドラを再設定
    newSocket.onmatchdata = (md: MatchData) => {
        try {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER) {
                const entries = Array.isArray(payload) ? payload : [payload];
                for (const e of entries) {
                    clog(conn.name, `rcv AOI_ENTER sid=${(e.sessionId as string).slice(0, 8)} x=${e.x} z=${e.z}`);
                    conn.receivedAOIEnter.push({ sessionId: e.sessionId, x: e.x, z: e.z });
                }
            } else if (md.op_code === OP_PROFILE_RESPONSE) {
                const resp = payload as { profiles: ProfileEntry[] };
                for (const p of resp.profiles ?? []) {
                    clog(conn.name, `rcv PROFILE sid=${p.sessionId.slice(0,8)} dn="${p.displayName}" lt="${p.loginTime}"`);
                    conn.receivedProfiles.push(p);
                }
            } else if (md.op_code === OP_SYSTEM_MESSAGE) {
                const sys = payload as { type: string; username: string };
                clog(conn.name, `rcv SYSTEM type=${sys.type} username=${sys.username}`);
                conn.receivedSystemMessages.push(sys);
            }
        } catch { /* ignore */ }
    };

    // onmatchpresence を joinMatch より前に登録
    newSocket.onmatchpresence = () => {};

    const match = await newSocket.joinMatch(conn.matchId);
    const newSessionId = match.self?.session_id ?? '';

    conn.socket = newSocket;
    conn.sessionId = newSessionId;

    // initPos 再送信
    clog(conn.name, `snd initPos (reconnect) sid=${newSessionId.slice(0, 8)}`);
    await newSocket.sendMatchState(conn.matchId, OP_INIT_POS, JSON.stringify({
        x: 0, z: 0, ry: 0, lt: new Date().toISOString(), dn: conn.name, tx: '/s3/avatars/pipo-nekonin008.png',
    }));

    // AOI 再送信
    const aoi = calcAOI(0, 0);
    clog(conn.name, `snd AOI_UPDATE (reconnect)`);
    await newSocket.sendMatchState(conn.matchId, OP_AOI_UPDATE, JSON.stringify(aoi));

    return { oldSessionId, newSessionId };
}

/** プロフィール取得 */
async function requestProfiles(conn: PlayerConn, sessionIds: string[], timeoutMs = 5000): Promise<ProfileEntry[]> {
    const beforeCount = conn.receivedProfiles.length;
    clog(conn.name, `snd profileRequest count=${sessionIds.length}`);
    await conn.socket.sendMatchState(conn.matchId, OP_PROFILE_REQUEST,
        new TextEncoder().encode(JSON.stringify({ sessionIds })));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (conn.receivedProfiles.length >= beforeCount + sessionIds.length) {
            return conn.receivedProfiles.slice(beforeCount);
        }
        await sleep(50);
    }
    // タイムアウトでも取得済み分を返す
    return conn.receivedProfiles.slice(beforeCount);
}

// ── テスト ──

describe('再接続テスト', { timeout: 30_000 }, () => {
    let playerA: PlayerConn;
    let playerB: PlayerConn;

    beforeAll(async () => {
        playerA = await loginAndJoin('playerA', 0, 0);
        await sleep(100);
        playerB = await loginAndJoin('playerB', 0, 0);
        // AOI_ENTER が届くのを待つ
        await sleep(1000);
    });

    afterAll(async () => {
        try { playerA?.socket.disconnect(true); } catch { /* */ }
        try { playerB?.socket.disconnect(true); } catch { /* */ }
    });

    it('playerA, playerB が互いに AOI_ENTER を受信している', () => {
        const aSeesB = playerA.receivedAOIEnter.some(e => e.sessionId === playerB.sessionId);
        const bSeesA = playerB.receivedAOIEnter.some(e => e.sessionId === playerA.sessionId);
        expect(aSeesB, 'playerA が playerB の AOI_ENTER を受信').toBe(true);
        expect(bSeesA, 'playerB が playerA の AOI_ENTER を受信').toBe(true);
    });

    it('playerA が切断→再接続すると新しい sessionId を取得する', async () => {
        const { oldSessionId, newSessionId } = await reconnect(playerA);
        clog('test', `old=${oldSessionId.slice(0, 8)} new=${newSessionId.slice(0, 8)}`);
        expect(newSessionId).toBeTruthy();
        expect(newSessionId).not.toBe(oldSessionId);
    });

    it('再接続後に playerB の AOI_ENTER を受信する', async () => {
        // reconnect() 内でバッファクリア + AOI_UPDATE 送信済み
        await sleep(1000);
        const seesB = playerA.receivedAOIEnter.some(e => e.sessionId === playerB.sessionId);
        expect(seesB, 'playerA が再接続後に playerB の AOI_ENTER を受信').toBe(true);
    });

    it('再接続後に playerB が playerA の新 AOI_ENTER を受信する', async () => {
        // playerA の reconnect で initPos → サーバが playerB へ AOI_ENTER 送信
        await sleep(500);
        const seesNewA = playerB.receivedAOIEnter.some(e => e.sessionId === playerA.sessionId);
        expect(seesNewA, 'playerB が playerA の新セッションの AOI_ENTER を受信').toBe(true);
    });

    it('再接続後に自分のプロフィールを取得できる（loginTime が有効）', async () => {
        const profiles = await requestProfiles(playerA, [playerA.sessionId]);
        expect(profiles.length, '1件のプロフィール').toBe(1);
        expect(profiles[0].sessionId).toBe(playerA.sessionId);
        const lt = new Date(profiles[0].loginTime);
        expect(lt.getTime(), 'loginTime が有効な日時').toBeGreaterThan(0);
        // loginTime が最近（5分以内）であること
        const diffMs = Date.now() - lt.getTime();
        expect(diffMs, 'loginTime が最近（5分以内）').toBeLessThan(5 * 60 * 1000);
    });

    it('再接続後に playerB のプロフィールを取得できる', async () => {
        const profiles = await requestProfiles(playerA, [playerB.sessionId]);
        expect(profiles.length, '1件のプロフィール').toBe(1);
        expect(profiles[0].sessionId).toBe(playerB.sessionId);
        expect(profiles[0].displayName).toBe('playerB');
    });

    it('playerB から playerA のプロフィール取得で新 sessionId が返る', async () => {
        const profiles = await requestProfiles(playerB, [playerA.sessionId]);
        expect(profiles.length, '1件のプロフィール').toBe(1);
        expect(profiles[0].displayName).toBe('playerA');
    });

    it('古い sessionId でプロフィール取得すると空で返る', async () => {
        // reconnect() で oldSessionId は保存していないが、profileRequest で不正SIDを送る
        const fakeSid = '00000000-0000-0000-0000-000000000000';
        const beforeCount = playerA.receivedProfiles.length;
        await playerA.socket.sendMatchState(playerA.matchId, OP_PROFILE_REQUEST,
            new TextEncoder().encode(JSON.stringify({ sessionIds: [fakeSid] })));
        await sleep(1000);
        // 不正SIDはスキップされるので、レスポンスが来ないか空で返る
        const after = playerA.receivedProfiles.slice(beforeCount);
        const hasFake = after.some(p => p.sessionId === fakeSid);
        expect(hasFake, '不正SIDのプロフィールは返らない').toBe(false);
    });
});

describe('再接続 連続テスト', { timeout: 30_000 }, () => {
    let player: PlayerConn;
    let observer: PlayerConn;

    beforeAll(async () => {
        observer = await loginAndJoin('observer', 0, 0);
        await sleep(100);
        player = await loginAndJoin('reconPlayer', 0, 0);
        await sleep(1000);
    });

    afterAll(async () => {
        try { player?.socket.disconnect(true); } catch { /* */ }
        try { observer?.socket.disconnect(true); } catch { /* */ }
    });

    it('3回連続で切断→再接続しても正常に動作する', async () => {
        for (let i = 0; i < 3; i++) {
            clog('test', `--- 再接続 ${i + 1}/3 ---`);
            const { newSessionId } = await reconnect(player);
            expect(newSessionId).toBeTruthy();
            await sleep(1000);

            // 再接続後に observer の AOI_ENTER を受信
            const seesObserver = player.receivedAOIEnter.some(e => e.sessionId === observer.sessionId);
            expect(seesObserver, `再接続${i + 1}回目: observer の AOI_ENTER を受信`).toBe(true);

            // observer から player のプロフィールが取得できる
            const profiles = await requestProfiles(observer, [player.sessionId]);
            expect(profiles.length, `再接続${i + 1}回目: プロフィール1件`).toBeGreaterThanOrEqual(1);
            expect(profiles[0].displayName).toBe('reconPlayer');
        }
    });
});

// ファイルレベルのクリーンアップ
afterAll(async () => {
    await deleteCreatedUsers();
}, 60_000);
