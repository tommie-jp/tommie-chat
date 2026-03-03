import { 
    Engine, 
    Scene, 
    Vector3, 
    Vector4,
    Color4,
    MeshBuilder, 
    HemisphericLight, 
    ArcRotateCamera, 
    PBRMaterial,      
    StandardMaterial, 
    Color3,
    Mesh,
    Texture,
    TransformNode,
    SceneInstrumentation,
    EngineInstrumentation,
    PointerEventTypes,
    DefaultRenderingPipeline 
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
    
    private hoverMarker!: Mesh;
    private clickMarker!: Mesh;

    private updatePlayerSpeech!: (newText: string) => void;

    private renderingPipeline!: DefaultRenderingPipeline;

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
        // 仮の初期化（後でアバターが生成された後に向きに合わせて再設定します）
        this.camera = new ArcRotateCamera(
            "camera", 
            -Math.PI / 2,     
            Math.PI / 2.5,    
            10.0,             
            new Vector3(0, 0.9, 0),
            this.scene
        );
        this.camera.attachControl(this.engine.getRenderingCanvas() as HTMLCanvasElement, true);

        this.camera.lowerRadiusLimit = 2; 
        this.camera.upperRadiusLimit = 50;
        this.camera.fovMode = ArcRotateCamera.FOVMODE_VERTICAL_FIXED;
        this.camera.inertia = 0;
        
        this.camera.maxZ = 500;
        this.camera.fov = 60 * Math.PI / 180;

        const light = new HemisphericLight("light", new Vector3(0, 1, 0), this.scene);
        light.intensity = 1.8;
        light.groundColor = new Color3(0.9, 0.9, 0.9);

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

        const faceUV = new Array(6).fill(new Vector4(0, 0, 0, 0));
        const vTrimStart = 0.02;
        const vTrimEnd = 0.98;
        faceUV[1] = new Vector4(1, vTrimEnd, 0, vTrimStart);

        const avatarMesh = MeshBuilder.CreateBox(name, { width, height, depth, faceUV }, this.scene);
        avatarMesh.position.set(x, height / 2, z);
        avatarMesh.rotation.y = Math.PI;

        const mat = new PBRMaterial(name + "_Mat", this.scene);
        const tex = new Texture(textureUrl, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
        
        tex.hasAlpha = true;
        mat.albedoTexture = tex;
        mat.useAlphaFromAlbedoTexture = true;
        
        mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATESTAND; 
        
        mat.metallic = 0.0;
        mat.roughness = 0.02;   
        mat.backFaceCulling = false;

        avatarMesh.material = mat;
        return avatarMesh;
    }

    private createNameTag(targetMesh: Mesh, nameText: string): void {
        const namePlane = MeshBuilder.CreatePlane("nameTag_" + targetMesh.name, { width: 1.5, height: 0.40 }, this.scene);
        namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        namePlane.isPickable = false;
        
        namePlane.parent = targetMesh;
        namePlane.position = new Vector3(0, 0.95, 0);

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

        this.createNameTag(this.playerBox, "tommie.jp✅️");
        this.createNameTag(player2, "npc001");
        this.createNameTag(player3, "npc002");
        this.createNameTag(player4, "npc003");

        this.createMinecraftClouds();
        this.createCoordinateLabels();
        
        this.updatePlayerSpeech = this.createSpeechBubble(this.playerBox, "こんにちは！");
        this.createSpeechBubble(player2, "キタちゃん１です。");
        this.createSpeechBubble(player3, "キタちゃん２です");
        this.createSpeechBubble(player4, "キタちゃん３です");

        this.createDebugOverlay();

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
            if (this.targetPosition && this.playerBox) {
                const deltaTime = this.engine.getDeltaTime() / 1000;
                const currentPos = this.playerBox.position;
                const target = new Vector3(this.targetPosition.x, currentPos.y, this.targetPosition.z);
                const distance = Vector3.Distance(currentPos, target);
                const moveDist = this.moveSpeed * deltaTime;

                if (distance > moveDist) {
                    const direction = target.subtract(currentPos).normalize();
                    this.playerBox.position.addInPlace(direction.scale(moveDist));
                    this.playerBox.rotation.y = Math.atan2(direction.x, direction.z);
                } else {
                    this.playerBox.position.copyFrom(target);
                    this.targetPosition = null; 
                    this.clickMarker.isVisible = false; 
                }
            }

            if (this.renderingPipeline.depthOfFieldEnabled && this.renderingPipeline.depthOfField) {
                this.renderingPipeline.depthOfField.focusDistance = this.camera.radius * 1000;
            }
        });

        // ★変更: アバター生成後、初期カメラ位置を「アバターの向いている方向の背後」に設定
        if (this.camera && this.playerBox) {
            this.camera.setTarget(this.playerBox);
            // Babylon.jsの計算上「-90度 ( -Math.PI / 2 ) からキャラのY回転を引く」と真後ろになります
            this.camera.alpha = -Math.PI / 2 - this.playerBox.rotation.y;
            this.camera.beta = Math.PI / 2.5;
            this.camera.radius = 10.0;
        }
    }

    private createSpeechBubble(targetMesh: Mesh, speechText: string): (newText: string) => void {
        const bubblePlane = MeshBuilder.CreatePlane("speechBubble_" + targetMesh.name, { width: 1.0, height: 0.20 }, this.scene);
        bubblePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        bubblePlane.isPickable = false;
        
        bubblePlane.parent = targetMesh;
        bubblePlane.position = new Vector3(0, 1.2, 0); 
        
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

    private createMinecraftClouds(): void {
        for (let i = 0; i < 15; i++) {
            const cloudGroup = new TransformNode("cloudGroup" + i, this.scene);
            const baseX = (Math.random() - 0.5) * 240;
            const baseZ = (Math.random() - 0.5) * 240;
            const baseY = 18 + Math.random() * 12;
            const cloudMaterial = new StandardMaterial("cloudMat" + i, this.scene);
            cloudMaterial.diffuseColor = new Color3(0.9, 0.9, 0.95);
            cloudMaterial.alpha = 0.95;

            for (let j = 0; j < 5; j++) {
                const sphere = MeshBuilder.CreateSphere("cloudSphere" + i + "_" + j, { diameter: 5, segments: 8 }, this.scene);
                sphere.position.set(baseX + (Math.random() - 0.5) * 8, baseY + (Math.random() - 0.5) * 4, baseZ + (Math.random() - 0.5) * 8);
                sphere.scaling.set(1.4, 0.65, 1.1);
                sphere.material = cloudMaterial;
                sphere.parent = cloudGroup;
                sphere.isPickable = false;
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
        const texture = AdvancedDynamicTexture.CreateForMesh(plane);
        const bg = new Rectangle();
        bg.width = "100%"; bg.height = "100%";
        bg.background = "rgba(255,255,255,0.50)";
        bg.cornerRadius = 12;
        texture.addControl(bg);
        const text = new TextBlock();
        text.text = labelText; text.color = "#FF0000"; text.fontSize = "200px";
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
        
        const resetViewBtn = document.getElementById("resetViewBtn") as HTMLButtonElement;
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

        let isFogEnabled = true;
        if (fogBtn) {
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

        let isDofEnabled = false;
        if (dofBtn) {
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

        // ★変更: リセット時も現在のアバターの向きを考慮して背後へ回り込ませる
        if (resetViewBtn && this.camera && this.playerBox) {
            resetViewBtn.addEventListener("click", () => {
                this.camera.alpha = -Math.PI / 2 - this.playerBox.rotation.y;     
                this.camera.beta = Math.PI / 2.5;     
                this.camera.radius = 10.0;            
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