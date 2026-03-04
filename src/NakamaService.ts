import { Client, Session, Socket, Channel, ChannelMessage, ChannelPresenceEvent } from "@heroiclabs/nakama-js";

const CHAT_ROOM = "world";
const CHAT_TYPE = 1; // 1=Room, 2=DM, 3=Group

export class NakamaService {
    private client: Client;
    private session: Session | null = null;
    private socket: Socket | null = null;
    private channelId: string | null = null;

    onChatMessage?: (username: string, text: string) => void;
    onPresenceJoin?: (userId: string, username: string) => void;
    onPresenceLeave?: (userId: string, username: string) => void;

    constructor(host = "127.0.0.1", port = "7350", useSSL = false) {
        this.client = new Client("defaultkey", host, port, useSSL);
    }

    async login(loginName: string): Promise<Session> {
        this.session = await this.client.authenticateCustom(loginName, true, loginName);

        this.socket = this.client.createSocket(false, false);
        await this.socket.connect(this.session, true);

        this.socket.onchannelmessage = (msg: ChannelMessage) => {
            const content = msg.content as { text?: string };
            if (content?.text) this.onChatMessage?.(msg.username ?? "", content.text);
        };

        const ch: Channel = await this.socket.joinChat(CHAT_ROOM, CHAT_TYPE, true, false);
        this.channelId = ch.id;

        for (const p of ch.presences ?? []) {
            this.onPresenceJoin?.(p.user_id, p.username);
        }

        this.socket.onchannelpresence = (event: ChannelPresenceEvent) => {
            for (const p of event.joins  ?? []) this.onPresenceJoin?.(p.user_id, p.username);
            for (const p of event.leaves ?? []) this.onPresenceLeave?.(p.user_id, p.username);
        };

        return this.session;
    }

    async sendChatMessage(text: string): Promise<void> {
        if (!this.socket || !this.channelId) return;
        await this.socket.writeChatMessage(this.channelId, { text });
    }

    getSession(): Session | null {
        return this.session;
    }
}
