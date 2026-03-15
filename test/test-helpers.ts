/**
 * テスト共通ヘルパー
 *
 * テスト中に作成したユーザーIDを収集し、テスト終了後に一括削除する。
 * ENABLE_TEST_RPC=true のサーバでのみ動作（本番では deleteUsers RPC が存在しない）。
 */
import { Client } from '@heroiclabs/nakama-js';

const HOST       = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT       = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';

/** テスト中に作成したユーザーIDを収集する配列 */
export const createdUserIds: string[] = [];

/** ユーザーIDを収集対象に追加する */
export function trackUserId(userId: string): void {
    createdUserIds.push(userId);
}

/** テストで作成したユーザーを一括削除（ENABLE_TEST_RPC=true 時のみ） */
export async function deleteCreatedUsers(): Promise<void> {
    if (createdUserIds.length === 0) return;
    try {
        const client = new Client(SERVER_KEY, HOST, PORT, false);
        const session = await client.authenticateCustom('__cleanup_tmp', true, '__cleanup_tmp');
        const socket = client.createSocket(false, false);
        await socket.connect(session, false);
        const allIds = [...createdUserIds, session.user_id!];
        for (let i = 0; i < allIds.length; i += 100) {
            const batch = allIds.slice(i, i + 100);
            try { await socket.rpc('deleteUsers', JSON.stringify({ userIds: batch })); } catch { /* 自分削除時はソケット切断 */ }
        }
        try { socket.disconnect(false); } catch { /* */ }
        console.log(`  ユーザー削除: ${createdUserIds.length}人`);
    } catch (e) {
        console.warn('  ユーザー削除スキップ:', e instanceof Error ? e.message : e);
    }
    createdUserIds.length = 0;
}
