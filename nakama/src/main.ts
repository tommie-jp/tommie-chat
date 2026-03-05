var serverUpTime = new Date().toISOString();

// チャットルーム "world" (type=Room) のストリーム定数
var STREAM_MODE_CHANNEL = 2;
var CHAT_ROOM_LABEL = "world";

function rpcGetServerInfo(
    ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    _payload: string
): string {
    var playerCount = nk.streamCount({ mode: STREAM_MODE_CHANNEL, label: CHAT_ROOM_LABEL });
    var info = {
        name: ctx.node || "nakama",
        version: (ctx.env && ctx.env["NAKAMA_VERSION"]) || "unknown",
        serverUpTime: serverUpTime,
        playerCount: playerCount,
    };
    return JSON.stringify(info);
}

var WORLD_COLLECTION = "world_state";
var WORLD_KEY        = "match_id";
var SYSTEM_USER_ID   = "00000000-0000-0000-0000-000000000000";

function rpcGetWorldMatch(
    _ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    _payload: string
): string {
    // Nakama Storage からマッチIDを読む（全ランタイムインスタンスで共有）
    try {
        var objects = nk.storageRead([{
            collection: WORLD_COLLECTION,
            key: WORLD_KEY,
            userId: SYSTEM_USER_ID,
        }]);
        if (objects && objects.length > 0) {
            var storedId = objects[0].value["matchId"] as string;
            if (storedId) {
                logger.info("Reusing world match: " + storedId);
                return JSON.stringify({ matchId: storedId });
            }
        }
    } catch (e) {
        logger.warn("storageRead failed: " + e);
    }

    var matchId = nk.matchCreate("world", {});
    logger.info("Created world match: " + matchId);

    try {
        nk.storageWrite([{
            collection: WORLD_COLLECTION,
            key: WORLD_KEY,
            userId: SYSTEM_USER_ID,
            value: { matchId: matchId },
            permissionRead: 2,
            permissionWrite: 1,
        }]);
    } catch (e) {
        logger.warn("storageWrite failed: " + e);
    }

    return JSON.stringify({ matchId: matchId });
}

// ワールドマッチハンドラ — Nakamaはトップレベル関数を参照する必要がある
function worldMatchInit(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _params: { [key: string]: string }
) {
    return { state: {}, tickRate: 10, label: "world" };
}

function worldMatchJoinAttempt(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: object,
    _presence: nkruntime.MatchPresence,
    _metadata: { [key: string]: string }
) {
    return { state: state, accept: true };
}

function worldMatchJoin(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: object,
    _presences: nkruntime.MatchPresence[]
) {
    return { state: state };
}

function worldMatchLeave(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: object,
    _presences: nkruntime.MatchPresence[]
) {
    return { state: state };
}

function worldMatchLoop(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: object,
    messages: nkruntime.MatchMessage[]
) {
    for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        dispatcher.broadcastMessage(msg.opCode, msg.data, null, msg.sender, true);
    }
    return { state: state };
}

function worldMatchTerminate(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: object,
    _graceSeconds: number
) {
    return { state: state };
}

function worldMatchSignal(
    _ctx: nkruntime.Context,
    _logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    _dispatcher: nkruntime.MatchDispatcher,
    _tick: number,
    state: object,
    data: string
) {
    return { state: state, data: data };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function InitModule(
    _ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    _nk: nkruntime.Nakama,
    initializer: nkruntime.Initializer
): void {
    initializer.registerMatch("world", {
        matchInit: worldMatchInit,
        matchJoinAttempt: worldMatchJoinAttempt,
        matchJoin: worldMatchJoin,
        matchLeave: worldMatchLeave,
        matchLoop: worldMatchLoop,
        matchTerminate: worldMatchTerminate,
        matchSignal: worldMatchSignal,
    });
    initializer.registerRpc("getServerInfo", rpcGetServerInfo);
    initializer.registerRpc("getWorldMatch", rpcGetWorldMatch);
    logger.info("server_info module loaded");
}
