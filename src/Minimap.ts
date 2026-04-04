import type { GameScene } from "./GameScene";
import { CHUNK_SIZE, WORLD_SIZE } from "./WorldConstants";

const HALF = WORLD_SIZE / 2;
const BG_COLOR = "#4a7a3a"; // 地面の緑
const ZOOM_LEVELS = [1, 2, 4, 8];

/**
 * ミニマップ — ワールドを 128×128 の 2D Canvas に描画
 *  - 地面: 緑背景
 *  - ブロック: 実際の色
 *  - 自分: 白い点
 *  - 他プレイヤー: 黄色い点
 *  - ズーム: +/- ボタン、ホイール、倍率表示
 */
export function setupMinimap(game: GameScene): void {
    const canvas = document.getElementById("minimap") as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const container = document.getElementById("minimap-container");
    if (!container) return;

    const isMobile = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;

    // PC のみツールチップ
    if (!isMobile) {
        canvas.title = "ミニマップ\nワールド全体の俯瞰図\n緑: 地面\n色付き: ブロック\n白▲: 自分\n緑▲: 他プレイヤー\n\nドラッグ: 移動\n右下ドラッグ: リサイズ\nホイール: ズーム";
    }

    // --- Cookie ヘルパー ---
    const ckGet = (name: string): string | null => {
        const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
        return m ? decodeURIComponent(m[1]) : null;
    };
    const ckSet = (name: string, value: string) => {
        document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${60*60*24*365}`;
    };

    // --- メニュートグル（表示/非表示） ---
    // --- 表示/非表示トグル ---
    const menuBtn = document.getElementById("menu-minimap");
    const savedVisible = ckGet("mmVisible");
    let mmVisible = savedVisible !== "0";

    const updateVisibility = () => {
        container.style.display = mmVisible ? "" : "none";
        if (menuBtn) menuBtn.textContent = (mmVisible ? "✓" : "　") + " ミニマップ";
        ckSet("mmVisible", mmVisible ? "1" : "0");
    };
    updateVisibility();

    if (menuBtn) {
        menuBtn.addEventListener("click", () => {
            mmVisible = !mmVisible;
            updateVisibility();
            (game as any).closeMenu?.(menuBtn);
        });
    }

    // --- Cookie から復元 ---
    const savedZoom = ckGet("mmZoom");
    const savedLeft = ckGet("mmLeft");
    const savedTop = ckGet("mmTop");
    const savedSize = ckGet("mmSize");

    if (savedLeft !== null && savedTop !== null) {
        container.style.left = savedLeft + "px";
        container.style.top = savedTop + "px";
        container.style.right = "auto";
    }
    if (savedSize !== null) {
        container.style.width = savedSize + "px";
        container.style.height = savedSize + "px";
    }

    // --- ズーム状態 ---
    let zoomIndex = savedZoom !== null ? Math.max(0, Math.min(ZOOM_LEVELS.length - 1, parseInt(savedZoom))) : 0;
    let zoom = ZOOM_LEVELS[zoomIndex];

    // --- UI: Xボタン（左上） + +/-ボタン（右上） + 倍率表示 ---
    const btnSize = isMobile ? "28px" : "20px";
    const btnFont = isMobile ? "16px" : "14px";
    const btnStyle = `width:${btnSize};height:${btnSize};font-size:${btnFont};line-height:1;border:1px solid rgba(0,0,0,0.3);border-radius:3px;background:rgba(255,255,255,0.4);cursor:pointer;padding:0;text-align:center;font-weight:bold;color:#333;`;

    // Xボタン（右上）
    const btnClose = document.createElement("button");
    btnClose.textContent = "✕";
    btnClose.style.cssText = `position:absolute;top:2px;right:2px;width:${btnSize};height:${btnSize};font-size:${btnFont};line-height:1;border:none;border-radius:3px;background:rgba(200,0,0,0.6);cursor:pointer;padding:0;text-align:center;font-weight:bold;color:#fff;pointer-events:auto;`;
    if (!isMobile) btnClose.title = "ミニマップを非表示（メニューから再表示）";
    btnClose.addEventListener("click", (e) => { e.stopPropagation(); mmVisible = false; updateVisibility(); });
    container.appendChild(btnClose);

    // +/-ボタン（左下）
    const controls = document.createElement("div");
    controls.style.cssText = "position:absolute;top:2px;left:2px;display:flex;flex-direction:column;align-items:center;gap:1px;pointer-events:auto;";

    const btnPlus = document.createElement("button");
    btnPlus.textContent = "+";
    btnPlus.style.cssText = btnStyle;
    if (!isMobile) btnPlus.title = "ズームイン";

    const btnMinus = document.createElement("button");
    btnMinus.textContent = "−";
    btnMinus.style.cssText = btnStyle;
    if (!isMobile) btnMinus.title = "ズームアウト";

    const zoomLabel = document.createElement("div");
    zoomLabel.style.cssText = "font-size:12px;font-family:monospace;color:#fff;text-shadow:0 0 2px #000,0 0 4px #000;pointer-events:none;white-space:nowrap;";

    const updateZoomLabel = () => { zoomLabel.textContent = `×${zoom}`; };
    updateZoomLabel();

    controls.appendChild(btnPlus);
    controls.appendChild(btnMinus);
    controls.appendChild(zoomLabel);
    container.style.position = "fixed"; // 既に fixed だが念のため
    container.appendChild(controls);

    const setZoom = (idx: number) => {
        zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx));
        zoom = ZOOM_LEVELS[zoomIndex];
        updateZoomLabel();
        ckSet("mmZoom", String(zoomIndex));
        redraw();
    };

    btnPlus.addEventListener("click", (e) => { e.stopPropagation(); setZoom(zoomIndex + 1); });
    btnMinus.addEventListener("click", (e) => { e.stopPropagation(); setZoom(zoomIndex - 1); });

    // 3Dシーンへのイベント伝播を防止
    for (const ev of ["click", "contextmenu"] as const) {
        container.addEventListener(ev, (e) => e.stopPropagation());
    }

    // --- ドラッグ移動 & リサイズ（タッチイベント直接制御 — iOS Safari対応） ---
    let dragging = false;
    let resizing = false;
    let dragOffX = 0, dragOffY = 0;
    let resizeStartSize = 0, resizeStartX = 0, resizeStartY = 0;
    const HANDLE = isMobile ? 28 : 12;

    const onStart = (cx: number, cy: number, target: HTMLElement) => {
        if (target.tagName === "BUTTON") return;
        const rect = container.getBoundingClientRect();
        if (cx > rect.right - HANDLE && cy > rect.bottom - HANDLE) {
            resizing = true;
            resizeStartSize = rect.width;
            resizeStartX = cx;
            resizeStartY = cy;
        } else {
            dragging = true;
            dragOffX = cx - rect.left;
            dragOffY = cy - rect.top;
        }
    };

    const onMove = (cx: number, cy: number) => {
        if (dragging) {
            container.style.left = Math.max(0, cx - dragOffX) + "px";
            container.style.top = Math.max(0, cy - dragOffY) + "px";
            container.style.right = "auto";
            container.style.bottom = "auto";
        } else if (resizing) {
            const dx = cx - resizeStartX;
            const dy = cy - resizeStartY;
            const delta = Math.max(dx, dy);
            const newSize = Math.max(64, Math.min(400, resizeStartSize + delta));
            container.style.width = newSize + "px";
            container.style.height = newSize + "px";
        }
    };

    const onEnd = () => {
        if (dragging) {
            const rect = container.getBoundingClientRect();
            ckSet("mmLeft", String(Math.round(rect.left)));
            ckSet("mmTop", String(Math.round(rect.top)));
        }
        if (resizing) {
            const rect = container.getBoundingClientRect();
            ckSet("mmSize", String(Math.round(rect.width)));
        }
        dragging = false;
        resizing = false;
    };

    // ポインターイベント（PC）
    let activePointerId = -1;
    container.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        // 2本目の指が来たらドラッグ中断
        if (activePointerId >= 0 && e.pointerId !== activePointerId) { onEnd(); activePointerId = -1; return; }
        activePointerId = e.pointerId;
        onStart(e.clientX, e.clientY, e.target as HTMLElement);
        container.setPointerCapture(e.pointerId);
    });
    container.addEventListener("pointermove", (e) => {
        if (!dragging && !resizing) return;
        e.stopPropagation();
        e.preventDefault();
        onMove(e.clientX, e.clientY);
    });
    container.addEventListener("pointerup", (e) => { e.stopPropagation(); onEnd(); activePointerId = -1; });

    // タッチイベント（iOS Safari — pointerイベントより確実）
    let pinching = false;
    let lastPinchDist = 0;

    const getTouchDist = (e: TouchEvent): number => {
        const t0 = e.touches[0], t1 = e.touches[1];
        const dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
        return Math.sqrt(dx * dx + dy * dy);
    };

    container.addEventListener("touchstart", (e) => {
        e.stopPropagation();
        if (e.touches.length >= 2) {
            e.preventDefault();
            onEnd();
            pinching = true;
            lastPinchDist = getTouchDist(e);
            return;
        }
        pinching = false;
        const t = e.touches[0];
        const target = document.elementFromPoint(t.clientX, t.clientY) as HTMLElement;
        if (target?.tagName === "BUTTON") return; // ボタンはブラウザのclick処理に委任
        e.preventDefault();
        onStart(t.clientX, t.clientY, target);
    }, { passive: false });
    container.addEventListener("touchmove", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.touches.length >= 2 && pinching) {
            // ピンチズーム
            const dist = getTouchDist(e);
            const delta = dist - lastPinchDist;
            if (Math.abs(delta) > 20) {
                setZoom(zoomIndex + (delta > 0 ? 1 : -1));
                lastPinchDist = dist;
            }
            return;
        }
        if (!dragging && !resizing) return;
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
    }, { passive: false });
    container.addEventListener("touchend", (e) => {
        e.stopPropagation();
        if (e.touches.length === 0) { pinching = false; onEnd(); }
    });

    // PC: ホイールズーム
    container.addEventListener("wheel", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.deltaY < 0) setZoom(zoomIndex + 1);
        else if (e.deltaY > 0) setZoom(zoomIndex - 1);
    }, { passive: false });

    // --- 描画 ---

    /** Canvas 内部解像度を表示サイズに合わせる */
    let mapSize = 128;
    const syncCanvasSize = () => {
        const dpr = window.devicePixelRatio || 1;
        const displayW = container.clientWidth;
        const sz = Math.round(displayW * dpr);
        if (canvas.width !== sz || canvas.height !== sz) {
            canvas.width = sz;
            canvas.height = sz;
            mapSize = sz;
        }
    };

    /** ワールド座標 → ミニマップ座標（ズーム・プレイヤー中心対応） */
    const toMap = (wx: number, wz: number): [number, number] => {
        const p = game.playerBox.position;
        const viewSize = WORLD_SIZE / zoom;
        const viewLeft = p.x + HALF - viewSize / 2;
        const viewBottom = p.z + HALF - viewSize / 2;

        const scale = mapSize / viewSize;
        const mx = Math.floor((wx + HALF - viewLeft) * scale);
        const my = mapSize - 1 - Math.floor((wz + HALF - viewBottom) * scale);
        return [mx, my];
    };

    /** 座標がミニマップ内にあるか */
    const inBounds = (mx: number, my: number): boolean =>
        mx >= 0 && mx < mapSize && my >= 0 && my < mapSize;


    /** 三角形（向き付きアイコン）を描画 */
    const drawArrow = (cx: number, cy: number, rotation: number, color: string, size: number) => {
        const ca = rotation - Math.PI;
        const tipX = cx + Math.sin(ca) * size;
        const tipY = cy - Math.cos(ca) * size;
        const baseL = size * 0.675;
        const backAngle = Math.PI * 0.75;
        const lx = cx + Math.sin(ca + backAngle) * baseL;
        const ly = cy - Math.cos(ca + backAngle) * baseL;
        const rx = cx + Math.sin(ca - backAngle) * baseL;
        const ry2 = cy - Math.cos(ca - backAngle) * baseL;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(lx, ly);
        ctx.lineTo(rx, ry2);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    };

    /** プレイヤーの三角形を描画（自分を最前面） */
    const drawPlayers = () => {
        const scale = mapSize / 128;
        const arrowSize = 5 * scale;

        // 他プレイヤー（黄色）— 先に描画
        for (const [sid, av] of game.remoteAvatars) {
            const tgt = game.remoteTargets.get(sid);
            const x = tgt ? tgt.x : av.position.x;
            const z = tgt ? tgt.z : av.position.z;
            const [mx, my] = toMap(x, z);
            if (!inBounds(mx, my)) continue;
            drawArrow(mx, my, av.rotation.y, "#00cc44", arrowSize * 0.85);
        }

        // 自分（赤）— 最後に描画（常に最前面）
        const p = game.playerBox.position;
        const [sx, sy] = toMap(p.x, p.z);
        drawArrow(sx, sy, game.playerBox.rotation.y, "#ffffff", arrowSize);
    };

    const redraw = () => {
        chunkCacheValid = false;
    };

    // 初回描画
    syncCanvasSize();

    // チャンクデータのキャッシュ画像（ブロック＋方角）
    let chunkCacheValid = false;
    const chunkCache = document.createElement("canvas");
    const chunkCacheCtx = chunkCache.getContext("2d")!;

    const redrawChunkCache = () => {
        syncCanvasSize();
        chunkCache.width = mapSize;
        chunkCache.height = mapSize;
        drawChunksTo(chunkCacheCtx);
        drawCompassTo(chunkCacheCtx);
        chunkCacheValid = true;
    };

    /** チャンクを指定コンテキストに描画 */
    const drawChunksTo = (c: CanvasRenderingContext2D) => {
        c.fillStyle = BG_COLOR;
        c.fillRect(0, 0, mapSize, mapSize);
        const viewSize = WORLD_SIZE / zoom;
        const blockPx = Math.max(1, Math.ceil(mapSize / viewSize));
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
                    const r = cells[si + 2], g = cells[si + 3], b = cells[si + 4];
                    const gx = cx * CHUNK_SIZE + lx, gz = cz * CHUNK_SIZE + lz;
                    const [mx, my] = toMap(gx - HALF, gz - HALF);
                    if (!inBounds(mx, my)) continue;
                    c.fillStyle = `rgb(${r},${g},${b})`;
                    c.fillRect(mx, my, blockPx, blockPx);
                }
            }
        }
    };

    /** 方角を指定コンテキストに描画 */
    const drawCompassTo = (c: CanvasRenderingContext2D) => {
        const scale = mapSize / 128;
        const fontSize = Math.round(10 * scale);
        const pad = Math.round(8 * scale);
        c.font = `bold ${fontSize}px sans-serif`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillStyle = "rgba(255,255,255,0.8)";
        c.strokeStyle = "rgba(0,0,0,0.5)";
        c.lineWidth = 2 * scale;
        const m = mapSize / 2;
        for (const [text, x, y] of [["N", m, pad], ["S", m, mapSize - pad], ["W", pad, m], ["E", mapSize - pad, m]] as [string, number, number][]) {
            c.strokeText(text, x, y);
            c.fillText(text, x, y);
        }
    };

    // 定期更新
    let frameCount = 0;
    game.scene.onAfterRenderObservable.add(() => {
        frameCount++;
        // チャンク + 方角: 120フレームごと（約2秒）
        if (!chunkCacheValid || frameCount % 120 === 0) {
            redrawChunkCache();
        }
        // プレイヤー: 10フレームごと（約0.17秒）
        if (frameCount % 10 === 0) {
            syncCanvasSize();
            // キャッシュからチャンク＋方角を転写
            ctx.drawImage(chunkCache, 0, 0);
            // プレイヤーを上に描画
            drawPlayers();
        }
    });
}
