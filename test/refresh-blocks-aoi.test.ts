/**
 * refreshBlocksForAOI ユニットテスト
 *
 * AOI変更時にブロックメッシュの破棄・生成が正しく行われるかテスト
 *
 * 実行: npx vitest run test/refresh-blocks-aoi.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';

// ── 定数（WorldConstants と同じ） ──
const CHUNK_SIZE = 16;
const WORLD_SIZE = 1024;

// ── Meshモック ──
interface MockMesh {
    disposed: boolean;
    dispose(): void;
}

function createMockMesh(): MockMesh {
    return {
        disposed: false,
        dispose() { this.disposed = true; },
    };
}

// ── refreshBlocksForAOI のロジックを再現するヘルパー ──
// GameScene のメソッドを抽出してテスト可能にする

interface AOIBounds {
    minCX: number; minCZ: number;
    maxCX: number; maxCZ: number;
}

interface ChunkData {
    cells: Uint8Array;
    hash: bigint;
}

/**
 * GameScene.refreshBlocksForAOI と同等のロジック
 * 戻り値: { disposed: blockMeshキー[], placed: {gx, gz, blockId}[] }
 */
function refreshBlocksForAOI(
    aoi: AOIBounds,
    blockMeshes: Map<number, MockMesh>,
    chunks: Map<string, ChunkData>,
    placeBlock: (gx: number, gz: number, blockId: number, r: number, g: number, b: number, a: number) => void
): { disposed: number[]; placed: { gx: number; gz: number; blockId: number }[] } {
    if (aoi.minCX < 0) return { disposed: [], placed: [] };
    const CS = CHUNK_SIZE;
    const WS = WORLD_SIZE;
    const disposed: number[] = [];
    const placed: { gx: number; gz: number; blockId: number }[] = [];

    // AOI外のブロックメッシュを破棄
    for (const [key, mesh] of blockMeshes) {
        const gx = Math.floor(key / WS);
        const gz = key % WS;
        const cx = Math.floor(gx / CS);
        const cz = Math.floor(gz / CS);
        if (cx < aoi.minCX || cx > aoi.maxCX || cz < aoi.minCZ || cz > aoi.maxCZ) {
            mesh.dispose();
            blockMeshes.delete(key);
            disposed.push(key);
        }
    }

    // AOI内のキャッシュ済みチャンクでメッシュが無いブロックを描画
    for (let cx = aoi.minCX; cx <= aoi.maxCX; cx++) {
        for (let cz = aoi.minCZ; cz <= aoi.maxCZ; cz++) {
            const ch = chunks.get(`${cx}_${cz}`);
            if (!ch) continue;
            const baseGX = cx * CS, baseGZ = cz * CS;
            for (let lx = 0; lx < CS; lx++) {
                for (let lz = 0; lz < CS; lz++) {
                    const gx = baseGX + lx, gz = baseGZ + lz;
                    const mkey = gx * WS + gz;
                    if (blockMeshes.has(mkey)) continue;
                    const si = (lx * CS + lz) * 6;
                    const blockId = ch.cells[si] | (ch.cells[si + 1] << 8);
                    if (blockId !== 0) {
                        placeBlock(gx, gz, blockId, ch.cells[si + 2], ch.cells[si + 3], ch.cells[si + 4], ch.cells[si + 5]);
                        placed.push({ gx, gz, blockId });
                    }
                }
            }
        }
    }

    return { disposed, placed };
}

// ── ヘルパー ──

/** gx, gz から blockMeshes のキーを計算 */
function blockKey(gx: number, gz: number): number {
    return gx * WORLD_SIZE + gz;
}

/** gx, gz からチャンク座標を計算 */
/** テスト用チャンクデータを作成（指定位置にブロックを配置） */
function createChunkWithBlocks(blocks: { lx: number; lz: number; blockId: number; r?: number; g?: number; b?: number; a?: number }[]): ChunkData {
    const cells = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 6);
    for (const b of blocks) {
        const si = (b.lx * CHUNK_SIZE + b.lz) * 6;
        cells[si] = b.blockId & 0xff;
        cells[si + 1] = (b.blockId >> 8) & 0xff;
        cells[si + 2] = b.r ?? 255;
        cells[si + 3] = b.g ?? 0;
        cells[si + 4] = b.b ?? 0;
        cells[si + 5] = b.a ?? 255;
    }
    return { cells, hash: 1n };
}

// ── テスト ──

describe('refreshBlocksForAOI ブロック破棄テスト', () => {
    let blockMeshes: Map<number, MockMesh>;
    let chunks: Map<string, ChunkData>;
    let placedBlocks: { gx: number; gz: number; blockId: number }[];
    let placeBlock: (gx: number, gz: number, blockId: number, r: number, g: number, b: number, a: number) => void;

    beforeEach(() => {
        blockMeshes = new Map();
        chunks = new Map();
        placedBlocks = [];
        placeBlock = (gx, gz, blockId, _r, _g, _b, _a) => {
            blockMeshes.set(blockKey(gx, gz), createMockMesh());
            placedBlocks.push({ gx, gz, blockId });
        };
    });

    it('AOI外のブロックメッシュが破棄される', () => {
        // チャンク(2,2)にブロックメッシュを配置（AOI外になる予定）
        const gx = 2 * CHUNK_SIZE + 5; // = 37
        const gz = 2 * CHUNK_SIZE + 3; // = 35
        const mesh = createMockMesh();
        blockMeshes.set(blockKey(gx, gz), mesh);

        // AOIをチャンク(10,10)-(12,12)に設定 → チャンク(2,2)はAOI外
        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(mesh.disposed).toBe(true);
        expect(blockMeshes.has(blockKey(gx, gz))).toBe(false);
        expect(result.disposed.length).toBe(1);
    });

    it('AOI内のブロックメッシュは破棄されない', () => {
        // チャンク(10,10)にブロックメッシュを配置（AOI内）
        const gx = 10 * CHUNK_SIZE + 5;
        const gz = 10 * CHUNK_SIZE + 3;
        const mesh = createMockMesh();
        blockMeshes.set(blockKey(gx, gz), mesh);

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(mesh.disposed).toBe(false);
        expect(blockMeshes.has(blockKey(gx, gz))).toBe(true);
        expect(result.disposed.length).toBe(0);
    });

    it('AOI境界上のブロックは保持される', () => {
        // チャンク(10,10)の最初のセル（境界上）
        const gx = 10 * CHUNK_SIZE; // = 160
        const gz = 10 * CHUNK_SIZE; // = 160
        const mesh = createMockMesh();
        blockMeshes.set(blockKey(gx, gz), mesh);

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(mesh.disposed).toBe(false);
        expect(blockMeshes.has(blockKey(gx, gz))).toBe(true);
    });

    it('AOI境界直外のブロックは破棄される', () => {
        // チャンク(9,10)の最後のセル（AOI外、境界の1チャンク外）
        const gx = 9 * CHUNK_SIZE + (CHUNK_SIZE - 1); // = 159
        const gz = 10 * CHUNK_SIZE;
        const mesh = createMockMesh();
        blockMeshes.set(blockKey(gx, gz), mesh);

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(mesh.disposed).toBe(true);
        expect(blockMeshes.has(blockKey(gx, gz))).toBe(false);
    });

    it('複数のAOI外ブロックがすべて破棄される', () => {
        const meshes: MockMesh[] = [];
        // 4つの異なるチャンクにブロックを配置（すべてAOI外）
        for (const [cx, cz] of [[0, 0], [1, 1], [50, 50], [63, 63]]) {
            const gx = cx * CHUNK_SIZE + 1;
            const gz = cz * CHUNK_SIZE + 1;
            const mesh = createMockMesh();
            blockMeshes.set(blockKey(gx, gz), mesh);
            meshes.push(mesh);
        }

        const aoi: AOIBounds = { minCX: 30, minCZ: 30, maxCX: 34, maxCZ: 34 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(meshes.every(m => m.disposed)).toBe(true);
        expect(blockMeshes.size).toBe(0);
        expect(result.disposed.length).toBe(4);
    });

    it('AOI内外が混在する場合、外だけ破棄される', () => {
        // AOI内: チャンク(30,30)
        const gxIn = 30 * CHUNK_SIZE + 5;
        const gzIn = 30 * CHUNK_SIZE + 5;
        const meshIn = createMockMesh();
        blockMeshes.set(blockKey(gxIn, gzIn), meshIn);

        // AOI外: チャンク(0,0)
        const gxOut = 5;
        const gzOut = 5;
        const meshOut = createMockMesh();
        blockMeshes.set(blockKey(gxOut, gzOut), meshOut);

        const aoi: AOIBounds = { minCX: 30, minCZ: 30, maxCX: 34, maxCZ: 34 };
        refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(meshIn.disposed).toBe(false);
        expect(meshOut.disposed).toBe(true);
        expect(blockMeshes.size).toBe(1);
    });
});

describe('refreshBlocksForAOI キャッシュ描画テスト', () => {
    let blockMeshes: Map<number, MockMesh>;
    let chunks: Map<string, ChunkData>;
    let placedBlocks: { gx: number; gz: number; blockId: number }[];
    let placeBlock: (gx: number, gz: number, blockId: number, r: number, g: number, b: number, a: number) => void;

    beforeEach(() => {
        blockMeshes = new Map();
        chunks = new Map();
        placedBlocks = [];
        placeBlock = (gx, gz, blockId, _r, _g, _b, _a) => {
            blockMeshes.set(blockKey(gx, gz), createMockMesh());
            placedBlocks.push({ gx, gz, blockId });
        };
    });

    it('AOI内のキャッシュ済みチャンクのブロックが描画される', () => {
        // チャンク(10,10)にブロックデータをキャッシュ
        chunks.set('10_10', createChunkWithBlocks([
            { lx: 3, lz: 5, blockId: 1 },
            { lx: 7, lz: 8, blockId: 2 },
        ]));

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(result.placed.length).toBe(2);
        expect(result.placed[0]).toEqual({ gx: 10 * CHUNK_SIZE + 3, gz: 10 * CHUNK_SIZE + 5, blockId: 1 });
        expect(result.placed[1]).toEqual({ gx: 10 * CHUNK_SIZE + 7, gz: 10 * CHUNK_SIZE + 8, blockId: 2 });
    });

    it('既にメッシュがあるブロックは再描画されない', () => {
        const gx = 10 * CHUNK_SIZE + 3;
        const gz = 10 * CHUNK_SIZE + 5;
        // 既にメッシュを配置
        blockMeshes.set(blockKey(gx, gz), createMockMesh());

        // 同じ位置にキャッシュデータあり
        chunks.set('10_10', createChunkWithBlocks([
            { lx: 3, lz: 5, blockId: 1 },
        ]));

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        // 新たに描画されない
        expect(result.placed.length).toBe(0);
    });

    it('AOI外のキャッシュ済みチャンクは描画されない', () => {
        // チャンク(5,5)はAOI外
        chunks.set('5_5', createChunkWithBlocks([
            { lx: 0, lz: 0, blockId: 1 },
        ]));

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(result.placed.length).toBe(0);
    });

    it('blockId=0（空）のセルは描画されない', () => {
        // 空セルのみ（デフォルトは0）
        chunks.set('10_10', createChunkWithBlocks([]));

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 12, maxCZ: 12 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(result.placed.length).toBe(0);
    });

    it('色情報が正しく渡される', () => {
        let capturedArgs: { r: number; g: number; b: number; a: number } | null = null;
        const capturePlaceBlock = (gx: number, gz: number, _blockId: number, r: number, g: number, b: number, a: number) => {
            blockMeshes.set(blockKey(gx, gz), createMockMesh());
            capturedArgs = { r, g, b, a };
        };

        chunks.set('10_10', createChunkWithBlocks([
            { lx: 0, lz: 0, blockId: 1, r: 128, g: 64, b: 32, a: 200 },
        ]));

        const aoi: AOIBounds = { minCX: 10, minCZ: 10, maxCX: 10, maxCZ: 10 };
        refreshBlocksForAOI(aoi, blockMeshes, chunks, capturePlaceBlock);

        expect(capturedArgs).toEqual({ r: 128, g: 64, b: 32, a: 200 });
    });
});

describe('refreshBlocksForAOI AOI移動シナリオテスト', () => {
    let blockMeshes: Map<number, MockMesh>;
    let chunks: Map<string, ChunkData>;
    let placedBlocks: { gx: number; gz: number; blockId: number }[];
    let placeBlock: (gx: number, gz: number, blockId: number, r: number, g: number, b: number, a: number) => void;

    beforeEach(() => {
        blockMeshes = new Map();
        chunks = new Map();
        placedBlocks = [];
        placeBlock = (gx, gz, blockId, _r, _g, _b, _a) => {
            blockMeshes.set(blockKey(gx, gz), createMockMesh());
            placedBlocks.push({ gx, gz, blockId });
        };
    });

    it('AOIが移動すると旧範囲のブロックが破棄され新範囲のブロックが描画される', () => {
        // 初期状態: チャンク(10,10)にブロックあり
        const gx1 = 10 * CHUNK_SIZE + 1;
        const gz1 = 10 * CHUNK_SIZE + 1;
        blockMeshes.set(blockKey(gx1, gz1), createMockMesh());

        // チャンク(20,20)にキャッシュデータあり
        chunks.set('20_20', createChunkWithBlocks([
            { lx: 2, lz: 3, blockId: 5 },
        ]));

        // AOI1: チャンク(10,10)を含む → チャンク(20,20)を含まない
        const aoi1: AOIBounds = { minCX: 8, minCZ: 8, maxCX: 12, maxCZ: 12 };
        refreshBlocksForAOI(aoi1, blockMeshes, chunks, placeBlock);
        expect(blockMeshes.has(blockKey(gx1, gz1))).toBe(true);
        expect(placedBlocks.length).toBe(0);

        // AOI2: チャンク(20,20)を含む → チャンク(10,10)を含まない
        placedBlocks.length = 0;
        const aoi2: AOIBounds = { minCX: 18, minCZ: 18, maxCX: 22, maxCZ: 22 };
        const result = refreshBlocksForAOI(aoi2, blockMeshes, chunks, placeBlock);

        // 旧ブロック破棄
        expect(result.disposed.length).toBe(1);
        expect(blockMeshes.has(blockKey(gx1, gz1))).toBe(false);

        // 新ブロック描画
        expect(result.placed.length).toBe(1);
        expect(result.placed[0].gx).toBe(20 * CHUNK_SIZE + 2);
        expect(result.placed[0].gz).toBe(20 * CHUNK_SIZE + 3);
    });

    it('AOIが1チャンク分だけスライドすると差分のみ更新される', () => {
        // チャンク(10,10)と(11,10)にブロック配置
        const gx10 = 10 * CHUNK_SIZE + 1;
        const gz10 = 10 * CHUNK_SIZE + 1;
        blockMeshes.set(blockKey(gx10, gz10), createMockMesh());

        const gx11 = 11 * CHUNK_SIZE + 1;
        const gz11 = 10 * CHUNK_SIZE + 1;
        blockMeshes.set(blockKey(gx11, gz11), createMockMesh());

        // チャンク(12,10)にキャッシュ
        chunks.set('12_10', createChunkWithBlocks([
            { lx: 0, lz: 0, blockId: 3 },
        ]));

        // AOI: (10,10)-(11,10) → (11,10)-(12,10) にスライド
        const aoi: AOIBounds = { minCX: 11, minCZ: 10, maxCX: 12, maxCZ: 10 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        // チャンク(10,10)が破棄される
        expect(blockMeshes.has(blockKey(gx10, gz10))).toBe(false);
        // チャンク(11,10)は残る
        expect(blockMeshes.has(blockKey(gx11, gz11))).toBe(true);
        // チャンク(12,10)が新規描画
        expect(result.placed.length).toBe(1);
        expect(result.placed[0].gx).toBe(12 * CHUNK_SIZE);
    });

    it('センチネル値（minCX < 0）の場合は何もしない', () => {
        blockMeshes.set(blockKey(100, 100), createMockMesh());
        chunks.set('10_10', createChunkWithBlocks([{ lx: 0, lz: 0, blockId: 1 }]));

        const aoi: AOIBounds = { minCX: -1, minCZ: -1, maxCX: -1, maxCZ: -1 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(result.disposed.length).toBe(0);
        expect(result.placed.length).toBe(0);
        expect(blockMeshes.size).toBe(1); // 変化なし
    });

    it('ブロックが大量にある場合でも正しく処理される', () => {
        // チャンク(5,5)に256ブロック配置（全セル）
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                const gx = 5 * CHUNK_SIZE + lx;
                const gz = 5 * CHUNK_SIZE + lz;
                blockMeshes.set(blockKey(gx, gz), createMockMesh());
            }
        }
        expect(blockMeshes.size).toBe(256);

        // AOIをチャンク(5,5)を含まない範囲に変更
        const aoi: AOIBounds = { minCX: 30, minCZ: 30, maxCX: 34, maxCZ: 34 };
        const result = refreshBlocksForAOI(aoi, blockMeshes, chunks, placeBlock);

        expect(result.disposed.length).toBe(256);
        expect(blockMeshes.size).toBe(0);
    });
});

describe('refreshBlocksForAOI blockKeyの正確性テスト', () => {
    it('blockKey から gx/gz/cx/cz を正しく逆算できる', () => {
        // blockKey = gx * WORLD_SIZE + gz の逆算テスト
        const testCases = [
            { gx: 0, gz: 0, cx: 0, cz: 0 },
            { gx: 15, gz: 15, cx: 0, cz: 0 },        // チャンク(0,0)の最後
            { gx: 16, gz: 0, cx: 1, cz: 0 },          // チャンク(1,0)の最初
            { gx: 512, gz: 512, cx: 32, cz: 32 },      // ワールド中心
            { gx: 1023, gz: 1023, cx: 63, cz: 63 },    // ワールド端
        ];

        for (const tc of testCases) {
            const key = blockKey(tc.gx, tc.gz);
            const derivedGx = Math.floor(key / WORLD_SIZE);
            const derivedGz = key % WORLD_SIZE;
            const derivedCx = Math.floor(derivedGx / CHUNK_SIZE);
            const derivedCz = Math.floor(derivedGz / CHUNK_SIZE);

            expect(derivedGx).toBe(tc.gx);
            expect(derivedGz).toBe(tc.gz);
            expect(derivedCx).toBe(tc.cx);
            expect(derivedCz).toBe(tc.cz);
        }
    });
});
