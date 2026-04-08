import { Client, Session, Socket, MatchData, MatchPresenceEvent } from "@heroiclabs/nakama-js";
import { prof } from "./Profiler";

// matchデータ opコード（WebSocket sendMatchState 経由の双方向メッセージ）
// MatchLoop のメッセージキューで処理。同一接続内で送信順が保証される。
// RPC と異なり非同期応答（別opコード）で結果を返す。
const OP_INIT_POS          = 1;  // C→S     ログイン時の初期位置・表示名・テクスチャ・loginTime
const OP_MOVE_TARGET       = 2;  // C→S→C   クリック移動の目標位置（AOI内ブロードキャスト）
const OP_AVATAR_CHANGE     = 3;  // C→S→C   アバターテクスチャ変更（AOI内ブロードキャスト）
const OP_BLOCK_UPDATE      = 4;  // C→S→C   ブロック設置/削除（AOI内ブロードキャスト＋Storage保存）
const OP_AOI_UPDATE        = 5;  // C→S     AOI範囲更新（チャンク座標）
const OP_AOI_ENTER         = 6;  // S→C     プレイヤーがAOI内に入った（位置のみ）
const OP_AOI_LEAVE         = 7;  // S→C     プレイヤーがAOI外に出た
const OP_DISPLAY_NAME      = 8;  // C→S→C   表示名変更（全員ブロードキャスト）
const OP_PROFILE_REQUEST   = 9;  // C→S     プロフィール要求（sessionId[]）
const OP_PROFILE_RESPONSE  = 10; // S→C     プロフィール応答（要求者のみ）
const OP_PLAYERS_AOI_REQ   = 11; // C→S     全プレイヤーAOI情報要求
const OP_PLAYERS_AOI_RESP  = 12; // S→C     全プレイヤーAOI情報応答（要求者のみ）
const OP_CHAT              = 13; // C→S→C   チャットメッセージ（全員ブロードキャスト）
const OP_SYSTEM_MSG        = 14; // S→C     システムメッセージ（ログイン/ログアウト通知）
const OP_PLAYER_LIST_SUB   = 16; // C→S     プレイヤーリスト購読（{subscribe:true/false}）
const OP_PLAYER_LIST_DATA  = 17; // S→C     全プレイヤーリスト（プッシュ配信）


export class NakamaService {
    private client: Client;
    private session: Session | null = null;
    private socket: Socket | null = null;
    private matchId: string | null = null;
    private host = location.hostname;
    private port = location.port || (location.protocol === "https:" ? "443" : "80");
    selfSessionId: string | null = null;
    /** 現在のマッチに参加中の session ID 一覧 */
    currentPresenceIds: string[] = [];

    get selfMatchId(): string | null { return this.matchId; }

    onChatMessage?: (username: string, text: string, userId: string, sessionId: string, ts: number) => void;
    onSystemMessage?: (type: string, username: string, userId: string, sessionId: string, uidCount: number, nameColor: string, ts: number) => void;
    onMatchPresenceJoin?: (sessionId: string, userId: string, username: string) => void;
    onMatchPresenceLeave?: (sessionId: string, userId: string, username: string) => void;
    onAvatarInitPos?:    (sessionId: string, x: number, z: number, ry: number, loginTimeISO: string, displayName: string, textureUrl: string, charCol: number, charRow: number, nameColor?: string) => void;
    onAvatarMoveTarget?: (sessionId: string, x: number, z: number) => void;
    onAvatarChange?:     (sessionId: string, textureUrl: string, charCol: number, charRow: number) => void;
    onBlockUpdate?:      (gx: number, gz: number, blockId: number, r: number, g: number, b: number, a: number) => void;
    onAOIEnter?:         (sessionId: string, x: number, z: number, ry: number) => void;
    onAOILeave?:         (sessionId: string) => void;
    onProfileResponse?:  (profiles: { sessionId: string; displayName: string; textureUrl: string; charCol: number; charRow: number; loginTime: string; nameColor?: string }[]) => void;
    onPlayersAOIResponse?: (players: { sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[]) => void;
    onDisplayName?:      (sessionId: string, displayName: string, nameColor?: string) => void;
    onPlayerListData?:   (players: { sessionId: string; userId: string; username: string; displayName: string; loginTime: string; nameColor?: string; worldId: number; matchId: string }[]) => void;
    onPlayerListCount?:  (count: number) => void;
    onMatchDisconnect?:  () => void;
    onMatchReconnect?:   () => void;
    /** 再接続時に joinMatch に渡すメタデータを取得するコールバック */
    getReconnectMeta?: () => Record<string, string>;

    private reconnecting = false;
    private loginName: string | null = null;
    private loginTimeISO: string = "";
    selfDisplayName: string = "";
    selfNameColor: string = "";
    private readonly _decoder = new TextDecoder();

    // onmatchdata プロファイル（呼び出し回数とコスト）
    matchDataProfile = { calls: 0, totalMs: 0, maxMs: 0 };
    private _mdProfileAccum = { calls: 0, totalMs: 0, maxMs: 0, lastReset: performance.now() };

    // op別ハンドラ関数テーブル（name: ログ表示名, silent: 共通ログ抑制, fn: ハンドラ）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly opHandlers: Record<number, { name: string; silent?: boolean; fn: (payload: any, sid: string | undefined) => void }> = {
        [OP_BLOCK_UPDATE]: { name: "BLOCK_UPDATE", silent: true, fn: (p) => {
            const blk = p as { gx: number; gz: number; blockId: number; r: number; g: number; b: number; a: number };
            this.onBlockUpdate?.(blk.gx, blk.gz, blk.blockId, blk.r ?? 255, blk.g ?? 255, blk.b ?? 255, blk.a ?? 255);
        }},
        [OP_AOI_ENTER]: { name: "AOI_ENTER", silent: true, fn: (p) => {
            type AoiEntry = { sessionId: string; x: number; z: number; ry?: number };
            const entries: AoiEntry[] = Array.isArray(p) ? p : [p];
            for (const e of entries) this.onAOIEnter?.(e.sessionId, e.x, e.z, e.ry ?? 0);
        }},
        [OP_AOI_LEAVE]: { name: "AOI_LEAVE", silent: true, fn: (p) => {
            this.onAOILeave?.((p as { sessionId: string }).sessionId);
        }},
        [OP_PROFILE_RESPONSE]: { name: "PROFILE_RESP", silent: true, fn: (p) => {
            const resp = p as { profiles: { sessionId: string; displayName: string; textureUrl: string; charCol: number; charRow: number; loginTime: string; nameColor?: string }[] };
            this.onProfileResponse?.(resp.profiles ?? []);
        }},
        [OP_PLAYERS_AOI_RESP]: { name: "AOI_RESP", fn: (p) => {
            const resp = p as { players: { sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[] };
            const players = resp.players ?? [];
            if (this._aoiResolve) { this._aoiResolve(players); this._aoiResolve = null; }
            this.onPlayersAOIResponse?.(players);
        }},
        [OP_CHAT]: { name: "CHAT", fn: (p) => {
            const chat = p as { text: string; username: string; userId: string; sessionId: string; ts?: number };
            this.onChatMessage?.(chat.username ?? "", chat.text ?? "", chat.userId ?? "", chat.sessionId ?? "", chat.ts ?? 0);
        }},
        [OP_SYSTEM_MSG]: { name: "SYS_MSG", fn: (p) => {
            const sys = p as { type: string; username: string; userId: string; sessionId?: string; uidCount?: number; nameColor?: string; ts?: number };
            this.onSystemMessage?.(sys.type, sys.username, sys.userId, sys.sessionId ?? "", sys.uidCount ?? 1, sys.nameColor ?? "", sys.ts ?? 0);
        }},
        [OP_PLAYER_LIST_DATA]: { name: "PL_DATA", fn: (p) => {
            const resp = p as { players?: { sessionId: string; userId: string; username: string; displayName: string; loginTime: string; nameColor?: string; worldId: number; matchId: string }[]; count?: number };
            if (resp.players) this.onPlayerListData?.(resp.players);
            else if (resp.count !== undefined) this.onPlayerListCount?.(resp.count);
        }},
        [OP_DISPLAY_NAME]: { name: "DISPLAY_NAME", silent: true, fn: (p, sid) => {
            if (!sid) return;
            const dn = p as { displayName: string; nc?: string };
            this.onDisplayName?.(sid, dn.displayName, dn.nc);
        }},
        [OP_INIT_POS]: { name: "INIT_POS", silent: true, fn: (p, sid) => {
            if (!sid) return;
            const pos = p as { x: number; z: number; ry?: number; lt?: string; dn?: string; tx?: string; cc?: number; cr?: number; nc?: string };
            this.onAvatarInitPos?.(sid, pos.x, pos.z, pos.ry ?? 0, pos.lt ?? "", pos.dn ?? "", pos.tx ?? "", pos.cc ?? 0, pos.cr ?? 0, pos.nc);
        }},
        [OP_MOVE_TARGET]: { name: "MOVE_TARGET", fn: (p, sid) => {
            if (!sid) return;
            const pos = p as { x: number; z: number };
            this.onAvatarMoveTarget?.(sid, pos.x, pos.z);
        }},
        [OP_AVATAR_CHANGE]: { name: "AVATAR_CHANGE", silent: true, fn: (p, sid) => {
            if (!sid) return;
            const av = p as { textureUrl: string; cc?: number; cr?: number };
            this.onAvatarChange?.(sid, av.textureUrl, av.cc ?? 0, av.cr ?? 0);
        }},
    };

    constructor() {
        const useSSL = location.protocol === "https:";
        this.client = new Client(import.meta.env.VITE_SERVER_KEY ?? "defaultkey", this.host, this.port, useSSL);
    }

    /** Cookie からデバイスIDを取得（Safari↔PWA間の共有用） */
    private getDeviceIdCookie(loginName: string): string | null {
        const ckey = `nakama_did_${loginName}`;
        const match = document.cookie.match(new RegExp("(?:^|; )" + ckey + "=([^;]*)"));
        return match ? decodeURIComponent(match[1]) : null;
    }

    /** Cookie にデバイスIDを保存（Safari→PWA引き継ぎ用、SameSite=Strict） */
    private setDeviceIdCookie(loginName: string, deviceId: string): void {
        const ckey = `nakama_did_${loginName}`;
        const secure = location.protocol === "https:" ? ";Secure" : "";
        document.cookie = `${ckey}=${encodeURIComponent(deviceId)};path=/;max-age=3600;SameSite=Strict${secure}`;
    }

    /** Cookie からデバイスIDを削除（引き継ぎ完了後） */
    private deleteDeviceIdCookie(loginName: string): void {
        const ckey = `nakama_did_${loginName}`;
        document.cookie = `${ckey}=;path=/;max-age=0`;
    }

    private generateDeviceId(): string {
        return (typeof crypto.randomUUID === "function")
            ? crypto.randomUUID()
            : (([1e7] as unknown as string) + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c: string) =>
                (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16));
    }

    private getOrCreateDeviceId(loginName: string): string {
        const key = `nakama_device_id_${loginName}`;
        // 1. localStorage（同一コンテキスト内で最速）
        let deviceId = localStorage.getItem(key);
        if (deviceId) {
            // Cookie にも同期（Safari→PWA引き継ぎ用）
            this.setDeviceIdCookie(loginName, deviceId);
            return deviceId;
        }
        // 2. Cookie（Safari↔PWA間の共有フォールバック）
        const cookieValue = this.getDeviceIdCookie(loginName);
        if (cookieValue) {
            localStorage.setItem(key, cookieValue);
            this.deleteDeviceIdCookie(loginName);  // 引き継ぎ完了、Cookie削除
            console.log("snd DeviceId restored from cookie (PWA bridge)");
            return cookieValue;
        }
        // 3. 新規生成 → localStorage + Cookie に保存
        deviceId = this.generateDeviceId();
        localStorage.setItem(key, deviceId);
        this.setDeviceIdCookie(loginName, deviceId);
        return deviceId;
    }

    async login(loginName: string): Promise<Session> {
        const _end = prof("NakamaService.login");
        try {
        this.loginName = loginName;
        const useSSL = location.protocol === "https:";
        const key = import.meta.env.VITE_SERVER_KEY || "defaultkey";
        console.log(`snd Connect ${useSSL ? "https" : "http"}://${this.host}:${this.port} (SSL=${useSSL})`);
        this.client = new Client(key, this.host, this.port, useSSL);
        const deviceId = this.getOrCreateDeviceId(loginName);
        this.session = await this.client.authenticateDevice(deviceId, true);
        // デバイス認証後にusernameを設定し、セッションを再取得（JWTにusernameを反映）
        if (this.session.username !== loginName) {
            try {
                await this.client.updateAccount(this.session, { username: loginName });
            } catch {
                const hasLocal = !!localStorage.getItem(`nakama_device_id_${loginName}`);
                const hasCookie = !!this.getDeviceIdCookie(loginName);
                const isPWA = window.matchMedia("(display-mode: standalone)").matches;
                throw new Error(
                    `ユーザーID "${loginName}" は既に使用されています。\n` +
                    `原因: このブラウザに紐付くデバイスIDがサーバー上の "${loginName}" と一致しません。\n` +
                    `状態: localStorage=${hasLocal ? "あり" : "なし"}, Cookie=${hasCookie ? "あり" : "なし"}, PWA=${isPWA ? "はい" : "いいえ"}\n` +
                    `対処: メニュー→「クッキー初期化」を実行するか、別のユーザーIDでログインしてください。`
                );
            }
            this.session = await this.client.authenticateDevice(deviceId, false);
        }
        console.log("snd Login username:", this.session.username);

        this.socket = this.client.createSocket(useSSL, false);
        this.socket.setHeartbeatTimeoutMs(60000);
        await this.socket.connect(this.session, true);

        this.setupSocketHandlers();

        this.selfSessionId = this.session.user_id ? (this.session as unknown as { session_id?: string }).session_id ?? "" : "";
        this.loginTimeISO = new Date().toISOString();

        return this.session;
        } finally { _end(); }
    }

    private setupSocketHandlers(): void {
        const _end = prof("NakamaService.setupSocketHandlers");
        if (!this.socket) { _end(); return; }
        this.socket.ondisconnect = () => {
            // Nakama SDK は disconnect() 呼び出しと WebSocket onClose で二重発火するためガード
            if (this.reconnecting) return;
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
                this.socket = this.client.createSocket(location.protocol === "https:", false);
                this.socket.setHeartbeatTimeoutMs(60000);
                await this.socket.connect(this.session, true);
                this.setupSocketHandlers();
                // マッチ再参加（チャットもマッチ経由、メタデータ付き）
                const meta = this.getReconnectMeta?.() ?? {};
                await this.joinWorldMatch(meta);
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

    async joinWorldMatch(initMeta?: Record<string, string>, worldId = 0): Promise<{ worldId: number; chunkCountX: number; chunkCountZ: number }> {
        const _end = prof("NakamaService.joinWorldMatch");
        try {
        console.log(`snd getWorldMatch worldId=${worldId}`);
        if (!this.session || !this.socket) throw new Error("no session/socket");
        const result = await this.socket.rpc("getWorldMatch", JSON.stringify({ worldId }));
        if (!result?.payload) throw new Error("getWorldMatch: no payload");
        const data = JSON.parse(result.payload) as { matchId?: string; worldId?: number; chunkCountX?: number; chunkCountZ?: number };
        if (!data.matchId) throw new Error("getWorldMatch: no matchId");
        this.matchId = data.matchId;
        const worldInfo = { worldId: data.worldId ?? 0, chunkCountX: data.chunkCountX ?? 64, chunkCountZ: data.chunkCountZ ?? 64 };

        // joinMatch() より前にハンドラを登録する（MatchJoin直後のサーバー通知を取りこぼさないため）
        this.socket.onmatchdata = (md: MatchData) => {
            const _mt0 = performance.now();
            const sid = md.presence?.session_id;
            const op = md.op_code;
            const entry = this.opHandlers[op];
            if (!entry?.silent) {
                console.log(`rcv op=${op} ${entry?.name ?? `?${op}`} sid=${sid ? sid.slice(0, 8) : "(srv)"}`);
            }
            try {
                const payload = JSON.parse(this._decoder.decode(md.data));
                if (entry) entry.fn(payload, sid);
            } catch (e) {
                console.warn(`rcv parse error op=${op} ${entry?.name ?? `?${op}`}`, e);
            }
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
        // onmatchpresence を joinMatch より前に登録（MatchLeave の取りこぼし防止）
        this.socket.onmatchpresence = (event: MatchPresenceEvent) => {
            for (const p of event.joins ?? []) this.onMatchPresenceJoin?.(p.session_id, p.user_id, p.username);
            for (const p of event.leaves ?? []) this.onMatchPresenceLeave?.(p.session_id, p.user_id, p.username);
        };
        console.log(`snd joinMatch matchId=${this.matchId.slice(0,8)} meta=${JSON.stringify(initMeta)}`);
        const match = await this.socket.joinMatch(this.matchId, undefined, initMeta ?? {});
        // selfSessionId を確定 + 現在の presences を記録
        const ids: string[] = [];
        if (match.self) {
            this.selfSessionId = match.self.session_id;
            ids.push(match.self.session_id);
            this.onMatchPresenceJoin?.(match.self.session_id, match.self.user_id, match.self.username);
        }
        for (const p of match.presences ?? []) {
            ids.push(p.session_id);
            this.onMatchPresenceJoin?.(p.session_id, p.user_id, p.username);
        }
        this.currentPresenceIds = ids;
        return worldInfo;
        } finally { _end(); }
    }

    /** 現在のマッチから離脱 */
    async leaveMatch(): Promise<void> {
        if (!this.socket || !this.matchId) return;
        console.log(`snd leaveMatch matchId=${this.matchId.slice(0, 8)}`);
        await this.socket.leaveMatch(this.matchId);
        this.matchId = undefined as unknown as string;
    }

    /** ワールド切替中フラグ（leave→join の間、ログアウト通知を抑制） */
    changingWorld = false;

    /** ワールド切替: 新マッチ join（metadata に worldMove=1）→ 旧マッチ leave */
    async changeWorldMatch(worldId: number, initMeta?: Record<string, string>): Promise<{ worldId: number; chunkCountX: number; chunkCountZ: number }> {
        this.changingWorld = true;
        const oldMatchId = this.matchId;
        // 先に新マッチに join（metadata で worldMove フラグを渡す）
        // MatchJoinAttempt で worldMovingUsers にセットされてから旧マッチの MatchLeave が呼ばれる
        const meta = { ...initMeta, worldMove: "1" };
        const result = await this.joinWorldMatch(meta, worldId);
        // 旧マッチを leave
        if (oldMatchId && this.socket) {
            await this.socket.leaveMatch(oldMatchId);
        }
        this.changingWorld = false;
        return result;
    }

    async sendInitPos(x: number, z: number, ry = 0, textureUrl = "", charCol = 0, charRow = 0): Promise<void> {
        const _end = prof("NakamaService.sendInitPos");
        try {
        console.log(`snd initPos x=${(+x).toFixed(1)} z=${(+z).toFixed(1)} ry=${(+ry).toFixed(1)} tx=${textureUrl} cc=${charCol} cr=${charRow}`);
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_INIT_POS, new TextEncoder().encode(JSON.stringify({ x, z, ry, lt: this.loginTimeISO, dn: this.selfDisplayName, tx: textureUrl, cc: charCol, cr: charRow, nc: this.selfNameColor })));
        } catch (e) { console.warn("NakamaService:", e); }
        } finally { _end(); }
    }

    async sendAvatarChange(textureUrl: string, charCol = 0, charRow = 0): Promise<void> {
        const _end = prof("NakamaService.sendAvatarChange");
        try {
        console.log(`snd sendAvatarChange textureUrl=${textureUrl} cc=${charCol} cr=${charRow}`);
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_AVATAR_CHANGE, new TextEncoder().encode(JSON.stringify({ textureUrl, cc: charCol, cr: charRow })));
        } catch (e) { console.warn("NakamaService:", e); }
        } finally { _end(); }
    }

    async sendDisplayName(displayName: string): Promise<void> {
        const _end = prof("NakamaService.sendDisplayName");
        try {
        console.log(`snd sendDisplayName displayName=${displayName}`);
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_DISPLAY_NAME, new TextEncoder().encode(JSON.stringify({ displayName, nc: this.selfNameColor })));
        } catch (e) { console.warn("NakamaService:", e); }
        } finally { _end(); }
    }

    async sendNameColor(nameColor: string): Promise<void> {
        if (!this.socket || !this.matchId) return;
        this.selfNameColor = nameColor;
        try {
            await this.socket.sendMatchState(this.matchId, OP_DISPLAY_NAME, new TextEncoder().encode(JSON.stringify({ displayName: this.selfDisplayName, nc: nameColor })));
        } catch (e) { console.warn("NakamaService:", e); }
    }

    async sendMoveTarget(x: number, z: number): Promise<void> {
        const _end = prof("NakamaService.sendMoveTarget");
        try {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_MOVE_TARGET, JSON.stringify({ x, z }));
        } catch (e) { console.warn("NakamaService:", e); }
        } finally { _end(); }
    }

    async sendAOI(minCX: number, minCZ: number, maxCX: number, maxCZ: number): Promise<void> {
        const _end = prof("NakamaService.sendAOI");
        try {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_AOI_UPDATE, JSON.stringify({ minCX, minCZ, maxCX, maxCZ }));
        } catch (e) { console.warn("NakamaService:", e); }
        } finally { _end(); }
    }

    async sendProfileRequest(sessionIds: string[]): Promise<void> {
        const _end = prof("NakamaService.sendProfileRequest");
        try {
        console.log(`snd profileRequest sids=${sessionIds.map(s => s.slice(0, 8)).join(",")}`);
        if (!this.socket || !this.matchId || sessionIds.length === 0) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_PROFILE_REQUEST, new TextEncoder().encode(JSON.stringify({ sessionIds })));
        } catch (e) { console.warn("NakamaService:", e); }
        } finally { _end(); }
    }

    async sendChatMessage(text: string): Promise<void> {
        const _end = prof("NakamaService.sendChatMessage");
        try {
        console.log(`snd sendChatMessage text=${text}`);
        if (!this.socket || !this.matchId) return;
        await this.socket.sendMatchState(this.matchId, OP_CHAT, new TextEncoder().encode(JSON.stringify({ text })));
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

    /** ワールド一覧を取得 */
    async getWorldList(): Promise<{ id: number; name: string; chunkCountX: number; chunkCountZ: number; ownerUid: string; playerCount: number }[]> {
        if (!this.socket) return [];
        const r = await this.socket.rpc("getWorldList");
        if (r?.payload) {
            const data = JSON.parse(r.payload) as { worlds?: { id: number; name: string; chunkCountX: number; chunkCountZ: number; ownerUid: string; playerCount: number }[] };
            return data.worlds ?? [];
        }
        return [];
    }

    /** 部屋を作成 */
    async createRoom(name: string, chunkCountX: number, chunkCountZ: number): Promise<number> {
        if (!this.socket) throw new Error("no socket");
        const r = await this.socket.rpc("createRoom", JSON.stringify({ name, chunkCountX, chunkCountZ }));
        if (r?.payload) {
            const data = JSON.parse(r.payload) as { worldId?: number };
            return data.worldId ?? -1;
        }
        return -1;
    }

    /** 部屋を削除 */
    async deleteRoom(worldId: number): Promise<boolean> {
        if (!this.socket) return false;
        const r = await this.socket.rpc("deleteRoom", JSON.stringify({ worldId }));
        if (r?.payload) {
            const data = JSON.parse(r.payload) as { deleted?: boolean };
            return data.deleted ?? false;
        }
        return false;
    }

    /** サーバーからブックマーク一覧を取得 */
    async getBookmarks(): Promise<{ name: string; x: number; z: number; ry: number; worldId: number }[]> {
        if (!this.socket) return [];
        const rpcResult = await this.socket.rpc("getBookmarks");
        if (rpcResult?.payload) {
            const data = JSON.parse(rpcResult.payload) as { items?: { name: string; x: number; z: number; ry: number; worldId: number }[] };
            return data.items ?? [];
        }
        return [];
    }

    /** ブックマーク一覧をサーバーに保存 */
    async saveBookmarks(items: { name: string; x: number; z: number; ry: number; worldId: number }[]): Promise<void> {
        if (!this.socket) return;
        await this.socket.rpc("saveBookmarks", JSON.stringify({ items }));
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
                const data = JSON.parse(result.payload) as { name?: string; version?: string; pluginDate?: string; pluginCommit?: string };
                const parts: string[] = [];
                if (data.name || data.version)
                    parts.push(`NakamaServerName="${[data.name, data.version ? `v${data.version}` : ""].filter(Boolean).join(" ")}"`);
                if (data.pluginDate || data.pluginCommit) {
                    const date = data.pluginDate?.replace(/_/g, " ") ?? "";
                    const commit = data.pluginCommit ?? "";
                    parts.push(`world.so ${[date, commit].filter(Boolean).join(" ")}`);
                }
                if (parts.length) return parts.join(" ");
            }
        } catch (e) { console.warn("NakamaService.getServerInfo RPC fallback:", e); }
        // ② /v2/serverinfo (Nakama 3.x+) — 同一オリジン経由
        const base = location.origin;
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
        } catch (e) { console.warn("NakamaService:", e); }
        return "不明";
        } finally { _end(); }
    }

    async setBlock(gx: number, gz: number, blockId: number, r: number, g: number, b: number, a = 255): Promise<void> {
        const _end = prof("NakamaService.setBlock");
        try {
        console.log(`snd setBlock gx=${gx} gz=${gz} blockId=${blockId} rgba=(${r},${g},${b},${a})`);
        if (!this.socket || !this.matchId) return;
        await this.socket.sendMatchState(this.matchId, OP_BLOCK_UPDATE, JSON.stringify({ gx, gz, blockId, r, g, b, a }));
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
        } catch (e) { console.warn("NakamaService.getGroundTable:", e); return null; }
    }

    async syncChunks(minCX: number, minCZ: number, maxCX: number, maxCZ: number, hashes: Record<string, string>, worldId = 0): Promise<{ cx: number; cz: number; hash: string; table: number[] }[]> {
        const _end = prof("NakamaService.syncChunks");
        try {
        if (!this.socket) return [];
        console.log(`snd syncChunks (${minCX},${minCZ})-(${maxCX},${maxCZ}) w=${worldId}`);
        try {
            const result = await this.socket.rpc("syncChunks", JSON.stringify({ worldId, minCX, minCZ, maxCX, maxCZ, hashes }));
            if (!result?.payload) return [];
            const data = JSON.parse(result.payload) as { chunks?: { cx: number; cz: number; hash: string; table: number[] }[] };
            return data.chunks ?? [];
        } catch (e) { console.warn("NakamaService.syncChunks:", e); return []; }
        } finally { _end(); }
    }

    async getGroundChunk(cx: number, cz: number, worldId = 0): Promise<{ cx: number; cz: number; table: number[] } | null> {
        const _end = prof("NakamaService.getGroundChunk");
        try {
        console.log(`snd getGroundChunk cx=${cx} cz=${cz} w=${worldId}`);
        if (!this.socket) return null;
        try {
            const result = await this.socket.rpc("getGroundChunk", JSON.stringify({ worldId, cx, cz }));
            if (!result?.payload) return null;
            return JSON.parse(result.payload) as { cx: number; cz: number; table: number[] };
        } catch (e) { console.warn("NakamaService.getGroundChunk:", e); return null; }
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
        } catch (e) {
            console.warn("NakamaService.measurePing:", e);
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
        } catch (e) {
            console.warn("NakamaService.getPlayerCount:", e);
            return null;
        }
        } finally { _end(); }
    }

    // プレイヤーリストのプッシュ配信を購読/解除
    async subscribePlayerList(subscribe: boolean, mode: "count" | "full" = "full"): Promise<void> {
        if (!this.socket || !this.matchId) return;
        try {
            await this.socket.sendMatchState(this.matchId, OP_PLAYER_LIST_SUB, new TextEncoder().encode(JSON.stringify({ subscribe, mode })));
        } catch (e) { console.warn("NakamaService.subscribePlayerList:", e); }
    }

    // 全プレイヤーのAOI情報を取得（matchデータ方式: 要求→応答）
    private _aoiResolve: ((players: { sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[]) => void) | null = null;
    async getPlayersAOI(): Promise<{ sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[]> {
        const _end = prof("NakamaService.getPlayersAOI");
        try {
        console.log("snd getPlayersAOI");
        if (!this.socket || !this.matchId) return [];
        const promise = new Promise<{ sessionId: string; username: string; minCX: number; minCZ: number; maxCX: number; maxCZ: number; x: number; z: number }[]>((resolve) => {
            this._aoiResolve = resolve;
            setTimeout(() => { if (this._aoiResolve === resolve) { this._aoiResolve = null; resolve([]); } }, 3000);
        });
        await this.socket.sendMatchState(this.matchId, OP_PLAYERS_AOI_REQ, "{}");
        return promise;
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
