/**
 * プレイヤーリスト通知テスト
 *
 * プレイヤーリストに通知する値（displayName, textureUrl, loginTime）が
 * サーバから正しく取得できるかを検証する。
 * 人数を変えて（1, 10, 100）プロフィール通知・表示名変更通知をテストする。
 *
 * 前提: nakama サーバが 127.0.0.1:7350 で起動していること
 *   cd nakama && docker compose up -d
 *
 * 実行: npx vitest run test/nakama-player-list.test.ts
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket, MatchData } from '@heroiclabs/nakama-js';
import { trackUserId, deleteCreatedUsers } from './test-helpers';

const HOST        = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT        = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY  = process.env.NAKAMA_SERVER_KEY ?? 'tommie-chat';
const TEXTURE_URL = '/s3/avatars/pic1.ktx2';
const CHAT_ROOM   = 'world';

const OP_INIT_POS          = 1;
const OP_AVATAR_CHANGE     = 3;
const OP_AOI_UPDATE        = 5;
const OP_AOI_ENTER         = 6;
const OP_DISPLAY_NAME      = 8;
const OP_PROFILE_REQUEST   = 9;
const OP_PROFILE_RESPONSE  = 10;

const CHUNK_SIZE  = 16;
const CHUNK_COUNT = 64;
const WORLD_SIZE  = 1024;
const AOI_RADIUS  = 48;

// ── タイムスタンプ付きログ ──

const clientLogs: { player: string; line: string }[] = [];

function ts(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${Math.floor(d.getMilliseconds() / 100)}`;
}

function clog(player: string, msg: string): void {
    const line = `${ts()} ${msg}`;
    clientLogs.push({ player, line });
    console.log(`[${player}] ${line}`);
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
    receivedEvents: { op: number; payload: unknown; senderSid: string | null }[];
    receivedProfiles: ProfileEntry[];
}

async function loginAndJoin(name: string, x = 0, z = 0): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const suffix = Date.now();
    const testId  = `plist_${name}_${suffix}`;
    const testUname = `${name}_${suffix}`;

    clog(name, `snd Login username: ${name}`);
    const session = await client.authenticateCustom(testId, true, testUname);
    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);
    await socket.joinChat(CHAT_ROOM, 1, true, false);

    clog(name, 'snd getWorldMatch');
    const wmResult = await socket.rpc('getWorldMatch');
    const wmData = JSON.parse(wmResult.payload ?? '{}') as { matchId?: string };
    if (!wmData.matchId) throw new Error(`getWorldMatch failed for ${name}`);

    const receivedEvents: PlayerConn['receivedEvents'] = [];
    const receivedProfiles: ProfileEntry[] = [];

    socket.onmatchdata = (md: MatchData) => {
        const senderSid = md.presence?.session_id ?? null;
        const shortSnd = senderSid ? senderSid.slice(0, 8) : '(srv)';
        clog(name, `rcv matchdata op=${md.op_code} sid=${shortSnd}`);
        try {
            const payload = JSON.parse(new TextDecoder().decode(md.data));
            if (md.op_code === OP_AOI_ENTER) {
                type AoiEnterEntry = { sessionId: string; x: number; z: number; ry?: number };
                const entries: AoiEnterEntry[] = Array.isArray(payload) ? payload : [payload];
                for (const e of entries) {
                    receivedEvents.push({ op: OP_AOI_ENTER, payload: e, senderSid });
                }
            } else if (md.op_code === OP_PROFILE_RESPONSE) {
                const resp = payload as { profiles: ProfileEntry[] };
                const profiles = resp.profiles ?? [];
                for (const p of profiles) {
                    receivedProfiles.push(p);
                    clog(name, `rcv PROFILE sid=${p.sessionId.slice(0,8)} dn="${p.displayName}" tx="${p.textureUrl}" lt="${p.loginTime}"`);
                }
                receivedEvents.push({ op: OP_PROFILE_RESPONSE, payload: profiles, senderSid });
            } else {
                receivedEvents.push({ op: md.op_code, payload, senderSid });
            }
        } catch { /* ignore */ }
    };

    // joinMatch リトライ（レートリミット対応）
    let match;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            match = await socket.joinMatch(wmData.matchId);
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
    const selfSid = match!.self?.session_id ?? '';

    const conn: PlayerConn = { name, client, session, socket, matchId: wmData.matchId, sessionId: selfSid, receivedEvents, receivedProfiles };
    trackUserId(session.user_id!);

    const ry = 0;
    clog(name, `snd initPos x=${x.toFixed(1)} z=${z.toFixed(1)} dn=${name} tx=${TEXTURE_URL}`);
    await socket.sendMatchState(wmData.matchId, OP_INIT_POS, JSON.stringify({
        x, z, ry, lt: new Date().toISOString(), dn: name, tx: TEXTURE_URL,
    }));

    const aoi = calcAOI(x, z);
    clog(name, `snd AOI_UPDATE (${aoi.minCX},${aoi.minCZ})-(${aoi.maxCX},${aoi.maxCZ})`);
    await socket.sendMatchState(wmData.matchId, OP_AOI_UPDATE, JSON.stringify(aoi));

    return conn;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// N人をログインさせる（レート制限対応）
// 環境変数 LOGIN_RATE_PER_SEC でバッチサイズを制御（0=無制限→全並列）
const _loginRatePerSec = parseInt(process.env['LOGIN_RATE_PER_SEC'] ?? '0', 10);

async function loginNPlayers(prefix: string, count: number): Promise<PlayerConn[]> {
    if (count <= 10) {
        const players: PlayerConn[] = [];
        for (let i = 0; i < count; i++) {
            players.push(await loginAndJoin(`${prefix}${i + 1}`, 0, 0));
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
            (_, j) => loginAndJoin(`${prefix}${i + j + 1}`, 0, 0)
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
                    console.error(`RATE LIMITED: ${msg}`);
                } else {
                    otherErrors++;
                    console.error(`LOGIN ERROR: ${msg}`);
                }
            }
        }
        // 大人数テスト時は進捗を表示（doAll.shのタイムアウト防止）
        if (count >= 100 && (i + batchSize) < count) {
            console.log(`  接続中: ${players.length}/${count}人`);
        }
        if (i + batchSize < count) await sleep(1000);
    }
    if (rateLimited > 0) {
        console.error(`\nレート制限で ${rateLimited}人が拒否されました (サーバ MAX_LOGIN_RATE_PER_SEC=${_loginRatePerSec || '?'}, クライアント batch=${batchSize}人/秒)`);
    }
    if (otherErrors > 0) {
        console.error(`\nその他のログインエラー: ${otherErrors}件`);
    }
    return players;
}

// プロフィールリクエスト送信してレスポンスを待つ
// Nakama の max_message_size_bytes (デフォルト4096) を超えないよう、
// 大量の sessionId はバッチ分割して送信する
const PROFILE_BATCH_SIZE = 20; // UUID 20個 ≈ 900 bytes

async function requestAndWaitProfiles(conn: PlayerConn, sessionIds: string[], timeoutMs = 15000): Promise<ProfileEntry[]> {
    const beforeCount = conn.receivedProfiles.length;
    const totalRequested = sessionIds.length;

    // バッチ分割送信
    for (let i = 0; i < sessionIds.length; i += PROFILE_BATCH_SIZE) {
        const batch = sessionIds.slice(i, i + PROFILE_BATCH_SIZE);
        clog(conn.name, `snd profileRequest batch=${Math.floor(i / PROFILE_BATCH_SIZE) + 1} count=${batch.length}`);
        await conn.socket.sendMatchState(conn.matchId, OP_PROFILE_REQUEST,
            new TextEncoder().encode(JSON.stringify({ sessionIds: batch })));
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (conn.receivedProfiles.length >= beforeCount + totalRequested) {
            return conn.receivedProfiles.slice(beforeCount);
        }
        await sleep(50);
    }
    const got = conn.receivedProfiles.length - beforeCount;
    throw new Error(`timeout waiting for profileResponse (requested ${totalRequested}, got ${got})`);
}

// 表示名変更イベント待機
function waitForDisplayName(conn: PlayerConn, targetSid: string, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = setInterval(() => {
            const ev = conn.receivedEvents.find(e =>
                e.op === OP_DISPLAY_NAME &&
                e.senderSid === targetSid
            );
            if (ev) {
                clearInterval(check);
                resolve((ev.payload as { displayName: string }).displayName);
                return;
            }
            if (Date.now() > deadline) {
                clearInterval(check);
                reject(new Error(`timeout waiting for displayName from ${targetSid.slice(0,8)}`));
            }
        }, 50);
    });
}

// ── テスト生成関数 ──

function makeProfileTest(count: number): void {
    const prefix = `prof${count}_`;
    const _envTimeout = parseInt(process.env['TEST_TIMEOUT_MS'] ?? '0', 10);
    const timeoutMs = _envTimeout > 0 ? _envTimeout : count <= 10 ? 30_000 : count <= 100 ? 180_000 : 600_000;

    describe(`${count}人 プロフィール通知`, { timeout: timeoutMs }, () => {
        let players: PlayerConn[] = [];

        beforeAll(async () => {
            players = await loginNPlayers(prefix, count);
            // initPos + AOI がサーバで処理されるのを待つ
            await sleep(count <= 10 ? 500 : 3000);
        }, timeoutMs);

        afterAll(async () => {
            for (const p of players) {
                try { p.socket.disconnect(true); } catch { /* */ }
            }
            console.log(`\n========== ${count}人 プロフィール通知 summary: ${players.length}/${count} logged in ==========`);
        });

        it(`${count}人全員がログインできる`, () => {
            expect(players.length, `${count}人中${players.length}人のみログイン成功`).toBe(count);
        });

        it('player[0] が全員のプロフィールを取得できる', async () => {
            const allSids = players.map(p => p.sessionId);
            const profiles = await requestAndWaitProfiles(players[0], allSids);
            expect(profiles.length, `${count}件のプロフィール`).toBe(count);

            for (const p of players) {
                const prof = profiles.find(pr => pr.sessionId === p.sessionId);
                expect(prof, `${p.name} のプロフィールが存在`).toBeTruthy();
                expect(prof!.displayName, `${p.name} の displayName`).toBe(p.name);
                expect(prof!.textureUrl, `${p.name} の textureUrl`).toBe(TEXTURE_URL);
                expect(prof!.loginTime, `${p.name} の loginTime 非空`).toBeTruthy();
                const parsed = new Date(prof!.loginTime);
                expect(parsed.getTime(), `${p.name} の loginTime が有効な日時`).toBeGreaterThan(0);
            }
        });

        if (count >= 2) {
            it('AOI_ENTER にはプロフィール情報が含まれない（位置のみ）', () => {
                const aoiEvents = players[0].receivedEvents.filter(e => e.op === OP_AOI_ENTER);
                for (const ev of aoiEvents) {
                    const payload = ev.payload as Record<string, unknown>;
                    expect(payload.displayName, 'AOI_ENTER に displayName がない').toBeUndefined();
                    expect(payload.textureUrl, 'AOI_ENTER に textureUrl がない').toBeUndefined();
                    expect(payload.loginTime, 'AOI_ENTER に loginTime がない').toBeUndefined();
                }
            });
        }
    });
}

function makeDisplayNameTest(count: number): void {
    const prefix = `dn${count}_`;
    const _envTimeout = parseInt(process.env['TEST_TIMEOUT_MS'] ?? '0', 10);
    const timeoutMs = _envTimeout > 0 ? _envTimeout : count <= 10 ? 30_000 : count <= 100 ? 180_000 : 600_000;

    describe(`${count}人 表示名変更通知`, { timeout: timeoutMs }, () => {
        let players: PlayerConn[] = [];

        beforeAll(async () => {
            players = await loginNPlayers(prefix, count);
            await sleep(count <= 10 ? 500 : 3000);
        }, timeoutMs);

        afterAll(async () => {
            for (const p of players) {
                try { p.socket.disconnect(true); } catch { /* */ }
            }
            console.log(`\n========== ${count}人 表示名変更通知 summary: ${players.length}/${count} logged in ==========`);
        });

        it(`${count}人全員がログインできる`, () => {
            expect(players.length, `${count}人中${players.length}人のみログイン成功`).toBe(count);
        });

        if (count >= 2) {
            it('player[0] が表示名を変更すると他の全員が受信する', async () => {
                const newName = `Changed_${prefix}1`;
                clog(players[0].name, `snd displayName "${newName}"`);
                await players[0].socket.sendMatchState(players[0].matchId, OP_DISPLAY_NAME,
                    JSON.stringify({ displayName: newName }));

                // player[1] が受信することを確認（代表1人）
                const received = await waitForDisplayName(players[1], players[0].sessionId);
                expect(received, 'player[1] が受信した displayName').toBe(newName);
            });
        }

        it('表示名変更後にプロフィール取得すると新しい名前が反映されている', async () => {
            const newName = `Updated_${prefix}1`;
            clog(players[0].name, `snd displayName "${newName}"`);
            await players[0].socket.sendMatchState(players[0].matchId, OP_DISPLAY_NAME,
                JSON.stringify({ displayName: newName }));
            await sleep(500);

            // プロフィール取得で確認（player[0] 自身 or 別プレイヤーから）
            const requester = count >= 2 ? players[1] : players[0];
            const profiles = await requestAndWaitProfiles(requester, [players[0].sessionId]);
            expect(profiles.length, '1件のプロフィール').toBe(1);
            expect(profiles[0].displayName, 'displayName が更新済み').toBe(newName);
        });
    });
}

// ── 存在しないsessionIdのprofileRequest テスト ──

function makeInvalidSidTest(count: number): void {
    const prefix = `invsid${count}_`;
    const _envTimeout = parseInt(process.env['TEST_TIMEOUT_MS'] ?? '0', 10);
    const timeoutMs = _envTimeout > 0 ? _envTimeout : count <= 10 ? 30_000 : count <= 100 ? 180_000 : 600_000;

    describe(`${count}人 不正sessionIdプロフィール要求`, { timeout: timeoutMs }, () => {
        let players: PlayerConn[] = [];

        beforeAll(async () => {
            players = await loginNPlayers(prefix, count);
            await sleep(count <= 10 ? 500 : 3000);
        }, timeoutMs);

        afterAll(async () => {
            for (const p of players) {
                try { p.socket.disconnect(true); } catch { /* */ }
            }
        });

        it(`${count}人全員がログインできる`, () => {
            expect(players.length).toBe(count);
        });

        it('存在しないsessionIdはスキップされ、有効なもののみ返る', async () => {
            const fakeSid = '00000000-0000-0000-0000-000000000000';
            const validSid = players[0].sessionId;
            const requestSids = [fakeSid, validSid, 'invalid-not-uuid'];

            const beforeCount = players[0].receivedProfiles.length;
            await players[0].socket.sendMatchState(players[0].matchId, OP_PROFILE_REQUEST,
                new TextEncoder().encode(JSON.stringify({ sessionIds: requestSids })));

            // 有効な1件のみ返るのを待つ
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline) {
                if (players[0].receivedProfiles.length >= beforeCount + 1) break;
                await sleep(50);
            }
            // 少し追加待ち（余計なレスポンスが来ないことを確認）
            await sleep(500);

            const profiles = players[0].receivedProfiles.slice(beforeCount);
            expect(profiles.length, '有効な1件のみ返る').toBe(1);
            expect(profiles[0].sessionId, '有効なsessionId').toBe(validSid);
            expect(profiles[0].displayName).toBe(players[0].name);
        });

        if (count >= 2) {
            it('ログアウト済みプレイヤーのsessionIdはスキップされる', async () => {
                const leavingPlayer = players[players.length - 1];
                const leavingSid = leavingPlayer.sessionId;
                clog(leavingPlayer.name, 'snd logout');
                leavingPlayer.socket.disconnect(true);
                await sleep(1000);

                const beforeCount = players[0].receivedProfiles.length;
                await players[0].socket.sendMatchState(players[0].matchId, OP_PROFILE_REQUEST,
                    new TextEncoder().encode(JSON.stringify({ sessionIds: [leavingSid, players[0].sessionId] })));

                const deadline = Date.now() + 5000;
                while (Date.now() < deadline) {
                    if (players[0].receivedProfiles.length >= beforeCount + 1) break;
                    await sleep(50);
                }
                await sleep(500);

                const profiles = players[0].receivedProfiles.slice(beforeCount);
                expect(profiles.length, 'ログアウト済みを除く1件のみ返る').toBe(1);
                expect(profiles[0].sessionId).toBe(players[0].sessionId);

                // afterAll でdisconnectしないよう除外
                players = players.slice(0, -1);
            });
        }
    });
}

// ── textureUrl変更後のプロフィール反映テスト ──

function makeTextureChangeTest(count: number): void {
    const prefix = `txchg${count}_`;
    const _envTimeout = parseInt(process.env['TEST_TIMEOUT_MS'] ?? '0', 10);
    const timeoutMs = _envTimeout > 0 ? _envTimeout : count <= 10 ? 30_000 : count <= 100 ? 180_000 : 600_000;

    describe(`${count}人 テクスチャ変更プロフィール反映`, { timeout: timeoutMs }, () => {
        let players: PlayerConn[] = [];

        beforeAll(async () => {
            players = await loginNPlayers(prefix, count);
            await sleep(count <= 10 ? 500 : 3000);
        }, timeoutMs);

        afterAll(async () => {
            for (const p of players) {
                try { p.socket.disconnect(true); } catch { /* */ }
            }
        });

        it(`${count}人全員がログインできる`, () => {
            expect(players.length).toBe(count);
        });

        it('avatarChange 後にプロフィール取得すると新しい textureUrl が反映されている', async () => {
            const newTexture = '/s3/avatars/changed.ktx2';
            clog(players[0].name, `snd avatarChange textureUrl=${newTexture}`);
            await players[0].socket.sendMatchState(players[0].matchId, OP_AVATAR_CHANGE,
                JSON.stringify({ textureUrl: newTexture }));
            await sleep(500);

            const requester = count >= 2 ? players[1] : players[0];
            const profiles = await requestAndWaitProfiles(requester, [players[0].sessionId]);
            expect(profiles.length, '1件のプロフィール').toBe(1);
            expect(profiles[0].textureUrl, 'textureUrl が更新済み').toBe(newTexture);
        });

        it('元のプレイヤーの textureUrl は変わっていない', async () => {
            if (count < 2) return;
            const requester = players[0];
            const profiles = await requestAndWaitProfiles(requester, [players[1].sessionId]);
            expect(profiles.length).toBe(1);
            expect(profiles[0].textureUrl, '未変更プレイヤーは元のまま').toBe(TEXTURE_URL);
        });
    });
}

// ── 途中参加者のプロフィール取得テスト ──

function makeLateJoinTest(count: number): void {
    const prefix = `late${count}_`;
    const _envTimeout = parseInt(process.env['TEST_TIMEOUT_MS'] ?? '0', 10);
    const timeoutMs = _envTimeout > 0 ? _envTimeout : count <= 10 ? 30_000 : count <= 100 ? 180_000 : 600_000;

    describe(`${count}人 途中参加プロフィール取得`, { timeout: timeoutMs }, () => {
        let players: PlayerConn[] = [];
        let latePlayer: PlayerConn;

        beforeAll(async () => {
            players = await loginNPlayers(prefix, count);
            await sleep(count <= 10 ? 500 : 3000);
            // 途中参加: 全員ログイン完了後に1人追加
            latePlayer = await loginAndJoin(`${prefix}late`, 0, 0);
            await sleep(500);
        }, timeoutMs);

        afterAll(async () => {
            try { latePlayer?.socket.disconnect(true); } catch { /* */ }
            for (const p of players) {
                try { p.socket.disconnect(true); } catch { /* */ }
            }
        });

        it(`${count}人+途中参加1人 全員ログイン成功`, () => {
            expect(players.length).toBe(count);
            expect(latePlayer.sessionId).toBeTruthy();
        });

        it('途中参加者が既存全員のプロフィールを取得できる', async () => {
            const allSids = players.map(p => p.sessionId);
            const profiles = await requestAndWaitProfiles(latePlayer, allSids);
            expect(profiles.length, `${count}件のプロフィール`).toBe(count);

            for (const p of players) {
                const prof = profiles.find(pr => pr.sessionId === p.sessionId);
                expect(prof, `${p.name} のプロフィールが存在`).toBeTruthy();
                expect(prof!.displayName).toBe(p.name);
                expect(prof!.textureUrl).toBe(TEXTURE_URL);
            }
        });

        it('既存プレイヤーが途中参加者のプロフィールを取得できる', async () => {
            const profiles = await requestAndWaitProfiles(players[0], [latePlayer.sessionId]);
            expect(profiles.length, '1件のプロフィール').toBe(1);
            expect(profiles[0].displayName).toBe(`${prefix}late`);
            expect(profiles[0].textureUrl).toBe(TEXTURE_URL);
        });
    });
}

// ── テスト実行 ──

makeProfileTest(1);
makeProfileTest(10);
makeProfileTest(100);
makeProfileTest(1000);
makeProfileTest(2000);

makeDisplayNameTest(1);
makeDisplayNameTest(10);
makeDisplayNameTest(100);
makeDisplayNameTest(1000);
makeDisplayNameTest(2000);

makeInvalidSidTest(1);
makeInvalidSidTest(10);

makeTextureChangeTest(1);
makeTextureChangeTest(10);

makeLateJoinTest(1);
makeLateJoinTest(10);

// 環境変数 PLAYER_LIST_N_COUNT で任意人数テストを追加（-n N オプション用）
const _customN = parseInt(process.env['PLAYER_LIST_N_COUNT'] ?? '0', 10);
if (_customN > 0 && ![1, 10, 100, 1000, 2000].includes(_customN)) {
    makeProfileTest(_customN);
    makeDisplayNameTest(_customN);
}

// ファイルレベルのクリーンアップ: 全 describe 完了後にユーザー削除
afterAll(async () => {
    await deleteCreatedUsers();
}, 60_000);
