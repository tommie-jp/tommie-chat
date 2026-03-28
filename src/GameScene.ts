import {
    Engine,
    Scene,
    Vector3,
    Color4,
    MeshBuilder,
    HemisphericLight,
    DirectionalLight,
    ArcRotateCamera,
    StandardMaterial,
    Color3,
    Mesh,
    PointerEventTypes,
    DefaultRenderingPipeline,
    Matrix
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";
import { AdvancedDynamicTexture, TextBlock, Rectangle } from "@babylonjs/gui";
import "@babylonjs/loaders";
import { NakamaService } from "./NakamaService";
import { loadAllChunks, saveChunks, ChunkRecord } from "./ChunkDB";
import { CHUNK_SIZE, CHUNK_COUNT, WORLD_SIZE } from "./WorldConstants";
import { CloudSystem } from "./CloudSystem";
import { AvatarSystem } from "./AvatarSystem";
import { SpriteAvatarSystem } from "./SpriteAvatarSystem";
import { NPCSystem } from "./NPCSystem";
import { AOIManager } from "./AOIManager";
import { setupHtmlUI } from "./UIPanel";
import { setupDebugOverlay } from "./DebugOverlay";
import { prof } from "./Profiler";

export class GameScene {
    engine: Engine;
    scene: Scene;
    camera!: ArcRotateCamera;
    playerBox!: Mesh;

    targetPosition: Vector3 | null = null;
    private readonly moveSpeed = 2.0;

    // カメラパンオフセット（右ドラッグで操作、キャラ追従を維持）
    panOffset = new Vector3(0, 0, 0);
    private isPanning = false;
    private panLastX = 0;
    private panLastY = 0;

    private inputMap: { [key: string]: boolean } = {};
    private lastKeyboardSendTime = 0;

    private hoverMarker!: Mesh;
    private clickMarker!: Mesh;
    previewBlock!: Mesh;
    previewMat!: StandardMaterial;

    updatePlayerSpeech!: (newText: string) => void;
    updatePlayerNameTag!: (newName: string, color?: string) => void;
    nakama = new NakamaService();
    private renderingPipeline: DefaultRenderingPipeline | null = null;
    private camSpecLight!: DirectionalLight;

    remoteAvatars = new Map<string, Mesh>();
    remoteTargets = new Map<string, { x: number; z: number }>();
    remoteSpeeches = new Map<string, (text: string) => void>();
    remoteNameUpdaters = new Map<string, (newName: string, color?: string) => void>();

    // ===== 地面ブロック =====
    chunks = new Map<string, { cells: Uint8Array; hash: bigint }>();
    private dbHashes = new Map<string, string>();
    currentUserId: string | null = null;

    camAutoRotate = true;
    private blockMeshes = new Map<number, Mesh>();
    private blockMatCache = new Map<string, StandardMaterial>();
    buildMode = false;
    latestPingAvg: number | null = null;
    playerTextureUrl = localStorage.getItem("spriteAvatarUrl") || "/s3/avatars/pipo-nekonin008.png";
    playerCharCol = parseInt(localStorage.getItem("spriteAvatarCol") ?? "0", 10) || 0;
    playerCharRow = parseInt(localStorage.getItem("spriteAvatarRow") ?? "0", 10) || 0;
    avatarDepth = 0.05;

    // フレームプロファイル（ms単位、10フレーム移動平均）
    frameProfile = { playerMove: 0, remoteAvatars: 0, npc: 0, total: 0 };
    private _profileAccum = { playerMove: 0, remoteAvatars: 0, npc: 0, total: 0, frames: 0 };
    /** DevTools Performance タブの Timings レーンに mark/measure を出すか */
    profiling = false;
    private _profileHistory: { ts: number; playerMove: number; remoteAvatars: number; npc: number; total: number; avatarCount: number }[] = [];
    /** ユーザーリスト DOM 再構築プロファイル（UIPanel から書き込まれる） */
    userListProfile = { calls: 0, totalMs: 0, maxMs: 0, userCount: 0 };
    /** 関数呼び出しカウンタ（プロファイル期間中に加算、profileDump で表示） */
    callCounts: Record<string, number> = {};

    // サブシステム
    avatarSystem!: AvatarSystem;
    spriteAvatarSystem!: SpriteAvatarSystem;
    cloudSystem!: CloudSystem;
    npcSystem!: NPCSystem;
    aoiManager!: AOIManager;

    constructor(canvas: HTMLCanvasElement) {
        this.engine = new Engine(canvas, false, { stencil: true });

        this.engine.setHardwareScalingLevel(1 / window.devicePixelRatio);

        this.scene = new Scene(this.engine);

        // サブシステム初期化
        this.avatarSystem = new AvatarSystem(this.scene);
        this.spriteAvatarSystem = new SpriteAvatarSystem(this.scene);
        this.cloudSystem = new CloudSystem(this.scene, this.engine);

        this.setupScene();
        this.createObjects();
        this.setMSAA(2);

        // NPCSystem, AOIManager はcreateObjects内で初期化済み
        setupHtmlUI(this);

        this.handleResize();

        this.engine.runRenderLoop(() => {
            if (this.scene.activeCamera) {
                this.scene.render();
            }
        });

        const canvasResizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => this.handleResize());
        });
        canvasResizeObserver.observe(canvas);
    }

    private setupScene(): void {
        const _end = prof("GameScene.setupScene");
        this.camera = new ArcRotateCamera(
            "camera",
            Math.PI / 2,
            Math.PI / 2.5,
            10.0,
            new Vector3(0, 0.9, 0),
            this.scene
        );

        // βの可動範囲を 0(真上) ~ 80度 に限定
        this.camera.lowerBetaLimit = 0;
        this.camera.upperBetaLimit = 80 * Math.PI / 180;

        this.camera.attachControl(this.engine.getRenderingCanvas() as HTMLCanvasElement, true);

        this.camera.keysUp = [];
        this.camera.keysDown = [];
        this.camera.keysLeft = [];
        this.camera.keysRight = [];

        this.camera.lowerRadiusLimit = 2;
        this.camera.upperRadiusLimit = 200;
        this.camera.fovMode = ArcRotateCamera.FOVMODE_VERTICAL_FIXED;
        this.camera.inertia = 0;
        this.camera.useNaturalPinchZoom = true;
        // デフォルトのパン機能を無効化（自前で右ドラッグパンを実装）
        this.camera.panningSensibility = 0;
        // 右ボタン・中ボタンでの操作を無効化（右ドラッグはパン専用にする）
        this.camera._useCtrlForPanning = false;
        const pointersInput = this.camera.inputs.attached["pointers"] as any;
        if (pointersInput) {
            pointersInput.buttons = [0];  // 左ボタンのみBabylon.jsで処理
            // Babylon.js のポインター入力の onButtonDown をラップして右ボタンを無視
            const origOnButtonDown = pointersInput.onButtonDown?.bind(pointersInput);
            if (origOnButtonDown) {
                pointersInput.onButtonDown = (evt: PointerEvent) => {
                    if (evt.button === 2) return;
                    origOnButtonDown(evt);
                };
            }
        }

        this.camera.maxZ = 200;
        this.camera.fov = 60 * Math.PI / 180;

        const hemiLight = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), this.scene);
        hemiLight.intensity = 0.8;
        hemiLight.groundColor = new Color3(0.9, 0.9, 0.9);
        hemiLight.specular = new Color3(0, 0, 0);

        const dirLightFront = new DirectionalLight("dirLightFront", new Vector3(-0.5, -1.0, 1.0), this.scene);
        dirLightFront.intensity = 0.7;
        dirLightFront.specular = new Color3(1.0, 1.0, 1.0);

        this.camSpecLight = new DirectionalLight("camSpecLight", new Vector3(0, -1, 0), this.scene);
        this.camSpecLight.diffuse = new Color3(0, 0, 0);
        this.camSpecLight.specular = new Color3(0.6, 0.6, 0.6);

        const skyColor = Color3.FromHexString("#a0d7f3");
        this.scene.clearColor = new Color4(skyColor.r, skyColor.g, skyColor.b, 1.0);
        this.scene.ambientColor = new Color3(0.65, 0.65, 0.75);

        this.scene.fogMode = Scene.FOGMODE_LINEAR;
        this.scene.fogColor = skyColor;
        this.scene.fogStart = 30.0;
        this.scene.fogEnd = this.camera.maxZ;
        _end();
    }

    // AOI変更時にAOI外のブロックメッシュを破棄し、AOI内のキャッシュ済みチャンクを描画
    refreshBlocksForAOI(): void {
        const _end = prof("GameScene.refreshBlocksForAOI");
        const aoi = this.aoiManager.lastAOI;
        if (aoi.minCX < 0) { _end(); return; }
        const CS = CHUNK_SIZE;
        const WS = WORLD_SIZE;

        // AOI外のブロックメッシュを破棄
        for (const [key, mesh] of this.blockMeshes) {
            const gx = Math.floor(key / WS);
            const gz = key % WS;
            const cx = Math.floor(gx / CS);
            const cz = Math.floor(gz / CS);
            if (cx < aoi.minCX || cx > aoi.maxCX || cz < aoi.minCZ || cz > aoi.maxCZ) {
                mesh.dispose();
                this.blockMeshes.delete(key);
            }
        }

        // AOI内のキャッシュ済みチャンクでメッシュが無いブロックを描画
        for (let cx = aoi.minCX; cx <= aoi.maxCX; cx++) {
            for (let cz = aoi.minCZ; cz <= aoi.maxCZ; cz++) {
                const ch = this.chunks.get(`${cx}_${cz}`);
                if (!ch) continue;
                const baseGX = cx * CS, baseGZ = cz * CS;
                for (let lx = 0; lx < CS; lx++) {
                    for (let lz = 0; lz < CS; lz++) {
                        const gx = baseGX + lx, gz = baseGZ + lz;
                        const mkey = gx * WS + gz;
                        if (this.blockMeshes.has(mkey)) continue; // 既にメッシュあり
                        const si = (lx * CS + lz) * 6;
                        const blockId = ch.cells[si] | (ch.cells[si + 1] << 8);
                        if (blockId !== 0) {
                            this.placeBlock(gx, gz, blockId, ch.cells[si + 2], ch.cells[si + 3], ch.cells[si + 4], ch.cells[si + 5]);
                        }
                    }
                }
            }
        }
        _end();
    }

    // AOI範囲内のチャンクをサーバと差分同期
    async syncAOIChunks(): Promise<void> {
        const _end = prof("GameScene.syncAOIChunks");
        try {
        const CS = CHUNK_SIZE;
        const aoi = this.aoiManager.lastAOI;
        if (aoi.minCX < 0) return; // センチネル
        const hashes: Record<string, string> = {};
        for (let cx = aoi.minCX; cx <= aoi.maxCX; cx++) {
            for (let cz = aoi.minCZ; cz <= aoi.maxCZ; cz++) {
                const key = `${cx}_${cz}`;
                const ch = this.chunks.get(key);
                hashes[key] = ch ? ch.hash.toString() : "0";
            }
        }
        const diffs = await this.nakama.syncChunks(aoi.minCX, aoi.minCZ, aoi.maxCX, aoi.maxCZ, hashes);
        for (const d of diffs) {
            if (d.table.length !== CS * CS * 6) continue;
            const key = `${d.cx}_${d.cz}`;
            let ch = this.chunks.get(key);
            if (!ch) { ch = { cells: new Uint8Array(CS * CS * 6), hash: 0n }; this.chunks.set(key, ch); }
            const baseGX = d.cx * CS, baseGZ = d.cz * CS;
            for (let lx = 0; lx < CS; lx++) {
                for (let lz = 0; lz < CS; lz++) {
                    const si = (lx * CS + lz) * 6;
                    for (let k = 0; k < 6; k++) ch.cells[si + k] = d.table[si + k];
                    const blockId = d.table[si] | (d.table[si + 1] << 8);
                    const gx = baseGX + lx, gz = baseGZ + lz;
                    if (blockId !== 0) this.placeBlock(gx, gz, blockId, d.table[si + 2], d.table[si + 3], d.table[si + 4], d.table[si + 5]);
                    else this.placeBlock(gx, gz, 0, 0, 0, 0, 0);
                }
            }
            ch.hash = BigInt(d.hash || "0");
        }
        if (diffs.length > 0) console.log(`syncChunks updated ${diffs.length} chunks (AOI ${aoi.minCX},${aoi.minCZ}-${aoi.maxCX},${aoi.maxCZ})`);
        } finally { _end(); }
    }

    // IndexedDBからチャンクをメモリに復元（ログイン後）
    async loadChunksFromDB(userId: string): Promise<void> {
        const _end = prof("GameScene.loadChunksFromDB");
        try {
        const CS = CHUNK_SIZE;
        const CC = CHUNK_COUNT;
        try {
            const records = await loadAllChunks(userId);
            for (const rec of records) {
                const parts = rec.key.split("_");
                if (parts.length !== 2) continue;
                const cx = parseInt(parts[0], 10);
                const cz = parseInt(parts[1], 10);
                if (cx < 0 || cx >= CC || cz < 0 || cz >= CC) continue;
                if (rec.cells.length !== CS * CS * 6) continue;
                const key = `${cx}_${cz}`;
                this.chunks.set(key, { cells: new Uint8Array(rec.cells), hash: BigInt(rec.hash || "0") });
                this.dbHashes.set(key, rec.hash || "0");
            }
            console.log(`ChunkDB loaded ${records.length} chunks from IndexedDB (user=${userId.slice(0, 8)})`);
        } catch (e) {
            console.warn("ChunkDB load failed:", e);
        }
        } finally { _end(); }
    }

    // ログアウト時にハッシュが変わったチャンクだけIndexedDBに保存
    saveChunksToDB(): void {
        const _end = prof("GameScene.saveChunksToDB");
        const userId = this.currentUserId;
        if (!userId) { _end(); return; }
        const dirty: ChunkRecord[] = [];
        for (const [key, ch] of this.chunks) {
            const hashStr = ch.hash.toString();
            if (hashStr !== (this.dbHashes.get(key) ?? "0")) {
                dirty.push({ key, cells: new Uint8Array(ch.cells), hash: hashStr });
                this.dbHashes.set(key, hashStr);
            }
        }
        if (dirty.length > 0) {
            saveChunks(userId, dirty).then(() => console.log(`ChunkDB saved ${dirty.length} chunks`))
                .catch(e => console.warn("ChunkDB save failed:", e));
        }
        _end();
    }

    refreshPreviewBlock(): void {
        const _end = prof("GameScene.refreshPreviewBlock");
        const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => mesh.name === "ground");
        if (pick?.hit && pick.pickedPoint) {
            const px = Math.floor(pick.pickedPoint.x) + 0.5;
            const pz = Math.floor(pick.pickedPoint.z) + 0.5;
            const colorInput = document.getElementById("blockColorInput") as HTMLInputElement | null;
            const hex = colorInput?.value ?? "#3366ff";
            const r = parseInt(hex.slice(1, 3), 16) / 255;
            const g = parseInt(hex.slice(3, 5), 16) / 255;
            const b = parseInt(hex.slice(5, 7), 16) / 255;
            const opacityInput = document.getElementById("blockOpacityInput") as HTMLInputElement | null;
            const alpha = Math.min(1, Math.max(0, parseFloat(opacityInput?.value ?? "0.5")));
            this.previewMat.diffuseColor = new Color3(r, g, b);
            this.previewMat.alpha = alpha;
            this.previewBlock.position.x = px;
            this.previewBlock.position.z = pz;
            this.previewBlock.isVisible = true;
        } else {
            this.previewBlock.isVisible = false;
        }
        _end();
    }

    private getOrCreateBlockMat(r: number, g: number, b: number, a: number): StandardMaterial {
        const key = `${r}_${g}_${b}_${a}`;
        if (!this.blockMatCache.has(key)) {
            const mat = new StandardMaterial(`blockMat_${key}`, this.scene);
            mat.diffuseColor = new Color3(r / 255, g / 255, b / 255);
            if (a < 255) mat.alpha = a / 255;
            this.blockMatCache.set(key, mat);
        }
        return this.blockMatCache.get(key)!;
    }

    placeBlock(gx: number, gz: number, blockId: number, r: number, g: number, b: number, a = 255): void {
        const _end = prof("GameScene.placeBlock");
        const key = gx * WORLD_SIZE + gz;
        const existing = this.blockMeshes.get(key);
        if (existing) { existing.dispose(); this.blockMeshes.delete(key); }
        if (blockId === 0) { _end(); return; }
        const half = WORLD_SIZE / 2;
        const box = MeshBuilder.CreateBox(`block_${gx}_${gz}`, { size: 1 }, this.scene);
        box.position.set(gx - half + 0.5, 0.5, gz - half + 0.5);
        box.material = this.getOrCreateBlockMat(r, g, b, a);
        box.isPickable = false;
        this.blockMeshes.set(key, box);
        _end();
    }

    private createObjects(): void {
        const ground = MeshBuilder.CreateGround("ground", { width: WORLD_SIZE, height: WORLD_SIZE }, this.scene);
        const gridMaterial = new GridMaterial("gridMaterial", this.scene);
        gridMaterial.mainColor = new Color3(0.85, 0.95, 0.85);
        gridMaterial.lineColor = new Color3(0.35, 0.55, 0.35);
        gridMaterial.gridRatio = 1.0;
        gridMaterial.opacity = 1.0;
        gridMaterial.freeze();
        ground.material = gridMaterial;
        ground.freezeWorldMatrix();

        this.previewBlock = MeshBuilder.CreateBox("previewBlock", { size: 1 }, this.scene);
        this.previewBlock.position.y = 0.5;
        this.previewBlock.isPickable = false;
        this.previewBlock.isVisible = false;
        this.previewMat = new StandardMaterial("previewMat", this.scene);
        this.previewMat.needDepthPrePass = true;
        this.previewBlock.material = this.previewMat;

        this.hoverMarker = MeshBuilder.CreatePlane("hoverMarker", { size: 1.0 }, this.scene);
        this.hoverMarker.rotation.x = Math.PI / 2;
        this.hoverMarker.position.y = 0.01;
        const hoverMat = new StandardMaterial("hoverMat", this.scene);
        hoverMat.emissiveColor = new Color3(0.5, 1.0, 0.5);
        hoverMat.alpha = 0.5;
        hoverMat.disableLighting = true;
        this.hoverMarker.material = hoverMat;
        this.hoverMarker.isPickable = false;

        this.clickMarker = MeshBuilder.CreatePlane("clickMarker", { size: 1.0 }, this.scene);
        this.clickMarker.rotation.x = Math.PI / 2;
        this.clickMarker.position.y = 0.01;
        const clickMat = new StandardMaterial("clickMat", this.scene);
        clickMat.emissiveColor = new Color3(0.0, 1.0, 0.0);
        clickMat.alpha = 0.7;
        clickMat.disableLighting = true;
        this.clickMarker.material = clickMat;
        this.clickMarker.isVisible = false;
        this.clickMarker.isPickable = false;

        // プレイヤーアバター（位置制御用の不可視ボックス）
        this.playerBox = this.avatarSystem.createAvatar("tommie.jp", "/textures/pic1.ktx2", 0, 0, this.avatarDepth);
        // 旧式メッシュアバターを非表示
        this.playerBox.getChildMeshes().forEach(m => m.isVisible = false);
        // スプライトアバターを作成
        this.spriteAvatarSystem.createAvatar(
            "__self__", this.playerTextureUrl, this.playerCharCol, this.playerCharRow, 0, 0, "",
            new Color3(1.0, 0.0, 0.0)
        ).catch(e => console.error("Failed to create player sprite avatar:", e));

        // NPCシステム
        this.npcSystem = new NPCSystem(this.avatarSystem);
        this.npcSystem.create(this.avatarDepth);

        // AOIマネージャー
        this.aoiManager = new AOIManager(
            this.scene, this.nakama,
            () => ({ x: this.playerBox.position.x, z: this.playerBox.position.z }),
            () => { this.refreshBlocksForAOI(); this.syncAOIChunks().catch(() => {}); }
        );

        // ネームタグ & 吹き出し
        const playerNameTag = this.avatarSystem.createNameTag(this.playerBox, "tommie.jp✅️");
        // スプライトアバターが有効ならメッシュ側の名前タグ・吹き出しを非表示
        playerNameTag.plane.isVisible = false;
        this.updatePlayerNameTag = (name: string, color?: string) => {
            playerNameTag.update(name);
            // スプライトアバターの名前タグも更新
            const sprNameUpdate = this.spriteAvatarSystem.getNameUpdate("__self__");
            if (sprNameUpdate) sprNameUpdate(name, color);
        };
        // メッシュ側の吹き出しはスプライトアバター使用時は作成しない（二重表示防止）
        this.updatePlayerSpeech = (text: string) => {
            const sprSpeechUpdate = this.spriteAvatarSystem.getSpeechUpdate("__self__");
            if (sprSpeechUpdate) sprSpeechUpdate(text);
        };

        // 雲
        this.cloudSystem.create();

        // 座標ラベル
        this.createCoordinateLabels();

        // デバッグオーバーレイ
        setupDebugOverlay(this);

        // キーボード入力
        window.addEventListener("keydown", (e) => {
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA" || activeElement.tagName === "SELECT")) {
                return;
            }

            if (!e.key) return;
            const key = e.key.toLowerCase();
            this.inputMap[key] = true;

            if (["w", "a", "s", "d", "q", "e", "x", "escape", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
                this.targetPosition = null;
                if (this.clickMarker) this.clickMarker.isVisible = false;
            }
        });

        window.addEventListener("keyup", (e) => {
            if (!e.key) return;
            const key = e.key.toLowerCase();
            this.inputMap[key] = false;
            if (key === "b" && document.activeElement?.tagName !== "TEXTAREA" && document.activeElement?.tagName !== "INPUT") {
                this.buildMode = !this.buildMode;
                const indicator = document.getElementById("build-mode-indicator");
                if (indicator) {
                    indicator.style.display = this.buildMode ? "" : "none";
                    if (this.buildMode) indicator.textContent = "🔨 ビルドモード（B/ESCキーで解除）";
                }
                const btn = document.getElementById("buildModeBtn") as HTMLButtonElement | null;
                if (btn) {
                    btn.textContent = this.buildMode ? "On" : "Off";
                    btn.classList.toggle("off", !this.buildMode);
                }
                if (this.buildMode) this.refreshPreviewBlock();
                else this.previewBlock.isVisible = false;
            }
            if (key === "escape" && this.buildMode) {
                this.buildMode = false;
                const indicator = document.getElementById("build-mode-indicator");
                if (indicator) indicator.style.display = "none";
                const btn = document.getElementById("buildModeBtn") as HTMLButtonElement | null;
                if (btn) { btn.textContent = "Off"; btn.classList.add("off"); }
                this.previewBlock.isVisible = false;
            }
        });

        document.getElementById("build-mode-indicator")?.addEventListener("click", () => {
            if (!this.buildMode) return;
            this.buildMode = false;
            const indicator = document.getElementById("build-mode-indicator");
            if (indicator) indicator.style.display = "none";
            const btn = document.getElementById("buildModeBtn") as HTMLButtonElement | null;
            if (btn) { btn.textContent = "Off"; btn.classList.add("off"); }
            this.previewBlock.isVisible = false;
        });

        // ビルドモード: ネイティブ canvas click でブロック設置/撤去
        const _canvas = this.engine.getRenderingCanvas();
        if (_canvas) {
            _canvas.addEventListener("click", (_e: MouseEvent) => {
                if (!this.buildMode) return;
                const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => mesh.name === "ground");
                if (pick?.hit && pick.pickedPoint) {
                    const half = WORLD_SIZE / 2;
                    const gx = Math.floor(pick.pickedPoint.x + half);
                    const gz = Math.floor(pick.pickedPoint.z + half);
                    if (gx >= 0 && gx < WORLD_SIZE && gz >= 0 && gz < WORLD_SIZE) {
                        const CS = CHUNK_SIZE;
                        const ccx = Math.floor(gx / CS), ccz = Math.floor(gz / CS);
                        const clx = gx % CS, clz = gz % CS;
                        const csi = (clx * CS + clz) * 6;
                        const cch = this.chunks.get(`${ccx}_${ccz}`);
                        const curId = cch ? (cch.cells[csi] | (cch.cells[csi+1] << 8)) : 0;
                        const blockId = curId === 0 ? 1 : 0;
                        const colorInput = document.getElementById("blockColorInput") as HTMLInputElement | null;
                        const hex = colorInput?.value ?? "#3366ff";
                        const r = parseInt(hex.slice(1, 3), 16);
                        const g = parseInt(hex.slice(3, 5), 16);
                        const b = parseInt(hex.slice(5, 7), 16);
                        const opacityInput = document.getElementById("blockOpacityInput") as HTMLInputElement | null;
                        const opacity = Math.min(1, Math.max(0, parseFloat(opacityInput?.value ?? "0.5")));
                        const a = Math.round(opacity * 255);
                        this.nakama.setBlock(gx, gz, blockId, r, g, b, a).catch(() => {});
                    }
                }
            });
        }

        this.scene.onPointerObservable.add((pointerInfo) => {
            if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
                const pick = this.scene.pick(
                    this.scene.pointerX,
                    this.scene.pointerY,
                    (mesh) => mesh.name === "ground"
                );

                if (pick && pick.hit && pick.pickedPoint) {
                    const px = Math.floor(pick.pickedPoint.x) + 0.5;
                    const pz = Math.floor(pick.pickedPoint.z) + 0.5;
                    this.hoverMarker.position.x = px;
                    this.hoverMarker.position.z = pz;
                    this.hoverMarker.isVisible = true;
                    if (this.buildMode) this.refreshPreviewBlock();
                    else this.previewBlock.isVisible = false;
                } else {
                    this.hoverMarker.isVisible = false;
                    this.previewBlock.isVisible = false;
                }
            }

            if (pointerInfo.type === PointerEventTypes.POINTERTAP) {
                if (this.buildMode) return; // ビルドモードはネイティブ click で処理
                // 右クリックはパン操作なので移動しない
                if (pointerInfo.event && (pointerInfo.event as PointerEvent).button === 2) return;
                const pick = pointerInfo.pickInfo;
                if (pick && pick.hit && pick.pickedMesh && pick.pickedMesh.name === "ground" && pick.pickedPoint) {
                    // 通常クリック → 移動
                    const snappedX = Math.floor(pick.pickedPoint.x) + 0.5;
                    const snappedZ = Math.floor(pick.pickedPoint.z) + 0.5;
                    this.targetPosition = new Vector3(snappedX, 0, snappedZ);
                    this.clickMarker.position.x = snappedX;
                    this.clickMarker.position.z = snappedZ;
                    this.clickMarker.isVisible = true;
                    // 現在位置を送信
                    const cp = this.playerBox.position;
                    this.nakama.sendMoveTarget(cp.x, cp.z).catch(() => {});
                    this.aoiManager.updateAOI();
                }
            }
        });

        // レンダーループ
        this.scene.onBeforeRenderObservable.add(() => {
            const _t0 = performance.now();
            const deltaTime = this.engine.getDeltaTime() / 1000;

            const currentPos = this.playerBox.position;
            const moveDist = this.moveSpeed * deltaTime;

            let isKeyboardMoving = false;
            let moveDirection = new Vector3(0, 0, 0);

            const forward = this.camera.getDirection(Vector3.Forward());
            forward.y = 0;
            forward.normalize();

            const right = this.camera.getDirection(Vector3.Right());
            right.y = 0;
            right.normalize();

            if (this.inputMap["w"] || this.inputMap["arrowup"]) moveDirection.addInPlace(forward);
            if (this.inputMap["s"] || this.inputMap["arrowdown"]) moveDirection.subtractInPlace(forward);
            if (this.inputMap["d"] || this.inputMap["e"] || this.inputMap["arrowright"]) moveDirection.addInPlace(right);
            if (this.inputMap["a"] || this.inputMap["q"] || this.inputMap["arrowleft"]) moveDirection.subtractInPlace(right);

            if (moveDirection.lengthSquared() > 0) {
                isKeyboardMoving = true;
                moveDirection.normalize();

                this.playerBox.position.addInPlace(moveDirection.scale(moveDist));

                const targetAngle = Math.atan2(moveDirection.x, moveDirection.z) + Math.PI;
                let diff = targetAngle - this.playerBox.rotation.y;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                this.playerBox.rotation.y += diff * Math.min(1.0, 15.0 * deltaTime);

                const now = performance.now();
                if (now - this.lastKeyboardSendTime >= 100) {
                    this.lastKeyboardSendTime = now;
                    const p = this.playerBox.position;
                    this.nakama.sendMoveTarget(p.x, p.z).catch(() => {});
                    this.aoiManager.updateAOI();
                }
            }

            if (!isKeyboardMoving && this.targetPosition) {
                const target = new Vector3(this.targetPosition.x, currentPos.y, this.targetPosition.z);
                const distance = Vector3.Distance(currentPos, target);

                if (distance > moveDist) {
                    const direction = target.subtract(currentPos).normalize();
                    this.playerBox.position.addInPlace(direction.scale(moveDist));

                    const targetAngle = Math.atan2(direction.x, direction.z) + Math.PI;
                    let diff = targetAngle - this.playerBox.rotation.y;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    this.playerBox.rotation.y += diff * Math.min(1.0, 15.0 * deltaTime);

                    if (this.camAutoRotate) {
                        const moveAngle = Math.atan2(direction.x, direction.z);
                        const destAlpha = -moveAngle - Math.PI / 2;

                        let alphaDiff = destAlpha - this.camera.alpha;
                        while (alphaDiff < -Math.PI) alphaDiff += Math.PI * 2;
                        while (alphaDiff >  Math.PI) alphaDiff -= Math.PI * 2;
                        this.camera.alpha += alphaDiff * Math.min(1.0, 2.0 * deltaTime);
                    }
                } else {
                    this.playerBox.position.copyFrom(target);
                    this.targetPosition = null;
                    this.clickMarker.isVisible = false;
                }
                // キーボード移動と同じスロットルで現在位置をサーバへ送信
                const now = performance.now();
                if (now - this.lastKeyboardSendTime >= 100) {
                    this.lastKeyboardSendTime = now;
                    const p = this.playerBox.position;
                    this.nakama.sendMoveTarget(p.x, p.z).catch(() => {});
                }
                this.aoiManager.updateAOI();
            }

            const _t1 = performance.now();
            // リモートアバターを目標位置へ移動（視錐台カリング付き）
            const frustumPlanes = this.scene.frustumPlanes;
            for (const [sid, av] of this.remoteAvatars) {
                const tgt = this.remoteTargets.get(sid);
                if (!tgt) continue;
                const isSprite = this.spriteAvatarSystem.has(sid);
                const dx = tgt.x - av.position.x, dz = tgt.z - av.position.z;
                const dist = dx * dx + dz * dz;
                if (dist <= 0.0025) continue; // 0.05^2
                // 視錐台外のアバターは位置をテレポート（補間スキップ）
                if (!isSprite && frustumPlanes && (av as Mesh).isInFrustum && !(av as Mesh).isInFrustum(frustumPlanes)) {
                    av.position.x = tgt.x;
                    av.position.z = tgt.z;
                    continue;
                }
                const d = Math.sqrt(dist);
                const step = Math.min(this.moveSpeed * deltaTime, d);
                av.position.x += (dx / d) * step;
                av.position.z += (dz / d) * step;
                if (isSprite) {
                    // スプライトの場合: スプライト位置を同期（回転は不要、updateAnimationで方向処理）
                    this.spriteAvatarSystem.syncPosition(sid, av.position.x, av.position.z);
                } else {
                    // メッシュの場合: 回転を補間
                    const targetAngle = Math.atan2(dx, dz) + Math.PI;
                    let diff = targetAngle - av.rotation.y;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff >  Math.PI) diff -= Math.PI * 2;
                    av.rotation.y += diff * Math.min(1.0, 15.0 * deltaTime);
                }
            }

            // スプライトアバターのアニメーション更新
            const camAlpha = this.camera.alpha;
            // 自分のスプライトアバター
            if (this.spriteAvatarSystem.has("__self__")) {
                this.spriteAvatarSystem.syncPosition("__self__", this.playerBox.position.x, this.playerBox.position.z);
                this.spriteAvatarSystem.updateAnimation("__self__", camAlpha);
            }
            // リモートのスプライトアバター
            for (const [sid] of this.remoteAvatars) {
                if (this.spriteAvatarSystem.has(sid)) {
                    this.spriteAvatarSystem.updateAnimation(sid, camAlpha);
                }
            }

            const _t2 = performance.now();
            // NPC アニメーション
            this.npcSystem.update(deltaTime);

            this.camSpecLight.direction = this.camera.getDirection(Vector3.Forward());

            // フレームプロファイル集計（10フレーム移動平均）
            const _t3 = performance.now();
            const pM = _t1 - _t0, rA = _t2 - _t1, nC = _t3 - _t2, tT = _t3 - _t0;

            // DevTools Timings レーンへの mark/measure
            if (this.profiling) {
                performance.mark('frame-start');
                performance.measure('playerMove', { start: _t0, end: _t1 });
                performance.measure('remoteAvatars', { start: _t1, end: _t2 });
                performance.measure('npc', { start: _t2, end: _t3 });
                performance.measure('frame-total', { start: _t0, end: _t3 });
                // 履歴に記録（最大600フレーム = 約10秒分）
                this._profileHistory.push({ ts: _t0, playerMove: pM, remoteAvatars: rA, npc: nC, total: tT, avatarCount: this.remoteAvatars.size });
                if (this._profileHistory.length > 600) this._profileHistory.shift();
            }

            const acc = this._profileAccum;
            acc.playerMove += pM;
            acc.remoteAvatars += rA;
            acc.npc += nC;
            acc.total += tT;
            acc.frames++;
            if (acc.frames >= 10) {
                const n = acc.frames;
                this.frameProfile = {
                    playerMove: acc.playerMove / n,
                    remoteAvatars: acc.remoteAvatars / n,
                    npc: acc.npc / n,
                    total: acc.total / n,
                };
                acc.playerMove = acc.remoteAvatars = acc.npc = acc.total = acc.frames = 0;
            }


        });

        // カメラをキャラ追従（パンオフセット付き）で毎フレーム更新
        if (this.camera && this.playerBox) {
            this.camera.setTarget(this.playerBox.position.add(this.panOffset));

            // 右ドラッグでパンオフセットを操作
            const canvas = this.engine.getRenderingCanvas()!;
            canvas.addEventListener("pointerdown", (e: PointerEvent) => {
                if (e.button === 2) {
                    this.isPanning = true;
                    this.panLastX = e.clientX;
                    this.panLastY = e.clientY;
                    canvas.setPointerCapture(e.pointerId);
                    e.stopImmediatePropagation();
                }
            }, true);
            const screenMargin = 0.15;
            // 仮オフセットでのプレイヤーの正規化スクリーン座標を計算
            const playerScreenPos = (testOffset: Vector3): { nx: number; ny: number } => {
                const testTarget = this.playerBox.position.add(testOffset);
                const alpha = this.camera.alpha;
                const beta = this.camera.beta;
                const radius = this.camera.radius;
                const camX = testTarget.x + radius * Math.sin(beta) * Math.cos(alpha);
                const camY = testTarget.y + radius * Math.cos(beta);
                const camZ = testTarget.z + radius * Math.sin(beta) * Math.sin(alpha);
                const camPos = new Vector3(camX, camY, camZ);
                const vm = Matrix.LookAtLH(camPos, testTarget, Vector3.Up());
                const pm = this.camera.getProjectionMatrix();
                const vp = this.camera.viewport.toGlobal(
                    this.engine.getRenderWidth(),
                    this.engine.getRenderHeight()
                );
                const sp = Vector3.Project(this.playerBox.position, vm, pm, vp);
                return { nx: sp.x / this.engine.getRenderWidth(), ny: sp.y / this.engine.getRenderHeight() };
            };
            const isPlayerInScreen = (testOffset: Vector3): boolean => {
                const { nx, ny } = playerScreenPos(testOffset);
                return nx >= screenMargin && nx <= 1 - screenMargin &&
                       ny >= screenMargin && ny <= 1 - screenMargin;
            };
            const screenDistFromCenter = (testOffset: Vector3): number => {
                const { nx, ny } = playerScreenPos(testOffset);
                return (nx - 0.5) ** 2 + (ny - 0.5) ** 2;
            };

            // captureフェーズでBabylon.jsより先にイベントを捕捉
            canvas.addEventListener("pointermove", (e: PointerEvent) => {
                if (!this.isPanning) return;
                // 右ドラッグ中はBabylon.jsにイベントを渡さない（ズーム防止）
                e.stopImmediatePropagation();
                const dx = e.clientX - this.panLastX;
                const dy = e.clientY - this.panLastY;
                this.panLastX = e.clientX;
                this.panLastY = e.clientY;

                // カメラの右方向・前方向をXZ平面で計算（コンテンツ移動方式）
                const camPos = this.camera.position;
                const camTarget = this.camera.target;
                const fwdX = camTarget.x - camPos.x;
                const fwdZ = camTarget.z - camPos.z;
                const fwdLen = Math.sqrt(fwdX * fwdX + fwdZ * fwdZ) || 1;
                const fnX = fwdX / fwdLen;
                const fnZ = fwdZ / fwdLen;
                const rnX = -fnZ;
                const rnZ = fnX;
                const sensitivity = this.camera.radius * 0.001;
                const newX = this.panOffset.x + (dx * rnX + dy * fnX) * sensitivity;
                const newZ = this.panOffset.z + (dx * rnZ + dy * fnZ) * sensitivity;

                // 仮オフセットでプレイヤーが画面内に収まるか、
                // 現在より画面中央に近づく方向なら許可
                const testOffset = new Vector3(newX, 0, newZ);
                const inScreen = isPlayerInScreen(testOffset);
                const movesTowardCenter = !inScreen && (() => {
                    const cur = screenDistFromCenter(this.panOffset);
                    const nxt = screenDistFromCenter(testOffset);
                    return nxt < cur;
                })();
                if (inScreen || movesTowardCenter) {
                    this.panOffset.x = newX;
                    this.panOffset.z = newZ;
                }
            }, true);  // capture phase
            canvas.addEventListener("pointerup", (e: PointerEvent) => {
                if (e.button === 2) {
                    this.isPanning = false;
                    canvas.releasePointerCapture(e.pointerId);
                    e.stopImmediatePropagation();
                }
            }, true);
            // ポインタがキャンバス外で失われた場合のフォールバック
            canvas.addEventListener("lostpointercapture", () => {
                this.isPanning = false;
            });
            canvas.addEventListener("contextmenu", (e: Event) => { e.preventDefault(); });

            // 毎フレームカメラターゲットを更新（target を直接書き換えて alpha/beta を維持）
            this.scene.onBeforeRenderObservable.add(() => {
                const p = this.playerBox.position;
                this.camera.target.x = p.x + this.panOffset.x;
                this.camera.target.y = p.y;
                this.camera.target.z = p.z + this.panOffset.z;
            });
        }
    }

    setMSAA(samples: number): void {
        const _end = prof("GameScene.setMSAA");
        if (samples <= 1) {
            if (this.renderingPipeline) {
                this.renderingPipeline.dispose();
                this.renderingPipeline = null;
            }
        } else {
            if (!this.renderingPipeline) {
                this.renderingPipeline = new DefaultRenderingPipeline("defaultPipeline", false, this.scene, [this.camera]);
            }
            this.renderingPipeline.samples = samples;
        }
        _end();
    }

    private createCoordinateLabels(): void {
        const step = 10;
        const range = 50;
        for (let x = -range; x <= range; x += step) this.createSingleLabel(x, 0, "(" + x + ",0)");
        for (let z = -range; z <= range; z += step) if (z !== 0) this.createSingleLabel(0, z, "(0," + z + ")");
    }

    private createSingleLabel(x: number, z: number, labelText: string): void {
        const plane = MeshBuilder.CreatePlane("coordLabel_" + x + "_" + z, { width: 1.0, height: 1.0 }, this.scene);
        plane.rotation.x = Math.PI / 2;
        plane.position.set(x, 0.02, z);
        plane.isPickable = false;
        plane.freezeWorldMatrix();

        const texture = AdvancedDynamicTexture.CreateForMesh(plane, 256, 256, false);
        const bg = new Rectangle();
        bg.width = "100%"; bg.height = "100%";
        bg.background = "rgba(255,255,255,0.50)";
        bg.cornerRadius = 12;
        texture.addControl(bg);
        const text = new TextBlock();
        text.text = labelText;
        text.color = "#FF0000";
        text.fontSize = "50px";
        bg.addControl(text);
    }

    private handleResize(): void {
        this.engine.resize(true);
    }

    applyAvatarDepth(): void {
        const _end = prof("GameScene.applyAvatarDepth");
        const avatars = [this.playerBox, this.npcSystem.npc001, this.npcSystem.npc002, this.npcSystem.npc003,
                         ...this.remoteAvatars.values()];
        this.avatarSystem.applyAvatarDepth(avatars, this.avatarDepth);
        _end();
    }

    clampToViewport(el: HTMLElement): void {
        const _end = prof("GameScene.clampToViewport");
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        // ① 位置をクランプ
        const r0 = el.getBoundingClientRect();
        const newLeft = Math.max(0, Math.min(r0.left, vw - r0.width));
        const newTop  = Math.max(0, Math.min(r0.top,  vh - r0.height));
        if (newLeft !== r0.left) { el.style.left = newLeft + "px"; el.style.right = "auto"; }
        if (newTop  !== r0.top)  el.style.top   = newTop  + "px";
        // ② 位置調整後に再取得し、右端・下端がはみ出す分だけサイズを縮める
        const r = el.getBoundingClientRect();
        if (r.right  > vw) el.style.width  = Math.max(100, vw - r.left) + "px";
        if (r.bottom > vh) el.style.height = Math.max(60,  vh - r.top)  + "px";
        _end();
    }
}
