import { DynamicTexture, MeshBuilder, StandardMaterial } from "@babylonjs/core";
import type { GameScene } from "./GameScene";
import { CHUNK_SIZE } from "./WorldConstants";
import { t } from "./i18n";

const BG_COLOR = "#4a7a3a"; // 地面の緑
const ZOOM_LEVELS = [1, 2, 4, 8, 16];

/**
 * ミニマップ — ワールドを 2D Canvas に描画し DynamicTexture 経由で WebGL 内に表示
 *  - DynamicTexture: ブラウザ合成コスト回避（HTML canvas overlay の代わり）
 *  - HTML container: ボタン・ラベル・ドラッグ操作は従来通り
 */
export function setupMinimap(game: GameScene): void {
    const htmlCanvas = document.getElementById("minimap") as HTMLCanvasElement | null;
    if (!htmlCanvas) return;

    const container = document.getElementById("minimap-container");
    if (!container) return;

    const isMobile = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;

    // HTML canvas は非表示（DynamicTexture 経由で WebGL 内に描画）
    htmlCanvas.style.display = "none";

    // WebGL/Canvas リソースは初回表示まで遅延生成
    const MAP_RES = 256;
    let mapSize = MAP_RES;
    let offCanvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let dt: DynamicTexture | null = null;
    let mmPlane: import("@babylonjs/core").Mesh | null = null;
    let chunkCache: HTMLCanvasElement | null = null;
    let chunkCacheCtx: CanvasRenderingContext2D | null = null;
    let chunkCacheValid = false;
    let playerDirty = true;

    const ensureResources = (): boolean => {
        if (dt) return true;
        offCanvas = document.createElement("canvas");
        offCanvas.width = MAP_RES;
        offCanvas.height = MAP_RES;
        ctx = offCanvas.getContext("2d")!;
        dt = new DynamicTexture("minimapDT", MAP_RES, game.scene, false);
        dt.hasAlpha = true;
        mmPlane = MeshBuilder.CreatePlane("minimapPlane", { size: 1 }, game.scene);
        const mmMat = new StandardMaterial("minimapMat", game.scene);
        mmMat.emissiveTexture = dt;
        mmMat.opacityTexture = dt;
        mmMat.disableLighting = true;
        mmMat.backFaceCulling = false;
        mmPlane.material = mmMat;
        mmPlane.renderingGroupId = 3;
        mmPlane.isPickable = false;
        mmPlane.parent = game.camera;
        mmPlane.alphaIndex = 100;
        chunkCache = document.createElement("canvas");
        chunkCache.width = mapSize;
        chunkCache.height = mapSize;
        chunkCacheCtx = chunkCache.getContext("2d")!;
        chunkCacheValid = false;
        playerDirty = true;
        return true;
    };

    // PC のみツールチップ
    if (!isMobile && game.tooltipsEnabled) {
        container.title = "ミニマップ\nワールド全体の俯瞰図\n緑: 地面\n色付き: ブロック\n白▲: 自分\n緑▲: 他プレイヤー\n\nドラッグ: 移動\n右下ドラッグ: リサイズ\nホイール: ズーム";
    }

    /** 平面メッシュの位置・サイズを HTML container に同期 */
    const syncPlaneToContainer = () => {
        if (!mmPlane) return;
        if (!mmVisible) {
            mmPlane.setEnabled(false);
            return;
        }
        mmPlane.setEnabled(true);
        const rect = container.getBoundingClientRect();
        // CSS ピクセルで統一（getBoundingClientRect と同じ座標系）
        const renderCanvas = game.engine.getRenderingCanvas();
        if (!renderCanvas) return;
        const sw = renderCanvas.clientWidth;
        const sh = renderCanvas.clientHeight;
        if (sw === 0 || sh === 0) return;

        // renderCanvas の画面上のオフセットも考慮
        const canvasRect = renderCanvas.getBoundingClientRect();

        // カメラ情報
        const cam = game.camera;
        const fov = cam.fov;
        const dist = cam.minZ + 0.5;
        const halfH = dist * Math.tan(fov / 2);
        const halfW = halfH * (sw / sh);

        // HTML container の中心を renderCanvas 内の正規化座標に変換
        const cx = (rect.left + rect.width / 2 - canvasRect.left) / sw;
        const cy = (rect.top + rect.height / 2 - canvasRect.top) / sh;
        mmPlane.position.x = (cx * 2 - 1) * halfW;
        mmPlane.position.y = (1 - cy * 2) * halfH;
        mmPlane.position.z = dist;

        // サイズ（CSS pixel → カメラローカルスケール）
        const sizeW = (rect.width / sw) * halfW * 2;
        const sizeH = (rect.height / sh) * halfH * 2;
        mmPlane.scaling.x = sizeW;
        mmPlane.scaling.y = sizeH;
    };

    // --- Cookie ヘルパー ---
    const ckGet = (name: string): string | null => {
        const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
        return m ? decodeURIComponent(m[1]) : null;
    };
    const ckSet = (name: string, value: string) => {
        document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${60*60*24*365}`;
    };

    // --- メニュートグル（表示/非表示） ---
    const menuBtn = document.getElementById("menu-minimap");
    const savedVisible = ckGet("mmVisible");
    let mmVisible = savedVisible !== "0";

    let onVisibilityChanged: (() => void) | null = null;
    let savedTop: number | null = null;
    let savedLeft: number | null = null;
    let savedWidth: number | null = null;
    const updateVisibility = () => {
        if (!mmVisible) {
            const rect = container.getBoundingClientRect();
            savedTop = rect.top;
            savedLeft = rect.left;
            savedWidth = rect.width;
        }
        container.style.display = mmVisible ? "" : "none";
        container.style.pointerEvents = mmVisible ? "auto" : "none";
        mmPlane?.setEnabled(mmVisible);
        if (menuBtn) menuBtn.textContent = (mmVisible ? "✓" : "　") + " " + t("menu.minimap");
        ckSet("mmVisible", mmVisible ? "1" : "0");
        if (mmVisible) {
            if (savedTop !== null && savedLeft !== null) {
                container.style.top = savedTop + "px";
                container.style.left = savedLeft + "px";
                container.style.right = "auto";
                container.style.bottom = "auto";
            }
            if (savedWidth !== null) {
                container.style.width = savedWidth + "px";
                container.style.height = savedWidth + "px";
            }
            onVisibilityChanged?.();
            requestAnimationFrame(() => clampToCanvas());
        }
    };
    updateVisibility();

    if (menuBtn) {
        menuBtn.addEventListener("click", () => {
            mmVisible = !mmVisible;
            updateVisibility();
            (game as any).closeMenu?.(menuBtn);
        });
    }

    game.onDividerMove.push(() => clampToCanvas());

    // --- Cookie から復元 ---
    const savedZoom = ckGet("mmZoom");
    const ckLeft = ckGet("mmLeft");
    const ckTop = ckGet("mmTop");
    const savedSize = ckGet("mmSize");

    if (ckLeft !== null && ckTop !== null) {
        const l = parseInt(ckLeft), t = parseInt(ckTop);
        if (isFinite(l) && isFinite(t) && l >= 0 && t >= 0 && l < window.innerWidth && t < window.innerHeight) {
            container.style.left = l + "px";
            container.style.top = t + "px";
            container.style.right = "auto";
        }
    }
    if (savedSize !== null) {
        const s = parseInt(savedSize);
        if (isFinite(s) && s >= 64 && s <= 400) {
            container.style.width = s + "px";
            container.style.height = s + "px";
        }
    }

    requestAnimationFrame(() => saveMarginFromRight());

    // --- ズーム状態 ---
    let zoomIndex = savedZoom !== null ? Math.max(0, Math.min(ZOOM_LEVELS.length - 1, parseInt(savedZoom))) : ZOOM_LEVELS.length - 1;
    let zoom = ZOOM_LEVELS[zoomIndex];

    // --- 回転モード ---
    const savedMmRotate = ckGet("mmRotate");
    game.minimapRotate = savedMmRotate !== null ? savedMmRotate === "1" : true;

    // --- UI: ボタン類 ---
    const btnSize = isMobile ? "32px" : "24px";
    const btnFont = isMobile ? "18px" : "16px";
    const closeBtnSize = isMobile ? "36px" : "28px";
    const closeBtnFont = isMobile ? "22px" : "20px";
    const btnStyle = `width:${btnSize};height:${btnSize};font-size:${btnFont};line-height:1;border:1px solid rgba(0,0,0,0.3);border-radius:3px;background:rgba(255,255,255,0.4);cursor:pointer;padding:0;text-align:center;font-weight:bold;color:#333;`;

    // Xボタン（右上）
    const btnClose = document.createElement("button");
    btnClose.textContent = "✕";
    btnClose.style.cssText = `position:absolute;top:2px;right:2px;width:${closeBtnSize};height:${closeBtnSize};font-size:${closeBtnFont};line-height:1;border:none;border-radius:3px;background:rgba(255,255,255,0.3);cursor:pointer;padding:0;text-align:center;font-weight:bold;color:#cc0000;pointer-events:auto;z-index:2;`;
    if (!isMobile) btnClose.title = "ミニマップを非表示（メニューから再表示）";
    btnClose.addEventListener("click", (e) => { e.stopPropagation(); mmVisible = false; updateVisibility(); });
    container.appendChild(btnClose);

    // 自分マーカー（回転モード用 — 非回転レイヤーに固定表示）
    const selfMarker = document.createElement("div");
    selfMarker.style.cssText = "position:absolute;top:50%;left:50%;width:0;height:0;transform:translate(-50%,-70%);border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid #ffffff;pointer-events:none;z-index:1;display:none;filter:drop-shadow(0 0 2px rgba(0,0,0,0.8));";
    container.appendChild(selfMarker);

    // +/-ボタン（左上）
    const controls = document.createElement("div");
    controls.style.cssText = "position:absolute;top:2px;left:2px;display:flex;flex-direction:column;align-items:center;gap:1px;pointer-events:auto;z-index:2;";

    const btnPlus = document.createElement("button");
    btnPlus.textContent = "+";
    btnPlus.style.cssText = btnStyle;

    const btnMinus = document.createElement("button");
    btnMinus.textContent = "−";
    btnMinus.style.cssText = btnStyle;

    const zoomLabel = document.createElement("div");
    zoomLabel.style.cssText = "font-size:12px;font-family:monospace;color:#fff;text-shadow:0 0 2px #000,0 0 4px #000;pointer-events:none;white-space:nowrap;";

    const updateZoomLabel = () => { zoomLabel.textContent = `×${zoom}`; };
    updateZoomLabel();

    controls.appendChild(btnPlus);
    controls.appendChild(btnMinus);
    container.style.position = "fixed";
    container.appendChild(controls);

    // 倍率ラベル（常時表示 — controls とは独立）
    zoomLabel.style.cssText += "position:absolute;bottom:2px;left:4px;z-index:1;";
    container.appendChild(zoomLabel);

    const setZoom = (idx: number) => {
        zoomIndex = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx));
        zoom = ZOOM_LEVELS[zoomIndex];
        updateZoomLabel();
        ckSet("mmZoom", String(zoomIndex));
        redraw();
    };

    btnPlus.addEventListener("click", (e) => { e.stopPropagation(); setZoom(zoomIndex + 1); });
    btnMinus.addEventListener("click", (e) => { e.stopPropagation(); setZoom(zoomIndex - 1); });

    // --- ボタン表示トグル（タップで表示/非表示） ---
    const resizeHandle = document.getElementById("minimap-resize-handle");
    const uiElements = [btnClose, controls, resizeHandle].filter(Boolean) as HTMLElement[];
    let uiShown = true;
    const setUiVisible = (show: boolean) => {
        uiShown = show;
        for (const el of uiElements) el.style.display = show ? "" : "none";
    };
    setUiVisible(false); // 初期は非表示

    let tapStartX = 0, tapStartY = 0;
    const TAP_THRESHOLD = 10; // px 以内ならタップ判定
    container.addEventListener("pointerdown", (e) => {
        tapStartX = e.clientX; tapStartY = e.clientY;
    }, true);

    for (const ev of ["click", "contextmenu"] as const) {
        container.addEventListener(ev, (e) => e.stopPropagation());
    }

    // --- ドラッグ移動 & リサイズ ---
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

    const getCanvasRect = (): { left: number; top: number; right: number; bottom: number } => {
        const cvs = document.getElementById("renderCanvas");
        if (cvs) {
            const r = cvs.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        }
        return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    };

    let marginFromRight = 4;
    const saveMarginFromRight = () => {
        const cr = getCanvasRect();
        const rect = container.getBoundingClientRect();
        marginFromRight = Math.max(4, cr.right - rect.right);
    };

    const clampToCanvas = () => {
        const cr = getCanvasRect();
        const availW = cr.right - cr.left - 8;
        const availH = cr.bottom - cr.top - 8;
        let w = container.offsetWidth;
        let h = container.offsetHeight;
        if (w > availW || h > availH) {
            const newSize = Math.max(64, Math.min(availW, availH));
            container.style.width = newSize + "px";
            container.style.height = newSize + "px";
            w = h = newSize;
            ckSet("mmSize", String(Math.round(newSize)));
        }
        const rect = container.getBoundingClientRect();
        let newLeft = cr.right - w - marginFromRight;
        let newTop = rect.top;
        if (newLeft + w > cr.right - 4) newLeft = cr.right - w - 4;
        if (newTop + h > cr.bottom - 4) newTop = cr.bottom - h - 4;
        if (newLeft < cr.left) newLeft = cr.left + 4;
        if (newTop < cr.top) newTop = cr.top + 4;
        if (newLeft !== rect.left || newTop !== rect.top) {
            container.style.left = Math.max(0, newLeft) + "px";
            container.style.top = Math.max(0, newTop) + "px";
            container.style.right = "auto";
            container.style.bottom = "auto";
            ckSet("mmLeft", String(Math.round(newLeft)));
            ckSet("mmTop", String(Math.round(newTop)));
        }
    };

    const onMove = (cx: number, cy: number) => {
        if (dragging) {
            const cr = getCanvasRect();
            const w = container.offsetWidth;
            const h = container.offsetHeight;
            const newLeft = Math.max(cr.left, Math.min(cx - dragOffX, cr.right - w - 4));
            const newTop = Math.max(cr.top, Math.min(cy - dragOffY, cr.bottom - h - 4));
            container.style.left = newLeft + "px";
            container.style.top = newTop + "px";
            container.style.right = "auto";
            container.style.bottom = "auto";
        } else if (resizing) {
            const dx = cx - resizeStartX;
            const dy = cy - resizeStartY;
            const delta = Math.max(dx, dy);
            const newSize = Math.max(64, Math.min(400, resizeStartSize + delta));
            container.style.width = newSize + "px";
            container.style.height = newSize + "px";
            playerDirty = true;
        }
    };

    const onEnd = () => {
        if (dragging) {
            const rect = container.getBoundingClientRect();
            ckSet("mmLeft", String(Math.round(rect.left)));
            ckSet("mmTop", String(Math.round(rect.top)));
            saveMarginFromRight();
        }
        if (resizing) {
            const rect = container.getBoundingClientRect();
            ckSet("mmSize", String(Math.round(rect.width)));
            saveMarginFromRight();
            playerDirty = true;
        }
        dragging = false;
        resizing = false;
    };

    let activePointerId = -1;
    container.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        const t = e.target as HTMLElement;
        if (t.tagName === "BUTTON") return;
        e.preventDefault();
        if (activePointerId >= 0 && e.pointerId !== activePointerId) { onEnd(); activePointerId = -1; return; }
        activePointerId = e.pointerId;
        onStart(e.clientX, e.clientY, t);
        container.setPointerCapture(e.pointerId);
    });
    container.addEventListener("pointermove", (e) => {
        if (!dragging && !resizing) return;
        e.stopPropagation();
        e.preventDefault();
        onMove(e.clientX, e.clientY);
    });
    container.addEventListener("pointerup", (e) => {
        e.stopPropagation();
        onEnd();
        activePointerId = -1;
        // タップ判定（ボタン上でなく、移動距離が小さい場合のみトグル）
        const t = e.target as HTMLElement;
        if (t.tagName === "BUTTON" || t.closest("button")) return;
        const dx = e.clientX - tapStartX, dy = e.clientY - tapStartY;
        if (dx * dx + dy * dy < TAP_THRESHOLD * TAP_THRESHOLD) {
            setUiVisible(!uiShown);
        }
    });

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
        if (target?.tagName === "BUTTON") return;
        e.preventDefault();
        onStart(t.clientX, t.clientY, target);
    }, { passive: false });
    container.addEventListener("touchmove", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.touches.length >= 2 && pinching) {
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

    container.addEventListener("wheel", (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (e.deltaY < 0) setZoom(zoomIndex + 1);
        else if (e.deltaY > 0) setZoom(zoomIndex - 1);
    }, { passive: false });

    // --- 描画 ---

    /** ワールド座標 → ミニマップ座標 */
    const toMap = (wx: number, wz: number): [number, number] => {
        const p = game.playerBox.position;
        const half = game.currentWorldSize / 2;
        const viewSize = game.currentWorldSize / zoom;
        const viewLeft = p.x + half - viewSize / 2;
        const viewBottom = p.z + half - viewSize / 2;
        const scale = mapSize / viewSize;
        const mx = Math.floor((wx + half - viewLeft) * scale);
        const my = mapSize - 1 - Math.floor((wz + half - viewBottom) * scale);
        return [mx, my];
    };

    const inBounds = (mx: number, my: number): boolean =>
        mx >= 0 && mx < mapSize && my >= 0 && my < mapSize;

    /** 三角形（向き付きアイコン）を描画 */
    const drawArrow = (cx: number, cy: number, rotation: number, color: string, size: number) => {
        const ca = -rotation;
        const tipX = cx + Math.sin(ca) * size;
        const tipY = cy + Math.cos(ca) * size;
        const baseL = size * 0.675;
        const backAngle = Math.PI * 0.75;
        const lx = cx + Math.sin(ca + backAngle) * baseL;
        const ly = cy + Math.cos(ca + backAngle) * baseL;
        const rx = cx + Math.sin(ca - backAngle) * baseL;
        const ry2 = cy + Math.cos(ca - backAngle) * baseL;
        if (!ctx) return;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(lx, ly);
        ctx.lineTo(rx, ry2);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
    };

    /** プレイヤーの三角形を描画 */
    const drawPlayers = () => {
        const scale = mapSize / 128;
        const arrowSize = 5 * scale;
        const selfRot = game.playerBox.rotation.y;

        for (const [sid, av] of game.remoteAvatars) {
            const tgt = game.remoteTargets.get(sid);
            const x = tgt ? tgt.x : av.position.x;
            const z = tgt ? tgt.z : av.position.z;
            const [mx, my] = toMap(x, z);
            if (!inBounds(mx, my)) continue;
            const angle = av.rotation.y;
            drawArrow(mx, my, angle, "#00ff55", arrowSize * 0.85);
        }

        if (game.minimapRotate) {
            selfMarker.style.display = "";
        } else {
            selfMarker.style.display = "none";
            const p = game.playerBox.position;
            const [sx, sy] = toMap(p.x, p.z);
            drawArrow(sx, sy, selfRot, "#ffffff", arrowSize);
        }
    };

    const redraw = () => { chunkCacheValid = false; playerDirty = true; };

    // 部屋移動（テレポート）時にチャンクキャッシュを無効化して即再描画
    game.onMoveBookmark.push(() => { chunkCacheValid = false; playerDirty = true; });
    // チャンク同期完了時にキャッシュを無効化（テレポート後の新チャンク到着で再描画）
    game.onChunkSync.push(() => { chunkCacheValid = false; playerDirty = true; });

    // チャンクキャッシュ
    onVisibilityChanged = () => { chunkCacheValid = false; };

    const redrawChunkCache = () => {
        if (!chunkCache || !chunkCacheCtx) return;
        chunkCache.width = mapSize;
        chunkCache.height = mapSize;
        drawChunksTo(chunkCacheCtx);
        chunkCacheValid = true;
    };

    const drawChunksTo = (c: CanvasRenderingContext2D) => {
        c.fillStyle = BG_COLOR;
        c.fillRect(0, 0, mapSize, mapSize);
        const half = game.currentWorldSize / 2;
        const viewSize = game.currentWorldSize / zoom;
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
                    const [mx, my] = toMap(gx - half, gz - half);
                    if (!inBounds(mx, my)) continue;
                    c.fillStyle = `rgb(${r},${g},${b})`;
                    c.fillRect(mx, my, blockPx, blockPx);
                }
            }
        }
    };

    // 方角ラベル（HTML — container 直下）
    const compassStyle = "position:absolute;font:bold 10px sans-serif;color:rgba(255,255,255,0.8);text-shadow:0 0 2px #000,0 0 4px #000;pointer-events:none;z-index:1;";
    const compassLabels: HTMLElement[] = [];
    const compassDirs = [
        { text: "N", angle: 0 },
        { text: "S", angle: Math.PI },
        { text: "W", angle: -Math.PI / 2 },
        { text: "E", angle: Math.PI / 2 },
    ];
    for (const d of compassDirs) {
        const el = document.createElement("div");
        if (d.text === "N") {
            el.textContent = "N";
            el.style.cssText = compassStyle + "color:#ff9900;width:14px;height:14px;line-height:14px;text-align:center;border:1.5px solid #ff9900;border-radius:50%;";
        } else {
            el.textContent = d.text;
            el.style.cssText = compassStyle;
        }
        container.appendChild(el);
        compassLabels.push(el);
    }
    const updateCompassPositions = (rotAngle: number) => {
        const r = container.clientWidth / 2;
        const margin = 2;
        for (let i = 0; i < compassDirs.length; i++) {
            const a = compassDirs[i].angle - rotAngle;
            const el = compassLabels[i];
            const x = r + Math.sin(a) * (r - margin);
            const y = r - Math.cos(a) * (r - margin);
            el.style.left = x + "px";
            el.style.top = y + "px";
            el.style.transform = "translate(-50%,-50%)";
        }
    };
    updateCompassPositions(0);

    // --- 描画ループ ---
    let prevPlayerX = NaN, prevPlayerZ = NaN, prevPlayerRot = NaN;
    let prevRemoteCount = -1;
    const MM_INTERVAL = 100; // ≈ 10 FPS
    let lastMmUpdate = 0;

    game.scene.onAfterRenderObservable.add(() => {
        if (!mmVisible) return;
        ensureResources();
        if (!ctx || !dt || !offCanvas || !chunkCache) return;

        // 平面メッシュを HTML container の位置に同期（毎フレーム、軽い処理）
        syncPlaneToContainer();

        const now = performance.now();
        const rot = game.playerBox.rotation.y;

        // Canvas 再描画は間引き（≈10 FPS）
        if (now - lastMmUpdate < MM_INTERVAL) return;
        lastMmUpdate = now;

        const p = game.playerBox.position;
        const rc = game.remoteAvatars.size;
        if (p.x !== prevPlayerX || p.z !== prevPlayerZ || rot !== prevPlayerRot || rc !== prevRemoteCount || rc > 0) {
            prevPlayerX = p.x; prevPlayerZ = p.z; prevPlayerRot = rot; prevRemoteCount = rc;
            playerDirty = true;
        }

        if (!chunkCacheValid || playerDirty) {
            redrawChunkCache();
        }

        if (playerDirty) {
            const half = mapSize / 2;
            ctx.clearRect(0, 0, mapSize, mapSize);
            // 円形クリップ + 半透明
            ctx.save();
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            ctx.arc(half, half, half, 0, Math.PI * 2);
            ctx.clip();
            if (game.minimapRotate) {
                const angle = -(rot + Math.PI);
                ctx.translate(half, half);
                ctx.rotate(angle);
                ctx.drawImage(chunkCache, -half, -half);
                // プレイヤーも同じ回転で描画（translate back して絶対座標→回転座標に変換）
                ctx.translate(-half, -half);
                drawPlayers();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
            } else {
                ctx.drawImage(chunkCache, 0, 0);
                drawPlayers();
            }
            ctx.restore();

            // オフスクリーン canvas → DynamicTexture にコピー
            const dtCtx = dt.getContext();
            dtCtx.clearRect(0, 0, MAP_RES, MAP_RES);
            dtCtx.drawImage(offCanvas, 0, 0);
            dt.update();

            playerDirty = false;

            // コンパスラベル位置更新（リサイズ時もサイズ変化で再計算が必要）
            if (game.minimapRotate) {
                updateCompassPositions(rot + Math.PI);
            } else {
                updateCompassPositions(0);
            }
        }
    });
}
