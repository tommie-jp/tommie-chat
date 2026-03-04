import { 
    Engine, 
    Scene, 
    Vector3, 
    Vector4,
    Color4,
    MeshBuilder, 
    HemisphericLight,
    DirectionalLight, 
    PointLight,
    ArcRotateCamera,     
    StandardMaterial, 
    Color3,
    Mesh,
    Texture,
    TransformNode,
    SceneInstrumentation,
    EngineInstrumentation,
    PointerEventTypes,
    DefaultRenderingPipeline,
    VertexBuffer,
    VertexData
} from "@babylonjs/core";
import { AdvancedDynamicTexture, TextBlock, Rectangle, Control } from "@babylonjs/gui"; 
import "@babylonjs/loaders";
import { GridMaterial } from "@babylonjs/materials";

export class GameScene {
    private engine: Engine;
    private scene: Scene;
    private camera!: ArcRotateCamera;
    private playerBox!: Mesh;

    private targetPosition: Vector3 | null = null;
    private readonly moveSpeed = 2.0; 
    
    private inputMap: { [key: string]: boolean } = {};
    
    private hoverMarker!: Mesh;
    private clickMarker!: Mesh;

    private updatePlayerSpeech!: (newText: string) => void;

    private renderingPipeline!: DefaultRenderingPipeline;

    // ==================== 自動移動用 ====================
    private time = 0;
    private npc001!: Mesh;
    private npc002!: Mesh;
    private npc003!: Mesh;                    // ← 新規追加
    private npc001BaseX = 0;
    private npc002BaseX = 1.5;
    private npc002BaseZ = 3;
    private npc003BaseX = 3;                  // ← 新規追加（円の中心）
    private npc003BaseZ = 3;                  // ← 新規追加
    // ===================================================

    constructor(canvas: HTMLCanvasElement) {
        this.engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
        
        this.engine.setHardwareScalingLevel(0.5);

        this.scene = new Scene(this.engine);

        this.setupScene();
        this.createObjects();
        this.setupHtmlUI(); 

        this.handleResize();

        this.engine.runRenderLoop(() => {
            if (this.scene.activeCamera) {
                this.scene.render();
            }
        });

        window.addEventListener("resize", () => {
            requestAnimationFrame(() => this.handleResize());
        });
    }

    private setupScene(): void {
        this.camera = new ArcRotateCamera(
            "camera", 
            Math.PI / 2,     
            Math.PI / 2.5,    
            10.0,             
            new Vector3(0, 0.9, 0),
            this.scene
        );
        this.camera.attachControl(this.engine.getRenderingCanvas() as HTMLCanvasElement, true);

        this.camera.keysUp = [];
        this.camera.keysDown = [];
        this.camera.keysLeft = [];
        this.camera.keysRight = [];

        this.camera.lowerRadiusLimit = 2; 
        this.camera.upperRadiusLimit = 50;
        this.camera.fovMode = ArcRotateCamera.FOVMODE_VERTICAL_FIXED;
        this.camera.inertia = 0;
        
        this.camera.maxZ = 500;
        this.camera.fov = 60 * Math.PI / 180;

        const hemiLight = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), this.scene);
        hemiLight.intensity = 0.8; 
        hemiLight.groundColor = new Color3(0.8, 0.8, 0.8);
        hemiLight.specular = new Color3(0, 0, 0); 

        const dirLightFront = new DirectionalLight("dirLightFront", new Vector3(-0.5, -1.0, 1.0), this.scene);
        dirLightFront.intensity = 0.6;
        dirLightFront.specular = new Color3(1.0, 1.0, 1.0); 

        const dirLightBack = new DirectionalLight("dirLightBack", new Vector3(0.5, -1.0, -1.0), this.scene);
        dirLightBack.intensity = 0.6;
        dirLightBack.specular = new Color3(1.0, 1.0, 1.0); 

        const camLight = new PointLight("camLight", new Vector3(0, 0, 0), this.scene);
        camLight.parent = this.camera; 
        camLight.intensity = 0.4; 
        camLight.diffuse = new Color3(0.0, 0.0, 0.0); 
        camLight.specular = new Color3(0.8, 0.8, 0.8); 

        const skyColor = Color3.FromHexString("#a0d7f3");
        this.scene.clearColor = new Color4(skyColor.r, skyColor.g, skyColor.b, 1.0);
        this.scene.ambientColor = new Color3(0.65, 0.65, 0.75);

        this.scene.fogMode = Scene.FOGMODE_LINEAR;
        this.scene.fogColor = skyColor; 
        this.scene.fogStart = 30.0; 
        this.scene.fogEnd = this.camera.maxZ; 

        this.renderingPipeline = new DefaultRenderingPipeline(
            "defaultPipeline", 
            false, 
            this.scene, 
            [this.camera]
        );
        this.renderingPipeline.samples = 4; 
        
        this.renderingPipeline.depthOfFieldEnabled = true;
        if (this.renderingPipeline.depthOfField) {
            this.renderingPipeline.depthOfField.fStop = 5.6;         
            this.renderingPipeline.depthOfField.focalLength = 50;    
        }
        this.renderingPipeline.depthOfFieldEnabled = false; 
    }

    private setupHtmlUI(): void {
        const textarea = document.getElementById("chatInput") as HTMLTextAreaElement;
        const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
        const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;

        if (!textarea || !sendBtn || !clearBtn) return;

        const sendMessage = () => {
            const text = textarea.value.trim();
            if (this.updatePlayerSpeech) {
                this.updatePlayerSpeech(text);
                textarea.value = "";
            }
        };

        clearBtn.onclick = () => {
            if (this.updatePlayerSpeech) this.updatePlayerSpeech(""); 
            textarea.value = "";
        };

        sendBtn.onclick = sendMessage;
        textarea.onkeydown = (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        };
    }

    private createAvatar(name: string, textureUrl: string, x: number, z: number): Mesh {
        const width = 1.0;
        const height = 1.5;
        const depth = 0.05;    
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

        return avatarRoot;
    }

    private createNameTag(targetMesh: Mesh, nameText: string): void {
        const namePlane = MeshBuilder.CreatePlane("nameTag_" + targetMesh.name, { width: 1.5, height: 0.40 }, this.scene);
        namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        namePlane.isPickable = false;
        
        namePlane.parent = targetMesh;
        namePlane.position = new Vector3(0, 1.75, 0);

        const dpr = window.devicePixelRatio || 1;
        const adt = AdvancedDynamicTexture.CreateForMesh(namePlane, 3600 * dpr, 300 * dpr);

        const textBlock = new TextBlock();
        textBlock.text = nameText;
        textBlock.color = "white";
        textBlock.fontSize = `${80 * dpr}px`;
        textBlock.fontWeight = "bold";
        textBlock.outlineWidth = 12 * dpr;
        textBlock.outlineColor = "black";
        
        adt.addControl(textBlock);
    }

    private createObjects(): void {
        const ground = MeshBuilder.CreateGround("ground", { width: 400, height: 400 }, this.scene);
        const gridMaterial = new GridMaterial("gridMaterial", this.scene);
        gridMaterial.mainColor = new Color3(0.85, 0.95, 0.85);
        gridMaterial.lineColor = new Color3(0.35, 0.55, 0.35);
        gridMaterial.gridRatio = 1.0;
        gridMaterial.opacity = 1.0;
        gridMaterial.freeze(); 
        ground.material = gridMaterial;

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

        this.playerBox = this.createAvatar("tommie.jp", "/textures/pic1.ktx2", 0, 0);
        const player2 = this.createAvatar("npc001", "/textures/pic2.ktx2", 0, 3);
        const player3 = this.createAvatar("npc002", "/textures/pic2.ktx2", 1.5, 3);
        const player4 = this.createAvatar("npc003", "/textures/pic2.ktx2", 3, 3);

        this.npc001 = player2;
        this.npc002 = player3;
        this.npc003 = player4;                    // ← 新規追加

        this.createNameTag(this.playerBox, "tommie.jp✅️");
        this.createNameTag(player2, "npc001");
        this.createNameTag(player3, "npc002");
        this.createNameTag(player4, "npc003");

        this.createRoundedMinecraftClouds();
        this.createCoordinateLabels();
        
        this.updatePlayerSpeech = this.createSpeechBubble(this.playerBox, "こんにちは！");
        this.createSpeechBubble(player2, "キタちゃん１です。");
        this.createSpeechBubble(player3, "キタちゃん２です");
        this.createSpeechBubble(player4, "キタちゃん３です");

        this.createDebugOverlay();

        window.addEventListener("keydown", (e) => {
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA" || activeElement.tagName === "SELECT")) {
                return; 
            }

            const key = e.key.toLowerCase();
            this.inputMap[key] = true;
            
            if (["w", "a", "s", "d", "q", "e", "x", "escape", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
                this.targetPosition = null;
                if (this.clickMarker) this.clickMarker.isVisible = false;
            }
        });

        window.addEventListener("keyup", (e) => {
            const key = e.key.toLowerCase();
            this.inputMap[key] = false;
        });

        this.scene.onPointerObservable.add((pointerInfo) => {
            if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
                const pick = this.scene.pick(
                    this.scene.pointerX, 
                    this.scene.pointerY, 
                    (mesh) => mesh.name === "ground"
                );

                if (pick && pick.hit && pick.pickedPoint) {
                    this.hoverMarker.position.x = Math.floor(pick.pickedPoint.x) + 0.5;
                    this.hoverMarker.position.z = Math.floor(pick.pickedPoint.z) + 0.5;
                    this.hoverMarker.isVisible = true;
                } else {
                    this.hoverMarker.isVisible = false;
                }
            }

            if (pointerInfo.type === PointerEventTypes.POINTERTAP) {
                const pick = pointerInfo.pickInfo;
                if (pick && pick.hit && pick.pickedMesh && pick.pickedMesh.name === "ground" && pick.pickedPoint) {
                    const snappedX = Math.floor(pick.pickedPoint.x) + 0.5;
                    const snappedZ = Math.floor(pick.pickedPoint.z) + 0.5;

                    this.targetPosition = new Vector3(snappedX, 0, snappedZ);
                    this.clickMarker.position.x = snappedX;
                    this.clickMarker.position.z = snappedZ;
                    this.clickMarker.isVisible = true;
                }
            }
        });

        this.scene.onBeforeRenderObservable.add(() => {
            const deltaTime = this.engine.getDeltaTime() / 1000;
            this.time += deltaTime;

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
                } else {
                    this.playerBox.position.copyFrom(target);
                    this.targetPosition = null; 
                    this.clickMarker.isVisible = false; 
                }
            }

            // ==================== NPC自動移動（位置＋進行方向回転） ====================
            // npc001：左右10単位往復
            this.npc001.position.x = this.npc001BaseX + 10 * Math.sin(this.time * 0.8);
            const velocityX = 10 * 0.8 * Math.cos(this.time * 0.8);
            if (Math.abs(velocityX) > 0.01) {
                const targetAngle1 = velocityX > 0 ? -Math.PI / 2 : Math.PI / 2;
                let diff1 = targetAngle1 - this.npc001.rotation.y;
                while (diff1 < -Math.PI) diff1 += Math.PI * 2;
                while (diff1 > Math.PI) diff1 -= Math.PI * 2;
                this.npc001.rotation.y += diff1 * 0.25;
            }

            // npc002：10単位の正方形軌道
            const cycle = (this.time * 0.6) % 40;
            let targetX2 = this.npc002.position.x;
            let targetZ2 = this.npc002.position.z;
            if (cycle < 10) { targetX2 = this.npc002BaseX + cycle; targetZ2 = this.npc002BaseZ; }
            else if (cycle < 20) { targetX2 = this.npc002BaseX + 10; targetZ2 = this.npc002BaseZ + (cycle - 10); }
            else if (cycle < 30) { targetX2 = this.npc002BaseX + (30 - cycle); targetZ2 = this.npc002BaseZ + 10; }
            else { targetX2 = this.npc002BaseX; targetZ2 = this.npc002BaseZ + (40 - cycle); }
            const delta2 = new Vector3(targetX2 - this.npc002.position.x, 0, targetZ2 - this.npc002.position.z);
            this.npc002.position.x = targetX2;
            this.npc002.position.z = targetZ2;
            if (delta2.length() > 0.001) {
                const targetAngle2 = Math.atan2(delta2.x, delta2.z) + Math.PI;
                let diff2 = targetAngle2 - this.npc002.rotation.y;
                while (diff2 < -Math.PI) diff2 += Math.PI * 2;
                while (diff2 > Math.PI) diff2 -= Math.PI * 2;
                this.npc002.rotation.y += diff2 * 0.15;
            }

            // npc003：半径5の円軌道（時計回り）
            const angle = this.time * 1.2;                    // 速度調整可能
            this.npc003.position.x = this.npc003BaseX + 5 * Math.cos(angle);
            this.npc003.position.z = this.npc003BaseZ + 5 * Math.sin(angle);
            // 進行方向回転
            const velocity3 = new Vector3(-5 * 1.2 * Math.sin(angle), 0, 5 * 1.2 * Math.cos(angle));
            if (velocity3.length() > 0.01) {
                const targetAngle3 = Math.atan2(velocity3.x, velocity3.z) + Math.PI;
                let diff3 = targetAngle3 - this.npc003.rotation.y;
                while (diff3 < -Math.PI) diff3 += Math.PI * 2;
                while (diff3 > Math.PI) diff3 -= Math.PI * 2;
                this.npc003.rotation.y += diff3 * 0.25;
            }
            // =====================================================================

            if (this.renderingPipeline.depthOfFieldEnabled && this.renderingPipeline.depthOfField) {
                this.renderingPipeline.depthOfField.focusDistance = this.camera.radius * 1000;
            }
        });

        if (this.camera && this.playerBox) {
            this.camera.setTarget(this.playerBox);
        }
    }

    private createSpeechBubble(targetMesh: Mesh, speechText: string): (newText: string) => void {
        const bubblePlane = MeshBuilder.CreatePlane("speechBubble_" + targetMesh.name, { width: 1.0, height: 0.20 }, this.scene);
        bubblePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        bubblePlane.isPickable = false;
        
        bubblePlane.parent = targetMesh;
        bubblePlane.position = new Vector3(0, 2.05, 0); 
        
        const dpr = window.devicePixelRatio || 1;
        const adt = AdvancedDynamicTexture.CreateForMesh(bubblePlane, 3600 * dpr, 260 * dpr);
        
        const bg = new Rectangle();
        bg.width = "100%"; bg.height = "100%";
        bg.cornerRadius = 20;
        bg.background = "rgba(255, 255, 255, 0.85)";
        bg.thickness = 1;
        bg.color = "#333333";
        adt.addControl(bg);

        const textBlock = new TextBlock();
        textBlock.text = speechText;
        textBlock.fontSize = `${80 * dpr}px`;
        textBlock.color = "black";
        
        textBlock.textWrapping = true;
        textBlock.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        textBlock.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        textBlock.paddingLeft = `${35 * dpr}px`;
        textBlock.paddingRight = `${35 * dpr}px`;
        textBlock.paddingTop = `${20 * dpr}px`;
        textBlock.paddingBottom = `${20 * dpr}px`;
        
        bg.addControl(textBlock);

        this.scene.onBeforeRenderObservable.add(() => {
            if (!textBlock.text || textBlock.text.trim() === "") {
                bubblePlane.isVisible = false;
            } else {
                bubblePlane.isVisible = true;
            }
        });
        
        return (newText: string) => {
            if (newText && newText.trim() !== "") {
                textBlock.text = newText;
                bubblePlane.isVisible = true;
            } else {
                textBlock.text = "";
                bubblePlane.isVisible = false;
            }
            adt.markAsDirty();
        };
    }

    private createRoundedMinecraftClouds(): void {
        const cloudMaterial = new StandardMaterial("roundedMinecraftCloudMat", this.scene);
        cloudMaterial.diffuseColor = new Color3(1, 1, 1);
        cloudMaterial.specularColor = new Color3(0, 0, 0); 
        cloudMaterial.emissiveColor = new Color3(0.6, 0.6, 0.6); 
        cloudMaterial.alpha = 0.6; 
        cloudMaterial.backFaceCulling = false; 
        cloudMaterial.freeze(); 

        const spheresToMerge: Mesh[] = [];

        const cloudPatterns = [
            [ 
                [0,0], [1,0], [2,0],
                [-1,1], [0,1], [1,1], [2,1], [3,1],
                [0,2], [1,2], [2,2],
                [1,3]
            ],
            [ 
                [0,0], [1,0],
                [-1,1], [0,1], [1,1], [2,1],
                [-2,2], [-1,2], [0,2], [1,2], [2,2], [3,2],
                [0,3], [1,3], [2,3],
                [1,4]
            ],
            [ 
                [0,0], [1,0], [2,0], [3,0],
                [-1,1], [0,1], [1,1], [2,1], [3,1], [4,1],
                [0,2], [1,2], [2,2], [3,2],
                [1,3], [2,3]
            ]
        ];

        const blockSize = 6.0; 
        const areaSize = 400; 

        for (let i = 0; i < 25; i++) {
            const baseX = (Math.random() - 0.5) * areaSize;
            const baseY = 40 + (Math.random() - 0.5) * 5; 
            const baseZ = (Math.random() - 0.5) * areaSize;
            
            const pattern = cloudPatterns[Math.floor(Math.random() * cloudPatterns.length)];

            for (const [bx, bz] of pattern) {
                const sphere = MeshBuilder.CreateSphere(`cloud_${i}_${bx}_${bz}`, { 
                    diameter: blockSize, 
                    segments: 24 
                }, this.scene);

                sphere.scaling.set(1.0, 0.5, 1.0);

                sphere.position.set(
                    baseX + bx * blockSize, 
                    baseY, 
                    baseZ + bz * blockSize
                );

                spheresToMerge.push(sphere);
            }
        }

        if (spheresToMerge.length > 0) {
            const mergedClouds = Mesh.MergeMeshes(spheresToMerge, true, true, undefined, false, true);
            if (mergedClouds) {
                mergedClouds.name = "roundedMinecraftClouds";
                mergedClouds.material = cloudMaterial;
                mergedClouds.isPickable = false;

                this.scene.onBeforeRenderObservable.add(() => {
                    const deltaTime = this.engine.getDeltaTime() / 1000;
                    mergedClouds.position.x += 2.0 * deltaTime; 
                    
                    if (mergedClouds.position.x > areaSize / 2) {
                         mergedClouds.position.x -= areaSize;
                    }
                });
            }
        }
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

    private createDebugOverlay(): void {
        const scaleSelect = document.getElementById("scaleSelect") as HTMLSelectElement;
        const aaBtn = document.getElementById("aaBtn") as HTMLButtonElement;
        const lodBtn = document.getElementById("lodBtn") as HTMLButtonElement;
        const farClipInput = document.getElementById("farClipInput") as HTMLInputElement;
        const fovSelect = document.getElementById("fovSelect") as HTMLSelectElement;
        const fovInput = document.getElementById("fovInput") as HTMLInputElement;
        const fogBtn = document.getElementById("fogBtn") as HTMLButtonElement;
        const fogColorInput = document.getElementById("fogColorInput") as HTMLInputElement;
        const dofBtn = document.getElementById("dofBtn") as HTMLButtonElement;
        const fStopInput = document.getElementById("fStopInput") as HTMLInputElement;
        const focalLengthInput = document.getElementById("focalLengthInput") as HTMLInputElement;
        const glossInput = document.getElementById("glossInput") as HTMLInputElement;
        
        const resetViewBtn = document.getElementById("resetViewBtn") as HTMLButtonElement;
        const topViewBtn   = document.getElementById("topViewBtn") as HTMLButtonElement;

        const playerPosVal = document.getElementById("val-player-pos");
        const camInfoVal = document.getElementById("val-cam-info");

        const fv = document.getElementById("val-fps");
        const cv = document.getElementById("val-cpu");
        const gv = document.getElementById("val-gpu");
        const dv = document.getElementById("val-draw");
        const mv = document.getElementById("val-mesh");
        const matv = document.getElementById("val-mats");
        const bv = document.getElementById("val-bones");
        const rv = document.getElementById("val-jsram");
        const tv = document.getElementById("val-texram");
        const geov = document.getElementById("val-georam");
        const iv = document.getElementById("val-indices");
        const pv = document.getElementById("val-polys");
        const ov = document.getElementById("val-occlq");
        const apiv = document.getElementById("val-api");

        const isWebGPU = (this.engine as any).isWebGPU || this.engine.name === "WebGPU";
        if (apiv) apiv.innerText = isWebGPU ? "WebGPU" : "WebGL2";

        if (scaleSelect) {
            scaleSelect.addEventListener("change", (e) => {
                const target = e.target as HTMLSelectElement;
                const newScale = parseFloat(target.value);
                this.engine.setHardwareScalingLevel(newScale);
            });
        }

        let isAAEnabled = true;
        if (aaBtn) {
            aaBtn.addEventListener("click", () => {
                isAAEnabled = !isAAEnabled;
                this.renderingPipeline.samples = isAAEnabled ? 4 : 1; 
                aaBtn.innerText = isAAEnabled ? "On" : "Off";
                if (isAAEnabled) aaBtn.classList.remove("off");
                else aaBtn.classList.add("off");
            });
        }

        let isLODEnabled = false;
        if (lodBtn) {
            lodBtn.addEventListener("click", () => {
                isLODEnabled = !isLODEnabled;
                lodBtn.innerText = isLODEnabled ? "On" : "Off";
                if (isLODEnabled) lodBtn.classList.remove("off");
                else lodBtn.classList.add("off");
            });
        }

        if (farClipInput && this.camera) {
            farClipInput.addEventListener("input", (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!isNaN(val) && val > 0) {
                    this.camera.maxZ = val;
                    this.scene.fogEnd = val;
                }
            });
        }

        if (fovSelect && fovInput && this.camera) {
            fovInput.addEventListener("input", (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!isNaN(val) && val > 0) {
                    this.camera.fov = val * Math.PI / 180;
                    
                    const optionExists = Array.from(fovSelect.options).some(opt => opt.value === val.toString());
                    if (optionExists) {
                        fovSelect.value = val.toString();
                    }
                }
            });

            fovSelect.addEventListener("change", (e) => {
                const target = e.target as HTMLSelectElement;
                const val = parseFloat(target.value);
                if (!isNaN(val) && val > 0) {
                    this.camera.fov = val * Math.PI / 180;
                    fovInput.value = target.value; 
                }
            });
        }

        if (fogBtn) {
            let isFogEnabled = true;
            fogBtn.addEventListener("click", () => {
                isFogEnabled = !isFogEnabled;
                this.scene.fogMode = isFogEnabled ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
                fogBtn.innerText = isFogEnabled ? "On" : "Off";
                if (isFogEnabled) fogBtn.classList.remove("off");
                else fogBtn.classList.add("off");
            });
        }

        if (fogColorInput) {
            fogColorInput.addEventListener("input", (e) => {
                const val = (e.target as HTMLInputElement).value;
                const newColor = Color3.FromHexString(val);
                this.scene.fogColor = newColor;
                this.scene.clearColor = new Color4(newColor.r, newColor.g, newColor.b, 1.0);
            });
        }

        if (dofBtn) {
            let isDofEnabled = false;
            dofBtn.addEventListener("click", () => {
                isDofEnabled = !isDofEnabled;
                this.renderingPipeline.depthOfFieldEnabled = isDofEnabled;
                dofBtn.innerText = isDofEnabled ? "On" : "Off";
                if (isDofEnabled) dofBtn.classList.remove("off");
                else dofBtn.classList.add("off");
            });
        }

        if (fStopInput) {
            fStopInput.addEventListener("input", (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!isNaN(val) && val > 0 && this.renderingPipeline.depthOfField) {
                    this.renderingPipeline.depthOfField.fStop = val;
                }
            });
        }

        if (focalLengthInput) {
            focalLengthInput.addEventListener("input", (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!isNaN(val) && val > 0 && this.renderingPipeline.depthOfField) {
                    this.renderingPipeline.depthOfField.focalLength = val;
                }
            });
        }

        if (glossInput) {
            glossInput.addEventListener("input", (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!isNaN(val)) {
                    const clampedVal = Math.max(0, Math.min(1.0, val)); 
                    this.scene.materials.forEach(mat => {
                        if (mat.name.endsWith("_frontMat") || mat.name.endsWith("_backMat")) {
                            (mat as StandardMaterial).specularColor = new Color3(clampedVal, clampedVal, clampedVal);
                        }
                    });
                }
            });
        }

        if (resetViewBtn && this.camera && this.playerBox) {
            resetViewBtn.addEventListener("click", () => {
                this.camera.alpha = Math.PI / 2 - this.playerBox.rotation.y;     
                this.camera.beta = Math.PI / 2.5;     
                this.camera.radius = 10.0;            
            });
        }

        if (topViewBtn && this.camera && this.playerBox) {
            topViewBtn.addEventListener("click", () => {
                this.camera.alpha = this.playerBox.rotation.y + Math.PI;
                this.camera.beta = 0.001;
                this.camera.radius = this.camera.upperRadiusLimit;
            });
        }

        const sceneInstrumentation = new SceneInstrumentation(this.scene);
        sceneInstrumentation.captureFrameTime = true;
        
        const engineInstrumentation = new EngineInstrumentation(this.engine);
        engineInstrumentation.captureGPUFrameTime = true;

        let frameCount = 0;
        let lastTexRAM = "0.0 MB";
        let lastGeoRAM = "0.0 MB";

        this.scene.onAfterRenderObservable.add(() => {
            frameCount++;
            
            if (frameCount % 10 !== 0) return;

            if (fv) fv.innerText = this.engine.getFps().toFixed(0);
            
            if (sceneInstrumentation.frameTimeCounter && cv) {
                cv.innerText = sceneInstrumentation.frameTimeCounter.lastSecAverage.toFixed(2);
            }
            
            if (engineInstrumentation.gpuFrameTimeCounter && gv) {
                let gpuTime = engineInstrumentation.gpuFrameTimeCounter.lastSecAverage;
                
                if (gpuTime > 0) {
                    gv.innerText = gpuTime.toFixed(2);
                } else {
                    const currentFps = this.engine.getFps();
                    const frameTime = currentFps > 0 ? 1000 / currentFps : 0; 
                    const cpuTime = sceneInstrumentation.frameTimeCounter ? sceneInstrumentation.frameTimeCounter.lastSecAverage : 0;
                    
                    gpuTime = Math.max(0, frameTime - cpuTime);
                    gv.innerText = `~${gpuTime.toFixed(2)}`; 
                }
            }

            if (sceneInstrumentation.drawCallsCounter && dv) {
                dv.innerText = sceneInstrumentation.drawCallsCounter.current.toString();
            }
            
            const activeMeshes = this.scene.getActiveMeshes();
            if (mv) mv.innerText = activeMeshes.length.toString();
            
            const activeMaterials = new Set();
            activeMeshes.forEach(m => { if(m.material) activeMaterials.add(m.material.name); });
            if (matv) matv.innerText = activeMaterials.size.toString();

            let activeBones = 0;
            activeMeshes.forEach(m => { if(m.skeleton) activeBones += m.skeleton.bones.length; });
            if (bv) bv.innerText = activeBones.toString();
            
            const mem = (performance as any).memory;
            if (mem && rv) rv.innerText = (mem.usedJSHeapSize / (1024 * 1024)).toFixed(1) + " MB";

            if (frameCount % 60 === 0) { 
                let textureMemoryBytes = 0;
                this.scene.textures.forEach(texture => {
                    const size = texture.getSize();
                    if (size && size.width && size.height) {
                        const multiplier = texture.noMipmap ? 1.0 : 1.33;
                        textureMemoryBytes += size.width * size.height * 4 * multiplier;
                    }
                });
                lastTexRAM = (textureMemoryBytes / (1024 * 1024)).toFixed(1) + " MB";
                
                let geoMemoryBytes = 0;
                this.scene.meshes.forEach(m => {
                    geoMemoryBytes += m.getTotalVertices() * 32;
                    const indices = m.getIndices();
                    if (indices) geoMemoryBytes += indices.length * 4;
                });
                lastGeoRAM = (geoMemoryBytes / (1024 * 1024)).toFixed(1) + " MB";
            }
            if (tv) tv.innerText = lastTexRAM;
            if (geov) geov.innerText = lastGeoRAM;

            const activeIndices = this.scene.getActiveIndices();
            if (iv) iv.innerText = activeIndices.toString();
            if (pv) pv.innerText = Math.floor(activeIndices / 3).toString();

            const activeOcclusionQueries = this.scene.meshes.filter((m: any) => m.isOcclusionQueryInProgress).length;
            if (ov) ov.innerText = activeOcclusionQueries.toString();

            if (playerPosVal && this.playerBox) {
                const pos = this.playerBox.position;
                playerPosVal.innerText = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
            }

            if (camInfoVal && this.camera) {
                const a = (this.camera.alpha * 180 / Math.PI).toFixed(0);
                const b = (this.camera.beta * 180 / Math.PI).toFixed(0);
                const r = this.camera.radius.toFixed(1);
                camInfoVal.innerText = `α:${a}°, β:${b}°, r:${r}`;
            }
        });
    }

    private handleResize(): void {
        this.engine.resize(true);
    }
}