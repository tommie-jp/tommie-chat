/**
 * オセロ参加通知テスト（socket.notification）
 *
 * 仕様: doc/20-仕様書.md ⭐️通知 / ⭐️socket.notification 定数名
 *
 * 検証内容:
 *   1. playerB が othelloJoin すると playerA（オーナー）へ socket.onnotification が配信される
 *   2. code=1001 (CodeOthelloJoined)
 *   3. subject="対戦相手が見つかりました"
 *   4. content={gameNo, opponentName}
 *   5. sender_id=playerB の userId
 *   6. persistent=true（DB に永続化されているので listNotifications で取得可能）
 *
 * 前提: nakama サーバが起動していること
 * 実行: npx vitest run test/nakama-othello-notification.test.ts
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client, Session, Socket, Notification } from '@heroiclabs/nakama-js';
import { trackUserId, deleteCreatedUsers } from './test-helpers';

const HOST       = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT       = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'tommie-chat';

const CODE_OTHELLO_JOINED = 1001;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface PlayerConn {
    name: string;
    displayName: string;
    client: Client;
    session: Session;
    socket: Socket;
    userId: string;
    notifications: Notification[];
}

async function loginPlayer(name: string): Promise<PlayerConn> {
    const client = new Client(SERVER_KEY, HOST, PORT, false);
    const suffix = Date.now();
    const testId = `othn_${name}_${suffix}`;
    const displayName = `othn_${name}_${suffix}`;

    const session = await client.authenticateCustom(testId, true, displayName);
    await client.updateAccount(session, { display_name: displayName });

    const socket = client.createSocket(false, false);
    socket.setHeartbeatTimeoutMs(60000);
    await socket.connect(session, true);

    const notifications: Notification[] = [];
    socket.onnotification = (n: Notification) => {
        notifications.push(n);
    };

    trackUserId(session.user_id!);

    return {
        name, displayName, client, session, socket,
        userId: session.user_id!,
        notifications,
    };
}

function waitForNotification(
    conn: PlayerConn,
    predicate: (n: Notification) => boolean,
    timeoutMs = 5000,
): Promise<Notification> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = setInterval(() => {
            const found = conn.notifications.find(predicate);
            if (found) { clearInterval(check); resolve(found); return; }
            if (Date.now() > deadline) { clearInterval(check); reject(new Error('timeout waiting for notification')); }
        }, 50);
    });
}

describe('オセロ参加通知テスト', { timeout: 30_000 }, () => {
    let playerA: PlayerConn;
    let playerB: PlayerConn;
    let gameId: string;
    let gameNo: number;

    beforeAll(async () => {
        playerA = await loginPlayer('nA');
        await sleep(200);
        playerB = await loginPlayer('nB');
        await sleep(300);
    });

    afterAll(async () => {
        try { playerA?.socket.disconnect(true); } catch { /* */ }
        try { playerB?.socket.disconnect(true); } catch { /* */ }
        await deleteCreatedUsers();
    }, 30_000);

    it('オーナー（黒）が othelloCreate でゲームを作成する', async () => {
        const result = await playerA.socket.rpc('othelloCreate', JSON.stringify({ worldId: 0 }));
        const data = JSON.parse(result.payload ?? '{}') as { gameId: string; gameNo: number; status: string; black: string };
        expect(data.gameId).toBeTruthy();
        expect(data.status).toBe('waiting');
        expect(data.black).toBe(playerA.userId);
        expect(typeof data.gameNo).toBe('number');
        gameId = data.gameId;
        gameNo = data.gameNo;
    });

    it('相手（白）が othelloJoin → オーナーに socket.onnotification が配信される', async () => {
        playerA.notifications.length = 0;

        await playerB.socket.rpc('othelloJoin', JSON.stringify({ gameId }));

        const n = await waitForNotification(playerA, n => n.code === CODE_OTHELLO_JOINED);
        expect(n.code).toBe(CODE_OTHELLO_JOINED);
        expect(n.subject).toBe('対戦相手が見つかりました');
        expect(n.sender_id).toBe(playerB.userId);
        expect(n.persistent).toBe(true);

        const content = n.content as { gameNo: number; opponentName: string };
        expect(content.gameNo).toBe(gameNo);
        expect(content.opponentName).toBe(playerB.displayName);
    });

    it('相手（白）側には通知が届かない', () => {
        const hasJoinNotif = playerB.notifications.some(n => n.code === CODE_OTHELLO_JOINED);
        expect(hasJoinNotif, '参加者本人には通知が届かないはず').toBe(false);
    });

    it('persistent=true のため listNotifications で DB から取得できる', async () => {
        const list = await playerA.client.listNotifications(playerA.session, 100);
        expect(list.notifications).toBeTruthy();
        const found = list.notifications?.find(n => n.code === CODE_OTHELLO_JOINED);
        expect(found, 'DB に永続化された通知が見つかる').toBeTruthy();
        expect(found!.subject).toBe('対戦相手が見つかりました');
    });

    it('deleteNotifications で DB から削除できる', async () => {
        const list = await playerA.client.listNotifications(playerA.session, 100);
        const ids = (list.notifications ?? [])
            .filter(n => n.code === CODE_OTHELLO_JOINED && n.id)
            .map(n => n.id!);
        expect(ids.length).toBeGreaterThan(0);

        const ok = await playerA.client.deleteNotifications(playerA.session, ids);
        expect(ok).toBe(true);

        const list2 = await playerA.client.listNotifications(playerA.session, 100);
        const remaining = (list2.notifications ?? []).filter(n => n.code === CODE_OTHELLO_JOINED);
        expect(remaining.length).toBe(0);
    });
});
