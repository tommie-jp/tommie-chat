# Edax 統合検討（Windows 11 テスト環境 / さくら VPS 本番）

2026-04-22

作成者: [tommie.jp](https://tommie.jp)

tommieChat が将来 NBoard Protocol に対応した際の、Linux 版 Edax 統合に関する検討メモ。
テスト用エンジン選定、デプロイ構成、リソース分離の方針をまとめる。

> **注記**: 「オセロ」は株式会社メガハウスの登録商標です。本書では「オセロ」の
> 代わりに一般名詞である「リバーシ」を使用しています（固有名詞・引用は除く）。

## 目次

- [1. 推奨エンジン](#1-推奨エンジン)
- [2. さくら VPS への同居可否](#2-さくら-vps-への同居可否)
- [3. デプロイ構成案](#3-デプロイ構成案)
- [4. アダプター実装の工数感](#4-アダプター実装の工数感)
- [5. Edax との通信方式](#5-edax-との通信方式)
- [6. 参考](#6-参考)

## 1. 推奨エンジン

NBoard Protocol 対応テストに使えるエンジン。

| エンジン | 作者 | 特徴 | 用途 |
| -------- | ---- | ---- | ---- |
| **Edax 4.4** | Richard Delorme | C / GPL / 世界トップクラス強度 / 60 手完全読み | **強度・機能テストの本命** |
| NTest | Chris Welty（NBoard 作者） | NBoard プロトコルのリファレンス実装 | **プロトコル準拠性テスト** |

- Edax: GitHub `abulmo/edax-reversi`。Windows バイナリあり。評価テーブル（約 50MB）を別途配置。Linux ネイティブビルド可 (`make build ARCH=x64-modern`)
- NTest: NBoard 同梱 (`ntestj.jar` / NBoard-2.0 に含まれる)
- NBoard プロトコルのバージョン 2 (`nboard 2`) に準拠。Edax 4.4 対応済み

**使い分け**:

- プロトコル仕様の正解を確認したい → NTest
- 強度・安定性を確認したい → Edax
- tommieChat 本番の「強豪 AI」として運用 → Edax

## 2. さくら VPS への同居可否

### 結論

- **テスト期間**: 同居 OK（コンテナで CPU 制限）
- **本番運用（同接 1000 人想定）**: AI 専用 VPS または厳密なリソース隔離を推奨

### リスク

Edax は `depth 20+` の探索で 1 コアを数秒間フル使用する。現行 tommieChat の構成
（nakama マッチループ 10Hz / Postgres / MinIO / nginx / Prometheus）は既に CPU を
消費しており、Edax の探索スパイクが同居すると:

- マッチループ tick の遅延 → 全プレイヤーの動きがカクつく
- 同接増加時に更に致命的

### 緩和策

テスト同居の場合:

- Docker `--cpus=0.5` または `--cpus=1` で上限設定
- `nice 10` で優先度下げ
- **探索深さを `set depth 10〜15` に固定**（本気モード `depth 20+` は禁止）
- **着手時間制限**: NBoard の `set time` を短めに

## 3. デプロイ構成案

### 案 A: Docker 同居（テスト期）

```text
さくら VPS
├─ nakama (Go)
├─ postgres
├─ minio
├─ nginx
├─ prometheus
└─ edax-nboard (新規、--cpus=1)
```

- nakama から Unix socket or TCP localhost で Edax コンテナに接続
- **NBoard プロトコル ⇔ UART プロトコル変換アダプタ**は nakama Go 側 or 別サイドカーに実装
  （§64 2.1 で検討した「アダプタ分離」路線）
- 評価テーブル（50MB）はイメージに焼き込みまたは volume マウント

### 案 B: AI 専用 VPS 分離（本番期）

```text
さくら VPS #1 (Web/Game)      さくら VPS #2 (AI)
├─ nakama                      ├─ edax-nboard × N 体
├─ postgres                    └─ (将来: 他エンジンも)
├─ minio
├─ nginx
└─ prometheus
                ↑             ↑
                └─ gRPC/TCP ─┘
```

- 強豪アバターを複数体並べても CPU 競合なし
- AI VPS の CPU コア数が AI 体数の上限 = キャパシティプランが明快
- レイテンシはインターネット越しになるが、Edax の思考時間（秒オーダー）に比べれば無視可能

### 推奨進め方

1. **テスト段階**: 案 A。Edax コンテナを tommieChat の docker-compose に追加、`depth 10〜15` で制限
2. **Edax が「普通の強豪アバター」になってきたら**: 案 B へ移行。AI VPS 1 台追加
3. 複数エンジン対応（Edax + NTest + 他）を視野に入れるなら、最初から案 B を想定した抽象化をしておくと移行が楽

## 4. アダプター実装の工数感

**最小プロトタイプ: 2〜3 日 / フル機能版: 1 週間程度**。

- 移動ベース運用（1 手指すたびに `move <mv>` を送る）なら **GGF パーサ不要**。
  `new` / `move <mv>` / `go` / `quit` の 4 コマンドだけで 1 局回せる
- §64 で決めた「アダプタ分離」路線が効くので、tommieChat 本体の内部モデルは触らずに
  NBoard ⇔ 内部モデル変換レイヤだけ足せば良い
- **重いのはロジックではなく運用**:
  - Edax subprocess のライフサイクル管理（起動・クラッシュ復帰・stdin 閉じ時の挙動）
  - 着手タイムアウト・思考時間制限の実装
  - 同時対局数の上限制御（CPU コア数で頭打ち）
  - ログ出力とメトリクス（Prometheus 連携）

**フル機能版の追加スコープ**: `hint <n>`（候補手ランキング表示）、
`status <text>` ストリーム（思考中表示）、`nodestats`（性能メトリクス）、
評価値表示など NBoard の可視化系。

## 5. Edax との通信方式

**Edax 自体は stdin/stdout 専用**。NBoard Protocol の subprocess モデルに準拠。
TCP サーバー機能は持っていないので、Edax を別コンテナに置く場合はブリッジが必要。

### 案 A: 同一コンテナで subprocess（推奨・シンプル）

```text
tommieChat コンテナ
├─ nakama (Go)
│   └─ NBoard アダプター
│         ↕ stdin/stdout (パイプ)
└─ edax プロセス（Go が os/exec.Cmd で起動）
```

- Go 側は `exec.Command("edax", "-nboard")` で起動し `stdin` / `stdout` を掴む
- 通信は単純な行ベース読み書き（NBoard Protocol は 1 行 1 コマンド）
- テスト期はこれで十分

### 案 B: Edax を別コンテナに分ける場合

```text
[tommieChat コンテナ]              [edax コンテナ]
nakama (Go)                        socat TCP-LISTEN
 └─ NBoard アダプター ─ TCP ──→    ↕ stdin/stdout
                                    edax
```

- `socat TCP-LISTEN:4000,fork EXEC:"edax -nboard"` のような薄いラッパーで接続
- 意味があるのは **CPU 隔離を cgroup で厳密にしたい**（本番期、案 B 構成）場合のみ
- テスト期にコンテナ分離する必要はなく、実装複雑度だけ上がる

### 通信の方向

矢印は双方向（リクエスト・レスポンス両方とも同じチャネル）だが、
**能動的に話しかけるのは常にアダプター → Edax**。Edax は完全リアクティブ
（`go` を受けるまで思考を始めない、`quit` で終了）。

## 6. 参考

- [61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) — tommieChat 独自 UART プロトコル
- [63-NBoard-Protocol概要.md](63-NBoard-Protocol概要.md) — NBoard Protocol 仕様
- [64-NBoard互換性検討.md](64-NBoard互換性検討.md) — UART プロトコルと NBoard 互換性検討
- Edax GitHub: <https://github.com/abulmo/edax-reversi>
- NBoard: NBoard-2.0（Windows 向け）
