/**
 * 初期地面データ投入
 *
 * OP_BLOCK_UPDATE でブロックを設置し、テスト用の地面を生成する。
 * シーン座標 (0,0)（＝ワールド座標 (512,512)）付近に地面を配置。
 *
 * パターン:
 *   plaza  — 広場パターン（デフォルト）: 中央白広場 + 芝生 + 小道 + 池
 *   4color — 4色テスト用: 象限ごとに緑/茶/青/灰
 *   clear  — 地面クリア: plaza 範囲のブロックを全削除
 *
 * 実行: SEED_PATTERN=plaza npx vitest run test/seed-ground.test.ts
 *       または ./test/doSeedGround.sh [--pattern plaza|4color]
 */
import { describe, it, expect } from 'vitest';
import * as ws from 'ws';
(globalThis as unknown as Record<string, unknown>).WebSocket = ws.WebSocket;
import { Client } from '@heroiclabs/nakama-js';

const HOST       = process.env.NAKAMA_HOST ?? '127.0.0.1';
const PORT       = process.env.NAKAMA_PORT ?? '7350';
const SERVER_KEY = process.env.NAKAMA_SERVER_KEY ?? 'defaultkey';
const PATTERN    = process.env.SEED_PATTERN ?? 'plaza';

const OP_BLOCK_UPDATE = 4;

// ワールド中心（シーン座標 (0,0) = ワールド座標 (512,512)）
const CX = 512;
const CZ = 512;

// ── パターン定義 ──

type RGB = { r: number; g: number; b: number };

// 色定数
const C_WHITE:     RGB = { r: 230, g: 225, b: 215 }; // ベージュ白（広場）
const C_GRASS:     RGB = { r:  76, g: 175, b:  80 }; // 緑（芝生）
const C_GRASS_D:   RGB = { r:  56, g: 142, b:  60 }; // 濃緑（外周）
const C_PATH:      RGB = { r: 161, g: 136, b: 127 }; // 茶グレー（小道）
const C_WATER:     RGB = { r:  33, g: 150, b: 243 }; // 青（池）
const C_BROWN:     RGB = { r: 141, g: 110, b:  99 }; // 茶色
const C_GRAY:      RGB = { r: 158, g: 158, b: 158 }; // 灰色

/** 広場パターン: 中央白広場 + 芝生 + 十字小道 + 池（四角ベース） */
function plazaColor(gx: number, gz: number): RGB | null {
    const dx = gx - CX, dz = gz - CZ;
    const ax = Math.abs(dx), az = Math.abs(dz);

    // スポーン空白（中央 3x3）
    if (ax <= 1 && az <= 1) return null;

    // 十字小道（幅1、中心から5〜20）
    if ((ax === 0 || az === 0) && Math.max(ax, az) >= 3 && Math.max(ax, az) <= 20) return C_PATH;

    // 中央広場（10x10）
    if (ax <= 5 && az <= 5) return C_WHITE;

    // 池（右上の一角、6x4）
    if (dx >= 7 && dx <= 12 && dz >= 7 && dz <= 10) return C_WATER;

    // 芝生エリア（40x40）
    if (ax <= 20 && az <= 20) return C_GRASS;

    // 外周（48x48）
    if (ax <= 24 && az <= 24) return C_GRASS_D;

    return null; // 範囲外
}

/** 4色テストパターン: 象限ごとに色分け（四角） */
function fourColorColor(gx: number, gz: number): RGB | null {
    const dx = gx - CX, dz = gz - CZ;
    const ax = Math.abs(dx), az = Math.abs(dz);

    // スポーン空白（中央 3x3）
    if (ax <= 1 && az <= 1) return null;

    // 範囲外（32x32）
    if (ax > 16 || az > 16) return null;

    if (dx < 0 && dz < 0) return C_GRASS;
    if (dx >= 0 && dz < 0) return C_BROWN;
    if (dx < 0 && dz >= 0) return C_WATER;
    return C_GRAY;
}

/** クリアパターン: 全ブロックを空白にする */
function clearColor(_gx: number, _gz: number): RGB | null {
    return null;
}

// パターン選択
const getColor: (gx: number, gz: number) => RGB | null =
    PATTERN === '4color' ? fourColorColor
    : PATTERN === 'clear' ? clearColor
    : plazaColor;

// 地面の範囲（clear は plaza と同じ範囲）
const RADIUS = PATTERN === '4color' ? 16 : 24;
const GROUND_MIN = CX - RADIUS;
const GROUND_MAX = CX + RADIUS;
const GROUND_MIN_Z = CZ - RADIUS;
const GROUND_MAX_Z = CZ + RADIUS;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('seed-ground', () => {
    it(`地面データを投入する（パターン: ${PATTERN}）`, async () => {
        // 認証
        const client = new Client(SERVER_KEY, HOST, PORT, false);
        const session = await client.authenticateDevice('seed-ground-admin', true, 'seed-admin');
        expect(session.token).toBeTruthy();

        // マッチ参加
        const socket = client.createSocket(false, false);
        await socket.connect(session, false);

        const rpcResult = await socket.rpc('getWorldMatch');
        const { matchId } = JSON.parse(rpcResult.payload ?? '{}') as { matchId: string };
        expect(matchId).toBeTruthy();

        const match = await socket.joinMatch(matchId);
        expect(match.self?.session_id).toBeTruthy();
        console.log(`  マッチ参加完了（パターン: ${PATTERN}）`);

        await sleep(500);

        // ブロック設置
        let total = 0;
        let skipped = 0;
        const size = GROUND_MAX - GROUND_MIN + 1;
        for (let gx = GROUND_MIN; gx <= GROUND_MAX; gx++) {
            for (let gz = GROUND_MIN_Z; gz <= GROUND_MAX_Z; gz++) {
                const color = getColor(gx, gz);
                if (color === null) {
                    // 空白ブロック（既存データのクリア用）
                    await socket.sendMatchState(matchId, OP_BLOCK_UPDATE,
                        JSON.stringify({ gx, gz, blockId: 0, r: 0, g: 0, b: 0, a: 0 }));
                    skipped++;
                } else {
                    await socket.sendMatchState(matchId, OP_BLOCK_UPDATE,
                        JSON.stringify({ gx, gz, blockId: 1, r: color.r, g: color.g, b: color.b, a: 255 }));
                    total++;
                }
            }
            if ((gx - GROUND_MIN) % 8 === 7) {
                console.log(`  進捗: ${gx - GROUND_MIN + 1}/${size}行`);
                await sleep(100);
            }
        }

        console.log(`  合計: ${total}ブロック設置、${skipped}ブロック空白`);

        await sleep(1000);
        socket.disconnect(false);
    }, 60_000);
});
