import type { GameScene } from "./GameScene";
import { CHUNK_SIZE, WORLD_SIZE } from "./WorldConstants";

const MAP_SIZE = 128; // canvas px
const SCALE = MAP_SIZE / WORLD_SIZE; // 1024 → 128 = 0.125
const HALF = WORLD_SIZE / 2;
const BG_COLOR = "#4a7a3a"; // 地面の緑

/**
 * ミニマップ — ワールド全体を 128×128 の 2D Canvas に描画
 *  - 地面: 緑背景
 *  - ブロック: 実際の色
 *  - 自分: 白い点
 *  - 他プレイヤー: 黄色い点
 */
export function setupMinimap(game: GameScene): void {
    const canvas = document.getElementById("minimap") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 初回塗りつぶし
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    /** ワールド座標 → ミニマップ座標 */
    const toMap = (wx: number, wz: number): [number, number] => {
        const mx = Math.floor((wx + HALF) * SCALE);
        // Z軸: ワールドの+Z=北=上 → ミニマップの上
        const my = MAP_SIZE - 1 - Math.floor((wz + HALF) * SCALE);
        return [
            Math.max(0, Math.min(MAP_SIZE - 1, mx)),
            Math.max(0, Math.min(MAP_SIZE - 1, my)),
        ];
    };

    /** チャンクデータからブロックを描画 */
    const drawChunks = () => {
        // 背景リセット
        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

        for (const [key, chunk] of game.chunks) {
            const parts = key.split("_");
            const cx = parseInt(parts[0]);
            const cz = parseInt(parts[1]);
            const cells = chunk.cells;

            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
                for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                    const si = (lx * CHUNK_SIZE + lz) * 6;
                    const blockId = cells[si] | (cells[si + 1] << 8);
                    if (blockId === 0) continue;

                    const r = cells[si + 2];
                    const g = cells[si + 3];
                    const b = cells[si + 4];

                    // グローバル座標
                    const gx = cx * CHUNK_SIZE + lx;
                    const gz = cz * CHUNK_SIZE + lz;
                    // ワールド座標に変換
                    const wx = gx - HALF;
                    const wz = gz - HALF;
                    const [mx, my] = toMap(wx, wz);

                    ctx.fillStyle = `rgb(${r},${g},${b})`;
                    ctx.fillRect(mx, my, 1, 1);
                }
            }
        }
    };

    /** プレイヤーの点を描画 */
    const drawPlayers = () => {
        // 自分（白、3×3）
        const p = game.playerBox.position;
        const [sx, sy] = toMap(p.x, p.z);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(sx - 1, sy - 1, 3, 3);
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(sx - 1, sy - 1, 3, 3);

        // 他プレイヤー（黄色、2×2）
        ctx.fillStyle = "#ffdd00";
        for (const [sid, av] of game.remoteAvatars) {
            // remoteTargets に最新位置があればそちら、なければアバターの位置
            const tgt = game.remoteTargets.get(sid);
            const x = tgt ? tgt.x : av.position.x;
            const z = tgt ? tgt.z : av.position.z;
            const [rx, ry] = toMap(x, z);
            ctx.fillRect(rx, ry, 2, 2);
        }
    };

    // 定期更新（2秒ごとにチャンク再描画、0.5秒ごとにプレイヤー更新）
    let frameCount = 0;
    game.scene.onAfterRenderObservable.add(() => {
        frameCount++;

        // プレイヤー位置: 30フレームごと（約0.5秒）
        if (frameCount % 30 === 0) {
            drawChunks();
            drawPlayers();
        }
    });
}
