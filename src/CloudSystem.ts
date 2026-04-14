import { Scene, Engine, Mesh, MeshBuilder, StandardMaterial, Color3 } from "@babylonjs/core";
import { prof } from "./Profiler";

export class CloudSystem {
    private cloudMesh: Mesh | null = null;
    private _enabled = true;

    constructor(private scene: Scene, private engine: Engine) {}

    get mesh(): Mesh | null { return this.cloudMesh; }
    get enabled(): boolean { return this._enabled; }

    setEnabled(on: boolean): void {
        this._enabled = on;
        if (on && !this.cloudMesh) {
            // DOM 初期描画をブロックしないよう遅延生成（ユーザが OFF に戻した場合は生成をスキップ）
            const schedule = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
                ?? ((cb: () => void) => setTimeout(cb, 0));
            schedule(() => { if (this._enabled) this.create(); }, { timeout: 2000 });
            return;
        }
        if (this.cloudMesh) this.cloudMesh.setEnabled(on);
    }

    create(): void {
        if (this.cloudMesh) return;
        const _end = prof("CloudSystem.create");
        const cloudMaterial = new StandardMaterial("roundedMinecraftCloudMat", this.scene);
        cloudMaterial.diffuseColor = new Color3(1, 1, 1);
        cloudMaterial.specularColor = new Color3(0, 0, 0);
        cloudMaterial.emissiveColor = new Color3(0.6, 0.6, 0.6);
        cloudMaterial.alpha = 0.6;
        cloudMaterial.backFaceCulling = true;
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
                    segments: 8
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
                this.cloudMesh = mergedClouds;

                this.scene.onBeforeRenderObservable.add(() => {
                    const deltaTime = this.engine.getDeltaTime() / 1000;
                    mergedClouds.position.x += 2.0 * deltaTime;

                    if (mergedClouds.position.x > areaSize / 2) {
                         mergedClouds.position.x -= areaSize;
                    }
                });
            }
        }
        _end();
    }
}
