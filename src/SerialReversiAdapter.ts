// 自作 CPU リバーシ対戦の UART ブリッジ（ブラウザ側）。
// シリアルテストパネルが公開する window.__serialTestBridge を介して
// 1 行単位でメッセージを送受信する。プロトコルは
// doc/reversi/61-UARTプロトコル仕様.md を参照。
//
// Phase 2: 受信パースの骨格（コマンドごとにログ出力するのみ）。
// 送信は既存互換の notifyOwnCpuGameStarted / resetLastNotified のみ。
// 状態遷移・RPC 発行・PI/PO は Phase 3 以降で追加する。

interface SerialTestBridge {
    isConnected(): boolean;
    sendLine(text: string): Promise<void>;
    onLine?(cb: (line: string) => void): void;
    offLine?(cb: (line: string) => void): void;
}

declare global {
    interface Window {
        __serialTestBridge?: SerialTestBridge;
    }
}

type AdapterState = "IDLE" | "MY_TURN" | "WAIT_OPP";

class SerialReversiAdapter {
    // §10 C1 (IDLE) / C2 (MY_TURN) / C3 (WAIT_OPP) のミラー。
    // Phase 3 以降で送受信判定に使う。
    // @ts-expect-error Phase 2 では書き込むだけで参照は Phase 3 以降
    private state: AdapterState = "IDLE";
    private bridgeAttached = false;
    private lastNotifiedGameId: string | null = null;
    private readonly lineHandler = (line: string) => this.onLine(line);

    attachBridge(): boolean {
        if (this.bridgeAttached) return true;
        const b = window.__serialTestBridge;
        if (!b || typeof b.onLine !== "function") return false;
        b.onLine(this.lineHandler);
        this.bridgeAttached = true;
        return true;
    }

    detachBridge(): void {
        if (!this.bridgeAttached) return;
        const b = window.__serialTestBridge;
        if (b && typeof b.offLine === "function") b.offLine(this.lineHandler);
        this.bridgeAttached = false;
    }

    // 受信 1 行のパース。§4 大文字小文字は区別しないので先頭 2 文字を大文字化して判定。
    // Phase 2 ではログ出力のみ（状態遷移・RPC 発行は未実装）。
    private onLine(raw: string): void {
        const line = raw.replace(/[\r\n]+$/g, "");
        if (line.length === 0) return;
        const head = line.slice(0, 2).toUpperCase();
        const rest = line.slice(2);
        switch (head) {
            case "PO":
                console.log("SerialReversi <CPU: PO (PONG)");
                return;
            case "VE":
                console.log(`SerialReversi <CPU: VE ${rest}`);
                return;
            case "MO":
                console.log(`SerialReversi <CPU: MO${rest} (未処理)`);
                return;
            case "PA":
                console.log("SerialReversi <CPU: PA (PASS・未処理)");
                return;
            case "EN":
                console.log("SerialReversi <CPU: EN (投了・未処理)");
                return;
            case "RE":
                console.log("SerialReversi <CPU: RE (READY・未処理)");
                return;
            case "ER":
                console.log("SerialReversi <CPU: ER (ログのみ・再送しない)");
                return;
            case "ST":
                console.log(`SerialReversi <CPU: ST ${rest}`);
                return;
            case "NC":
                console.log(`SerialReversi <CPU: NC ${rest}`);
                return;
            default:
                // §8: 現在状態で無効なコマンドは黙って捨てる
                console.debug(`SerialReversi <CPU: 不明コマンド "${line}" を破棄`);
                return;
        }
    }

    // 自分の CPU 対戦ゲームに相手が参加し playing に遷移した直後に呼ぶ。
    // 同じ gameId は 1 度しか送らない（applyGameList は複数回呼ばれるため）。
    notifyOwnCpuGameStarted(gameId: string): void {
        if (this.lastNotifiedGameId === gameId) return;
        this.lastNotifiedGameId = gameId;
        this.attachBridge();
        const b = window.__serialTestBridge;
        if (!b || !b.isConnected()) {
            console.warn(`SerialReversiAdapter: シリアル未接続のため "SB\\n" 送信をスキップ (gameId=${gameId})`);
            return;
        }
        this.state = "MY_TURN"; // §11 SB→C2 (MY_TURN)
        b.sendLine("SB").catch((e) => {
            console.warn("SerialReversiAdapter: sendLine 失敗:", e);
        });
    }

    // 終局・取消時に呼んで、次回の同一 gameId を再送可能にする（現状は予防のみ）。
    resetLastNotified(): void {
        this.lastNotifiedGameId = null;
        this.state = "IDLE";
    }
}

const adapter = new SerialReversiAdapter();

// test-web-serial-api.js はモジュール評価順で本モジュールより後に動く可能性があるため、
// ブリッジが準備できたタイミングで attachBridge() する。
if (typeof window !== "undefined") {
    const tryAttach = () => adapter.attachBridge();
    tryAttach();
    window.addEventListener("serialtestbridge-ready", tryAttach);
}

// 既存 UIPanel からの呼び出しを変えないよう、関数形式の API を残す。
export function notifyOwnCpuGameStarted(gameId: string): void {
    adapter.notifyOwnCpuGameStarted(gameId);
}

export function resetLastNotified(): void {
    adapter.resetLastNotified();
}
