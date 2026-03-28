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
    nameUpdate: (name: string, color?: string) => void;
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

    constructor(private scene: Scene) {}

    private async getOrCreateManager(sheetUrl: string): Promise<ManagerEntry> {
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
            result.dataURL, 50,
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

    async createAvatar(
        id: string, sheetUrl: string, charCol: number, charRow: number,
        x: number, z: number, name: string, baseColor?: Color3, ry?: number
    ): Promise<TransformNode> {
        const _end = prof("SpriteAvatarSystem.createAvatar");
        // 作成中なら無視
        if (this.creating.has(id)) { _end(); return new TransformNode("dummy_" + id, this.scene); }
        this.creating.add(id);
        const entry = await this.getOrCreateManager(sheetUrl);
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

        // name tag
        const { plane: namePlane, update: nameUpdate } = this.createNameTag(root, name, s.height);

        // speech bubble
        const { updater: speechUpdate, redraw: speechRedraw, setAlpha: speechSetAlpha, getAlpha: speechGetAlpha } = this.createSpeechBubble(namePlane);

        // 新しいアバターの準備が完了してから旧アバターを破棄（ちらつき防止）
        if (this.avatars.has(id)) {
            this.dispose(id);
        }

        // creating中にdisposeが呼ばれていた場合、作成したものを即破棄
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
            _end();
            return root;
        }

        const data: SpriteAvatarData = {
            sprite: s, root, standBase, namePlane, nameUpdate, speechUpdate, speechRedraw, speechSetAlpha, speechGetAlpha,
            sheetInfo: info, charCol, charRow,
            currentDir: 0, isMoving: false,
            prevX: x, prevZ: z,
        };
        this.avatars.set(id, data);
        this.creating.delete(id);

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

    setEnabled(id: string, enabled: boolean): void {
        const data = this.avatars.get(id);
        if (!data) return;
        data.sprite.isVisible = enabled;
        data.root.setEnabled(enabled);
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

    getNameUpdate(id: string): ((name: string, color?: string) => void) | undefined {
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

    private createStandBase(id: string, parent: TransformNode, color?: Color3): Mesh {
        const baseThickness = 0.05;
        const y = baseThickness / 2;
        const baseColor = color ?? new Color3(0.4, 0.75, 0.95);

        const p0 = new Vector3(0, y, -0.5);
        const p1 = new Vector3(0.5, y, -0.1);
        const p2 = new Vector3(0.5, y, 0.5);
        const p3 = new Vector3(-0.5, y, 0.5);
        const p4 = new Vector3(-0.5, y, -0.1);
        const b0 = new Vector3(0, -y, -0.5);
        const b1 = new Vector3(0.5, -y, -0.1);
        const b2 = new Vector3(0.5, -y, 0.5);
        const b3 = new Vector3(-0.5, -y, 0.5);
        const b4 = new Vector3(-0.5, -y, -0.1);

        // 先頭三角形（p0-p1-p4 と底面 b0-b1-b4 + 側面）
        const frontMesh = new Mesh("sprStandFront_" + id, this.scene);
        const fPos: number[] = [], fInd: number[] = [];
        let fi = 0;
        const fAdd = (v0: Vector3, v1: Vector3, v2: Vector3) => {
            fPos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
            fInd.push(fi, fi + 1, fi + 2); fi += 3;
        };
        const fQuad = (v0: Vector3, v1: Vector3, v2: Vector3, v3: Vector3) => { fAdd(v0, v1, v2); fAdd(v0, v2, v3); };
        fAdd(p0, p4, p1); // top
        fAdd(b0, b1, b4); // bottom
        fQuad(p0, p1, b1, b0); // side front-right
        fQuad(p4, p0, b0, b4); // side front-left
        const fNorm: number[] = [];
        VertexData.ComputeNormals(fPos, fInd, fNorm);
        const fVd = new VertexData();
        fVd.positions = fPos; fVd.indices = fInd; fVd.normals = fNorm;
        fVd.applyToMesh(frontMesh);

        const frontMat = new StandardMaterial("sprBaseMatFront_" + id, this.scene);
        frontMat.diffuseColor = baseColor;
        frontMat.alpha = 0.8;
        frontMat.specularColor = new Color3(0, 0, 0);
        frontMat.backFaceCulling = false;
        frontMat.needDepthPrePass = true;
        frontMesh.material = frontMat;

        // 後方四角形（p1-p2-p3-p4 と底面 b1-b2-b3-b4 + 側面）
        const backMesh = new Mesh("sprStandBack_" + id, this.scene);
        const bPos: number[] = [], bInd: number[] = [];
        let bi = 0;
        const bAdd = (v0: Vector3, v1: Vector3, v2: Vector3) => {
            bPos.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
            bInd.push(bi, bi + 1, bi + 2); bi += 3;
        };
        const bQuad = (v0: Vector3, v1: Vector3, v2: Vector3, v3: Vector3) => { bAdd(v0, v1, v2); bAdd(v0, v2, v3); };
        bQuad(p1, p2, p3, p4); // top
        bQuad(b4, b3, b2, b1); // bottom
        bQuad(p1, p2, b2, b1); // side right
        bQuad(p2, p3, b3, b2); // side back
        bQuad(p3, p4, b4, b3); // side left
        const bNorm: number[] = [];
        VertexData.ComputeNormals(bPos, bInd, bNorm);
        const bVd = new VertexData();
        bVd.positions = bPos; bVd.indices = bInd; bVd.normals = bNorm;
        bVd.applyToMesh(backMesh);

        const backMat = new StandardMaterial("sprBaseMatBack_" + id, this.scene);
        backMat.diffuseColor = baseColor;
        backMat.alpha = 0.4;
        backMat.specularColor = new Color3(0, 0, 0);
        backMat.backFaceCulling = false;
        backMat.needDepthPrePass = true;
        backMesh.material = backMat;

        // 親にまとめる
        const standRoot = new TransformNode("sprStand_" + id, this.scene);
        standRoot.parent = parent;
        standRoot.position.set(0, y + 0.01, 0);
        frontMesh.parent = standRoot;
        backMesh.parent = standRoot;

        return standRoot as unknown as Mesh;
    }

    private createNameTag(parent: TransformNode, nameText: string, spriteHeight: number): { plane: Mesh; update: (name: string) => void } {
        const nameTexW = 1024, nameTexH = 384;
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
        tbAt.fontSize = "48px";
        tbAt.fontWeight = "bold";
        tbAt.outlineWidth = 5;
        tbAt.outlineColor = "black";
        tbAt.widthInPixels = 80;
        tbAt.heightInPixels = nameTexH;
        panel.addControl(tbAt);

        const tbName = new TextBlock();
        tbName.text = nameText;
        tbName.color = "white";
        tbName.fontSize = "48px";
        tbName.fontWeight = "bold";
        tbName.outlineWidth = 5;
        tbName.outlineColor = "black";
        tbName.resizeToFit = true;
        tbName.heightInPixels = nameTexH;
        panel.addControl(tbName);

        return { plane: namePlane, update: (n: string, color?: string) => {
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
        } };
    }

    private createSpeechBubble(namePlane: Mesh): { updater: (text: string) => void; redraw: () => void; setAlpha: (a: number) => void; getAlpha: () => number } {
        const texW = 1024, texH = 1024;
        // 1テクスチャpx = worldScale ワールド単位
        const worldScale = 1 / 256;  // 256px = 1.0 ワールド単位

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
            const ctx = dynTex.getContext() as unknown as CanvasRenderingContext2D;
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
