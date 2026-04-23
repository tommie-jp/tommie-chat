# リバーシ CPU テスター

自作リバーシ CPU (FPGA / MCU / ソフトウェア) が [61-UART プロトコル仕様](../../../doc/reversi/61-UARTプロトコル仕様.md) に
準拠しているかをブラックボックスで検証する pytest ベースのツール。

tommieChat 本体には依存しない独立ツール。COM ポート経由で CPU と直接対話する。

## 対象レベル

| 層 | 内容 | 実装状況 |
| -- | ---- | -------- |
| L1 プロトコル適合 | `VE` / `PI-PO` / §4 違反 (小文字/CR) / 未知コマンド拒否 | ✅ 11 件 |
| L2 合法手判定 | `SB` 後の初手、`BO` 後の応答、終局、`RS` 等 (§7/§9) | ✅ 11 件 |
| L3 フルゲーム対戦 | 内蔵 AI vs CPU で完走 | 🚧 計画中 |

仕様書 §6.1/§6.2 の「必須 (✔)」コマンドは全てカバー。任意コマンド
(BO / RS / EN / ST / NC) も対応しており、`--required-only` で除外可能。

## セットアップ

venv の構造は OS 固有 (Linux は `bin/`、Windows は `Scripts/`)。
**実行する OS で venv を作ること。** 同じディレクトリを WSL と Windows から混用はできない。

### Windows PowerShell (COM ポートを叩くのでこちらが主)

```powershell
cd test\reversi\cpu_tester
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### WSL / Linux / macOS (`--reference-cpu` で自己ドッグフードする場合)

```bash
cd test/reversi/cpu_tester
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### 両方で使いたい場合

`.venv-win` と `.venv-wsl` のように別々にすると安全 (`.gitignore` で `.venv-*/` を除外済み)。

## 実行方法

### 実機 CPU をテスト

```bash
.venv/bin/pytest --port /dev/ttyUSB0       # Linux
.venv/bin/pytest --port COM3               # Windows
```

### 参照実装 (`reversi_cpu.py`) で自己ドッグフード

実機なしで環境確認用。2 つのやり方がある:

#### 方法 A: 内蔵 pty 起動 (Linux / macOS のみ)

`--reference-cpu` を付けると、pytest が `reversi_cpu.py` をサブプロセスで起動し
pty 経由で接続する。CI 向き:

```bash
.venv/bin/pytest --reference-cpu -v
```

#### 方法 B: 仮想 COM ブリッジ (Windows / 全 OS)

仮想シリアルブリッジで 2 つの COM ポートをペアにし、片方で `reversi_cpu.py`、
もう片方で pytest を走らせる。**実際の UART に近い条件**でテストでき、
大会や本番デプロイ前の最終確認にも使える。

ブリッジツール例:

- **[HHD Virtual Serial Port Tools](https://www.hhdsoftware.com/virtual-serial-port-tools)**
  (Windows, Free 版は再起動で消える)
- **[com0com](https://sourceforge.net/projects/com0com/)**
  (Windows, オープンソース、永続)
- **`socat`**
  (Linux/macOS: `socat -d -d pty,link=/tmp/ttyS10 pty,link=/tmp/ttyS11`)

Windows で COM1↔COM2 のペアを作った例:

```powershell
# ターミナル A: 参照 CPU を COM2 で起動
cd test\reversi
py reversi_cpu.py --port COM2 --baud 115200

# ターミナル B: cpu_tester を COM1 から叩く
cd test\reversi\cpu_tester
.venv\Scripts\pytest --port COM1 -v
```

`reversi_cpu.py` 側の自己チェックと、cpu_tester 側の外部テストが同時に走り、
**現場の UART ラウンドトリップそのまま**で双方向検証できる。

### 個別テスト

```bash
# プロトコル層だけ
.venv/bin/pytest test_1_protocol.py --port COM3

# 特定のケース名で絞り込み
.venv/bin/pytest -k "VE" --port COM3

# 失敗時の詳細ログ
.venv/bin/pytest -vv --port COM3

# 必須プロトコル (§6.1/§6.2 の ✔ マーク付きのみ) に限定
# → BO / EN / RS / ST / NC 等の任意コマンドは skip
.venv/bin/pytest --port COM3 --required-only -v
```

### CI 用 (JUnit XML / HTML レポート)

```bash
.venv/bin/pytest --port COM3 --junit-xml=report.xml
.venv/bin/pytest --port COM3 --html=report.html --self-contained-html
```

## テストケース形式

`cases/protocol/*.json` に JSON で記述する。データ駆動なのでコードを書かずに
ケースを追加できる。

```json
{
    "name": "VE に VE<NN><名前> を返す",
    "section": "§6.2 #4",
    "required": true,
    "timeout_ms": 500,
    "steps": [
        { "tx": "VE" },
        { "rx_regex": "^VE[0-9]{2}.{1,16}$" }
    ]
}
```

ステップの種類:

- `{ "tx": "<text>" }` — ホスト → CPU に `<text>\n` を送信 (LF 自動付与)
- `{ "tx_raw": "<bytes>" }` — LF 自動付与なしで任意バイト列送信 (CR 混入テスト等、
  エスケープシーケンス `\r\n` は文字列リテラルとして解釈される)
- `{ "rx": "<exact>" }` — CPU → ホスト が `<exact>` (改行除く) と完全一致すること
- `{ "rx_regex": "<pattern>" }` — CPU → ホスト が正規表現にマッチすること

ケース共通フィールド:

- `name`: 人間向けテスト名
- `section`: 仕様書の参照章 (§6.2 #4 など)
- `required`: `true` = §6.1/§6.2 で必須 (✔) 付きコマンドのテスト、
  `false` = 任意コマンド (BO/EN/RS/ST/NC 等) のテスト。
  `--required-only` で実行時に `false` は skip される
- `timeout_ms`: 1 行受信のタイムアウト (ms)

## トラブルシュート

| 症状 | 原因 | 対処 |
| ---- | ---- | ---- |
| `--port が指定されていません` | 引数忘れ | `--port COM3` を付ける |
| `no LF received within ...` | CPU 応答がタイムアウト | `timeout_ms` 延長、実機の応答確認 |
| `expected /.../, got 'xxx'` | CPU 応答が仕様と不一致 | 仕様書 §6.2 のフォーマット見直し |
| 毎回違うテストが散発的に失敗 / RERUN 後に成功 | HHD Free 版仮想ブリッジの間欠遅延 (数秒の ACK 遅延が観測される) | 無視してよい (自動リトライで吸収)。実機 USB シリアルで再確認 |
| `pi-po-rapid` 等の連続送信テストだけ頻繁に落ちる | 仮想ブリッジのバッファ coalescing | 実機環境で確認。もしくは `cases/protocol/09-pi-po-rapid.json` のステップ数を減らす |

## 仮想ブリッジの既知の制約

HHD Software の **Free 版仮想シリアルポートツール** は以下の挙動が観測されています:

- 連続送信時に受信側への配送が 3-4 秒遅延することがある
- とくに `tx → rx → tx → rx → tx` のパターンで 3 回目以降の送信が遅延
- 再起動で仮想ブリッジが消える (永続化は有料版)

**対処**: テスト runner は `flaky(reruns=3)` でリトライするので大半は成功するが、
`pi-po-rapid` や `sb-five-moves` 等の多段交換テストは散発的に落ちる可能性がある。

**恒久的な解決**:

- **com0com** (無料・オープンソース) を使う (署名済み版推奨)
- 実機 USB シリアル (FT232 / Pico UART 等) で検証する
- 有料版 HHD 仮想ブリッジ (100ドル程度)

## 関連ドキュメント

- [doc/reversi/61-UARTプロトコル仕様.md](../../../doc/reversi/61-UARTプロトコル仕様.md) — 仕様本体
- [doc/reversi/67-リプレイテスト.md](../../../doc/reversi/67-リプレイテスト.md) — 参照 CPU の回帰テスト (本ツールとは別物)
- [doc/reversi/58-自作CPUオセロ大会ルール.md](../../../doc/reversi/58-自作CPUオセロ大会ルール.md) — 大会ルール (本ツールの通過が出場条件になる想定)
