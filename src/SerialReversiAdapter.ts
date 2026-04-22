// 自作 CPU リバーシ対戦の UART ブリッジ（ブラウザ側）。
// シリアルテストパネルが公開する window.__serialTestBridge を介して
// 1 行単位でメッセージを送受信する。プロトコルは
// doc/reversi/61-UARTプロトコル仕様.md を参照。
//
// Phase 5: PI/PO ハートビート（3 秒間隔）、3 連続失敗で CPU 停止扱い。
//          文字間 100ms タイムアウトはブリッジ側 (adapterFeed) で対応。
// Phase 6: 対局中途参加／RE 復帰の BO + SB/SW 再送。
// Phase 7: VE 問い合わせ、EN → othelloResign RPC、PA は警告のみ（Nakama 未対応）。

import type { OthelloUpdatePayload } from "./NakamaService";

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

// NakamaService 全体を取り込まずに済むよう、使う RPC だけを structural に要求する。
export interface SerialReversiMovePort {
    othelloMove(gameId: string, row: number, col: number): Promise<OthelloUpdatePayload | null>;
    othelloResign(gameId: string): Promise<OthelloUpdatePayload | null>;
}

type AdapterState = "IDLE" | "MY_TURN" | "WAIT_OPP";

const PING_INTERVAL_MS = 3000; // §5
const PING_FAIL_THRESHOLD = 3; // §5 3 連続失敗で切断扱い

class SerialReversiAdapter {
    // §10 C1 (IDLE) / C2 (MY_TURN) / C3 (WAIT_OPP) のミラー
    private state: AdapterState = "IDLE";
    private bridgeAttached = false;
    private readonly lineHandler = (line: string) => this.onLine(line);

    // onGameStateUpdate が追跡するゲーム別スナップショット
    private currentGameId: string | null = null;
    private prevStatus = "";
    private prevTurn = 0;
    private prevLastMove = -2;
    private startSent = false;
    private movePort: SerialReversiMovePort | null = null;

    // Phase 5: ハートビート
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pingOutstanding = 0;
    private cpuStalled = false;
    private veRequestedForConnection = false;

    // Phase 6: §12 復帰のため、直前に送った「ゲーム指示」を保持
    //          PI / VE / ER の類は対象外
    private lastDirectiveSent = "";

    attachBridge(): boolean {
        if (this.bridgeAttached) return true;
        const b = window.__serialTestBridge;
        if (!b || typeof b.onLine !== "function") return false;
        b.onLine(this.lineHandler);
        this.bridgeAttached = true;
        this.startPingLoop();
        return true;
    }

    detachBridge(): void {
        if (!this.bridgeAttached) return;
        const b = window.__serialTestBridge;
        if (b && typeof b.offLine === "function") b.offLine(this.lineHandler);
        this.bridgeAttached = false;
        this.stopPingLoop();
    }

    // 受信 1 行のパース。§4 大文字小文字は区別しないので先頭 2 文字を大文字化して判定。
    private onLine(raw: string): void {
        const line = raw.replace(/[\r\n]+$/g, "");
        if (line.length === 0) return;
        const head = line.slice(0, 2).toUpperCase();
        const rest = line.slice(2);
        switch (head) {
            case "PO":
                // §10 共通応答。ハートビートの応答
                this.onPongReceived();
                return;
            case "VE":
                console.log(`SerialReversi <CPU: VE ${rest}`);
                return;
            case "MO":
                this.handleMoMessage(rest);
                return;
            case "PA":
                // §11 MY_TURN でのみ意味がある。Nakama 側にパス RPC が無いため警告のみ
                if (this.state !== "MY_TURN") {
                    console.debug("SerialReversi <CPU: PA を MY_TURN 外で受信、破棄");
                    return;
                }
                console.warn("SerialReversi <CPU: PA (CPU がパス宣言) - Nakama にパス RPC 未実装、手動操作で対応");
                return;
            case "EN":
                this.handleEnMessage();
                return;
            case "RE":
                this.handleReMessage();
                return;
            case "ER":
                // §6.2 #7 ログ記録のみ、自動再送はしない
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

    // CPU からの MO 着手 → othelloMove RPC
    private handleMoMessage(rest: string): void {
        const m = rest.match(/^([a-hA-H])([1-8])/);
        if (!m) {
            console.warn(`SerialReversi <CPU: MO${rest} パース失敗、破棄`);
            return;
        }
        const colCh = m[1].toLowerCase();
        const rowCh = m[2];
        const col = colCh.charCodeAt(0) - "a".charCodeAt(0);
        const row = rowCh.charCodeAt(0) - "1".charCodeAt(0);
        if (this.state !== "MY_TURN") {
            console.debug(`SerialReversi <CPU: MO${colCh}${rowCh} を MY_TURN 外で受信、破棄`);
            return;
        }
        if (this.cpuStalled) {
            console.warn(`SerialReversi <CPU: MO${colCh}${rowCh} 受信するも CPU 停止中フラグ、破棄`);
            return;
        }
        if (!this.currentGameId || !this.movePort) {
            console.warn(`SerialReversi <CPU: MO${colCh}${rowCh} 受信するもゲーム未結線、破棄`);
            return;
        }
        console.log(`SerialReversi <CPU: MO${colCh}${rowCh} → othelloMove(row=${row}, col=${col})`);
        const gameId = this.currentGameId;
        const port = this.movePort;
        this.state = "WAIT_OPP";
        port.othelloMove(gameId, row, col).catch((e) => {
            console.warn(`SerialReversi: othelloMove RPC 失敗 (${colCh}${rowCh}):`, e);
        });
    }

    // CPU からの EN → othelloResign RPC
    private handleEnMessage(): void {
        if (!this.currentGameId || !this.movePort) {
            console.warn("SerialReversi <CPU: EN 受信するもゲーム未結線、破棄");
            return;
        }
        console.log(`SerialReversi <CPU: EN (投了) → othelloResign(gameId=${this.currentGameId})`);
        const port = this.movePort;
        const gameId = this.currentGameId;
        // §10 終局時: CPU は EN 送信後ただちに IDLE へ
        this.state = "IDLE";
        port.othelloResign(gameId).catch((e) => {
            console.warn("SerialReversi: othelloResign RPC 失敗:", e);
        });
    }

    // CPU からの RE (READY) → 直前指示を再送 (§12)
    private handleReMessage(): void {
        if (!this.lastDirectiveSent) {
            console.log("SerialReversi <CPU: RE (READY) 受信 - 再送する直前指示なし");
            return;
        }
        console.log(`SerialReversi <CPU: RE (READY) → 直前指示を再送: "${this.lastDirectiveSent}"`);
        // RE 復帰時は boot直後 → C1 (IDLE) 相当。再送するのが SB/SW なら後続の遷移で復活する
        this.sendDirective(this.lastDirectiveSent, { skipRecord: true });
    }

    // PO 受信: ハートビートリセット
    private onPongReceived(): void {
        if (this.cpuStalled) {
            console.log("SerialReversi <CPU: PO 受信 - CPU 復活");
        }
        this.pingOutstanding = 0;
        this.cpuStalled = false;
    }

    private startPingLoop(): void {
        if (this.pingTimer !== null) return;
        this.pingTimer = setInterval(() => this.pingTick(), PING_INTERVAL_MS);
    }

    private stopPingLoop(): void {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        this.pingOutstanding = 0;
        this.cpuStalled = false;
        this.veRequestedForConnection = false;
    }

    // 3 秒おきに PI を送る。未接続時はスキップ。3 連続 PO 失敗で停止フラグ。
    private pingTick(): void {
        const b = window.__serialTestBridge;
        if (!b || !b.isConnected()) {
            // ポート切断中はカウンタリセット（次回接続時に仕切り直し）
            this.pingOutstanding = 0;
            this.cpuStalled = false;
            this.veRequestedForConnection = false;
            return;
        }
        // Phase 7: 接続確立後の初回のみ VE 問い合わせ
        if (!this.veRequestedForConnection) {
            this.veRequestedForConnection = true;
            b.sendLine("VE").catch((e) => console.warn("SerialReversi: VE 送信失敗:", e));
        }
        this.pingOutstanding++;
        if (this.pingOutstanding >= PING_FAIL_THRESHOLD && !this.cpuStalled) {
            this.cpuStalled = true;
            console.warn(`SerialReversi: CPU 応答なし (PO 連続 ${PING_FAIL_THRESHOLD} 回失敗) - MO 送信を停止`);
        }
        b.sendLine("PI").catch((e) => console.warn("SerialReversi: PI 送信失敗:", e));
    }

    // UIPanel.applyState から毎回呼ぶ。CPU 対戦ゲームでオーナーである場合にのみ送信を行う。
    onGameStateUpdate(p: OthelloUpdatePayload, myUid: string, nakama: SerialReversiMovePort): void {
        this.movePort = nakama;
        if (!p.isCpu || !myUid) return;
        let cpuColor: 0 | 1 | 2 = 0;
        if (p.black === myUid) cpuColor = 1;
        else if (p.white === myUid) cpuColor = 2;
        if (cpuColor === 0) return;

        // ゲーム ID が変わったらスナップショットをリセット
        if (p.gameId !== this.currentGameId) {
            this.currentGameId = p.gameId;
            this.prevStatus = "";
            this.prevTurn = 0;
            this.prevLastMove = -2;
            this.startSent = false;
            this.lastDirectiveSent = "";
            this.state = "IDLE";
        }

        const status = p.status;
        const turn = p.turn;
        const lastMove = typeof p.lastMove === "number" ? p.lastMove : -1;
        const board = p.board ?? [];

        // (1) 対局開始 or 対局中途参加: prev != playing → playing
        if (this.prevStatus !== "playing" && status === "playing" && !this.startSent) {
            this.startSent = true;
            // Phase 6: 初期局面でなければ先に BO で盤面同期 (§6.1 #5, §10 BOは IDLE で受理)
            if (!isInitialBoard(board)) {
                this.sendDirective("BO" + encodeBO(board));
            }
            if (cpuColor === 1) {
                this.sendDirective("SB");
                this.state = "MY_TURN";
            } else {
                this.sendDirective("SW");
                this.state = "WAIT_OPP";
            }
            // 中途参加時、既に CPU の手番が来ている場合（turn === cpuColor && lastMove が相手色）
            // は SB/SW 送信時点で CPU 側 MY_TURN になるので追加送信は不要
        }
        // (2) 対局中: 相手→CPU に手番が移ったら相手の着手 or パスを通知
        else if (this.prevStatus === "playing" && status === "playing"
                 && this.prevTurn !== turn && turn === cpuColor) {
            const placed = lastMove >= 0 && lastMove !== this.prevLastMove
                         ? board[lastMove]
                         : 0;
            const oppColor = cpuColor === 1 ? 2 : 1;
            if (placed === oppColor) {
                const col = lastMove % 8;
                const row = Math.floor(lastMove / 8);
                const colCh = String.fromCharCode("a".charCodeAt(0) + col);
                const rowCh = String.fromCharCode("1".charCodeAt(0) + row);
                this.sendDirective(`MO${colCh}${rowCh}`);
            } else {
                this.sendDirective("PA");
            }
            this.state = "MY_TURN";
        }
        // (3) 対局中: CPU→相手に手番が移ったら状態のみ更新
        else if (this.prevStatus === "playing" && status === "playing"
                 && this.prevTurn !== turn && turn !== cpuColor) {
            this.state = "WAIT_OPP";
        }

        // (4) 終局
        if (this.prevStatus !== "finished" && status === "finished") {
            const w = p.winner;
            if (w === 1) this.sendDirective("EB");
            else if (w === 2) this.sendDirective("EW");
            else if (w === 3) this.sendDirective("ED");
            this.state = "IDLE";
        }

        this.prevStatus = status;
        this.prevTurn = turn;
        this.prevLastMove = lastMove;
    }

    // 「ゲーム指示」を送る。RE 復帰の再送対象となるため lastDirectiveSent を更新する
    // （skipRecord=true のときは更新しない。RE 受信時の再送ループ防止用）
    private sendDirective(line: string, opts?: { skipRecord?: boolean }): void {
        const b = window.__serialTestBridge;
        if (!b || !b.isConnected()) {
            console.warn(`SerialReversiAdapter: シリアル未接続のため "${line}\\n" 送信をスキップ`);
            return;
        }
        if (this.cpuStalled) {
            console.warn(`SerialReversiAdapter: CPU 停止中のため "${line}\\n" 送信をスキップ`);
            return;
        }
        if (!opts?.skipRecord) this.lastDirectiveSent = line;
        this.attachBridge();
        b.sendLine(line).catch((e) => {
            console.warn(`SerialReversiAdapter: sendLine "${line}" 失敗:`, e);
        });
    }
}

// §7 初期局面: d4=W(2), e4=B(1), d5=B(1), e5=W(2)
// idx = row*8 + col 。d4=27, e4=28, d5=35, e5=36
function isInitialBoard(board: number[]): boolean {
    if (!board || board.length !== 64) return false;
    for (let i = 0; i < 64; i++) {
        let expected = 0;
        if (i === 27 || i === 36) expected = 2;
        if (i === 28 || i === 35) expected = 1;
        if ((board[i] | 0) !== expected) return false;
    }
    return true;
}

// §7 §6.1 #5 BO の並び順: 行優先 (a1..h1, a2..h2, ... h8) の 64 文字
function encodeBO(board: number[]): string {
    let s = "";
    const n = Math.min(64, board?.length ?? 0);
    for (let i = 0; i < n; i++) {
        const v = board[i] | 0;
        s += v === 1 ? "1" : v === 2 ? "2" : "0";
    }
    while (s.length < 64) s += "0";
    return s;
}

const adapter = new SerialReversiAdapter();

// test-web-serial-api.js はモジュール評価順で本モジュールより後に動く可能性があるため、
// ブリッジが準備できたタイミングで attachBridge() する。
if (typeof window !== "undefined") {
    const tryAttach = () => adapter.attachBridge();
    tryAttach();
    window.addEventListener("serialtestbridge-ready", tryAttach);
}

// UIPanel.applyState から呼ぶエントリポイント。
export function onGameStateUpdate(
    payload: OthelloUpdatePayload,
    myUid: string,
    nakama: SerialReversiMovePort,
): void {
    adapter.onGameStateUpdate(payload, myUid, nakama);
}
