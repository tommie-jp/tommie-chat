import { Client, Session, Socket, Channel, ChannelMessage, ChannelPresenceEvent, MatchData, MatchPresenceEvent } from "@heroiclabs/nakama-js";
import { prof } from "./Profiler";

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
    get selfMatchId(): string | null { return this.matchId; }
    get selfChannelId(): string | null { return this.channelId; }

    onChatMessage?: (username: string, text: string, userId: string) => void;
    onPresenceJoin?: (sessionId: string, userId: string, username: string) => void;
    onPresenceNewJoin?: (sessionId: string, userId: string, username: string) => void;
    onPresenceLeave?: (sessionId: string, userId: string, username: string) => void;
    onMatchPresenceJoin?: (sessionId: string, userId: string, username: string) => void;
    onMatchPresenceLeave?: (sessionId: string, userId: string, username: string) => void;
    onAvatarInitPos?:    (sessionId: string, x: number, z: number, ry: number, loginTimeISO: string, displayName: string, textureUrl: string) => void;
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
    private loginTimeISO: string = "";
    selfDisplayName: string = "";
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
        const _end = prof("NakamaService.login");
        try {
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
        console.log("snd Login username:", this.session.username);

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
        } finally { _end(); }
    }

    private setupSocketHandlers(): void {
        const _end = prof("NakamaService.setupSocketHandlers");
        if (!this.socket) { _end(); return; }
        this.socket.onchannelmessage = (msg: ChannelMessage) => {
            const content = msg.content as { text?: string };
            if (content?.text) this.onChatMessage?.(msg.username ?? "", content.text, msg.sender_id ?? "");
        };
        this.socket.ondisconnect = () => {
            console.warn("NakamaService WebSocket disconnected");
            this.onMatchDisconnect?.();
            this.tryReconnect();
        };
        _end();
    }

    private async tryReconnect(): Promise<void> {
        const _end = prof("NakamaService.tryReconnect");
        try {
        if (this.reconnecting || !this.session || !this.loginName) return;
        this.reconnecting = true;
        const delays = [1000, 2000, 4000, 8000, 15000];
        for (let attempt = 0; attempt < delays.length; attempt++) {
            await new Promise(r => setTimeout(r, delays[attempt]));
            if (!this.session) { this.reconnecting = false; return; } // logged out
            try {
                console.log(`NakamaService reconnect attempt ${attempt + 1}/${delays.length}`);
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
                console.log("NakamaService reconnected successfully");
                this.onMatchReconnect?.();
                this.reconnecting = false;
                return;
            } catch (e) {
                console.warn(`NakamaService reconnect attempt ${attempt + 1} failed:`, e);
            }
        }
        console.error("NakamaService all reconnect attempts failed");
        this.reconnecting = false;
        } finally { _end(); }
    }

    async joinWorldMatch(): Promise<void> {
        const _end = prof("NakamaService.joinWorldMatch");
        try {
        console.log("snd getWorldMatch");
        if (!this.session || !this.socket) throw new Error("no session/socket");
        const result = await this.socket.rpc("getWorldMatch");
        if (!result?.payload) throw new Error("getWorldMatch: no payload");
        const data = JSON.parse(result.payload) as { matchId?: string; players?: { sessionId: string; x: number; z: number; ry: number; textureUrl: string; displayName: string }[] };
        if (!data.matchId) throw new Error("getWorldMatch: no matchId");
        this.matchId = data.matchId;
        // joinMatch() より前にハンドラを登録する（MatchJoin直後のサーバー通知を取りこぼさないため）
        this.socket.onmatchdata = (md: MatchData) => {
            const _mt0 = performance.now();
            const sid = md.presence?.session_id;
            console.log(`rcv matchdata op=${md.op_code} sid=${sid ? sid.slice(0, 8) : "(srv)"}`);
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
                    const pos = payload as { x: number; z: number; ry?: number; lt?: string; dn?: string; tx?: string };
                    this.onAvatarInitPos?.(sid, pos.x, pos.z, pos.ry ?? 0, pos.lt ?? "", pos.dn ?? "", pos.tx ?? "");
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
        } finally { _end(); }
    }

    async sendInitPos(x: number, z: number, ry = 0, textureUrl = ""): Promise<void> {
        const _end = prof("NakamaService.sendInitPos");
        try {
        console.log(`snd initPos x=${(+x).toFixed(1)} z=${(+z).toFixed(1)} ry=${(+ry).toFixed(1)} tx=${textureUrl}`);
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_INIT_POS, JSON.stringify({ x, z, ry, lt: this.loginTimeISO, dn: this.selfDisplayName, tx: textureUrl }));
        } catch { /* ignore */ }
        } finally { _end(); }
    }

    async sendAvatarChange(textureUrl: string): Promise<void> {
        const _end = prof("NakamaService.sendAvatarChange");
        try {
        console.log(`snd sendAvatarChange textureUrl=${textureUrl}`);
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_AVATAR_CHANGE, JSON.stringify({ textureUrl }));
        } catch { /* ignore */ }
        } finally { _end(); }
    }

    async sendDisplayName(displayName: string): Promise<void> {
        const _end = prof("NakamaService.sendDisplayName");
        try {
        console.log(`snd sendDisplayName displayName=${displayName}`);
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_DISPLAY_NAME, new TextEncoder().encode(JSON.stringify({ displayName })));
        } catch { /* ignore */ }
        } finally { _end(); }
    }

    async sendMoveTarget(x: number, z: number): Promise<void> {
        const _end = prof("NakamaService.sendMoveTarget");
        try {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_MOVE_TARGET, JSON.stringify({ x, z }));
        } catch { /* ignore */ }
        } finally { _end(); }
    }

    async sendAOI(minCX: number, minCZ: number, maxCX: number, maxCZ: number): Promise<void> {
        const _end = prof("NakamaService.sendAOI");
        try {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_AOI_UPDATE, JSON.stringify({ minCX, minCZ, maxCX, maxCZ }));
        } catch { /* ignore */ }
        } finally { _end(); }
    }

    async sendChatMessage(text: string): Promise<void> {
        const _end = prof("NakamaService.sendChatMessage");
        try {
        console.log(`snd sendChatMessage text=${text}`);
        if (!this.socket || !this.channelId) return;
        await this.socket.writeChatMessage(this.channelId, { text });
        } finally { _end(); }
    }

    logout(): void {
        const _end = prof("NakamaService.logout");
        console.log("snd logout");
        if (this.socket) {
            this.socket.disconnect(true);
            this.socket = null;
        }
        this.session       = null;
        this.channelId     = null;
        this.matchId       = null;
        this.selfSessionId = null;
        _end();
    }

    getSession(): Session | null {
        return this.session;
    }

    async updateDisplayName(displayName: string): Promise<void> {
        const _end = prof("NakamaService.updateDisplayName");
        try {
        console.log(`snd updateDisplayName displayName=${displayName}`);
        if (!this.socket) throw new Error("no socket");
        await this.socket.rpc("updateDisplayName", JSON.stringify({ displayName }));
        } finally { _end(); }
    }

    async getDisplayNames(userIds: string[]): Promise<Map<string, string>> {
        const _end = prof("NakamaService.getDisplayNames");
        try {
        const result = new Map<string, string>();
        if (!this.socket || userIds.length === 0) return result;
        const rpcResult = await this.socket.rpc("getDisplayNames", JSON.stringify({ userIds }));
        if (rpcResult?.payload) {
            const data = JSON.parse(rpcResult.payload) as { users?: { id: string; displayName: string }[] };
            for (const u of data.users ?? []) {
                result.set(u.id, u.displayName);
            }
        }
        return result;
        } finally { _end(); }
    }

    async getServerInfo(): Promise<string> {
        const _end = prof("NakamaService.getServerInfo");
        try {
        if (!this.socket) return "不明";
        console.log("snd getServerInfo");
        // ① カスタム RPC "getServerInfo" (WebSocket経由)
        try {
            const result = await this.socket.rpc("getServerInfo");
            if (result?.payload) {
                const data = JSON.parse(result.payload) as { name?: string; version?: string; playerCount?: number };
                const parts: string[] = [];
                if (data.name || data.version)
                    parts.push(`NakamaServerName="${[data.name, data.version ? `v${data.version}` : ""].filter(Boolean).join(" ")}"`);
                // serverUpTime は運用情報のためクライアントには非表示
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
        } finally { _end(); }
    }

    private async storeLoginTime(sessionId: string): Promise<void> {
        const _end = prof("NakamaService.storeLoginTime");
        try {
        console.log(`snd storeLoginTime sessionId=${sessionId.slice(0, 8)}`);
        if (!this.socket) return;
        this.loginTimeISO = new Date().toISOString();
        await this.socket.rpc("storeLoginTime", JSON.stringify({ sessionId, loginTime: this.loginTimeISO }));
        } finally { _end(); }
    }


    async setBlock(gx: number, gz: number, blockId: number, r: number, g: number, b: number, a = 255): Promise<void> {
        const _end = prof("NakamaService.setBlock");
        try {
        console.log(`snd setBlock gx=${gx} gz=${gz} blockId=${blockId} rgba=(${r},${g},${b},${a})`);
        if (!this.socket) return;
        await this.socket.rpc("setBlock", JSON.stringify({ gx, gz, blockId, r, g, b, a }));
        } finally { _end(); }
    }

    async getGroundTable(): Promise<number[] | null> {
        if (!this.socket) return null;
        console.log("snd getGroundTable");
        try {
            const result = await this.socket.rpc("getGroundTable");
            if (!result?.payload) return null;
            const data = JSON.parse(result.payload) as { table?: number[] };
            return data.table ?? null;
        } catch { return null; }
    }

    async syncChunks(minCX: number, minCZ: number, maxCX: number, maxCZ: number, hashes: Record<string, string>): Promise<{ cx: number; cz: number; hash: string; table: number[] }[]> {
        const _end = prof("NakamaService.syncChunks");
        try {
        if (!this.socket) return [];
        console.log(`snd syncChunks (${minCX},${minCZ})-(${maxCX},${maxCZ})`);
        try {
            const result = await this.socket.rpc("syncChunks", JSON.stringify({ minCX, minCZ, maxCX, maxCZ, hashes }));
            if (!result?.payload) return [];
            const data = JSON.parse(result.payload) as { chunks?: { cx: number; cz: number; hash: string; table: number[] }[] };
            return data.chunks ?? [];
        } catch { return []; }
        } finally { _end(); }
    }

    async getGroundChunk(cx: number, cz: number): Promise<{ cx: number; cz: number; table: number[] } | null> {
        const _end = prof("NakamaService.getGroundChunk");
        try {
        console.log(`snd getGroundChunk cx=${cx} cz=${cz}`);
        if (!this.socket) return null;
        try {
            const result = await this.socket.rpc("getGroundChunk", JSON.stringify({ cx, cz }));
            if (!result?.payload) return null;
            return JSON.parse(result.payload) as { cx: number; cz: number; table: number[] };
        } catch { return null; }
        } finally { _end(); }
    }

    // サーバへの WebSocket RPC ラウンドトリップ時間を計測する（ms）
    async measurePing(): Promise<number | null> {
        const _end = prof("NakamaService.measurePing");
        try {
        if (!this.socket) return null;
        try {
            const t0 = performance.now();
            await this.socket.rpc("ping");
            return Math.round(performance.now() - t0);
        } catch {
            return null;
        }
        } finally { _end(); }
    }

    // サーバの同接数を取得する（range指定で履歴も取得）
    async getPlayerCount(range?: string): Promise<{ count: number; history: number[] } | null> {
        const _end = prof("NakamaService.getPlayerCount");
        try {
        console.log(`snd getPlayerCount range=${range ?? ""}`);
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
        } finally { _end(); }
    }

    // 全プレイヤーのAOI情報を取得
    async getPlayersAOI(): Promise<{ sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[]> {
        const _end = prof("NakamaService.getPlayersAOI");
        try {
        console.log("snd getPlayersAOI");
        if (!this.socket) return [];
        try {
            const result = await this.socket.rpc("getPlayersAOI");
            if (!result?.payload) return [];
            const data = JSON.parse(result.payload) as { players?: { sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[] };
            return data.players ?? [];
        } catch {
            return [];
        }
        } finally { _end(); }
    }

    /** サーバ側プロファイル RPC を呼び出す */
    async profileRpc(method: "profileStart" | "profileStop" | "profileDump"): Promise<string | null> {
        if (!this.socket) { console.warn(`profileRpc socket is null`); return null; }
        console.log(`snd profileRpc method=${method}`);
        const res = await this.socket.rpc(method);
        return res?.payload ?? null;
    }
}
