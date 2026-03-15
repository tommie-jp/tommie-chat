/**
 * 初期地面データ投入
 *
 * OP_BLOCK_UPDATE でブロックを設置し、テスト用の地面を生成する。
 * (0,0) 付近に地面を生成。半径5以内は空白（スポーン地点）。
 *
 * 実行: npx vitest run test/seed-ground.test.ts
 *       または ./test/doSeedGround.sh
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client } from '@heroiclabs/nakama-js';
import { trackUserId, deleteCreatedUsers } from './test-helpers';

const HOST       = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT       = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';

const OP_BLOCK_UPDATE = 4;
const CHUNK_SIZE = 16;

// スポーン地点の空白半径
const SPAWN_RADIUS = 5;

// 地面の範囲: (0,0) を中心に -16〜+15 の 32x32 エリア
// ただしワールド座標は 0〜1023 なので、負の座標は使えない
// → (0,0)〜(31,31) の範囲に生成、(0,0) 付近の半径5は空白
const GROUND_MIN = 0;
const GROUND_MAX = 31;

// 色パターン（象限ごとに色を変える）
function getColor(gx: number, gz: number): { r: number; g: number; b: number } {
    if (gx < 16 && gz < 16) return { r:  76, g: 175, b:  80 }; // 左下: 緑の草地
    if (gx >= 16 && gz < 16) return { r: 141, g: 110, b:  99 }; // 右下: 茶色の土
    if (gx < 16 && gz >= 16) return { r:  33, g: 150, b: 243 }; // 左上: 青い水面
    return { r: 158, g: 158, b: 158 };                           // 右上: 灰色の石
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('seed-ground', () => {
    it('地面データを投入する（(0,0)付近、半径5は空白）', async () => {
        // 認証
        const client = new Client(SERVER_KEY, HOST, PORT, false);
        const session = await client.authenticateDevice('seed-ground-admin', true, 'seed-admin');
        trackUserId(session.user_id!);
        expect(session.token).toBeTruthy();

        // マッチ参加
        const socket = client.createSocket(false, false);
        await socket.connect(session, false);

        const rpcResult = await socket.rpc('getWorldMatch');
        const { matchId } = JSON.parse(rpcResult.payload ?? '{}') as { matchId: string };
        expect(matchId).toBeTruthy();

        const match = await socket.joinMatch(matchId);
        expect(match.self?.session_id).toBeTruthy();
        console.log('  マッチ参加完了');

        // 少し待ってからブロック設置開始
        await sleep(500);

        // ブロック設置
        let total = 0;
        let skipped = 0;
        for (let gx = GROUND_MIN; gx <= GROUND_MAX; gx++) {
            for (let gz = GROUND_MIN; gz <= GROUND_MAX; gz++) {
                // (0,0) からの距離が SPAWN_RADIUS 以内は空白（blockId=0 で上書き）
                if (Math.sqrt(gx * gx + gz * gz) <= SPAWN_RADIUS) {
                    const clearData = JSON.stringify({
                        gx, gz, blockId: 0, r: 0, g: 0, b: 0, a: 0,
                    });
                    await socket.sendMatchState(matchId, OP_BLOCK_UPDATE, clearData);
                    skipped++;
                    continue;
                }
                const color = getColor(gx, gz);
                const data = JSON.stringify({
                    gx, gz,
                    blockId: 1,
                    r: color.r, g: color.g, b: color.b, a: 255,
                });
                await socket.sendMatchState(matchId, OP_BLOCK_UPDATE, data);
                total++;
            }
            // 行ごとに少し待つ（サーバ負荷軽減）
            if (gx % 8 === 7) {
                console.log(`  進捗: ${gx + 1}/${GROUND_MAX + 1}行`);
                await sleep(100);
            }
        }

        console.log(`  合計: ${total}ブロック設置、${skipped}ブロックスキップ（スポーン空白）`);

        // 保存完了を待つ
        await sleep(1000);

        socket.disconnect(false);
    }, 30_000);
});

// ファイルレベルのクリーンアップ: 全 describe 完了後にユーザー削除
afterAll(async () => {
    await deleteCreatedUsers();
}, 60_000);
