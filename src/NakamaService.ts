import { Client, Session, Socket, Channel, ChannelMessage, ChannelPresenceEvent, MatchData } from "@heroiclabs/nakama-js";

const CHAT_ROOM = "world";
const CHAT_TYPE = 1; // 1=Room, 2=DM, 3=Group
const OP_INIT_POS      = 1; // ログイン時の初期位置
const OP_MOVE_TARGET   = 2; // クリック移動の目標位置
const OP_AVATAR_CHANGE = 3; // アバターテクスチャ変更
const OP_BLOCK_UPDATE  = 4; // ブロック設置/削除通知

export class NakamaService {
    private client: Client;
    private session: Session | null = null;
    private socket: Socket | null = null;
    private channelId: string | null = null;
    private matchId: string | null = null;
    private host = "127.0.0.1";
    private port = "7350";
    selfSessionId: string | null = null;

    onChatMessage?: (username: string, text: string, userId: string) => void;
    onPresenceJoin?: (sessionId: string, userId: string, username: string) => void;
    onPresenceNewJoin?: (sessionId: string, userId: string, username: string) => void;
    onPresenceLeave?: (sessionId: string, userId: string, username: string) => void;
    onAvatarInitPos?:    (sessionId: string, x: number, z: number, ry: number) => void;
    onAvatarMoveTarget?: (sessionId: string, x: number, z: number) => void;
    onAvatarChange?:     (sessionId: string, textureUrl: string) => void;
    onBlockUpdate?:      (gx: number, gz: number, blockId: number) => void;

    constructor(host = "127.0.0.1", port = "7350", useSSL = false) {
        this.client = new Client("defaultkey", host, port, useSSL);
    }

    async login(loginName: string, host = "127.0.0.1", port = "7350"): Promise<Session> {
        this.host = host;
        this.port = port;
        this.client = new Client("defaultkey", host, port, false);
        this.session = await this.client.authenticateCustom(loginName, true, loginName);

        this.socket = this.client.createSocket(false, false);
        await this.socket.connect(this.session, true);

        this.socket.onchannelmessage = (msg: ChannelMessage) => {
            const content = msg.content as { text?: string };
            if (content?.text) this.onChatMessage?.(msg.username ?? "", content.text, msg.sender_id ?? "");
        };

        const ch: Channel = await this.socket.joinChat(CHAT_ROOM, CHAT_TYPE, true, false);
        this.channelId = ch.id;

        // ch.self.session_id は他ユーザのプレゼンスに見える session_id と一致する
        const selfSessionId = ch.self?.session_id ?? "";
        this.selfSessionId = selfSessionId;
        try { await this.storeLoginTime(selfSessionId); } catch { /* ignore */ }

        // 自分自身を先に追加（ch.presences には自分が含まれない）
        if (ch.self) {
            this.onPresenceJoin?.(selfSessionId, ch.self.user_id, ch.self.username);
        }
        for (const p of ch.presences ?? []) {
            this.onPresenceJoin?.(p.session_id ?? "", p.user_id, p.username);
        }

        this.socket.onchannelpresence = (event: ChannelPresenceEvent) => {
            for (const p of event.joins ?? []) {
                this.onPresenceJoin?.(p.session_id ?? "", p.user_id, p.username);
                this.onPresenceNewJoin?.(p.session_id ?? "", p.user_id, p.username);
            }
            for (const p of event.leaves ?? []) this.onPresenceLeave?.(p.session_id ?? "", p.user_id, p.username);
        };

        return this.session;
    }

    async joinWorldMatch(): Promise<void> {
        if (!this.session || !this.socket) return;
        try {
            const result = await this.client.rpc(this.session, "getWorldMatch", "" as unknown as object);
            if (!result?.payload) return;
            const raw = typeof result.payload === "string" ? result.payload : JSON.stringify(result.payload);
            const data = JSON.parse(raw) as { matchId?: string };
            if (!data.matchId) return;
            this.matchId = data.matchId;
            await this.socket.joinMatch(this.matchId);
            this.socket.onmatchdata = (md: MatchData) => {
                const sid = md.presence?.session_id;
                try {
                    const payload = JSON.parse(new TextDecoder().decode(md.data));
                    if (md.op_code === OP_BLOCK_UPDATE) {
                        const b = payload as { gx: number; gz: number; blockId: number };
                        this.onBlockUpdate?.(b.gx, b.gz, b.blockId);
                    } else if (!sid) {
                        return;
                    } else if (md.op_code === OP_INIT_POS) {
                        const pos = payload as { x: number; z: number; ry?: number };
                        this.onAvatarInitPos?.(sid, pos.x, pos.z, pos.ry ?? 0);
                    } else if (md.op_code === OP_MOVE_TARGET) {
                        const pos = payload as { x: number; z: number };
                        this.onAvatarMoveTarget?.(sid, pos.x, pos.z);
                    } else if (md.op_code === OP_AVATAR_CHANGE) {
                        const av = payload as { textureUrl: string };
                        this.onAvatarChange?.(sid, av.textureUrl);
                    }
                } catch { /* ignore */ }
            };
        } catch { /* ignore */ }
    }

    async sendInitPos(x: number, z: number, ry = 0): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_INIT_POS, JSON.stringify({ x, z, ry }));
        } catch { /* ignore */ }
    }

    async sendAvatarChange(textureUrl: string): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_AVATAR_CHANGE, JSON.stringify({ textureUrl }));
        } catch { /* ignore */ }
    }

    async sendMoveTarget(x: number, z: number): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_MOVE_TARGET, JSON.stringify({ x, z }));
        } catch { /* ignore */ }
    }

    async sendChatMessage(text: string): Promise<void> {
        if (!this.socket || !this.channelId) return;
        await this.socket.writeChatMessage(this.channelId, { text });
    }

    logout(): void {
        if (this.socket) {
            this.socket.disconnect(true);
            this.socket = null;
        }
        this.session       = null;
        this.channelId     = null;
        this.matchId       = null;
        this.selfSessionId = null;
    }

    getSession(): Session | null {
        return this.session;
    }

    async getServerInfo(): Promise<string> {
        if (!this.session) return "不明";
        // ① カスタム RPC "getServerInfo"
        try {
            const result = await this.client.rpc(this.session, "getServerInfo", "" as unknown as object);
            if (result?.payload) {
                const raw = typeof result.payload === "string"
                    ? result.payload : JSON.stringify(result.payload);
                const data = JSON.parse(raw) as { name?: string; version?: string; serverUpTime?: string; playerCount?: number };
                const toJst = (iso: string) => {
                    const d = new Date(iso);
                    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
                    const pad = (n: number) => String(n).padStart(2, "0");
                    const ms = String(jst.getUTCMilliseconds()).padStart(3, "0");
                    return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth()+1)}-${pad(jst.getUTCDate())}T${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}.${ms}+09:00`;
                };
                const parts: string[] = [];
                if (data.name || data.version)
                    parts.push(`NakamaServerName="${[data.name, data.version ? `v${data.version}` : ""].filter(Boolean).join(" ")}"`);
                if (data.serverUpTime)
                    parts.push(`serverUpTime=${toJst(data.serverUpTime)}`);
                if (data.playerCount !== undefined)
                    parts.push(`players=${data.playerCount}`);
                if (parts.length) return parts.join(" ");
            }
        } catch { /* RPC 未登録時はフォールバック */ }
        // ② /v2/serverinfo (Nakama 3.x+)
        const proto = "http";
        const base = `${proto}://${this.host}:${this.port}`;
        try {
            const res = await fetch(`${base}/v2/serverinfo`, {
                headers: { "Authorization": `Bearer ${this.session.token}` }
            });
            const text = await res.text();
            if (res.ok && text) {
                const data = JSON.parse(text) as { version?: string; name?: string };
                const parts = [data.name, data.version].filter(Boolean);
                if (parts.length) return parts.join(" ");
            }
        } catch { /* ignore */ }
        return "不明";
    }

    private async storeLoginTime(sessionId: string): Promise<void> {
        if (!this.session) return;
        await this.client.writeStorageObjects(this.session, [{
            collection: "user_status",
            key: `login_time_${sessionId}`,
            value: { loginTime: new Date().toISOString() },
            permission_read: 2,
            permission_write: 1,
        }]);
    }

    async getSessionLoginTime(userId: string, sessionId: string): Promise<string | null> {
        if (!this.session) return null;
        try {
            const result = await this.client.readStorageObjects(this.session, {
                object_ids: [{ collection: "user_status", key: `login_time_${sessionId}`, user_id: userId }]
            });
            const obj = result.objects?.[0];
            if (obj?.value) {
                const val = obj.value as { loginTime?: string };
                return val.loginTime ?? null;
            }
        } catch { /* ignore */ }
        return null;
    }

    async setBlock(gx: number, gz: number, blockId: number): Promise<void> {
        if (!this.session) return;
        await this.client.rpc(this.session, "setBlock", { gx, gz, blockId } as unknown as object);
    }

    async getGroundTable(): Promise<number[] | null> {
        if (!this.session) return null;
        try {
            const result = await this.client.rpc(this.session, "getGroundTable", "" as unknown as object);
            if (!result?.payload) return null;
            const raw = typeof result.payload === "string" ? result.payload : JSON.stringify(result.payload);
            const data = JSON.parse(raw) as { table?: number[] };
            return data.table ?? null;
        } catch { return null; }
    }

    // サーバへの RPC ラウンドトリップ時間を計測する（ms）
    async measurePing(): Promise<number | null> {
        if (!this.session) return null;
        try {
            const t0 = performance.now();
            await this.client.rpc(this.session, "ping", "" as unknown as object);
            return Math.round(performance.now() - t0);
        } catch {
            return null;
        }
    }
}
