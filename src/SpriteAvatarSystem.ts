import {
    Scene, Mesh, MeshBuilder, Vector3, StandardMaterial, Color3,
    TransformNode, Texture, DynamicTexture, VertexData
} from "@babylonjs/core";
import { SpriteManager, Sprite } from "@babylonjs/core";
import { AdvancedDynamicTexture, TextBlock, StackPanel } from "@babylonjs/gui";
import {
    cellIndex, animRange, worldDirToSpriteDir,
    buildTransparentPNG, sampleBgColor, type SheetInfo
} from "../lib/babylon-rpgmaker-sprites/src/RpgMakerSpriteSheet";
import { prof } from "./Profiler";

interface SpriteAvatarData {
    sprite: Sprite;
    root: TransformNode;
    standBase: Mesh;
    namePlane: Mesh;
    nameUpdate: (name: string, color?: string, suffix?: string) => void;
    speechUpdate: (text: string) => void;
    speechRedraw: () => void;
    speechSetAlpha: (a: number) => void;
    speechGetAlpha: () => number;
    sheetInfo: SheetInfo;
    charCol: number;
    charRow: number;
    currentDir: number;
    isMoving: boolean;
    prevX: number;
    prevZ: number;
    spriteBaseY: number;  // sprite.position.y の基準値（ジャンプ演出用）
    jumpStart: number;    // performance.now() 時点、0 なら非ジャンプ中
    jumpDuration: number; // ms
    jumpHeight: number;   // world units
}

interface ManagerEntry {
    mgr: SpriteManager;
    sheetInfo: SheetInfo;
    refCount: number;
}

export class SpriteAvatarSystem {
    private managers = new Map<string, ManagerEntry>();
    private avatars = new Map<string, SpriteAvatarData>();
    private processing = new Map<string, Promise<ManagerEntry>>();
    private creating = new Set<string>();
    private disposed = new Set<string>();  // creating中にdisposeされたIDを記録
    // アバター再作成中に jump が来た場合、作成完了後に適用するため保留
    private pendingJumps = new Map<string, { ts: number; height: number; duration: number }>();
    private readonly PENDING_JUMP_TTL_MS = 3000;
    // 足元の五角形（standBase）の表示状態（デバッグ用、デフォルト OFF）
    private standBaseVisible = false;
    // 読み込み失敗した URL を記憶し、同じ URL の再リクエストを防止する
    private failedUrls = new Set<string>();
    // 同時アバター作成数を制限し、大量同時接続によるブラウザクラッシュを防止
    private readonly MAX_CONCURRENT_CREATE = 5;
    private concurrentCreating = 0;
    private createQueue: Array<{ resolve: () => void }> = [];

    constructor(private scene: Scene) {}

    private async getOrCreateManager(sheetUrl: string): Promise<ManagerEntry> {
        if (this.failedUrls.has(sheetUrl)) {
            throw new Error(`Sheet URL previously failed: ${sheetUrl}`);
        }
        const existing = this.managers.get(sheetUrl);
        if (existing) {
            existing.refCount++;
            return existing;
        }
        const pending = this.processing.get(sheetUrl);
        if (pending) {
            const entry = await pending;
            entry.refCount++;
            return entry;
        }
        const promise = this.loadManager(sheetUrl);
        this.processing.set(sheetUrl, promise);
        try {
            const entry = await promise;
            this.managers.set(sheetUrl, entry);
            return entry;
        } catch (e) {
            this.failedUrls.add(sheetUrl);
            throw e;
        } finally {
            this.processing.delete(sheetUrl);
        }
    }

    private async loadManager(sheetUrl: string): Promise<ManagerEntry> {
        const bg = await sampleBgColor(sheetUrl);
        const result = await buildTransparentPNG(sheetUrl, bg.r, bg.g, bg.b, 30);
        const info = result.info;
        const scale = result.finalScale;
        const frameW = info.frameW * scale;
        const frameH = info.frameH * scale;

        const mgr = new SpriteManager(
            "sprMgr_" + sheetUrl.replace(/[^a-zA-Z0-9]/g, "_"),
            result.dataURL, 200,
            { width: frameW, height: frameH },
            this.scene
        );
        mgr.texture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);

        // テクスチャのロード完了を待つ
        await new Promise<void>((resolve) => {
            if (mgr.texture.isReady()) {
                resolve();
            } else {
                mgr.texture.onLoadObservable.addOnce(() => resolve());
            }
        });

        return { mgr, sheetInfo: info, refCount: 1 };
    }

    /** セマフォ取得: 同時作成数が上限未満なら即 resolve、超過中はキューで待機 */
    private acquireCreateSlot(): Promise<void> {
        if (this.concurrentCreating < this.MAX_CONCURRENT_CREATE) {
            this.concurrentCreating++;
            return Promise.resolve();
        }
        return new Promise(resolve => this.createQueue.push({ resolve }));
    }
    /** セマフォ解放: キューに待機中のものがあれば1つ起こす */
    private releaseCreateSlot(): void {
        const next = this.createQueue.shift();
        if (next) {
            next.resolve();  // concurrentCreating は変わらない（枠を引き継ぐ）
        } else {
            this.concurrentCreating--;
        }
    }

    async createAvatar(
        id: string, sheetUrl: string, charCol: number, charRow: number,
        x: number, z: number, name: string, baseColor?: Color3, ry?: number
    ): Promise<TransformNode> {
        const _end = prof("SpriteAvatarSystem.createAvatar");
        // 作成中なら無視
        if (this.creating.has(id)) { _end(); return new TransformNode("dummy_" + id, this.scene); }
        this.creating.add(id);

        // 同時作成数を制限（大量接続時のブラウザクラッシュ防止）
        await this.acquireCreateSlot();

        let entry: ManagerEntry;
        try {
            entry = await this.getOrCreateManager(sheetUrl);
        } catch (e) {
            this.releaseCreateSlot();
            this.creating.delete(id);
            _end();
            console.warn(`SpriteAvatarSystem: failed to load sheet ${sheetUrl}:`, e);
            return new TransformNode("dummy_" + id, this.scene);
        }
        const info = entry.sheetInfo;

        console.log(`SpriteAvatarSystem.createAvatar id=${id} sheet=${sheetUrl} frameW=${info.frameW} frameH=${info.frameH} fCols=${info.fCols}`);
        const s = new Sprite("sprAvatar_" + id, entry.mgr);
        const baseSprW = info.frameW >= 80 ? 3.0 : 1.8;
        const sprAspect = info.frameH / info.frameW;
        s.width = baseSprW;
        s.height = baseSprW * sprAspect;

        const root = new TransformNode("sprRoot_" + id, this.scene);
        root.position.set(x, 0, z);
        if (ry !== undefined) root.rotation.y = ry;

        s.position = new Vector3(x, s.height / 2, z);

        // idle frame (dir=0 down, frame=1 middle)
        const idle = cellIndex(info, charCol, charRow, 0, 1);
        s.cellIndex = idle;

        // stand base
        const standBase = this.createStandBase(id, root, baseColor);
        standBase.setEnabled(this.standBaseVisible);

        // name tag
        const { plane: namePlane, update: nameUpdate } = this.createNameTag(root, name, s.height);

        // speech bubble（遅延生成: 初回のspeechUpdate呼出時に実体を作成）
        let speechImpl: { updater: (text: string) => void; redraw: () => void; setAlpha: (a: number) => void; getAlpha: () => number } | null = null;
        const ensureSpeech = () => {
            if (!speechImpl) speechImpl = this.createSpeechBubble(namePlane);
            return speechImpl;
        };
        const speechUpdate = (text: string) => ensureSpeech().updater(text);
        const speechRedraw = () => { if (speechImpl) speechImpl.redraw(); };
        const speechSetAlpha = (a: number) => { if (speechImpl) speechImpl.setAlpha(a); };
        const speechGetAlpha = () => speechImpl ? speechImpl.getAlpha() : 0;

        // 新しいアバターの準備が完了してから旧アバターを破棄（ちらつき防止）
        if (this.avatars.has(id)) {
            this.dispose(id);
            // dispose() が creating 中フラグを見て disposed に追加してしまうので、
            // 内部呼び出し分をクリアする（外部からの dispose 要求とは区別）
            this.disposed.delete(id);
        }

        // creating中に外部からdisposeが呼ばれていた場合、作成したものを即破棄
        if (this.disposed.has(id)) {
            this.disposed.delete(id);
            this.creating.delete(id);
            s.dispose();
            root.getChildMeshes().forEach(m => {
                if (m.material) {
                    const mat = m.material as StandardMaterial;
                    if (mat.diffuseTexture) mat.diffuseTexture.dispose();
                    mat.dispose();
                }
                m.dispose();
            });
            root.dispose();
            this.releaseCreateSlot();
            _end();
            return root;
        }

        const data: SpriteAvatarData = {
            sprite: s, root, standBase, namePlane, nameUpdate, speechUpdate, speechRedraw, speechSetAlpha, speechGetAlpha,
            sheetInfo: info, charCol, charRow,
            currentDir: 0, isMoving: false,
            prevX: x, prevZ: z,
            spriteBaseY: s.height / 2, jumpStart: 0, jumpDuration: 0, jumpHeight: 0,
        };
        this.avatars.set(id, data);
        this.creating.delete(id);
        this.releaseCreateSlot();

        // 再作成中に保留された jump を適用（TTL 内のみ）
        const pending = this.pendingJumps.get(id);
        if (pending && performance.now() - pending.ts < this.PENDING_JUMP_TTL_MS) {
            data.jumpHeight = pending.height;
            data.jumpDuration = pending.duration;
            data.jumpStart = performance.now();
        }
        this.pendingJumps.delete(id);

        _end();
        return root;
    }

    updateAnimation(id: string, camAlpha: number): void {
        const data = this.avatars.get(id);
        if (!data) return;

        const { sprite, root, sheetInfo, charCol, charRow } = data;
        const dx = root.position.x - data.prevX;
        const dz = root.position.z - data.prevZ;
        data.prevX = root.position.x;
        data.prevZ = root.position.z;

        sprite.position.x = root.position.x;
        sprite.position.z = root.position.z;

        // ジャンプ演出: 放物線オフセット（4t(1-t) は t=0.5 でピーク 1.0）
        // root は動かし名前タグ等は一緒に跳ね、足元の五角形(standBase)は逆補正で地面に固定
        if (data.jumpStart > 0) {
            const t = (performance.now() - data.jumpStart) / data.jumpDuration;
            if (t >= 1) {
                data.jumpStart = 0;
                root.position.y = 0;
                sprite.position.y = data.spriteBaseY;
                data.standBase.position.y = 0.025 + 0.01;
            } else {
                const offset = 4 * t * (1 - t) * data.jumpHeight;
                root.position.y = offset;
                sprite.position.y = data.spriteBaseY + offset;
                data.standBase.position.y = 0.025 + 0.01 - offset;
            }
        }

        const moving = dx * dx + dz * dz > 0.0001;

        if (moving) {
            // スタンドベースを移動方向に向ける
            const targetAngle = Math.atan2(dx, dz) + Math.PI;
            root.rotation.y = targetAngle;

            const dir = worldDirToSpriteDir(dx, dz, camAlpha);
            if (!data.isMoving || dir !== data.currentDir) {
                const range = animRange(sheetInfo, charCol, charRow, dir);
                sprite.playAnimation(range.from, range.to, true, 150);
                data.currentDir = dir;
            }
            data.isMoving = true;
        } else if (data.isMoving) {
            sprite.stopAnimation();
            // 停止時: スタンドベース方向からスプライト方向を算出
            const mvx = -Math.sin(root.rotation.y);
            const mvz = -Math.cos(root.rotation.y);
            const stopDir = worldDirToSpriteDir(mvx, mvz, camAlpha);
            data.currentDir = stopDir;
            sprite.cellIndex = cellIndex(sheetInfo, charCol, charRow, stopDir, 1);
            data.isMoving = false;
        } else {
            // 静止中でもカメラ回転でスプライト方向を更新
            const mvx = -Math.sin(root.rotation.y);
            const mvz = -Math.cos(root.rotation.y);
            const idleDir = worldDirToSpriteDir(mvx, mvz, camAlpha);
            if (idleDir !== data.currentDir) {
                data.currentDir = idleDir;
                sprite.cellIndex = cellIndex(sheetInfo, charCol, charRow, idleDir, 1);
            }
        }
    }

    /** 指定アバターをジャンプさせる（放物線で上下に跳ねる）
     *  アバター再作成中の場合は保留し、createAvatar 完了時に適用 */
    jump(id: string, height: number = 1.5, durationMs: number = 500): void {
        const data = this.avatars.get(id);
        if (data) {
            data.jumpHeight = height;
            data.jumpDuration = durationMs;
            data.jumpStart = performance.now();
        }
        // 再作成中 or 未作成 なら保留（新スプライト作成時に反映）
        if (!data || this.creating.has(id)) {
            this.pendingJumps.set(id, { ts: performance.now(), height, duration: durationMs });
        }
    }

    setEnabled(id: string, enabled: boolean): void {
        const data = this.avatars.get(id);
        if (!data) return;
        data.sprite.isVisible = enabled;
        data.root.setEnabled(enabled);
    }

    /** 足元の五角形（standBase）の表示状態を全アバターに一括適用（新規作成分にも反映） */
    setStandBaseVisible(visible: boolean): void {
        this.standBaseVisible = visible;
        for (const data of this.avatars.values()) {
            data.standBase.setEnabled(visible);
        }
    }

    getStandBaseVisible(): boolean {
        return this.standBaseVisible;
    }

    setPosition(id: string, x: number, z: number): void {
        const data = this.avatars.get(id);
        if (!data) return;
        data.root.position.x = x;
        data.root.position.z = z;
        data.prevX = x;
        data.prevZ = z;
        data.sprite.position.x = x;
        data.sprite.position.z = z;
    }

    setRotation(id: string, ry: number): void {
        const data = this.avatars.get(id);
        if (!data) return;
        data.root.rotation.y = ry;
    }

    syncPosition(id: string, x: number, z: number): void {
        const data = this.avatars.get(id);
        if (!data) return;
        data.root.position.x = x;
        data.root.position.z = z;
        data.sprite.position.x = x;
        data.sprite.position.z = z;
    }

    getNameUpdate(id: string): ((name: string, color?: string, suffix?: string) => void) | undefined {
        return this.avatars.get(id)?.nameUpdate;
    }

    getSpeechUpdate(id: string): ((text: string) => void) | undefined {
        return this.avatars.get(id)?.speechUpdate;
    }

    setSpeechAlpha(id: string, alpha: number): void {
        this.avatars.get(id)?.speechSetAlpha(alpha);
    }

    getSpeechAlpha(id: string): number {
        return this.avatars.get(id)?.speechGetAlpha() ?? 1;
    }

    dispose(id: string): void {
        // creating中ならフラグを立てて、createAvatar完了時に破棄させる
        if (this.creating.has(id)) {
            this.disposed.add(id);
        }
        const data = this.avatars.get(id);
        if (!data) return;

        // 子メッシュのマテリアル・テクスチャを再帰的に破棄
        const disposeMeshTree = (node: TransformNode) => {
            for (const child of node.getChildTransformNodes(false)) {
                disposeMeshTree(child);
            }
            if (node instanceof Mesh) {
                if (node.material) {
                    const mat = node.material as StandardMaterial;
                    if (mat.diffuseTexture) mat.diffuseTexture.dispose();
                    mat.dispose();
                }
                // AdvancedDynamicTexture (GUI) はメッシュの _linkedControls ではなくテクスチャリストに残る
                const guiTextures = this.scene.textures.filter(
                    t => t instanceof AdvancedDynamicTexture && (t as any)._meshByName === node.name
                );
                for (const gt of guiTextures) gt.dispose();
                node.dispose();
            }
        };

        // namePlane に付いた AdvancedDynamicTexture を直接破棄
        const adtList = this.scene.textures.filter(
            t => t instanceof AdvancedDynamicTexture
                && (t as any)._mesh === data.namePlane
        );
        for (const adt of adtList) adt.dispose();

        disposeMeshTree(data.root);
        data.sprite.dispose();
        data.root.dispose();
        this.avatars.delete(id);
    }

    refreshAllSpeeches(): void {
        for (const data of this.avatars.values()) {
            data.speechRedraw();
        }
    }

    has(id: string): boolean {
        return this.avatars.has(id);
    }

    isCreating(id: string): boolean {
        return this.creating.has(id);
    }

    // 台座の頂点データ（形状は全アバター共通）をキャッシュ
    private _standFrontVd: VertexData | null = null;
    private _standBackVd: VertexData | null = null;
    // デフォルト色のMaterialを共有（色指定なしのアバター全員で使い回す）
    private _defaultFrontMat: StandardMaterial | null = null;
    private _defaultBackMat: StandardMaterial | null = null;

    private getStandVertexData(): { front: VertexData; back: VertexData } {
        if (this._standFrontVd && this._standBackVd) {
            return { front: this._standFrontVd, back: this._standBackVd };
        }
        const y = 0.025; // baseThickness(0.05) / 2
        // 頂点座標（上面5点 + 底面5点）
        const p = [
            [0, y, -0.5], [0.5, y, -0.1], [0.5, y, 0.5], [-0.5, y, 0.5], [-0.5, y, -0.1],
            [0, -y, -0.5], [0.5, -y, -0.1], [0.5, -y, 0.5], [-0.5, -y, 0.5], [-0.5, -y, -0.1],
        ];
        const v = (i: number) => p[i];
        // Front mesh: 先頭三角形（p0-p1-p4 + 底面 + 側面）
        const fPos: number[] = [], fInd: number[] = [];
        let fi = 0;
        const fAdd = (a: number[], b: number[], c: number[]) => {
            fPos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
            fInd.push(fi, fi + 1, fi + 2); fi += 3;
        };
        const fQuad = (a: number[], b: number[], c: number[], d: number[]) => { fAdd(a, b, c); fAdd(a, c, d); };
        fAdd(v(0), v(4), v(1));
        fAdd(v(5), v(6), v(9));
        fQuad(v(0), v(1), v(6), v(5));
        fQuad(v(4), v(0), v(5), v(9));
        const fNorm: number[] = [];
        VertexData.ComputeNormals(fPos, fInd, fNorm);
        this._standFrontVd = new VertexData();
        this._standFrontVd.positions = fPos; this._standFrontVd.indices = fInd; this._standFrontVd.normals = fNorm;
        // Back mesh: 後方四角形（p1-p2-p3-p4 + 底面 + 側面）
        const bPos: number[] = [], bInd: number[] = [];
        let bi = 0;
        const bAdd = (a: number[], b: number[], c: number[]) => {
            bPos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
            bInd.push(bi, bi + 1, bi + 2); bi += 3;
        };
        const bQuad = (a: number[], b: number[], c: number[], d: number[]) => { bAdd(a, b, c); bAdd(a, c, d); };
        bQuad(v(1), v(2), v(3), v(4));
        bQuad(v(9), v(8), v(7), v(6));
        bQuad(v(1), v(2), v(7), v(6));
        bQuad(v(2), v(3), v(8), v(7));
        bQuad(v(3), v(4), v(9), v(8));
        const bNorm: number[] = [];
        VertexData.ComputeNormals(bPos, bInd, bNorm);
        this._standBackVd = new VertexData();
        this._standBackVd.positions = bPos; this._standBackVd.indices = bInd; this._standBackVd.normals = bNorm;
        return { front: this._standFrontVd, back: this._standBackVd };
    }

    private getDefaultStandMaterials(): { front: StandardMaterial; back: StandardMaterial } {
        if (!this._defaultFrontMat) {
            const c = new Color3(0.4, 0.75, 0.95);
            const f = new StandardMaterial("sprBaseMatFront_default", this.scene);
            f.diffuseColor = c; f.alpha = 0.8; f.specularColor = Color3.Black();
            f.backFaceCulling = false; f.needDepthPrePass = true;
            this._defaultFrontMat = f;
            const b = new StandardMaterial("sprBaseMatBack_default", this.scene);
            b.diffuseColor = c; b.alpha = 0.4; b.specularColor = Color3.Black();
            b.backFaceCulling = false; b.needDepthPrePass = true;
            this._defaultBackMat = b;
        }
        return { front: this._defaultFrontMat, back: this._defaultBackMat! };
    }

    private createStandBase(id: string, parent: TransformNode, color?: Color3): Mesh {
        const { front: fVd, back: bVd } = this.getStandVertexData();

        const frontMesh = new Mesh("sprStandFront_" + id, this.scene);
        fVd.applyToMesh(frontMesh);
        const backMesh = new Mesh("sprStandBack_" + id, this.scene);
        bVd.applyToMesh(backMesh);

        if (color) {
            // カスタム色（自分のアバター）は専用Material
            const fm = new StandardMaterial("sprBaseMatFront_" + id, this.scene);
            fm.diffuseColor = color; fm.alpha = 0.8; fm.specularColor = Color3.Black();
            fm.backFaceCulling = false; fm.needDepthPrePass = true;
            frontMesh.material = fm;
            const bm = new StandardMaterial("sprBaseMatBack_" + id, this.scene);
            bm.diffuseColor = color; bm.alpha = 0.4; bm.specularColor = Color3.Black();
            bm.backFaceCulling = false; bm.needDepthPrePass = true;
            backMesh.material = bm;
        } else {
            // デフォルト色は共有Material
            const { front: fm, back: bm } = this.getDefaultStandMaterials();
            frontMesh.material = fm;
            backMesh.material = bm;
        }

        const standRoot = new TransformNode("sprStand_" + id, this.scene);
        standRoot.parent = parent;
        standRoot.position.set(0, 0.025 + 0.01, 0);
        frontMesh.parent = standRoot;
        backMesh.parent = standRoot;

        return standRoot as unknown as Mesh;
    }

    private createNameTag(parent: TransformNode, nameText: string, spriteHeight: number): { plane: Mesh; update: (name: string, color?: string, suffix?: string) => void } {
        const nameTexW = 512, nameTexH = 192;
        const nameW = 3.0;
        const nameH = nameW * (nameTexH / nameTexW);
        const namePlane = MeshBuilder.CreatePlane("sprNameTag_" + parent.name, { width: nameW, height: nameH }, this.scene);
        namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        namePlane.isPickable = false;
        namePlane.parent = parent;
        namePlane.position = new Vector3(0, spriteHeight + 0.05, 0);

        const adt = AdvancedDynamicTexture.CreateForMesh(namePlane, nameTexW, nameTexH);

        // @マーク用（色付き）と ユーザID用（白）を横並びにする
        const panel = new StackPanel();
        panel.isVertical = false;
        panel.adaptWidthToChildren = true;
        panel.heightInPixels = nameTexH;
        panel.horizontalAlignment = StackPanel.HORIZONTAL_ALIGNMENT_CENTER;
        panel.verticalAlignment = StackPanel.VERTICAL_ALIGNMENT_TOP;
        panel.clipChildren = false;
        panel.clipContent = false;
        adt.addControl(panel);

        const tbAt = new TextBlock();
        tbAt.text = "";
        tbAt.color = "white";
        tbAt.fontSize = "24px";
        tbAt.fontWeight = "bold";
        tbAt.outlineWidth = 3;
        tbAt.outlineColor = "black";
        tbAt.widthInPixels = 40;
        tbAt.heightInPixels = nameTexH;
        panel.addControl(tbAt);

        const tbName = new TextBlock();
        tbName.text = nameText;
        tbName.color = "white";
        tbName.fontSize = "24px";
        tbName.fontWeight = "bold";
        tbName.outlineWidth = 3;
        tbName.outlineColor = "black";
        tbName.resizeToFit = true;
        tbName.heightInPixels = nameTexH;
        panel.addControl(tbName);

        // セッションIDサフィックス用（#だけ色付き、4桁は白）
        const tbHash = new TextBlock();
        tbHash.text = "";
        tbHash.color = "white";
        tbHash.fontSize = "20px";
        tbHash.fontWeight = "bold";
        tbHash.outlineWidth = 3;
        tbHash.outlineColor = "black";
        tbHash.resizeToFit = true;
        tbHash.heightInPixels = nameTexH;
        panel.addControl(tbHash);

        const tbSuffixId = new TextBlock();
        tbSuffixId.text = "";
        tbSuffixId.color = "white";
        tbSuffixId.fontSize = "20px";
        tbSuffixId.fontWeight = "bold";
        tbSuffixId.outlineWidth = 3;
        tbSuffixId.outlineColor = "black";
        tbSuffixId.resizeToFit = true;
        tbSuffixId.heightInPixels = nameTexH;
        panel.addControl(tbSuffixId);

        return { plane: namePlane, update: (n: string, color?: string, suffix?: string) => {
            if (color && color !== "white") {
                // @マークだけ色付き、残りは白
                tbAt.text = "@";
                tbAt.color = color;
                tbAt.outlineColor = "rgba(0,0,0,0.7)";
                tbName.text = n.startsWith("@") ? n.slice(1) : n;
                tbName.color = "white";
                tbName.outlineColor = "black";
            } else {
                // 表示名モード: @マークなし、全部白
                tbAt.text = "";
                tbName.text = n;
                tbName.color = "white";
                tbName.outlineColor = "black";
            }
            // セッションIDサフィックス（#だけ色付き、4桁は白）
            if (suffix && suffix.startsWith("#")) {
                const hashColor = color && color !== "white" ? color : "#00bbfa";
                tbHash.text = "#";
                tbHash.color = hashColor;
                tbHash.outlineColor = "rgba(0,0,0,0.7)";
                tbSuffixId.text = suffix.slice(1);
                tbSuffixId.color = "white";
                tbSuffixId.outlineColor = "black";
            } else {
                tbHash.text = "";
                tbSuffixId.text = "";
            }
        } };
    }

    private createSpeechBubble(namePlane: Mesh): { updater: (text: string) => void; redraw: () => void; setAlpha: (a: number) => void; getAlpha: () => number } {
        const texW = 512, texH = 512;
        // 1テクスチャpx = worldScale ワールド単位
        const worldScale = 1 / 128;  // 128px = 1.0 ワールド単位

        const bubblePlane = MeshBuilder.CreatePlane("sprBubble_" + namePlane.name,
            { width: texW * worldScale, height: texH * worldScale }, this.scene);
        bubblePlane.isPickable = false;
        bubblePlane.parent = namePlane;
        bubblePlane.position = new Vector3(0, 0, 0);

        const dynTex = new DynamicTexture("sprBubbleTex_" + namePlane.name, { width: texW, height: texH }, this.scene, true);
        dynTex.hasAlpha = true;
        const mat = new StandardMaterial("sprBubbleMat_" + namePlane.name, this.scene);
        mat.diffuseTexture = dynTex;
        mat.useAlphaFromDiffuseTexture = true;
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        bubblePlane.material = mat;
        bubblePlane.isVisible = false;

        let lastText = "";

        const draw = (text: string) => {
            const ctx = dynTex.getContext() as unknown as CanvasRenderingContext2D | null;
            if (!ctx) return;  // テクスチャ破棄済み
            ctx.clearRect(0, 0, texW, texH);
            if (!text || text.trim() === "") return;

            const MAX_LINES = 5;
            const ptSize = parseInt((document.getElementById("speechSizeSelect") as HTMLSelectElement | null)?.value ?? "24", 10);
            const fontSize = Math.round(ptSize * 96 / 72);
            const aaMode = (document.getElementById("aaModeBtn") as HTMLButtonElement | null)?.classList.contains("on") ?? false;
            let fontFamily: string;
            let leadingMult: number;
            if (aaMode) {
                fontFamily = "'ＭＳ Ｐゴシック', 'MS PGothic', 'Mona', sans-serif";
                leadingMult = 1.0;
            } else {
                fontFamily = (document.getElementById("speechFontSelect") as HTMLSelectElement | null)?.value ?? "monospace";
                leadingMult = parseFloat((document.getElementById("speechLeadingSelect") as HTMLSelectElement | null)?.value ?? "1.3");
            }
            const lineSpacing = Math.round(fontSize * leadingMult);

            // フォント設定してからwrap計算
            ctx.font = `bold ${fontSize}px ${fontFamily}`;
            const pad = Math.max(8, Math.round(fontSize * 0.5));
            const maxLineW = texW - pad * 2;

            // 折り返し処理
            const wrapLine = (line: string): string[] => {
                if (ctx.measureText(line).width <= maxLineW) return [line];
                const wrapped: string[] = [];
                let cur = "";
                for (let i = 0; i < line.length; i++) {
                    const ch = line[i];
                    const test = cur + ch;
                    if (ctx.measureText(test).width > maxLineW && cur.length > 0) {
                        wrapped.push(cur);
                        cur = ch;
                    } else {
                        cur = test;
                    }
                }
                if (cur) wrapped.push(cur);
                return wrapped;
            };

            const rawLines = text.split("\n");
            while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") rawLines.pop();
            const wrappedLines: string[] = [];
            for (const line of rawLines) {
                for (const wl of wrapLine(line)) {
                    wrappedLines.push(wl);
                    if (wrappedLines.length >= MAX_LINES) break;
                }
                if (wrappedLines.length >= MAX_LINES) break;
            }
            // MAX_LINES超過時は最終行に...を付加
            if (wrappedLines.length >= MAX_LINES) {
                const totalRawLines = rawLines.reduce((s, l) => s + wrapLine(l).length, 0);
                if (totalRawLines > MAX_LINES) {
                    wrappedLines[MAX_LINES - 1] = wrappedLines[MAX_LINES - 1].slice(0, -1) + "...";
                }
            }
            const clippedLines = wrappedLines;
            const n = Math.max(1, clippedLines.length);

            const vertPad = Math.round(fontSize / 2);
            let bH1 = Math.max(fontSize + vertPad * 2, lineSpacing + vertPad * 2);
            let tH  = Math.max(36, Math.round(fontSize * 0.95));
            let lH  = Math.max(lineSpacing, 48);
            const rawTotalH = bH1 + (n - 1) * lH + tH;
            const fit = rawTotalH > texH ? texH / rawTotalH : 1;
            if (fit < 1) {
                bH1 = Math.round(bH1 * fit);
                tH  = Math.round(tH  * fit);
                lH  = Math.round(lH  * fit);
            }
            const drawFontSize = Math.round(fontSize * fit);

            const rad = Math.max(4, Math.round(14 * (bH1 / 108)));
            const actualLeftPad = Math.max(8, Math.round(drawFontSize * 0.5));

            ctx.font = `bold ${drawFontSize}px ${fontFamily}`;
            const maxTextW = Math.max(...clippedLines.map(l => ctx.measureText(l).width));
            const usedTexW = Math.min(texW, Math.max(60, Math.ceil(actualLeftPad * 2 + maxTextW)));

            const bodyH  = bH1 + (n - 1) * lH;

            // プレーンのスケール = 1.0（テクスチャpx→ワールドはworldScaleで固定済み）
            bubblePlane.scaling.x = 1;
            bubblePlane.scaling.y = 1;
            // 尻尾先端が表示名の少し上に来るよう配置
            const nameH = 0.75;  // namePlane の高さ
            const planeFullH = texH * worldScale;
            bubblePlane.position.y = nameH * 0.1 + planeFullH / 2;
            bubblePlane.position.x = 0;

            // 外枠が小さいときは尻尾を縮小（尻尾基本幅60pxの2倍を閾値とする）
            const tailBaseW = Math.round(60 * (bH1 / 108));
            const tailScale = usedTexW < tailBaseW * 2 ? 0.5 : 1.0;
            const drawTotalH = bodyH + Math.round(tH * tailScale);

            // テクスチャの下端に尻尾が来るよう、下詰めで描画
            const yOff = texH - drawTotalH;

            // 吹き出しをテクスチャの水平中央に配置
            const xOff = Math.round((texW - usedTexW) / 2);

            ctx.save();
            ctx.translate(xOff, yOff);

            ctx.beginPath();
            ctx.moveTo(rad, 0);
            ctx.lineTo(usedTexW - rad, 0);
            ctx.quadraticCurveTo(usedTexW, 0, usedTexW, rad);
            ctx.lineTo(usedTexW, bodyH - rad);
            ctx.quadraticCurveTo(usedTexW, bodyH, usedTexW - rad, bodyH);
            // 尻尾を吹き出し本体の中央に描画（2文字以下は半分サイズ）
            const tailX = Math.round(usedTexW / 2);
            const tailHalf = Math.round(30 * (bH1 / 108) * tailScale);
            const tailL = tailX - tailHalf;
            const tailR = tailX + tailHalf;
            const tailTip = bodyH + Math.round(tH * tailScale);
            ctx.lineTo(tailR, bodyH);
            ctx.lineTo(tailX, tailTip);
            ctx.lineTo(tailL, bodyH);
            ctx.lineTo(rad, bodyH);
            ctx.quadraticCurveTo(0, bodyH, 0, bodyH - rad);
            ctx.lineTo(0, rad);
            ctx.quadraticCurveTo(0, 0, rad, 0);
            ctx.closePath();
            ctx.fillStyle = "rgba(255,255,255,0.92)";
            ctx.fill();
            ctx.strokeStyle = "#444";
            ctx.lineWidth = 3;
            ctx.stroke();

            ctx.font = `bold ${drawFontSize}px ${fontFamily}`;
            ctx.fillStyle = "#111";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            const totalTextH = n * lH;
            const textStartY = (bodyH - totalTextH) / 2 + lH / 2;
            for (let i = 0; i < n; i++) {
                ctx.fillText(clippedLines[i], actualLeftPad, textStartY + i * lH);
            }
            ctx.restore();
            dynTex.update();
        };

        const updater = (text: string) => {
            lastText = text;
            const visible = !!(text && text.trim() !== "");
            bubblePlane.isVisible = visible;
            if (visible) mat.alpha = 1;
            draw(text);
        };
        const redraw = () => { if (lastText) draw(lastText); };
        const setAlpha = (a: number) => {
            mat.alpha = a;
            if (a <= 0) { bubblePlane.isVisible = false; lastText = ""; }
        };
        const getAlpha = () => mat.alpha;
        return { updater, redraw, setAlpha, getAlpha };
    }
}
