import { Mesh, Vector3 } from "@babylonjs/core";
import { AvatarSystem } from "./AvatarSystem";
import { prof } from "./Profiler";
import { escapeHtml } from "./utils";

export class NPCSystem {
    npc001?: Mesh;
    npc002?: Mesh;
    npc003?: Mesh;
    isNpcChatOn = false;
    isVisible = false;

    private npc001BaseX = 0;
    private npc002BaseX = 1.5;
    private npc002BaseZ = 3;
    private npc003BaseX = 3;
    private npc003BaseZ = 3;
    private time = 0;
    private intervals: ReturnType<typeof setInterval>[] = [];
    private _avatarDepth = 0;
    private u1?: (t: string) => void;
    private u2?: (t: string) => void;
    private u3?: (t: string) => void;

    constructor(private avatarSystem: AvatarSystem) {}

    setAvatarDepth(d: number): void { this._avatarDepth = d; }

    private ensureCreated(): void {
        if (this.npc001) return;
        const _end = prof("NPCSystem.create");
        this.npc001 = this.avatarSystem.createAvatar("npc001", "/textures/pic2.ktx2", 0, 3, this._avatarDepth);
        this.npc002 = this.avatarSystem.createAvatar("npc002", "/textures/pic2.ktx2", 1.5, 3, this._avatarDepth);
        this.npc003 = this.avatarSystem.createAvatar("npc003", "/textures/pic2.ktx2", 3, 3, this._avatarDepth);
        const npc001Tag = this.avatarSystem.createNameTag(this.npc001, "npc001");
        const npc002Tag = this.avatarSystem.createNameTag(this.npc002, "npc002");
        const npc003Tag = this.avatarSystem.createNameTag(this.npc003, "npc003");
        this.u1 = this.avatarSystem.createSpeechBubble(npc001Tag.plane, "キタちゃん１です。");
        this.u2 = this.avatarSystem.createSpeechBubble(npc002Tag.plane, "キターちゃん２です");
        this.u3 = this.avatarSystem.createSpeechBubble(npc003Tag.plane, "キタちゃん３です");
        _end();
    }

    private addChatHistory(name: string, text: string): void {
        const list = document.getElementById("chat-history-list");
        if (!list) return;
        const panel = document.getElementById("chat-history-panel");
        const inactive = !panel || panel.style.display === "none" || panel.classList.contains("minimized");
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        const entry = document.createElement("div");
        entry.className = "chat-history-entry";
        entry.innerHTML =
            `<span class="chat-history-time">${hh}:${mm}:${ss}</span>` +
            `<span class="chat-history-name">${escapeHtml(name)}</span>` +
            `<span class="chat-history-text">${escapeHtml(text)}</span>`;
        list.appendChild(entry);
        while (list.childElementCount > 500) list.firstElementChild?.remove();
        if (!inactive) entry.scrollIntoView({ block: "end", behavior: "instant" });
    }

    private getNpcMessage(label: string): string {
        const now = new Date();
        const mm = String(now.getMinutes()).padStart(2, "0");
        const ss = String(now.getSeconds()).padStart(2, "0");
        return `${label}時刻の分秒は${mm}:${ss}です！`;
    }

    private startIntervals(): void {
        if (this.intervals.length > 0) return;
        const u1 = this.u1, u2 = this.u2, u3 = this.u3;
        if (!u1 || !u2 || !u3) return;
        this.intervals.push(setInterval(() => {
            const msg = this.getNpcMessage("わーい。キタちゃん１です。");
            u1(msg);
            if (this.isNpcChatOn) this.addChatHistory("npc001", msg);
        }, 3000));
        this.intervals.push(setInterval(() => {
            const msg = this.getNpcMessage("キタちゃん２です。❤");
            u2(msg);
            if (this.isNpcChatOn) this.addChatHistory("npc002", msg);
        }, 5000));
        this.intervals.push(setInterval(() => {
            const msg = this.getNpcMessage("にゃにゃ。キタちゃん３です。🐕️");
            u3(msg);
            if (this.isNpcChatOn) this.addChatHistory("npc003", msg);
        }, 8000));
    }

    private stopIntervals(): void {
        for (const id of this.intervals) clearInterval(id);
        this.intervals.length = 0;
    }

    update(deltaTime: number): void {
        if (!this.isVisible || !this.npc001 || !this.npc002 || !this.npc003) return;
        const _end = prof("NPCSystem.update");
        this.time += deltaTime;

        // npc001: X軸サイン波移動
        this.npc001.position.x = this.npc001BaseX + 10 * Math.sin(this.time * 0.8);
        const velocityX = 10 * 0.8 * Math.cos(this.time * 0.8);
        if (Math.abs(velocityX) > 0.01) {
            const targetAngle1 = velocityX > 0 ? -Math.PI / 2 : Math.PI / 2;
            let diff1 = targetAngle1 - this.npc001.rotation.y;
            while (diff1 < -Math.PI) diff1 += Math.PI * 2;
            while (diff1 > Math.PI) diff1 -= Math.PI * 2;
            this.npc001.rotation.y += diff1 * 0.25;
        }

        // npc002: 矩形パス移動
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

        // npc003: 円形パス移動
        const angle = this.time * 1.2;
        this.npc003.position.x = this.npc003BaseX + 5 * Math.cos(angle);
        this.npc003.position.z = this.npc003BaseZ + 5 * Math.sin(angle);
        const velocity3 = new Vector3(-5 * 1.2 * Math.sin(angle), 0, 5 * 1.2 * Math.cos(angle));
        if (velocity3.length() > 0.01) {
            const targetAngle3 = Math.atan2(velocity3.x, velocity3.z) + Math.PI;
            let diff3 = targetAngle3 - this.npc003.rotation.y;
            while (diff3 < -Math.PI) diff3 += Math.PI * 2;
            while (diff3 > Math.PI) diff3 -= Math.PI * 2;
            this.npc003.rotation.y += diff3 * 0.25;
        }
        _end();
    }

    setEnabled(visible: boolean): void {
        this.isVisible = visible;
        if (visible) {
            this.ensureCreated();
            this.npc001?.setEnabled(true);
            this.npc002?.setEnabled(true);
            this.npc003?.setEnabled(true);
            this.startIntervals();
        } else {
            this.npc001?.setEnabled(false);
            this.npc002?.setEnabled(false);
            this.npc003?.setEnabled(false);
            this.stopIntervals();
        }
    }
}
