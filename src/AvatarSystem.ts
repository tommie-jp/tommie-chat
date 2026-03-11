import {
    Scene, Mesh, MeshBuilder, StandardMaterial, Color3, MultiMaterial,
    Texture, VertexBuffer, VertexData, Vector3, DynamicTexture
} from "@babylonjs/core";
import { AdvancedDynamicTexture, TextBlock } from "@babylonjs/gui";
import { prof } from "./Profiler";

export class AvatarSystem {
    constructor(private scene: Scene) {}

    changeAvatarTexture(av: Mesh, textureUrl: string): void {
        const _end = prof("AvatarSystem.changeAvatarTexture");
        const tex = new Texture(textureUrl, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;
        for (const child of av.getChildMeshes()) {
            if (!(child.material instanceof MultiMaterial)) continue;
            let disposed = false;
            for (const sub of child.material.subMaterials) {
                const mat = sub as StandardMaterial | null;
                if (!mat?.diffuseTexture) continue;
                if (!disposed) { mat.diffuseTexture.dispose(); disposed = true; }
                mat.diffuseTexture = tex;
            }
        }
        _end();
    }

    createAvatar(name: string, textureUrl: string, x: number, z: number, depth = 0.05): Mesh {
        const _end = prof("AvatarSystem.createAvatar");
        const width = 1.0;
        const height = 1.5;
        const layerCount = 5;
        const vTrimStart = 0.02;
        const vTrimEnd = 0.98;

        const tex = new Texture(textureUrl, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;

        const frontMat = new StandardMaterial(name + "_frontMat", this.scene);
        frontMat.diffuseTexture = tex;
        frontMat.useAlphaFromDiffuseTexture = true;
        frontMat.backFaceCulling = true;
        frontMat.specularColor = new Color3(0.5, 0.5, 0.5);
        frontMat.specularPower = 64;
        frontMat.emissiveColor = new Color3(0.1, 0.1, 0.1);

        const backMat = new StandardMaterial(name + "_backMat", this.scene);
        backMat.diffuseTexture = tex;
        backMat.useAlphaFromDiffuseTexture = true;
        backMat.backFaceCulling = true;
        backMat.specularColor = new Color3(0.5, 0.5, 0.5);
        backMat.specularPower = 64;
        backMat.emissiveColor = new Color3(0.1, 0.1, 0.1);

        const sideMat = new StandardMaterial(name + "_sideMat", this.scene);
        sideMat.diffuseTexture = tex;
        sideMat.useAlphaFromDiffuseTexture = true;
        sideMat.diffuseColor = new Color3(0.5, 0.5, 0.5);
        sideMat.specularColor = new Color3(0.8, 0.8, 0.8);
        sideMat.emissiveColor = new Color3(0.15, 0.15, 0.15);
        sideMat.backFaceCulling = false;

        const normalUVs = [0, vTrimEnd, 1, vTrimEnd, 1, vTrimStart, 0, vTrimStart];
        const invertedUVs = [1, vTrimEnd, 0, vTrimEnd, 0, vTrimStart, 1, vTrimStart];

        const applyCustomUVs = (mesh: Mesh, uvArray: number[]) => {
            mesh.setVerticesData(VertexBuffer.UVKind, uvArray);
        };

        const meshesToMerge: Mesh[] = [];

        const frontMesh = MeshBuilder.CreatePlane(name + "_front", { width, height, updatable: true }, this.scene);
        frontMesh.position.z = -depth / 2;
        frontMesh.material = frontMat;
        applyCustomUVs(frontMesh, normalUVs);
        meshesToMerge.push(frontMesh);

        const backMesh = MeshBuilder.CreatePlane(name + "_back", { width, height, updatable: true }, this.scene);
        backMesh.position.z = depth / 2;
        backMesh.rotation.y = Math.PI;
        backMesh.material = backMat;
        applyCustomUVs(backMesh, invertedUVs);
        meshesToMerge.push(backMesh);

        const step = depth / (layerCount + 1);
        for (let i = 1; i <= layerCount; i++) {
            const layerMesh = MeshBuilder.CreatePlane(name + "_layer" + i, { width, height, updatable: true }, this.scene);
            layerMesh.position.z = -depth / 2 + step * i;
            layerMesh.material = sideMat;
            applyCustomUVs(layerMesh, normalUVs);
            meshesToMerge.push(layerMesh);
        }

        // X字型の対角プレーン（横から見たときの厚みを演出）
        const diagMat = new StandardMaterial(name + "_diagMat", this.scene);
        diagMat.diffuseTexture = tex;
        diagMat.useAlphaFromDiffuseTexture = true;
        diagMat.backFaceCulling = false;
        diagMat.specularColor = new Color3(0.5, 0.5, 0.5);
        diagMat.specularPower = 64;
        diagMat.emissiveColor = new Color3(0.1, 0.1, 0.1);

        const diagAngle = Math.asin(depth / width);

        const diagMesh1 = MeshBuilder.CreatePlane(name + "_diag1", { width, height, updatable: true }, this.scene);
        diagMesh1.rotation.y = diagAngle;
        diagMesh1.material = diagMat;
        applyCustomUVs(diagMesh1, normalUVs);
        meshesToMerge.push(diagMesh1);

        const diagMesh2 = MeshBuilder.CreatePlane(name + "_diag2", { width, height, updatable: true }, this.scene);
        diagMesh2.rotation.y = -diagAngle;
        diagMesh2.material = diagMat;
        applyCustomUVs(diagMesh2, normalUVs);
        meshesToMerge.push(diagMesh2);

        const mergedAvatar = Mesh.MergeMeshes(meshesToMerge, true, true, undefined, false, true) as Mesh;
        mergedAvatar.name = name;

        const avatarRoot = MeshBuilder.CreateBox(name + "_root", { size: 0.1 }, this.scene);
        avatarRoot.isVisible = false;
        avatarRoot.position.set(x, 0, z);

        const baseThickness = 0.05;
        const groundOffset = 0.01;

        mergedAvatar.parent = avatarRoot;
        mergedAvatar.position.set(0, height / 2 + baseThickness + groundOffset, 0);

        const standBase = new Mesh(name + "_standBase", this.scene);
        const y = baseThickness / 2;

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

        const positions: number[] = [];
        const indices: number[] = [];
        let idx = 0;

        const addFace = (v0: Vector3, v1: Vector3, v2: Vector3) => {
            positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
            indices.push(idx, idx+1, idx+2);
            idx += 3;
        };
        const addQuad = (v0: Vector3, v1: Vector3, v2: Vector3, v3: Vector3) => {
            addFace(v0, v1, v2);
            addFace(v0, v2, v3);
        };

        addFace(p0, p4, p3);
        addFace(p0, p3, p2);
        addFace(p0, p2, p1);

        addFace(b0, b1, b2);
        addFace(b0, b2, b3);
        addFace(b0, b3, b4);

        addQuad(p0, p1, b1, b0);
        addQuad(p1, p2, b2, b1);
        addQuad(p2, p3, b3, b2);
        addQuad(p3, p4, b4, b3);
        addQuad(p4, p0, b0, b4);

        const normals: number[] = [];
        VertexData.ComputeNormals(positions, indices, normals);

        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;
        vertexData.applyToMesh(standBase);

        standBase.parent = avatarRoot;
        standBase.position.set(0, y + groundOffset, 0);

        const baseMat = new StandardMaterial(name + "_baseMat", this.scene);
        baseMat.diffuseColor = new Color3(0.4, 0.75, 0.95);
        baseMat.alpha = 0.6;
        baseMat.specularColor = new Color3(0.0, 0.0, 0.0);
        baseMat.backFaceCulling = false;
        baseMat.needDepthPrePass = true;
        standBase.material = baseMat;

        _end();
        return avatarRoot;
    }

    createNameTag(targetMesh: Mesh, nameText: string): { update: (newName: string) => void; plane: Mesh } {
        const _end = prof("AvatarSystem.createNameTag");
        const namePlane = MeshBuilder.CreatePlane("nameTag_" + targetMesh.name, { width: 1.5, height: 0.40 }, this.scene);
        namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        namePlane.isPickable = false;

        namePlane.parent = targetMesh;
        namePlane.position = new Vector3(0, 1.75, 0);

        const adt = AdvancedDynamicTexture.CreateForMesh(namePlane, 1024, 128);

        const textBlock = new TextBlock();
        textBlock.text = nameText;
        textBlock.color = "white";
        textBlock.fontSize = "56px";
        textBlock.fontWeight = "bold";
        textBlock.outlineWidth = 6;
        textBlock.outlineColor = "black";

        adt.addControl(textBlock);

        _end();
        return { update: (newName: string) => { textBlock.text = newName; }, plane: namePlane };
    }

    createSpeechBubble(namePlane: Mesh, speechText: string): (newText: string) => void {
        const _end = prof("AvatarSystem.createSpeechBubble");
        const nameW = 1.5;
        const texW = 1024, texH = 384;
        const planeW = texW / 512 * 1.5;
        const bodyH1 = 108, triH = 36;
        const baseTotalH = bodyH1 + triH;
        const maxPlaneH = texH * (0.42 / baseTotalH);
        const bubblePlane = MeshBuilder.CreatePlane("speechBubble_" + namePlane.name, { width: planeW, height: maxPlaneH }, this.scene);
        bubblePlane.isPickable = false;
        bubblePlane.parent = namePlane;
        const baseX = nameW / 2 + planeW / 2 - 0.5;
        const fixedBottom = -(0.42 / 2);
        bubblePlane.position = new Vector3(baseX, 0, 0);

        const dynTex = new DynamicTexture("speechTex_" + namePlane.name, { width: texW, height: texH }, this.scene, true);
        dynTex.hasAlpha = true;
        const mat = new StandardMaterial("speechMat_" + namePlane.name, this.scene);
        mat.diffuseTexture = dynTex;
        mat.useAlphaFromDiffuseTexture = true;
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        bubblePlane.material = mat;

        bubblePlane.isVisible = false;

        const drawBubble = (text: string) => {
            const ctx = dynTex.getContext() as unknown as CanvasRenderingContext2D;
            ctx.clearRect(0, 0, texW, texH);
            if (!text || text.trim() === "") return;

            const MAX_CHARS = 40;
            const rawLines = text.split('\n');
            while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') rawLines.pop();
            if (rawLines.length > 5) rawLines.splice(5);
            const clippedLines = rawLines.map(l => l.length > MAX_CHARS ? l.slice(0, MAX_CHARS) + '...' : l);
            const n = Math.max(1, clippedLines.length);

            const ptSize = parseInt((document.getElementById("speechSizeSelect") as HTMLSelectElement | null)?.value ?? "14", 10);
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

            const vertPad = 35;
            let bH1 = Math.max(108, lineSpacing + vertPad * 2);
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

            const ttX = Math.round(60 * (bH1 / 108));
            const tbL = Math.round(30 * (bH1 / 108));
            const tbR = Math.round(90 * (bH1 / 108));
            const rad = Math.max(4, Math.round(14 * (bH1 / 108)));
            const leftPad  = Math.max(8, Math.round(fontSize * fit * 0.5));
            const rightPad = leftPad;

            ctx.font = `bold ${drawFontSize}px ${fontFamily}`;
            const maxTextW = Math.max(...clippedLines.map(l => ctx.measureText(l).width));
            const rawUsedTexW = Math.max(60, Math.ceil(leftPad + maxTextW + rightPad));
            const fitX = rawUsedTexW > texW ? texW / rawUsedTexW : 1;
            const usedTexW = rawUsedTexW > texW ? texW : rawUsedTexW;

            const bodyH  = bH1 + (n - 1) * lH;
            const totalH = bodyH + tH;

            const s = totalH / texH;
            const scaleX = s / fitX;
            bubblePlane.scaling.y = s;
            bubblePlane.scaling.x = scaleX;
            bubblePlane.position.y = fixedBottom + s * maxPlaneH / 2;
            bubblePlane.position.x = (nameW / 2 - 0.5) + planeW * scaleX / 2;

            ctx.beginPath();
            ctx.moveTo(rad, 0);
            ctx.lineTo(usedTexW - rad, 0);
            ctx.quadraticCurveTo(usedTexW, 0, usedTexW, rad);
            ctx.lineTo(usedTexW, bodyH - rad);
            ctx.quadraticCurveTo(usedTexW, bodyH, usedTexW - rad, bodyH);
            ctx.lineTo(tbR, bodyH);
            ctx.lineTo(ttX, totalH);
            ctx.lineTo(tbL, bodyH);
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

            ctx.fillStyle = "#111";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            const totalTextH = n * lH;
            const textStartY = (bodyH - totalTextH) / 2 + lH / 2;
            if (fitX < 1) {
                ctx.save();
                ctx.scale(fitX, 1);
                for (let i = 0; i < n; i++) {
                    ctx.fillText(clippedLines[i], leftPad / fitX, textStartY + i * lH);
                }
                ctx.restore();
            } else {
                for (let i = 0; i < n; i++) {
                    ctx.fillText(clippedLines[i], leftPad, textStartY + i * lH);
                }
            }

            dynTex.update();
        };

        if (speechText && speechText.trim() !== "") {
            bubblePlane.isVisible = true;
            drawBubble(speechText);
        }

        _end();
        return (newText: string) => {
            bubblePlane.isVisible = !!(newText && newText.trim() !== "");
            drawBubble(newText);
        };
    }

    applyAvatarDepth(avatars: Mesh[], depth: number): void {
        const _end = prof("AvatarSystem.applyAvatarDepth");
        const scale = depth / 0.05;
        for (const av of avatars) {
            const body = av.getChildMeshes(false).find(m => m.material instanceof MultiMaterial);
            if (body) body.scaling.z = scale;
        }
        _end();
    }
}
