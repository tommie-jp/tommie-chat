# リバーシ CPU テスター

自作 CPU (FPGA / MCU / ソフトウェア実装) が [61-UART プロトコル仕様](61-UARTプロトコル仕様.md) に
準拠しているかをブラックボックスで検証する pytest ベースの独立ツール。

**tommieChat 本体には依存しない**。COM ポート経由で CPU と直接対話する。

- 実体: [test/reversi/cpu_tester/](../../test/reversi/cpu_tester/)
- 詳細: [test/reversi/cpu_tester/README.md](../../test/reversi/cpu_tester/README.md)

## v0.1 仕様改訂の反映

プロトコル仕様書 [61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) の v0.1 改訂
(§4 / §4.1 / §14.2) でコマンド大文字のみ・LF のみ・仕様違反は ER 応答、と厳格化された。
本ツールもこれに追従しており、次のケースで新規定を検証する:

| ケース | 検証内容 |
| ---- | ---- |
| `cases/protocol/03-case-insensitive-pi.json` | 小文字 `pi` → `ER` 応答 (§4.1) |
| `cases/protocol/04-case-insensitive-ve.json` | 小文字 `ve` → `ER` 応答 (§4.1) |
| `cases/protocol/08-mixed-case.json` | 混在 `Pi` / `pI` → `ER` 応答 (§4.1) |
| `cases/protocol/10-cr-rejected.json` | CR 混入 `PI\r\n` → `ER` 応答 (§4.1) |
| `cases/protocol/11-unknown-command-rejected.json` | 未知コマンド `XX` → `ER` 応答 (§4.1) |

## 関連ツールとの住み分け

| ツール | 対象 | 用途 |
| ---- | ---- | ---- |
| `reversi_cpu.py --replay` (§67) | 参照 CPU (Python) | 参照実装自身の回帰テスト |
| `SerialReversiAdapter.test.ts` (Vitest) | tommieChat の Adapter (TS) | ブラウザ側状態機械の単体テスト |
| **`cpu_tester/` (pytest)** | **任意の CPU (外部)** | **仕様適合ブラックボックステスト** |
| シリアルテストパネル | CPU (対話的) | 手動探索・シナリオ記録 |

## テスト 3 層

| 層 | 内容 | 実装状況 |
| -- | ---- | -------- |
| L1 プロトコル適合 | `VE` / `PI-PO` / §4 違反 (小文字/CR) / 未知コマンド (§6.1/§6.2/§4.1) | ✅ 11 件 |
| L2 合法手判定 | `SB` 後の初手、`BO`、終局 (EB/EW/ED)、`RS` 等 (§7/§9) | ✅ 11 件 |
| L3 フルゲーム対戦 | 内蔵 AI vs CPU で完走 | 🚧 Phase 3 |

§6.1/§6.2 の必須 (✔) コマンドは全てカバー。任意コマンド (BO / RS) も対応。
`pytest --required-only` で必須のみに絞ることも可能。Windows + HHD Free 版ブリッジ
構成でも `flaky(reruns=3)` で散発的な遅延を吸収しつつ通過する実用レベル。

## セットアップの注意点

venv の構造は OS 固有 (Linux: `bin/`, Windows: `Scripts/`)。**実行 OS で venv を作ること。**
同じディレクトリを WSL と Windows から混用するとモジュールロードエラーになる。

両方で使いたい場合は `.venv-win` / `.venv-wsl` のように分ける (`.gitignore` で `.venv-*/` を除外済み)。

### Windows (実 COM ポートを叩くのでこちらが主)

```powershell
cd test\reversi\cpu_tester
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

### WSL / Linux / macOS (`--reference-cpu` で自己ドッグフード用)

```bash
cd test/reversi/cpu_tester
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 実行の選択肢

### A. 参照 CPU 自己ドッグフード (Linux/macOS の pty)

実機・ブリッジ不要、最速:

```bash
.venv/bin/pytest --reference-cpu -v
```

`reversi_cpu.py` をサブプロセスで起動して pty 経由で通信する。CI 向き。

### B. 仮想 COM ブリッジで自己ドッグフード (Windows 本命)

HHD Virtual Serial Port Tools や com0com で COM1↔COM2 をペアにし、
片方で `reversi_cpu.py`、もう片方で cpu_tester を走らせる。**実 UART に近い**。

```powershell
# ターミナル A
cd test\reversi
py reversi_cpu.py --port COM2 --baud 115200

# ターミナル B
cd test\reversi\cpu_tester
.venv\Scripts\pytest --port COM1 -v
```

### C. 実機 CPU をテスト

自作 CPU を USB シリアル経由で接続:

```powershell
.venv\Scripts\pytest --port COM3 --baud 115200 -v
```

## 実行範囲を絞るフラグ

CPU 実装の進捗に合わせてテストを段階的に流すためのオプション。

| フラグ | 効果 | 想定用途 |
| ---- | ---- | ---- |
| (無指定) | 全 22 件実行 | 完成品の総合検証 |
| `--protocol-only` | L1 プロトコル層 11 件のみ。L2 ゲームルール層 11 件は skip | UART 疎通直後、ゲームロジック未実装時の診断 |
| `--required-only` | §6.1/§6.2 で必須 (✔) 付きコマンドのみ。任意コマンド (BO / RS 等) は skip | 大会参加資格チェック |
| `--protocol-only --required-only` | L1 の必須のみ 11 件 | UART 層最小限の疎通確認 |

### 使い分け例

```powershell
# 1. CPU 実装直後 (UART 疎通だけ確認)
pytest --port COM2 --protocol-only -v

# 2. ゲームロジック実装後 (合法手判定まで)
pytest --port COM2 -v

# 3. 大会提出用 (任意コマンドは未実装でも可)
pytest --port COM2 --required-only --html=report.html --self-contained-html
```

### 必須 / 任意 の判定

各 JSON ケースに `"required": true/false` フィールドで指定。v0.1 時点では:

- **任意扱い**: `cases/game_rule/04-bo-midgame.json`, `cases/game_rule/11-cpu-rs-on-mismatch.json`
- **必須扱い**: 上記以外の 20 件すべて

新規ケース追加時は §6.1/§6.2 の必須マーク (✔) に従って設定する。

## テストケース形式

`cases/protocol/*.json` にデータ駆動で記述する。

```json
{
    "name": "VE に VE<NN><名前> を返す",
    "section": "§6.2 #4",
    "timeout_ms": 500,
    "steps": [
        { "tx": "VE" },
        { "rx_regex": "^VE[0-9]{2}.{1,16}$" }
    ]
}
```

ステップ:

- `{ "tx": "<text>" }` — ホスト → CPU に `<text>\n` を送信 (LF 自動付与)
- `{ "tx_raw": "<bytes>" }` — LF 自動付与なしで生バイト送信 (CR 混入テスト等)
- `{ "rx": "<exact>" }` — CPU 応答が `<exact>` と完全一致
- `{ "rx_regex": "<pattern>" }` — CPU 応答が正規表現にマッチ

ゲームルール層 (`cases/game_rule/*.json`) はさらに以下が使える:

- `{ "tx_bo": "<64char>" }` — `BO<64char>` 送信 + 盤面トラッカー同期
- `{ "tx_opp_mo": "<coord>" }` — 相手手 `MO<coord>` を盤面に適用しつつ送信
- `{ "tx_pa": true }` — opp パス通知 `PA` 送信
- `{ "rx_mo_legal": true }` — `MO<coord>` 受信 + 合法手判定
- `{ "rx_pa": true }` — `PA` 応答を期待
- `{ "rx_silent_ms": N }` — N ms 間 (ST/NC 以外の) 応答が無いことを確認

ケース共通フィールド:

- `name`: 人間向けテスト名
- `section`: 仕様書の参照章 (§6.2 #4 など)
- `required`: `true` = §6.1/§6.2 で必須 (✔) のコマンド、`false` = 任意コマンド。
  `--required-only` 時に `false` は skip
- `timeout_ms`: 1 行受信のタイムアウト (ms)

## トラブルシュート早見表

| 症状 | 原因 | 対処 |
| ---- | ---- | ---- |
| `.venv\Scripts\pytest : The module '.venv' could not be loaded` | WSL で作った Linux venv を Windows から叩いている (`bin/` vs `Scripts/`) | `Remove-Item -Recurse -Force .venv` → `py -m venv .venv` で作り直し |
| `could not open port 'COM1': PermissionError` | 他プロセスが COM を掴んでいる | `Stop-Process -Name py` で解放 |
| `no LF received within 0.5s` | CPU 応答遅延 or 未実装 | `timeout_ms` を増やす or CPU 実装確認 |
| `expected 'PO', got 'po'` | CPU が大文字化してない | §6.2 は出力を大文字で規定 |
| `expected /^VE[0-9]{2}.*$/, got 'VE1xxx'` | バージョン 2 桁必須 (`VE01`) | CPU の VE 応答を直す |
| HHD ブリッジが再起動で消えた | HHD Free 版の制限 | GUI から再作成 (有料版で永続) |

## 大会との連携想定

将来 [58-自作 CPU オセロ大会](58-自作CPUオセロ大会ルール.md) 開催時は、
このツールの **全件 PASS を出場条件** にする方向で設計している。

- 参加者は `cpu_tester/ pytest --port COMn` を通すだけで適合性をセルフチェック可能
- 運営は同じ JSON ケースで審査できるので判定基準が透明
- `--html=report.html` で提出用レポートを作れる

## 残タスク (Phase 3 以降)

### 優先度: 高

- [ ] **L3 フルゲーム対戦テスト** (`cases/full_game/`)
  - 内蔵ランダム/first-legal AI vs CPU で 1 局を最後まで走らせる
  - ブラウザ用の `reversi_rules.py` をそのまま流用できる
  - 決定論的にするためシード固定 (`random.seed(42)` 等)
  - 期待: 最大 60 手で EB/EW/ED のいずれかが確実に来る

### 優先度: 中

- [ ] **エッジケース L2 追加**
  - [ ] CPU の `EN` (投了) 受理: `TX EN` を送っても副作用がないこと
  - [ ] CPU からの `EN` 送信: そもそも送る仕様か未確定 (§6.2 #5)
  - [ ] CPU からの `RS` 要求: 意図的に不正盤面を送って RS が返ってくるかの検証
  - [ ] 未知コマンド受信: 黙殺 or `ER` 応答のどちらも許容する柔軟なアサート
- [ ] **HHD Free 版の flaky 対策強化**
  - 現状 `reruns=3` で吸収しているが、連続送信テスト (`pi-po-rapid` 等) が散発的に落ちる
  - 候補: send_line 間の待機時間を可変にする `--inter-tx-ms N` オプション
  - もしくは実機 USB シリアル/com0com で検証する運用に寄せる

### 優先度: 低

- [ ] **CI 統合** (GitHub Actions)
  - `--reference-cpu` モードで Linux runner 上で毎 PR 実行
  - matrix で Python 3.11/3.12/3.13 をカバー
- [ ] **実機 CPU 向け配布形態**
  - `pyinstaller` で Windows 用 `cpu_tester.exe` シングルバイナリ化
  - 大会参加者が Python 環境を整えずに走らせられる
- [ ] **ケース別レポート**
  - HTML レポートで仕様書の §6.1/§6.2 章ごとに集計
  - 落ちたら仕様書の該当章にリンクするように拡張
- [ ] **テスト順序内の速度計測**
  - `--slowest` 相当で遅いテストを特定
  - L1 プロトコル層は 1 秒以内, L2 は 3 秒以内が目標
- [ ] **ケース JSON のスキーマ検証**
  - `jsonschema` で `cases/**/*.json` の構造をテスト (誤字で silent fail を防ぐ)

### Phase 2 で保留した改善

- [ ] conftest の `_FdSerial` (pty モード) を実環境挙動とより近づける
  - 現状でも 17 テスト全通過するが、windows-like な coalescing 挙動を入れたほうが pty/実機の差分を小さくできる
- [ ] `reversi_rules.py` のユニットテスト
  - 現状は reversi_cpu.py の --replay 経由で間接的にカバーされているが、直接の単体テストは無い
  - `test_rules.py` で `legal_moves/apply_move/find_flips` を網羅的に

## 関連

- [61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) — プロトコル本体
- [67-リプレイテスト.md](67-リプレイテスト.md) — 参照 CPU の回帰テスト (別ツール)
- [66-実装計画-SerialReversiAdaptor.md](66-実装計画-SerialReversiAdaptor.md) — Adapter 側設計
- [58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md) — 大会ルール
