# 59-設計-外部CPU接続（リバーシ・リモート対戦）

自作CPU（FPGA等）を tommieChat に接続し、ネット越しに自作CPU同士で
リバーシ対戦を行うための設計メモ。

## 背景

- 通常、自作CPUのリバーシ対戦は CPU を持ち寄っての対面方式。
- 第7回 自作CPUを語る会 [58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md) もこの形式。
- 自宅にいながら自作CPU同士で対戦できる仕組みを tommieChat 上で提供したい。
- さらに **CPU製作者のPCで Web Serial 接続を張りっぱなしにして 24/7 対戦受付**
  できる「**常駐CPUホスト**」モードを提供する。一度接続設定すれば、他クライアントから
  いつでも挑戦可能な状態になる。

## 全体構成

全体構成図: [59-arch-external-cpu.puml](59-arch-external-cpu.puml)

```text
┌──────── プレイヤーA 自宅 ────────┐         ┌──────── プレイヤーB 自宅 ────────┐
│                                  │         │                                  │
│  自作CPU                         │         │                          自作CPU │
│   ↕ UART                         │         │                         UART ↕  │
│  USB-UART変換器                  │         │                  USB-UART変換器 │
│   ↕ USB                          │         │                          USB ↕  │
│  PC                              │         │                              PC │
│   ├ ブラウザ (tommieChat)        │         │        (tommieChat) ブラウザ ┤  │
│   │  └ Web Serial API            │         │            Web Serial API ┘  │  │
│   │     ↕ シリアル               │         │             シリアル ↕        │  │
│   │  └ SerialReversiAdapter      │         │      SerialReversiAdapter ┘  │  │
│   │     ↕ othelloMove RPC など   │         │   など othelloMove RPC ↕      │  │
└───┼──────────────────────────────┘         └──────────────────────────────┼──┘
    │                                                                       │
    └─────────── WebSocket / HTTPS ──→  Nakama サーバ ←──────────────────────┘
                                       （既存の対戦リバーシ機能を流用）
```

ポイント:

- **Nakama サーバ側は変更不要**。既存の `othelloMove` RPC をそのまま使う。
- ブラウザ内の **SerialOthelloAdapter** がシリアル ↔ RPC を仲介する。
- tommieChat から見れば「人間プレイヤー＝CPU 代理」として動作。

## ブリッジ層の方式選定

| 案 | 構成 | 評価 |
| -- | ---- | ---- |
| **A: Web Serial API 直結** | ブラウザ→USB-UART→CPU | ◎採用。Chromium 系のみだが追加配布物ゼロ、HTTPS 要件は既にクリア |
| B: ローカル WS ブリッジ | ブラウザ↔ws://localhost↔小プログラム↔シリアル | mixed-content 対策（自己署名証明書等）が面倒。配布も必要 |
| C: ネイティブ Messaging | Chrome 拡張＋ヘルパー | オーバーキル |

→ **案 A 採用**。Safari/Firefox 利用者は手動入力モードへフォールバック。

### Web Serial API のセキュアコンテキスト要件

Web Serial API は **secure context 必須**。アクセス元 URL によって可否が分かれる。

| URL | 可否 | 備考 |
| --- | ---- | ---- |
| `http://localhost` / `http://127.0.0.1` | ✅ | localhost は仕様上 secure context |
| `http://192.168.1.40` 等 LAN IP | ❌ | secure context にならない |
| `https://192.168.1.40`（自己署名） | ✅ | mkcert 等で証明書を発行＋各 PC に rootCA |
| `https://mmo.tommie.jp` 等 本番 | ✅ | 既存運用でクリア |

→ **HTTPS 必須**（localhost のみ例外）。LAN 越し検証時の選択肢:

1. PC 単体テスト → `http://localhost:5173`（Vite dev）
2. LAN 内別 PC から → mkcert で自己署名 HTTPS / ngrok 等のトンネル /
   本番・ステージング (`mmo-test.tommie.jp`) を直接使う
3. 緊急回避 → `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
   に LAN URL を追加（自分の PC だけ・自己責任）

### Web Serial API のプラットフォーム別対応（2026年4月時点）

| プラットフォーム | ブラウザ | 対応 | 備考 |
| -------------- | -------- | ---- | ---- |
| **macOS** | Chrome / Edge / Opera | ✅ | デスクトップ Chromium 系は問題なく動作 |
| **macOS** | Safari | ❌ | WebKit は Web Serial API 未実装 |
| **Windows** | Chrome / Edge | ✅ | |
| **Linux** | Chrome / Edge | ✅ | |
| **Android** | Chrome | ✅（新規） | **Chrome 148 Beta（2026/4）で対応開始**。安定版普及はこれから |
| **Android** | Edge / Opera | ✅ 見込み | Chromium ベースなので追従見込み |
| **iOS / iPadOS** | 全ブラウザ | ❌ | iOS は全ブラウザが WebKit エンジン強制。**誰も使えない** |

#### モバイル参加の実用面

- **Android**: Chrome 148 安定版が普及すれば「スマホ + USB OTG ケーブル +
  USB-UART 変換器」で CPU 接続可能になる見込み。
  ただし CDC-ACM ドライバ・OTG 相性・電源供給などハードウェア要因で
  失敗しやすい → **実機検証必須**
- **iOS / iPadOS**: Web Serial API は永続的に使えない見込み。
  → **iPhone/iPad ユーザーには「CPU 接続」UI を出さない**。
  「観戦」または「手動代理入力モード」のみ提供する設計にする

## UART プロトコル仕様

UART プロトコル（メッセージ書式・状態遷移・タイムアウト等）は CPU 製作者向けに
独立した仕様書として切り出してある。本書では深入りしない。

- [61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) — メッセージ書式・状態遷移・タイムアウト
- [59-state-external-cpu.puml](59-state-external-cpu.puml) — CPU 側 状態遷移図（例）

tommieChat 側の実装で押さえておくべき要点:

- 送信は LF (`\n`) のみ。受信は CR/LF/CRLF いずれも受理
- `PI` 間隔 3–5 秒、`PO` 待ち 1000ms、3 連続失敗で切断扱い
- 着手タイムアウトは UI で設定可（デフォルト 30 秒）
- CPU が `RE` を能動送信した場合は、直前の指示（`SB`/`MOd?`/`BO...` 等）を再送して局面復元
- CPU が `ER` を返してきた場合はシリアルログに記録するのみ、自動再送しない

## ブラウザ側実装（追加分のみ）

### 配置方針: 7b.リバーシパネル内に統合（別ページは作らない）

シリアル接続 UI も対戦ロジックも **すべて tommieChat 本体の 7b.リバーシパネル内に置く**。
当初は別ページ案（`public/cpu-serial.html` 等）も検討したが以下の理由で却下。

- **SerialPort オブジェクトはタブを跨げない**（Transferable でない）ため、
  別ページ方式だと BroadcastChannel 等でバイト列を中継する必要があり複雑化
- 既存の Nakama 認証・WebSocket 接続をそのまま使える
- 既存の対戦 UI（盤面・アニメ・効果音）をそのまま活用可能
- 1タブ完結 → CPU 製作者のメンタルモデルもシンプル

### UI（[src/UIPanel.ts](../../src/UIPanel.ts) のリバーシセクションに追加）

- 「**🔌 外部 CPU を接続**」ボタン
  - 押下で `navigator.serial.requestPort()` → ボーレート選択ダイアログ
  - 2回目以降は `navigator.serial.getPorts()` で**永続権限を使い自動再接続**
- 接続状態表示（未接続 / 接続中 / 通信中 / タイムアウト）
- 通信ログパネル（送受信バイト列を時系列表示。**必須・デバッグの命綱**）
- 「手動入力モード」切替（CPU が黙ったとき用）
- 「**🤖 CPUホストモード**」切替 トグル
  - OFF: 接続したCPUで1試合だけ対戦（手動）
  - ON : 終局後も自動で次の待機ゲーム作成 → 24/7 運用

### CPUホストモードの動作仕様

```text
[ON にした瞬間]
  ├ 既存の自分の待機中ゲームがなければ rpcReversiCreate で作成
  └ 自動待機ループ開始

[他プレイヤーが参加 → playing 状態]
  ├ 通常の対戦が進行（既存ロジック）
  └ 対局終了時 (finished)、自動的に rpcReversiCreate で次の待機ゲーム作成

[ON の間、以下を継続監視]
  ├ Nakama WebSocket: 切断検知 → 指数バックオフで自動再接続
  ├ Web Serial ポート: 切断検知 → getPorts() で自動再オープン試行
  ├ CPU heartbeat: 30秒おきに無害な "?" 送信、応答なし N 回で「停止中」表示
  └ Babylon.js: engine.stopRenderLoop() または FPS を 5 に絞って省電力化
```

### 新規モジュール `src/SerialReversiAdapter.ts`（仮）

責務:

```text
- SerialPort のオープン／クローズ／永続権限管理 (navigator.serial.getPorts)
- 受信ストリームの行バッファリング
- 受信行をパース → 合法手チェック → othelloMove RPC 呼び出し
  （RPC 名は既存コードに合わせる。識別子リネームは別フェーズ）
- OP_OTHELLO_UPDATE 受信時、自分のターンなら相手の最後の手を抽出して
  port.writable へ書き込む
- 接続状態を UIPanel に通知（イベント emit）
- CPUホストモード用の自動ループ制御（対局終了 → 新規ゲーム作成）
- heartbeat 送信・応答監視
- 持ち時間カウント（クロック依存式 max(60-8*log10(clock),0.1) 秒）
  → 表示のみ。タイムアウト時は手動操作に委ねる（公式ルール準拠）
```

※ 既存 RPC 名（`othelloMove` 等）は内部識別子として温存する可能性あり。リバーシ表記は
日本語テキストのみ対象で、コード識別子の一斉リネームはこのフェーズのスコープ外。

### サーバ側変更

**ほぼ不要**。既存の `othelloMove` / `othelloJoin` / `othelloResign` RPC で十分。

ただし CPUホストモード運用のために以下を検討する価値あり:

- `displayNameCache` に「CPUフラグ」を追加し、ゲーム一覧応答に含める
  → ロビーで `🤖 tommie-CPU` のように識別表示
- 同一 userId が複数の待機中ゲームを持つのを禁止（CPU側の無限増殖防止）
- 「CPU 相手との連戦は同一挑戦者から N 回まで」制限（独占防止）

## 大会との関係

- 公式持ち時間ルール: `T_max = max(60 - 8 * log10(clock), 0.1)` 秒
  → tommieChat 側で **表示のみ**（運営は計測しない方針なので tommieChat も
  超過時の強制処理はしない）
- 不正手検出は tommieChat サーバ側 (Go) で既存実装を流用
- 公式ルールでは入出力フォーマット未定義。本仕様は **tommieChat 独自の規約**
  として定義し、参加者には事前に共有する

## 落とし穴・要検討

### 物理層・CPU 個別事情

1. **超低速 CPU (0.1〜1 Hz) の UART**:
   - UART は通常別クロックで動くが、トランジスタ CPU やレッドストーン CPU では
     UART 自体が実装困難
   - → **手動入力モード併用** を必ず用意する
2. **CPU リセット・初期化タイミング**:
   - 対戦開始時に「リセット → 局面投入」が必要な CPU もある
   - → 接続時オプションとして局面全体投入（`BO...` メッセージ）を実装
3. **ボーレート不一致**:
   - 受信文字化け時は UI で警告。ボーレート再選択を促す

### ソフトウェア・運用

1. **不正手・パース失敗**:
   - adapter で検出 → 「やり直し / 強制パス / 強制投了」を選ばせる
2. **通信タイムアウト**:
   - 持ち時間超過時、UI で「相手の手を手動入力する」「投了させる」を選択可能に
3. **観戦体験**:
   - ネット越し FPGA 対戦を tommieChat の 3D 空間で観戦できる
     ＝**本機能の最大の魅力**
   - LT 発表ではこれを強くアピール
4. **大会当日のシナリオ**:
   - 出張参加者がリモートから tommieChat 経由で参加 → 現地 CPU と対戦
     という使い方も可能

## 検証手順（tommieChat 組み込み前の事前確認）

### 検証用テストページ

[public/test-web-serial-api.html](../../public/test-web-serial-api.html) に Web Serial API の
テストページを用意済み。Vite 経由で配信されるので `/test-web-serial-api.html` でアクセス可能。
本番では リバーシパネル「ゲームロビー」行の「シリアルテスト」リンクからも開ける。

機能:

- API 選択（自動 / Native `navigator.serial` / Polyfill WebUSB）
- ボーレート選択（300 / 1,200 / 9,600 / 38,400 / 115,200 / 230,400 / 460,800 / 921,600）
- 新接続 / 再接続 / 接続を切る
- 受信データの表示（行バッファリング・行番号・タイムスタンプ（なし/時刻/相対時間）・Hex・スクロール・行間）
- 任意文字列の送信（改行は CRLF / LF / CR / なし を選択）
- シリアル出力・コンソールログそれぞれの Copy / Clear、ログローテーション

### Step 1: PC 単体で動作確認（最初に必ずやる）

```bash
npm run dev
# → http://localhost:3000/test-web-serial-api.html を Chrome で開く
# → 新接続 → ポート選択 → デバイスのログが流れれば成功
```

`http://localhost` は secure context 扱いなので **HTTPS 不要**。
ここで動けば Web Serial API 実装が正しいことが確定する。

### Step 2: Android スマホから LAN 越しに試す

`http://192.168.x.x:3000/test-web-serial-api.html` は secure context にならないため、
そのままでは Web Serial API が使えない。以下どちらかで対処。

#### 方法 A: Chrome flag でバイパス（最速・5分）

Android Chrome Beta で:

1. アドレスバーに `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. **Enabled** にして、テキスト欄に `http://192.168.x.x:3000` を追加
3. 「Relaunch」で Chrome 再起動
4. `http://192.168.x.x:3000/test-web-serial-api.html` を開く → 新接続

> 自分のスマホだけに効く設定。テスト後に元に戻すこと。

#### 方法 B: mkcert で HTTPS 化（正攻法・約10分）

```bash
# 1. mkcert インストール（Ubuntu / WSL）
sudo apt install libnss3-tools
curl -JLO "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
chmod +x mkcert-* && sudo mv mkcert-* /usr/local/bin/mkcert
mkcert -install

# 2. 証明書生成（プロジェクトルートで）
mkcert localhost 127.0.0.1 192.168.x.x
# → ./localhost+2.pem と ./localhost+2-key.pem ができる

# 3. .gitignore に追加
echo "*.pem" >> .gitignore
```

[vite.config.ts](../../vite.config.ts) の `server` ブロックに追加:

```ts
import fs from 'node:fs';
// ...
server: {
  // 既存設定はそのまま
  https: {
    cert: fs.readFileSync('./localhost+2.pem'),
    key:  fs.readFileSync('./localhost+2-key.pem'),
  },
  // ...
}
```

→ `npm run dev` → `https://192.168.x.x:3000/test-web-serial-api.html`

スマホ側で **mkcert の rootCA をインストール**する必要あり:

```bash
mkcert -CAROOT  # rootCA.pem の場所が出る
# その rootCA.pem をスマホに転送
# → Android「設定 → セキュリティ → 暗号化と認証情報 → CA 証明書」からインストール
```

#### 方法 C: ステージング (`mmo-test.tommie.jp`) を使う（最も安心）

証明書の手間がゼロ。CSP・nginx 検証も同時にできる運用方針と一致。
ステージングに `test-web-serial-api.html` を含むビルドをデプロイすれば、
スマホは普通に HTTPS でアクセスして検証可能。

### 推奨の進め方

1. **Step 1（PC 単体）で動作確認** ← 必ずこれが先
2. 動いたら **Step 2-A（Chrome flag）** で Android 確認 ← 即できる
3. 本格運用に向けては **Step 2-B（mkcert）** か **2-C（ステージング）**

### 既知の動作実績（2026-04-19 確認）

| 環境 | デバイス | API | 結果 |
| ---- | -------- | --- | ---- |
| Android Chrome 148 Beta | Raspberry Pi Pico 2（CDC-ACM, USB-OTG接続） | Native Web Serial API（`navigator.serial`） | ✅ 動作 |
| Android Chrome 148 Beta | 同上 | WebUSB Polyfill | ❌ Pico の CDC-ACM はポリフィルのドライバ対象外で見えず |

→ tommieChat の構成（Native Web Serial API 直結）が Android 実機で動くことを確認済み。

## 実装フェーズ（提案）

| フェーズ | 内容 | 備考 |
| -------- | ---- | ---- |
| 1 | 手動入力モード（外部 CPU 想定の入力欄を追加） | シリアル接続なしでプロトコル検証 |
| 2 | Web Serial API 接続 + 受信ログ表示（リバーシパネル内） | デバッグ環境の整備 |
| 3 | 自動対戦（受信→RPC、配信→送信） | 本命機能（1試合限り） |
| 4 | 局面全体投入・`RE\n`（READY）対応 | CPU 個別事情への対応 |
| 5 | **CPUホストモード** 実装 | 自動ループ・永続シリアル権限・heartbeat |
| 6 | 24/7運用の堅牢化（Nakama 再接続・3Dシーン省電力・エラー通知） | 常駐稼働の安定性向上 |
| 7 | ロビーで 🤖 CPU マーカー表示（サーバ側追加必要） | 挑戦者向け UX 改善 |

## 24/7 運用でのデスクトップ環境チェックリスト

CPUホストモード運用時に CPU 製作者側で設定が必要なもの:

- **電源プラン**: 「高パフォーマンス」or スリープ無効
- **Chrome のバックグラウンドタブ制限**: 対象外化（`chrome://settings/performance`
  の「メモリセーバー」をオフ、または例外サイトに追加）
- **Windows Update 再起動**: アクティブ時間を 24 時間に設定、または手動更新運用
- **画面ロック**: シリアル I/O は継続するが画面スリープは問題なし
- **USB サスペンド**: Windows の「USB のセレクティブサスペンド」を無効化
  （USB-UART 変換器が休止すると復帰に失敗することがある）

## 参考

- 大会ルール: [58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md)
- リバーシ実装: [56-設計-対戦リバーシ.md](56-設計-対戦リバーシ.md)
- WSL2 での COM ポート接続: [doc/etc/11-WSL2-Windows-COM接続.md](../etc/11-WSL2-Windows-COM接続.md)
- シリアル疑似デバイス: [doc/62-デバッグ-シリアル疑似デバイス.md](../62-デバッグ-シリアル疑似デバイス.md)
- Web Serial API:
  <https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API>
