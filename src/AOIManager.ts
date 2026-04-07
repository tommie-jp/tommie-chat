import { Scene, Mesh, MeshBuilder, StandardMaterial, Color3 } from "@babylonjs/core";
import { NakamaService } from "./NakamaService";
import { CHUNK_SIZE, CHUNK_COUNT } from "./WorldConstants";
import { prof } from "./Profiler";

export class AOIManager {
    aoiRadius = 48;
    chunkCount = CHUNK_COUNT; // ワールド切替時に変更可能
    get worldSize(): number { return this.chunkCount * CHUNK_SIZE; }
    lastAOI = { minCX: -1, minCZ: -1, maxCX: -1, maxCZ: -1 };
    aoiVisEnabled = false;
    remoteAoiEnabled = false;

    private syncThrottleTimer: ReturnType<typeof setTimeout> | null = null;
    private aoiBox: Mesh | null = null;
    private aoiBoxMat: StandardMaterial | null = null;
    private remoteAoiBoxes: Mesh[] = [];
    private remoteAoiMat: StandardMaterial | null = null;
    private remoteAoiTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private scene: Scene,
        private nakama: NakamaService,
        private getPlayerPos: () => { x: number; z: number },
        private onSyncChunks: () => void
    ) {}

    updateAOI(): void {
        const _end = prof("AOIManager.updateAOI");
        const CC = this.chunkCount;
        const half = (CC * CHUNK_SIZE) / 2;
        const CS = CHUNK_SIZE;
        const pos = this.getPlayerPos();
        const px = pos.x + half;
        const pz = pos.z + half;
        const r = this.aoiRadius;
        const minCX = Math.max(0, Math.floor((px - r) / CS));
        const minCZ = Math.max(0, Math.floor((pz - r) / CS));
        const maxCX = Math.min(CC - 1, Math.floor((px + r) / CS));
        const maxCZ = Math.min(CC - 1, Math.floor((pz + r) / CS));
        if (minCX !== this.lastAOI.minCX || minCZ !== this.lastAOI.minCZ ||
            maxCX !== this.lastAOI.maxCX || maxCZ !== this.lastAOI.maxCZ) {
            this.lastAOI = { minCX, minCZ, maxCX, maxCZ };
            this.updateAOILines();
            if (this.nakama.selfMatchId) {
                console.log(`snd AOI_UPDATE (${minCX},${minCZ})-(${maxCX},${maxCZ})`);
                this.nakama.sendAOI(minCX, minCZ, maxCX, maxCZ).catch((e) => console.warn("AOIManager:", e));
                if (this.syncThrottleTimer) clearTimeout(this.syncThrottleTimer);
                this.syncThrottleTimer = setTimeout(() => this.onSyncChunks(), 300);
            }
        }
        _end();
    }

    updateAOILines(): void {
        const _end = prof("AOIManager.updateAOILines");
        try {
        if (this.aoiBox) { this.aoiBox.dispose(); this.aoiBox = null; }
        if (!this.aoiVisEnabled) return;
        const a = this.lastAOI;
        if (a.minCX < 0) return;
        const half = this.worldSize / 2;
        const CS = CHUNK_SIZE;
        const x0 = a.minCX * CS - half;
        const z0 = a.minCZ * CS - half;
        const x1 = (a.maxCX + 1) * CS - half;
        const z1 = (a.maxCZ + 1) * CS - half;
        const w = x1 - x0;
        const d = z1 - z0;
        const h = 0.3;
        this.aoiBox = MeshBuilder.CreateBox("aoiBox", { width: w, height: h, depth: d }, this.scene);
        this.aoiBox.position.x = (x0 + x1) / 2;
        this.aoiBox.position.y = h / 2 + 0.05;
        this.aoiBox.position.z = (z0 + z1) / 2;
        if (!this.aoiBoxMat) {
            const mat = new StandardMaterial("aoiBoxMat", this.scene);
            mat.diffuseColor = new Color3(1, 0, 0);
            mat.alpha = 0.15;
            mat.backFaceCulling = false;
            this.aoiBoxMat = mat;
        }
        this.aoiBox.material = this.aoiBoxMat;
        this.aoiBox.isPickable = false;
        } finally { _end(); }
    }

    clearRemoteAoiBoxes(): void {
        for (const m of this.remoteAoiBoxes) m.dispose();
        this.remoteAoiBoxes = [];
    }

    async refreshRemoteAOI(): Promise<void> {
        const _end = prof("AOIManager.refreshRemoteAOI");
        try {
        if (!this.remoteAoiEnabled) { this.clearRemoteAoiBoxes(); return; }
        const players = await this.nakama.getPlayersAOI();
        this.clearRemoteAoiBoxes();
        if (!this.remoteAoiEnabled) return;
        const mySid = this.nakama.selfSessionId;
        const half = this.worldSize / 2;
        const CS = CHUNK_SIZE;
        if (!this.remoteAoiMat) {
            const mat = new StandardMaterial("remoteAoiMat", this.scene);
            mat.diffuseColor = new Color3(0, 1, 0);
            mat.alpha = 0.10;
            mat.backFaceCulling = false;
            this.remoteAoiMat = mat;
        }
        for (const p of players) {
            if (p.sessionId === mySid) continue;
            const x0 = p.minCX * CS - half;
            const z0 = p.minCZ * CS - half;
            const x1 = (p.maxCX + 1) * CS - half;
            const z1 = (p.maxCZ + 1) * CS - half;
            const w = x1 - x0;
            const d = z1 - z0;
            const h = 0.3;
            const box = MeshBuilder.CreateBox("remoteAoi_" + p.sessionId, { width: w, height: h, depth: d }, this.scene);
            box.position.x = (x0 + x1) / 2;
            box.position.y = h / 2 + 0.10;
            box.position.z = (z0 + z1) / 2;
            box.material = this.remoteAoiMat;
            box.isPickable = false;
            this.remoteAoiBoxes.push(box);
        }
        } finally { _end(); }
    }

    setRemoteAoiEnabled(enabled: boolean): void {
        this.remoteAoiEnabled = enabled;
        if (enabled) {
            this.refreshRemoteAOI();
            this.remoteAoiTimer = setInterval(() => this.refreshRemoteAOI(), 2000);
        } else {
            if (this.remoteAoiTimer) { clearInterval(this.remoteAoiTimer); this.remoteAoiTimer = null; }
            this.clearRemoteAoiBoxes();
        }
    }
}
