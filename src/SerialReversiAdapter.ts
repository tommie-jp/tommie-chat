// 自作 CPU ゲームの参加通知を受けて、シリアルテストパネルで接続済みのポートへ
// UART プロトコル（doc/reversi/61-UARTプロトコル仕様.md §メッセージ書式）の
// メッセージを 1 行送る最小アダプタ。改行は LF (\n) のみ。
//
// 現時点では「他プレイヤー参加 → SB\n（黒先攻・初手要求）」のみ実装。
// 盤面同期・CPU 応答受信・終局送信などは未実装。

interface SerialTestBridge {
    isConnected(): boolean;
    sendLine(text: string): Promise<void>;
}

declare global {
    interface Window {
        __serialTestBridge?: SerialTestBridge;
    }
}

let lastNotifiedGameId: string | null = null;

// 自分の CPU 対戦ゲームに相手が参加し playing に遷移した直後に呼ぶ。
// 同じ gameId は 1 度しか送らない（applyGameList は複数回呼ばれるため）。
export function notifyOwnCpuGameStarted(gameId: string): void {
    if (lastNotifiedGameId === gameId) return;
    lastNotifiedGameId = gameId;
    const bridge = window.__serialTestBridge;
    if (!bridge || !bridge.isConnected()) {
        console.warn(`SerialReversiAdapter: シリアル未接続のため "SB\\n" 送信をスキップ (gameId=${gameId})`);
        return;
    }
    bridge.sendLine("SB").catch((e) => {
        console.warn("SerialReversiAdapter: sendLine 失敗:", e);
    });
}

// 終局・取消時に呼んで、次回の同一 gameId を再送可能にする（現状は予防のみ）。
export function resetLastNotified(): void {
    lastNotifiedGameId = null;
}
