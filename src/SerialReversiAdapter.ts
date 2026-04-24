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
    emitStatus?(text: string): void;
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

const PING_INTERVAL_MS = 1000; // §5 サーバー側は 1000 ms 待機
const PING_FAIL_THRESHOLD = 3; // §5 3 連続失敗で切断扱い
const STUCK_THRESHOLD_MS = 10_000;     // PI/PO 以外の活動が N ms 無ければ STUCK
const STUCK_DUMP_INTERVAL_MS = 10_000; // STUCK 中の再ダンプ間隔
const STUCK_CHECK_INTERVAL_MS = 2_000; // STUCK チェックの走査間隔
const RS_MAX_RETRIES = 3;              // RS 連続試行回数の上限（超過で投了）

// テスト (test/SerialReversiAdapter.test.ts) から new できるよう export する。
// 実行時は下部の const adapter = new SerialReversiAdapter() がシングルトンとして使われる。
export class SerialReversiAdapter {
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

    // STUCK 検知: PI/PO 以外の TX/RX があった最終時刻と、最後にダンプした時刻
    private lastGameActivity = Date.now();
    private lastStuckDump = 0;
    private stuckTimer: ReturnType<typeof setInterval> | null = null;

    // RS (再同期要求) 受信時のため、最後に受け取ったサーバ盤面を保持
    private lastBoardSnapshot: number[] | null = null;
    // RS 連続試行回数。RS_MAX_RETRIES を超えたら反則負け扱い (othelloResign) する
    private rsRetryCount = 0;

    attachBridge(): boolean {
        if (this.bridgeAttached) return true;
        const b = window.__serialTestBridge;
        if (!b || typeof b.onLine !== "function") return false;
        b.onLine(this.lineHandler);
        this.bridgeAttached = true;
        this.startPingLoop();
        this.startStuckLoop();
        return true;
    }

    detachBridge(): void {
        if (!this.bridgeAttached) return;
        const b = window.__serialTestBridge;
        if (b && typeof b.offLine === "function") b.offLine(this.lineHandler);
        this.bridgeAttached = false;
        this.stopPingLoop();
        this.stopStuckLoop();
    }

    // Adapter の受信処理結果を serial テストパネルのログに出す。OK or NG+理由。
    private emitStatus(ok: boolean, detail?: string): void {
        const b = window.__serialTestBridge;
        if (!b || typeof b.emitStatus !== "function") return;
        b.emitStatus(ok ? "OK" : `NG ${detail ?? "unknown"}`);
    }

    // §4.1 / §6.3: 仕様違反受信時に ER<NN>[ <reason>] を返す。
    // code は §6.3 エラーコード表の 2 桁数値 (0-99)。reason はデバッグ用の任意文字列。
    // 未接続ならサイレント。
    private sendErrorResponse(code: number, reason?: string): void {
        const b = window.__serialTestBridge;
        if (!b || !b.isConnected()) return;
        const cc = String(code).padStart(2, "0");
        const payload = reason ? `ER${cc} ${reason}` : `ER${cc}`;
        b.sendLine(payload).catch((e) => console.warn("SerialReversi: ER 送信失敗:", e));
    }

    // 受信 1 行のパース。§4: コマンドは大文字のみ、改行は LF のみ。
    // 仕様違反受信は §4.1 に従い ER で応答する。
    private onLine(raw: string): void {
        // CR 混入チェック (§4 仕様違反) → ER03
        if (raw.includes("\r")) {
            console.warn(`SerialReversi: CR detected in input (§4 violation): ${JSON.stringify(raw)}`);
            this.sendErrorResponse(3, "CR in input");
            this.emitStatus(false, "CR in input (§4)");
            return;
        }
        const line = raw.replace(/\n$/g, "");
        if (line.length === 0) return;
        const head = line.slice(0, 2);
        const rest = line.slice(2);
        // §4 コマンドは大文字のみ → ER02
        if (!/^[A-Z]{2}$/.test(head)) {
            console.warn(`SerialReversi: lowercase or non-alpha command (§4 violation): ${JSON.stringify(head)}`);
            this.sendErrorResponse(2, `lowercase cmd ${head}`);
            this.emitStatus(false, `non-uppercase cmd: ${head}`);
            return;
        }
        // STUCK 検知用: PI/PO 以外の受信は「ゲーム活動」として記録
        if (head !== "PI" && head !== "PO") {
            this.lastGameActivity = Date.now();
        }
        switch (head) {
            case "PO":
                // §10 共通応答。ハートビートの応答。OK は頻度が多いので出さない。
                this.onPongReceived();
                return;
            case "VE":
                console.log(`SerialReversi <CPU: VE ${rest}`);
                this.emitStatus(true);
                return;
            case "MO":
                this.handleMoMessage(rest);
                return;
            case "PA":
                // §11 MY_TURN でのみ意味がある。Nakama 側にパス RPC が無いため警告のみ
                if (this.state !== "MY_TURN") {
                    console.debug("SerialReversi <CPU: PA を MY_TURN 外で受信、破棄");
                    this.emitStatus(false, `PA in state=${this.state}`);
                    return;
                }
                console.warn("SerialReversi <CPU: PA (CPU がパス宣言) - Nakama にパス RPC 未実装、手動操作で対応");
                this.emitStatus(false, "PA: Nakama にパス RPC 未実装");
                return;
            case "EN":
                this.handleEnMessage();
                return;
            case "RE":
                this.handleReMessage();
                this.emitStatus(true);
                return;
            case "ER": {
                // §6.2 #7 / §6.3 ER<NN>[ <reason>] — ログ記録のみ、自動再送はしない。
                // rest の形: "" (ER\n) or "NN" or "NN reason"
                const m = rest.match(/^(\d{2})(?:\s+(.*))?$/);
                if (m) {
                    const code = m[1];
                    const reason = m[2] ?? "";
                    console.log(`SerialReversi <CPU: ER code=${code}${reason ? ` reason="${reason}"` : ""}`);
                } else {
                    console.log(`SerialReversi <CPU: ER (legacy or malformed) ${rest}`);
                }
                this.emitStatus(true);
                return;
            }
            case "ST":
                // §6.2 #8 ST は自由形式テキスト。以前は診断用に "ST BO<64>" 形式で盤面スナップショットも
                // 流していたが、v0.1 で BS (§6.2 #11) に分離。後方互換のため当面は ST BO も受理する。
                if (/^\s*BO[0-2]{64}$/.test(rest)) {
                    console.warn(
                        `SerialReversi <CPU: "ST BO<64>" はレガシー形式 (v0.1 以降は "BS<64>" を使用、§6.2 #11)`,
                    );
                }
                console.log(`SerialReversi <CPU: ST ${rest}`);
                this.emitStatus(true);
                return;
            case "BS":
                // §6.2 #11 BOARD STATUS: CPU が自盤面スナップショットを報告。診断用。
                if (/^[0-2]{64}$/.test(rest)) {
                    console.log(`SerialReversi <CPU: BS ${rest}`);
                    this.emitStatus(true);
                } else {
                    console.warn(`SerialReversi <CPU: BS 不正書式 (§6.2 #11) → ER04`);
                    this.sendErrorResponse(4, `bad BS payload`);
                    this.emitStatus(false, `BS 不正書式: ${rest}`);
                }
                return;
            case "RS":
                this.handleRsMessage();
                return;
            case "NC":
                console.log(`SerialReversi <CPU: NC ${rest}`);
                this.emitStatus(true);
                return;
            default:
                // §4.1: 未知コマンドは仕様違反 → ER01 で応答
                console.warn(`SerialReversi <CPU: 未知コマンド "${line}" (§4.1 violation) → ER01`);
                this.sendErrorResponse(1, `unknown cmd ${head}`);
                this.emitStatus(false, `unknown cmd: ${line}`);
                return;
        }
    }

    // CPU からの MO 着手 → othelloMove RPC
    private handleMoMessage(rest: string): void {
        // §4 / §6.1 / §7: 座標は小文字のみ受理。MOD3 等の大文字は ER04 で拒否
        const m = rest.match(/^([a-h])([1-8])/);
        if (!m) {
            console.warn(`SerialReversi <CPU: MO${rest} 不正座標 (§7 violation) → ER04`);
            this.sendErrorResponse(4, `bad coord ${rest.slice(0, 2)}`);
            this.emitStatus(false, `MO 不正座標: ${rest}`);
            return;
        }
        const colCh = m[1];
        const rowCh = m[2];
        const col = colCh.charCodeAt(0) - "a".charCodeAt(0);
        const row = rowCh.charCodeAt(0) - "1".charCodeAt(0);
        if (this.state !== "MY_TURN") {
            console.debug(`SerialReversi <CPU: MO${colCh}${rowCh} を MY_TURN 外で受信、破棄`);
            this.emitStatus(false, `MO${colCh}${rowCh} in state=${this.state}`);
            return;
        }
        if (this.cpuStalled) {
            console.warn(`SerialReversi <CPU: MO${colCh}${rowCh} 受信するも CPU 停止中フラグ、破棄`);
            this.emitStatus(false, `MO${colCh}${rowCh}: CPU stalled`);
            return;
        }
        if (!this.currentGameId || !this.movePort) {
            console.warn(`SerialReversi <CPU: MO${colCh}${rowCh} 受信するもゲーム未結線、破棄`);
            this.emitStatus(false, `MO${colCh}${rowCh}: no game bound`);
            return;
        }
        console.log(`SerialReversi <CPU: MO${colCh}${rowCh} → othelloMove(row=${row}, col=${col})`);
        const gameId = this.currentGameId;
        const port = this.movePort;
        this.state = "WAIT_OPP";
        this.rsRetryCount = 0; // CPU が正常に MO を返せたら RS カウンタをリセット
        this.emitStatus(true);
        const t0 = performance.now();
        port.othelloMove(gameId, row, col).then(
            (res) => {
                const dt = (performance.now() - t0).toFixed(0);
                console.log(`SerialReversi: othelloMove RES ${dt}ms ok=${!!res} (${colCh}${rowCh})`);
            },
            (e) => {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn(`SerialReversi: othelloMove RPC 失敗 (${colCh}${rowCh}):`, e);
                this.emitStatus(false, `MO${colCh}${rowCh} RPC 拒否: ${msg}`);
            },
        );
    }

    // CPU からの EN → othelloResign RPC
    private handleEnMessage(): void {
        if (!this.currentGameId || !this.movePort) {
            console.warn("SerialReversi <CPU: EN 受信するもゲーム未結線、破棄");
            this.emitStatus(false, "EN: no game bound");
            return;
        }
        console.log(`SerialReversi <CPU: EN (投了) → othelloResign(gameId=${this.currentGameId})`);
        const port = this.movePort;
        const gameId = this.currentGameId;
        // §10 終局時: CPU は EN 送信後ただちに IDLE へ
        this.state = "IDLE";
        this.emitStatus(true);
        const t0 = performance.now();
        port.othelloResign(gameId).then(
            (res) => {
                const dt = (performance.now() - t0).toFixed(0);
                console.log(`SerialReversi: othelloResign RES ${dt}ms ok=${!!res}`);
            },
            (e) => {
                const msg = e instanceof Error ? e.message : String(e);
                console.warn("SerialReversi: othelloResign RPC 失敗:", e);
                this.emitStatus(false, `EN RPC 拒否: ${msg}`);
            },
        );
    }

    // CPU からの RS (REQUEST SYNC §6.2 #10)。盤面乖離検知時の再同期要求。
    // §12.1 に従い、現在のサーバ盤面を BO で送り、直前の指示 (通常 MO?) を再送する。
    // ただし連続 RS_MAX_RETRIES 回まで。超過したら反則負け扱いで投了 RPC を呼ぶ。
    private handleRsMessage(): void {
        console.log("SerialReversi <CPU: RS (REQUEST SYNC)");
        if (!this.lastBoardSnapshot || !this.lastDirectiveSent) {
            console.warn("SerialReversi: RS 受信 — 再同期用スナップショットが無いため無視");
            this.emitStatus(false, "RS: no snapshot");
            return;
        }
        this.rsRetryCount++;
        if (this.rsRetryCount > RS_MAX_RETRIES) {
            console.error(
                `SerialReversi: RS が ${RS_MAX_RETRIES} 回連続で解消せず — CPU を反則負け扱いで投了`,
            );
            this.emitStatus(false, `RS limit(${RS_MAX_RETRIES}) exceeded: CPU 反則負け → 投了`);
            this.rsRetryCount = 0;
            if (this.currentGameId && this.movePort) {
                const gameId = this.currentGameId;
                this.movePort.othelloResign(gameId).then(
                    () => {
                        console.log(`SerialReversi: othelloResign 成功 (gameId=${gameId})`);
                        this.emitStatus(false, `CPU 反則負け: 投了完了 (${gameId})`);
                    },
                    (e) => {
                        const msg = e instanceof Error ? e.message : String(e);
                        console.warn("SerialReversi: othelloResign RPC 失敗:", e);
                        this.emitStatus(false, `CPU 反則負け: 投了 RPC 失敗: ${msg}`);
                    },
                );
            } else {
                this.emitStatus(false, "CPU 反則負け: gameId/movePort 未設定で投了スキップ");
            }
            return;
        }
        console.warn(
            `SerialReversi: RS 受信 (${this.rsRetryCount}/${RS_MAX_RETRIES}) — ` +
            `BO 再同期 + "${this.lastDirectiveSent}" 再送`,
        );
        this.emitStatus(false, `RS (${this.rsRetryCount}/${RS_MAX_RETRIES}): resyncing`);
        // BO は state を変えず (skipRecord で lastDirectiveSent 上書きも避ける)、
        // そのあと直前の MO 指示を再送する
        this.sendDirective("BO" + encodeBO(this.lastBoardSnapshot), { skipRecord: true });
        this.sendDirective(this.lastDirectiveSent, { skipRecord: true });
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
            this.lastBoardSnapshot = null;
            this.rsRetryCount = 0;
        }

        const status = p.status;
        const turn = p.turn;
        const lastMove = typeof p.lastMove === "number" ? p.lastMove : -1;
        const board = p.board ?? [];
        // ER illegal 再同期のため常にサーバ盤面の最新をスナップショットしておく
        if (board.length === 64) this.lastBoardSnapshot = board.slice();

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
                console.log(`SerialReversi BOARD(post-OPP ${colCh}${rowCh}) ${encodeBO(board)}`);
                this.sendDirective(`MO${colCh}${rowCh}`);
            } else {
                console.log(`SerialReversi BOARD(opp-pass) ${encodeBO(board)}`);
                this.sendDirective("PA");
            }
            this.state = "MY_TURN";
        }
        // (3) 対局中: CPU→相手に手番が移ったら状態のみ更新
        else if (this.prevStatus === "playing" && status === "playing"
                 && this.prevTurn !== turn && turn !== cpuColor) {
            console.log(`SerialReversi BOARD(post-MY) ${encodeBO(board)}`);
            this.state = "WAIT_OPP";
        }
        // (3b) サーバー auto-pass: CPU が打った直後なのに turn が CPU のまま戻ってきた
        //      → 相手に合法手がなくサーバが自動でパス処理 (main.go othelloApplyMove)。
        //      CPU には「相手パス」として PA を通知し、もう一度打たせる
        else if (this.prevStatus === "playing" && status === "playing"
                 && this.prevTurn === turn && turn === cpuColor
                 && lastMove !== this.prevLastMove && lastMove >= 0
                 && this.state === "WAIT_OPP") {
            this.sendDirective("PA");
            this.state = "MY_TURN";
        }
        // (2b) サーバー auto-pass (CPU 側): CPU の手番が来る前に相手が追加着手した
        //      → CPU に合法手がなくサーバが CPU を自動パスして相手がもう一手打った。
        //      CPU にはその相手の追加着手だけ MO で通知する (連続発生なら複数回起きる)。
        //      CPU は my_move で合法手無しを検出し PA を返すが、サーバは既に auto-pass 済みで
        //      adapter は WAIT_OPP のため debug 破棄される (影響なし)。
        else if (this.prevStatus === "playing" && status === "playing"
                 && this.prevTurn === turn && turn !== cpuColor
                 && lastMove !== this.prevLastMove && lastMove >= 0
                 && this.state === "WAIT_OPP") {
            const placed = board[lastMove];
            const oppColor = cpuColor === 1 ? 2 : 1;
            if (placed === oppColor) {
                const col = lastMove % 8;
                const row = Math.floor(lastMove / 8);
                const colCh = String.fromCharCode("a".charCodeAt(0) + col);
                const rowCh = String.fromCharCode("1".charCodeAt(0) + row);
                console.log(`SerialReversi BOARD(post-OPP ${colCh}${rowCh}, CPU auto-passed) ${encodeBO(board)}`);
                this.sendDirective(`MO${colCh}${rowCh}`);
            }
            // state は WAIT_OPP のまま (turn が CPU に戻るまで)
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
            // シリアル未接続は通常状態。CPU 対戦モードで毎ターン呼ばれるため debug に留める
            console.debug(`SerialReversiAdapter: シリアル未接続のため "${line}\\n" 送信をスキップ`);
            return;
        }
        if (this.cpuStalled) {
            console.warn(`SerialReversiAdapter: CPU 停止中のため "${line}\\n" 送信をスキップ`);
            return;
        }
        if (!opts?.skipRecord) this.lastDirectiveSent = line;
        // sendDirective は常にゲーム活動 (PI/VE/ER/PO は sendDirective 経由で送らない)
        this.lastGameActivity = Date.now();
        this.attachBridge();
        b.sendLine(line).catch((e) => {
            console.warn(`SerialReversiAdapter: sendLine "${line}" 失敗:`, e);
        });
    }

    private startStuckLoop(): void {
        if (this.stuckTimer !== null) return;
        this.stuckTimer = setInterval(() => this.stuckTick(), STUCK_CHECK_INTERVAL_MS);
    }

    private stopStuckLoop(): void {
        if (this.stuckTimer !== null) {
            clearInterval(this.stuckTimer);
            this.stuckTimer = null;
        }
    }

    // ゲーム活動が N 秒無ければ現在状態を WARN でダンプ (重複ダンプは抑制)
    // MY_TURN (CPU が応答すべき局面) のみ検知。WAIT_OPP は人間相手が長考しうるので対象外。
    // シリアル未接続の観戦タブでは偽陽性が出るのでスキップする
    private stuckTick(): void {
        if (this.state !== "MY_TURN") return;
        const b = window.__serialTestBridge;
        if (!b || !b.isConnected()) return;
        const now = Date.now();
        const idle = now - this.lastGameActivity;
        if (idle < STUCK_THRESHOLD_MS) return;
        if (now - this.lastStuckDump < STUCK_DUMP_INTERVAL_MS) return;
        this.lastStuckDump = now;
        console.warn(
            `SerialReversi [STUCK] state=${this.state} gameId=${this.currentGameId ?? "null"} ` +
            `idle=${(idle / 1000).toFixed(1)}s lastDirective="${this.lastDirectiveSent}" ` +
            `prevStatus=${this.prevStatus} prevTurn=${this.prevTurn} ` +
            `prevLastMove=${this.prevLastMove} cpuStalled=${this.cpuStalled} ` +
            `pingOutstanding=${this.pingOutstanding}`,
        );
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
