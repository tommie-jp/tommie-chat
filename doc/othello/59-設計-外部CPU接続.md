# 59-設計-外部CPU接続（オセロ・リモート対戦）

自作CPU（FPGA等）を tommieChat に接続し、ネット越しに自作CPU同士で
オセロ対戦を行うための設計メモ。

## 背景

- 通常、自作CPUのオセロ対戦は CPU を持ち寄っての対面方式。
- 第7回 自作CPUを語る会 [58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md) もこの形式。
- 自宅にいながら自作CPU同士で対戦できる仕組みを tommieChat 上で提供したい。

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
│   │  └ SerialOthelloAdapter      │         │      SerialOthelloAdapter ┘  │  │
│   │     ↕ othelloMove RPC など   │         │   など othelloMove RPC ↕      │  │
└───┼──────────────────────────────┘         └──────────────────────────────┼──┘
    │                                                                       │
    └─────────── WebSocket / HTTPS ──→  Nakama サーバ ←──────────────────────┘
                                       （既存の対戦オセロ機能を流用）
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

## UART プロトコル仕様（叩き台）

### 物理層

- **デフォルト**: 9600 bps, 8N1, フロー制御なし
- **設定可能**: 300 / 1200 / 9600 / 38400 / 115200 bps
- ボーレートはブラウザ側 UI で選択させる（CPU 側に合わせる）

### 文字コード・改行

- ASCII（人間がデバッグできる）
- 改行は CR / LF / CRLF いずれも受理（CPU 実装の自由度を確保）
- 大文字小文字は区別しない（受信時に大文字化）

### メッセージ書式

#### tommieChat → CPU（CPU への入力）

| 書式 | 意味 |
| ---- | ---- |
| `S B\r\n` | あなたは黒（先攻）。最初の手を指してください |
| `S W\r\n` | あなたは白（後攻）。相手の手を待ってください |
| `M D3\r\n` | 相手が D3 に置いた |
| `M PASS\r\n` | 相手がパス |
| `B ........BW......WB.........\r\n` | 局面全体投入（オプション・接続直後の同期用） |
| `E B\r\n` | 終局・黒勝ち |
| `E W\r\n` | 終局・白勝ち |
| `E D\r\n` | 終局・引分 |

#### CPU → tommieChat（CPU からの応答）

| 書式 | 意味 |
| ---- | ---- |
| `D3\r\n` | D3 に置く |
| `PASS\r\n` | パスする |
| `RESIGN\r\n` | 投了 |
| `READY\r\n` | （任意）起動完了。tommieChat 側からの再送要求として使える |

#### 座標表記

- 列: A〜H（列、左→右）
- 行: 1〜8（行、上→下、黒の初期配置側を上）
- 例: `D3`, `H8`, `A1`

### プロトコル設計の指針

- **1 行 1 メッセージ**。状態を持たないので CPU 側パーサが楽
- **echo back 推奨**（CPU が受信内容を返してもエラーにしない）。デバッグ用
- **再送はしない**。CPU の応答待ちは時間制限まで黙って待つ
- **READY 受信時**は直前の指示を再送する（起動タイミング吸収）
- **不正な応答**（合法手でない・パース失敗）は adapter がユーザーに通知し、
  「再送 / 手動入力 / 強制投了」を選ばせる

## ブラウザ側実装（追加分のみ）

### UI（[src/UIPanel.ts](../../src/UIPanel.ts) のオセロセクションに追加）

- 「外部 CPU を接続」ボタン
  - 押下で `navigator.serial.requestPort()` → ボーレート選択ダイアログ
- 接続状態表示（未接続 / 接続中 / 通信中 / タイムアウト）
- 通信ログパネル（送受信バイト列を時系列表示。**必須・デバッグの命綱**）
- 「手動入力モード」切替（CPU が黙ったとき用）

### 新規モジュール `src/SerialOthelloAdapter.ts`（仮）

責務:

```text
- SerialPort のオープン／クローズ
- 受信ストリームの行バッファリング
- 受信行をパース → 合法手チェック → othelloMove RPC 呼び出し
- OP_OTHELLO_UPDATE 受信時、自分のターンなら相手の最後の手を抽出して
  port.writable へ書き込む
- 接続状態を UIPanel に通知（イベント emit）
- 持ち時間カウント（クロック依存式 max(60-8*log10(clock),0.1) 秒）
  → 表示のみ。タイムアウト時は手動操作に委ねる（公式ルール準拠）
```

### サーバ側変更

**なし**。既存の `othelloMove` / `othelloJoin` / `othelloResign` RPC で十分。
ただし将来的には観戦者向けに「外部 CPU プレイヤー」フラグを表示できると良い。

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
   - → 接続時オプションとして局面全体投入（`B ...` メッセージ）を実装
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
本番では オセロパネル「ゲームロビー」行の「シリアルテスト」リンクからも開ける。

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
| 2 | Web Serial API 接続 + 受信ログ表示 | デバッグ環境の整備 |
| 3 | 自動対戦（受信→RPC、配信→送信） | 本命機能 |
| 4 | 局面全体投入・READY 対応 | CPU 個別事情への対応 |
| 5 | 観戦 UI 改善（外部 CPU マーク表示） | サーバ側追加が必要 |

## 参考

- 大会ルール: [58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md)
- オセロ実装: [56-設計-対戦オセロ.md](56-設計-対戦オセロ.md)
- WSL2 での COM ポート接続: [doc/etc/11-WSL2-Windows-COM接続.md](../etc/11-WSL2-Windows-COM接続.md)
- シリアル疑似デバイス: [doc/62-デバッグ-シリアル疑似デバイス.md](../62-デバッグ-シリアル疑似デバイス.md)
- Web Serial API:
  <https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API>
