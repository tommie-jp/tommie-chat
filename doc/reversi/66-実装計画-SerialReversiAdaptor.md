# 66-実装計画-SerialReversiAdaptor

[61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) を満たす形で、ブラウザ側の
[src/SerialReversiAdapter.ts](../../src/SerialReversiAdapter.ts) を段階的に育てる計画。

関連:

- [59-設計-外部CPU接続.md](59-設計-外部CPU接続.md) — 路線の設計正典
- [60-実装計画-シリアル接続.md](60-実装計画-シリアル接続.md) — 上位の実装計画（本書は §Phase 4 の詳細版）
- [61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) — UART 仕様（CPU 製作者向け）

## 現状と完成形のギャップ

### 現状

- [src/SerialReversiAdapter.ts](../../src/SerialReversiAdapter.ts) は最小スタブ。ゲーム開始時に `SB\n` を 1 度だけ送るのみ
- シリアルテストパネル側の `window.__serialTestBridge` は送信専用 (`isConnected()` / `sendLine(text)`) — **受信を Adapter に届ける経路がない**
- プロトコル状態機械なし、`PI/PO`・`MO`・終局通知・`RE` 復帰なし

### 完成形（§6〜§11）

- サーバ→CPU: `SB` / `SW` / `MOd?` / `PA` / `BO...` / `EB` / `EW` / `ED` / `VE` / `PI`
- CPU→サーバ: `MOd?` / `PA` / `PO` / `VE<NN>...` / `EN` / `RE` / `ER` / `ST` / `NC` を解釈
- CPU 側状態（IDLE / MY_TURN / WAIT_OPP）をブラウザ側でミラーし、ゲーム進行と整合させる

## 全体アーキ

```text
[UIPanel.applyState] ──(OthelloUpdatePayload)──▶ [SerialReversiAdapter]
                                                      │
                                                 sendLine ▼        ▲ onLine
                                          ┌─────────────────────────┐
                                          │ window.__serialTestBridge│
                                          └─────────────────────────┘
                                                      ▲ Web Serial ▼
                                                 [自作 CPU (UART)]
```

- Adapter はブリッジ経由で送受信。Web Serial の詳細は知らない
- 送信トリガは `applyState` (Nakama からのゲーム状態更新)
- 受信はブリッジの `onLine(cb)` から 1 行単位で受け取る

## フェーズ分割（マージしやすさ順）

### Phase 1: ブリッジに `onLine` を追加 — 互換性のみの拡張

[public/js/test-web-serial-api.js](../../public/js/test-web-serial-api.js) の
`window.__serialTestBridge` に次を追加する。

```js
window.__serialTestBridge = {
  isConnected() { ... },        // 既存
  async sendLine(text) { ... }, // 既存
  onLine(cb)  { lineListeners.add(cb); },   // ★ 追加
  offLine(cb) { lineListeners.delete(cb); }, // ★ 追加
};
```

受信経路:

- UI 用の `opt-line-buffer` 設定とは独立の **Adapter 用行バッファ**を `processIncoming` 内に持つ
- CR / LF / CRLF いずれも受理（§4 受信側）
- 登録されたリスナに改行を除いた 1 行を逐次渡す
- 文字間タイムアウト 100ms でパーサリセット（§5）は Phase 5 で PING/PONG と一緒に入れる（最初は改行ベースの分割だけ）

ブリッジ初期化のタイミング問題:

- `test-web-serial-api.js` は `type="module"` で [index.html](../../index.html) 下部に記述
  されるため、`main.ts`（→ `SerialReversiAdapter.ts`）より遅れて評価される
- `window.__serialTestBridge` を代入した直後に
  `window.dispatchEvent(new Event('serialtestbridge-ready'))` を発火
- Adapter 側は同イベントを listen して `attachBridge()` する

### Phase 2: Adapter をクラス化、受信パース骨格（ログのみ）

[src/SerialReversiAdapter.ts](../../src/SerialReversiAdapter.ts) を書き直す。

外形 API（既存 UIPanel からの呼び出し `notifyOwnCpuGameStarted(gameId)` / `resetLastNotified()` は
互換シムとして残す）:

```ts
class SerialReversiAdapter {
  attachBridge(): boolean
  detachBridge(): void
  notifyOwnCpuGameStarted(gameId: string): void
  resetLastNotified(): void
  // 以下はフェーズ 3 以降
  // onGameStateUpdate(payload: OthelloUpdatePayload): void
}
```

内部状態:

- `state: "IDLE" | "MY_TURN" | "WAIT_OPP"`（§10 C1–C3 のミラー）
- `currentGameId`, `lastNotifiedGameId`

受信パース（先頭 2 文字を `toUpperCase()`、残りは素のまま）:

| 受信 | Phase 2 の処理 |
| --- | --- |
| `PO` | `console.log` |
| `VE<NN>...` | `console.log`（バージョン表示） |
| `MOxy` | `console.log`（まだ RPC には繋げない） |
| `PA` | `console.log` |
| `EN` | `console.log` |
| `RE` | `console.log`（復帰要求検知のみ、直前指示再送は Phase 6） |
| `ER` | `console.log`（自動再送しない。§6.2 #7） |
| `ST<text>` | `console.log` |
| `NC<nodes>,<ms>` | `console.log` |
| その他 | §8 に従い黙って破棄（トレース用に `console.debug` 程度） |

この段階ではまだ状態遷移・RPC 発行を行わず、「受信経路が通っていること」の確認だけ。
既存の `SB\n` 送信は維持する。

### Phase 3: 送信側 MO/EB/EW/ED を `onGameStateUpdate` に統合

[src/UIPanel.ts:5671](../../src/UIPanel.ts#L5671) 付近の
`notifyOwnCpuGameStarted(data.gameId)` 呼び出しを、
`adapter.onGameStateUpdate(data)` 1 本に置き換え。Adapter 側で判定:

| トリガ | 送信 | 遷移 |
| --- | --- | --- |
| `prevStatus != "playing" && status == "playing" && 自分が黒` | `SB` | IDLE → MY_TURN |
| 同上・白 | `SW` | IDLE → WAIT_OPP |
| 相手の着手を検知（新しい `lastMove` の色が相手） | `MO<col><row>` | WAIT_OPP → MY_TURN |
| 相手のパス | `PA` | WAIT_OPP → MY_TURN |
| `status == "finished"` | `EB` / `EW` / `ED`（`winner` から決定） | → IDLE |

座標変換は §7 に合わせる: `col='a'+col`, `row='1'+row`。

### Phase 4: 受信 MO → `othelloMove` RPC 連携

- `MOxy` を受けたら `col = ch-'a'` / `row = ch-'1'` で `[0,7]` レンジチェック
- `nakama.othelloMove(currentGameId, row, col)` を呼ぶ
- 不正手・範囲外は §14.2 の**案 A（黙って無視）**で統一、ログは残す
- 送信成功で MY_TURN → WAIT_OPP

この段階で CPU と Nakama がループする＝対戦らしく動く最小構成が完成する。

### Phase 5: PI/PO ハートビート + 切断検知

- Adapter 生存中 3 秒ごとに `PI` 送信（§5）
- `pingOutstanding++`、`PO` 受信でクリア
- 3 連続失敗で「CPU 停止中」表示 + 以降の `MO` 送信停止
- 文字間 100ms タイムアウトの行バッファリセット（§5）もこのフェーズで

### Phase 6: BO・RE 復帰

- 接続直後／対局途中参加で `BO<64>` を先に送ってから `SB` / `SW`（§6.1 #5）
- CPU が `RE` を送ってきたら `lastDirectiveSent` を再送（§12）

### Phase 7: VE / EN / PA の仕上げ

- 起動時 `VE` を送って `VE01...` 応答をログ／UI に表示
- `EN` 受信で `othelloResign(gameId)` RPC 呼び出し
- `PA` 受信 → パス API は現状 Nakama 側に無いので「警告 + 手動操作に委ねる」で割り切り

## 本書のスコープ外（当面）

- 手動入力モードとの共存（[60 §4](60-実装計画-シリアル接続.md)）
- CPU ホストモード（24/7 運用）
- ロビー上の 🤖 マーカー（サーバ側拡張要）

## 作業開始順

1. **Phase 1**（ブリッジ拡張）と **Phase 2**（Adapter クラス化＋受信パース骨格）を 1 PR で入れる
2. 動作確認は [public/test-web-serial-api.html](../../public/test-web-serial-api.html) を単独で開くか、
   `7b3.シリアルテストパネル` で疑似 CPU を接続し、適当な行を送信して
   DevTools コンソールに `SerialReversi: <CPU ...` が流れることを見るだけで十分
3. Phase 3 以降は対戦ロジックに踏み込むので、必ず人 vs 人対戦を 1 局通してから着手する
