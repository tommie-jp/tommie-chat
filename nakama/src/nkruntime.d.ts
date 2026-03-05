declare namespace nkruntime {
    interface Context {
        node: string;
        env: Record<string, string>;
        [key: string]: unknown;
    }
    interface Logger {
        info(msg: string, ...args: unknown[]): void;
        warn(msg: string, ...args: unknown[]): void;
        error(msg: string, ...args: unknown[]): void;
    }
    interface Stream {
        mode: number;
        subject?: string;
        subcontext?: string;
        label?: string;
    }
    interface Match {
        matchId: string;
        authoritative: boolean;
        label: string;
        size: number;
    }
    interface MatchPresence {
        userId: string;
        sessionId: string;
        username: string;
        node: string;
    }
    interface MatchMessage {
        sender: MatchPresence;
        persistence: boolean;
        status: string;
        opCode: number;
        data: string;
        reliable: boolean;
        receiveTimeMs: number;
    }
    interface MatchDispatcher {
        broadcastMessage(opCode: number, data: string | null, presences: MatchPresence[] | null, sender: MatchPresence | null, reliable?: boolean): void;
    }
    interface MatchHandler {
        matchInit: (ctx: Context, logger: Logger, nk: Nakama, params: { [key: string]: string }) => { state: object; tickRate: number; label?: string };
        matchJoinAttempt: (ctx: Context, logger: Logger, nk: Nakama, dispatcher: MatchDispatcher, tick: number, state: object, presence: MatchPresence, metadata: { [key: string]: string }) => { state: object; accept: boolean; rejectMessage?: string };
        matchJoin: (ctx: Context, logger: Logger, nk: Nakama, dispatcher: MatchDispatcher, tick: number, state: object, presences: MatchPresence[]) => { state: object };
        matchLeave: (ctx: Context, logger: Logger, nk: Nakama, dispatcher: MatchDispatcher, tick: number, state: object, presences: MatchPresence[]) => { state: object };
        matchLoop: (ctx: Context, logger: Logger, nk: Nakama, dispatcher: MatchDispatcher, tick: number, state: object, messages: MatchMessage[]) => { state: object } | null;
        matchTerminate: (ctx: Context, logger: Logger, nk: Nakama, dispatcher: MatchDispatcher, tick: number, state: object, graceSeconds: number) => { state: object };
        matchSignal: (ctx: Context, logger: Logger, nk: Nakama, dispatcher: MatchDispatcher, tick: number, state: object, data: string) => { state: object; data: string };
    }
    interface StorageReadRequest {
        collection: string;
        key: string;
        userId: string;
    }
    interface StorageObject {
        collection: string;
        key: string;
        userId: string;
        value: { [key: string]: unknown };
        version: string;
        permissionRead: number;
        permissionWrite: number;
    }
    interface StorageWriteRequest {
        collection: string;
        key: string;
        userId: string;
        value: { [key: string]: unknown };
        permissionRead?: number;
        permissionWrite?: number;
        version?: string;
    }
    interface Nakama {
        streamCount(stream: Stream): number;
        matchCreate(module: string, params?: { [key: string]: string }): string;
        matchList(limit: number, authoritative: boolean, label: string | null, minSize: number | null, maxSize: number | null, query: string): Match[];
        storageRead(ids: StorageReadRequest[]): StorageObject[];
        storageWrite(objects: StorageWriteRequest[]): { key: string; collection: string; userId: string; version: string }[];
        storageDelete(ids: StorageReadRequest[]): void;
    }
    interface Initializer {
        registerRpc(id: string, fn: RpcFunction): void;
        registerMatch(name: string, handlers: MatchHandler): void;
    }
    type RpcFunction = (
        ctx: Context,
        logger: Logger,
        nk: Nakama,
        payload: string
    ) => string | void;
}
