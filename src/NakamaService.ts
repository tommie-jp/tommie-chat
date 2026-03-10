import { Client, Session, Socket, Channel, ChannelMessage, ChannelPresenceEvent, MatchData, MatchPresenceEvent } from "@heroiclabs/nakama-js";

const CHAT_ROOM = "world";
const CHAT_TYPE = 1; // 1=Room, 2=DM, 3=Group
const OP_INIT_POS      = 1; // ログイン時の初期位置
const OP_MOVE_TARGET   = 2; // クリック移動の目標位置
const OP_AVATAR_CHANGE = 3; // アバターテクスチャ変更
const OP_BLOCK_UPDATE  = 4; // ブロック設置/削除通知
const OP_AOI_UPDATE    = 5; // AOI（チャンク範囲）更新
const OP_AOI_ENTER     = 6; // AOI内に入ったプレイヤー情報
const OP_AOI_LEAVE     = 7; // AOI外に出たプレイヤー通知
const OP_DISPLAY_NAME  = 8; // 表示名変更通知

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
    onMatchPresenceJoin?: (sessionId: string, userId: string, username: string) => void;
    onMatchPresenceLeave?: (sessionId: string, userId: string, username: string) => void;
    onAvatarInitPos?:    (sessionId: string, x: number, z: number, ry: number) => void;
    onAvatarMoveTarget?: (sessionId: string, x: number, z: number) => void;
    onAvatarChange?:     (sessionId: string, textureUrl: string) => void;
    onBlockUpdate?:      (gx: number, gz: number, blockId: number, r: number, g: number, b: number, a: number) => void;
    onAOIEnter?:         (sessionId: string, x: number, z: number, ry: number, textureUrl: string, displayName: string) => void;
    onAOILeave?:         (sessionId: string) => void;
    onDisplayName?:      (sessionId: string, displayName: string) => void;
    onMatchDisconnect?:  () => void;
    onMatchReconnect?:   () => void;

    private reconnecting = false;
    private loginName: string | null = null;
    private readonly _decoder = new TextDecoder();

    // onmatchdata プロファイル（呼び出し回数とコスト）
    matchDataProfile = { calls: 0, totalMs: 0, maxMs: 0 };
    private _mdProfileAccum = { calls: 0, totalMs: 0, maxMs: 0, lastReset: performance.now() };

    constructor(host = "127.0.0.1", port = "7350", useSSL = false) {
        this.client = new Client("defaultkey", host, port, useSSL);
    }

    private getOrCreateDeviceId(loginName: string): string {
        const key = `nakama_device_id_${loginName}`;
        let deviceId = localStorage.getItem(key);
        if (!deviceId) {
            deviceId = crypto.randomUUID();
            localStorage.setItem(key, deviceId);
        }
        return deviceId;
    }

    async login(loginName: string, host = "127.0.0.1", port = "7350"): Promise<Session> {
        this.host = host;
        this.port = port;
        this.loginName = loginName;
        this.client = new Client("defaultkey", host, port, false);
        const deviceId = this.getOrCreateDeviceId(loginName);
        this.session = await this.client.authenticateDevice(deviceId, true);
        // デバイス認証後にusernameを設定し、セッションを再取得（JWTにusernameを反映）
        if (this.session.username !== loginName) {
            await this.client.updateAccount(this.session, { username: loginName });
            this.session = await this.client.authenticateDevice(deviceId, false);
        }
        console.log("[Login] username:", this.session.username);

        this.socket = this.client.createSocket(false, false);
        this.socket.setHeartbeatTimeoutMs(60000);
        await this.socket.connect(this.session, true);

        this.setupSocketHandlers();

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

    private setupSocketHandlers(): void {
        if (!this.socket) return;
        this.socket.onchannelmessage = (msg: ChannelMessage) => {
            const content = msg.content as { text?: string };
            if (content?.text) this.onChatMessage?.(msg.username ?? "", content.text, msg.sender_id ?? "");
        };
        this.socket.ondisconnect = () => {
            console.warn("[NakamaService] WebSocket disconnected");
            this.onMatchDisconnect?.();
            this.tryReconnect();
        };
    }

    private async tryReconnect(): Promise<void> {
        if (this.reconnecting || !this.session || !this.loginName) return;
        this.reconnecting = true;
        const delays = [1000, 2000, 4000, 8000, 15000];
        for (let attempt = 0; attempt < delays.length; attempt++) {
            await new Promise(r => setTimeout(r, delays[attempt]));
            if (!this.session) { this.reconnecting = false; return; } // logged out
            try {
                console.log(`[NakamaService] reconnect attempt ${attempt + 1}/${delays.length}`);
                this.socket = this.client.createSocket(false, false);
                this.socket.setHeartbeatTimeoutMs(60000);
                await this.socket.connect(this.session, true);
                this.setupSocketHandlers();
                // チャットチャンネル再参加
                const ch = await this.socket.joinChat(CHAT_ROOM, CHAT_TYPE, true, false);
                this.channelId = ch.id;
                if (ch.self?.session_id) this.selfSessionId = ch.self.session_id;
                this.socket.onchannelpresence = (event: ChannelPresenceEvent) => {
                    for (const p of event.joins ?? []) {
                        this.onPresenceJoin?.(p.session_id ?? "", p.user_id, p.username);
                        this.onPresenceNewJoin?.(p.session_id ?? "", p.user_id, p.username);
                    }
                    for (const p of event.leaves ?? []) this.onPresenceLeave?.(p.session_id ?? "", p.user_id, p.username);
                };
                // マッチ再参加
                await this.joinWorldMatch();
                console.log("[NakamaService] reconnected successfully");
                this.onMatchReconnect?.();
                this.reconnecting = false;
                return;
            } catch (e) {
                console.warn(`[NakamaService] reconnect attempt ${attempt + 1} failed:`, e);
            }
        }
        console.error("[NakamaService] all reconnect attempts failed");
        this.reconnecting = false;
    }

    async joinWorldMatch(): Promise<void> {
        if (!this.session || !this.socket) throw new Error("no session/socket");
        const result = await this.socket.rpc("getWorldMatch");
        if (!result?.payload) throw new Error("getWorldMatch: no payload");
        const data = JSON.parse(result.payload) as { matchId?: string };
        if (!data.matchId) throw new Error("getWorldMatch: no matchId");
        this.matchId = data.matchId;
        const match = await this.socket.joinMatch(this.matchId);
        // マッチ初期プレゼンス通知
        if (match.self) {
            this.onMatchPresenceJoin?.(this.selfSessionId ?? match.self.session_id, match.self.user_id, match.self.username);
        }
        for (const p of match.presences ?? []) {
            this.onMatchPresenceJoin?.(p.session_id, p.user_id, p.username);
        }
        this.socket.onmatchpresence = (event: MatchPresenceEvent) => {
            for (const p of event.joins ?? []) this.onMatchPresenceJoin?.(p.session_id, p.user_id, p.username);
            for (const p of event.leaves ?? []) this.onMatchPresenceLeave?.(p.session_id, p.user_id, p.username);
        };
        this.socket.onmatchdata = (md: MatchData) => {
            const _mt0 = performance.now();
            const sid = md.presence?.session_id;
            try {
                const payload = JSON.parse(this._decoder.decode(md.data));
                if (md.op_code === OP_BLOCK_UPDATE) {
                    const blk = payload as { gx: number; gz: number; blockId: number; r: number; g: number; b: number; a: number };
                    this.onBlockUpdate?.(blk.gx, blk.gz, blk.blockId, blk.r ?? 255, blk.g ?? 255, blk.b ?? 255, blk.a ?? 255);
                } else if (md.op_code === OP_AOI_ENTER) {
                    const e = payload as { sessionId: string; x: number; z: number; ry?: number; textureUrl?: string; displayName?: string };
                    this.onAOIEnter?.(e.sessionId, e.x, e.z, e.ry ?? 0, e.textureUrl ?? "", e.displayName ?? "");
                } else if (md.op_code === OP_AOI_LEAVE) {
                    const e = payload as { sessionId: string };
                    this.onAOILeave?.(e.sessionId);
                } else if (md.op_code === OP_DISPLAY_NAME && sid) {
                    const dn = payload as { displayName: string };
                    this.onDisplayName?.(sid, dn.displayName);
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
            // プロファイル集計（1秒ごとにリセット）
            const _mt1 = performance.now();
            const elapsed = _mt1 - _mt0;
            const acc = this._mdProfileAccum;
            acc.calls++;
            acc.totalMs += elapsed;
            if (elapsed > acc.maxMs) acc.maxMs = elapsed;
            if (_mt1 - acc.lastReset >= 1000) {
                this.matchDataProfile = { calls: acc.calls, totalMs: acc.totalMs, maxMs: acc.maxMs };
                acc.calls = acc.totalMs = acc.maxMs = 0;
                acc.lastReset = _mt1;
            }
        };
    }

    async sendInitPos(x: number, z: number, ry = 0): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_INIT_POS, JSON.stringify({ x, z, ry }));
        } catch { /* ignore */ }
    }

    async sendAvatarChange(textureUrl: string): Promise<void> {
        console.log(`[sendAvatarChange] textureUrl=${textureUrl}`);
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_AVATAR_CHANGE, JSON.stringify({ textureUrl }));
        } catch { /* ignore */ }
    }

    async sendDisplayName(displayName: string): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_DISPLAY_NAME, new TextEncoder().encode(JSON.stringify({ displayName })));
        } catch { /* ignore */ }
    }

    async sendMoveTarget(x: number, z: number): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_MOVE_TARGET, JSON.stringify({ x, z }));
        } catch { /* ignore */ }
    }

    async sendAOI(minCX: number, minCZ: number, maxCX: number, maxCZ: number): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_AOI_UPDATE, JSON.stringify({ minCX, minCZ, maxCX, maxCZ }));
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

    async updateDisplayName(displayName: string): Promise<void> {
        if (!this.session) throw new Error("not logged in");
        await this.client.updateAccount(this.session, { display_name: displayName });
    }

    async getDisplayNames(userIds: string[]): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        if (!this.session || userIds.length === 0) return result;
        const users = await this.client.getUsers(this.session, userIds);
        for (const u of users.users ?? []) {
            result.set(u.id!, u.display_name ?? "");
        }
        return result;
    }

    async getServerInfo(): Promise<string> {
        if (!this.socket) return "不明";
        // ① カスタム RPC "getServerInfo" (WebSocket経由)
        try {
            const result = await this.socket.rpc("getServerInfo");
            if (result?.payload) {
                const data = JSON.parse(result.payload) as { name?: string; version?: string; serverUpTime?: string; playerCount?: number };
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
                headers: { "Authorization": `Bearer ${this.session?.token}` }
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

    async setBlock(gx: number, gz: number, blockId: number, r: number, g: number, b: number, a = 255): Promise<void> {
        if (!this.socket) return;
        await this.socket.rpc("setBlock", JSON.stringify({ gx, gz, blockId, r, g, b, a }));
    }

    async getGroundTable(): Promise<number[] | null> {
        if (!this.socket) return null;
        try {
            const result = await this.socket.rpc("getGroundTable");
            if (!result?.payload) return null;
            const data = JSON.parse(result.payload) as { table?: number[] };
            return data.table ?? null;
        } catch { return null; }
    }

    async syncChunks(minCX: number, minCZ: number, maxCX: number, maxCZ: number, hashes: Record<string, string>): Promise<{ cx: number; cz: number; hash: string; table: number[] }[]> {
        if (!this.socket) return [];
        try {
            const result = await this.socket.rpc("syncChunks", JSON.stringify({ minCX, minCZ, maxCX, maxCZ, hashes }));
            if (!result?.payload) return [];
            const data = JSON.parse(result.payload) as { chunks?: { cx: number; cz: number; hash: string; table: number[] }[] };
            return data.chunks ?? [];
        } catch { return []; }
    }

    async getGroundChunk(cx: number, cz: number): Promise<{ cx: number; cz: number; table: number[] } | null> {
        if (!this.socket) return null;
        try {
            const result = await this.socket.rpc("getGroundChunk", JSON.stringify({ cx, cz }));
            if (!result?.payload) return null;
            return JSON.parse(result.payload) as { cx: number; cz: number; table: number[] };
        } catch { return null; }
    }

    // サーバへの WebSocket RPC ラウンドトリップ時間を計測する（ms）
    async measurePing(): Promise<number | null> {
        if (!this.socket) return null;
        try {
            const t0 = performance.now();
            await this.socket.rpc("ping");
            return Math.round(performance.now() - t0);
        } catch {
            return null;
        }
    }

    // サーバの同接数を取得する（range指定で履歴も取得）
    async getPlayerCount(range?: string): Promise<{ count: number; history: number[] } | null> {
        if (!this.socket) return null;
        try {
            const payload = range ? JSON.stringify({ range }) : undefined;
            const result = await this.socket.rpc("getPlayerCount", payload);
            if (!result?.payload) return null;
            const data = JSON.parse(result.payload) as { count?: number; history?: number[] };
            return { count: data.count ?? 0, history: data.history ?? [] };
        } catch {
            return null;
        }
    }

    // 全プレイヤーのAOI情報を取得
    async getPlayersAOI(): Promise<{ sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[]> {
        if (!this.socket) return [];
        try {
            const result = await this.socket.rpc("getPlayersAOI");
            if (!result?.payload) return [];
            const data = JSON.parse(result.payload) as { players?: { sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[] };
            return data.players ?? [];
        } catch {
            return [];
        }
    }
}
