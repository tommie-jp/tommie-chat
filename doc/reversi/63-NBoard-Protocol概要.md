# NBoard Protocol 概要

2026-04-22

作成者: [tommie.jp](https://tommie.jp)

NBoard Protocol の概要と、tommieChat への応用可能性のメモ。
[61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) の設計検討時の比較対象として
調査した内容を記録する。

> **注記**: 「オセロ」は株式会社メガハウスの登録商標です。本書では「オセロ」の
> 代わりに一般名詞である「リバーシ」を使用しています（固有名詞・引用は除く）。

## 目次

- [1. NBoard Protocol とは](#1-nboard-protocol-とは)
- [2. 基本仕様](#2-基本仕様)
- [3. 主なコマンド（ホスト → エンジン）](#3-主なコマンドホスト--エンジン)
- [4. 主な応答（エンジン → ホスト）](#4-主な応答エンジン--ホスト)
- [5. 本書 UART プロトコルとの比較](#5-本書-uart-プロトコルとの比較)
- [6. CPU 対戦への使えるか](#6-cpu-対戦への使えるか)
- [7. tommieChat への具体応用](#7-tommiechat-への具体応用)

## 1. NBoard Protocol とは

任意のリバーシ／オセロエンジン（CPU）と GUI（NBoard など）を接続して対戦させる
ためのテキストプロトコル。**CPU 対戦にそのまま使える**。実際、Edax / Logistello /
Zebra など主要なエンジンはほぼ全て NBoard Protocol を喋れる。

ソフトウェアエンジン同士 or 人間 vs エンジンの接続が本来の用途。物理的な
シリアル接続（UART）は想定外。

## 2. 基本仕様

- **テキストベース**、1 行 1 コマンド、LF 区切り
- トランスポートは **stdin / stdout**（サブプロセス起動してパイプで会話）
- **ホスト（GUI）→ エンジン**: コマンド送信
- **エンジン → ホスト**: 応答・進捗情報

## 3. 主なコマンド（ホスト → エンジン）

| コマンド | 意味 |
| -------- | ---- |
| `nboard <version>` | プロトコルバージョン通告（ハンドシェイク） |
| `set depth <n>` | 探索深さ設定 |
| `set game <ggf>` | GGF (Generic Game Format) 形式で局面設定 |
| `move <mv>` | 人間の着手を通知（例: `move f5`） |
| `hint <n>` | 上位 n 手の候補を返せ |
| `go` | 次の手を計算して送れ |
| `ping <n>` | 生存確認（エンジンは `pong n` を返す） |
| `learn` | 直前の対局を学習 |

## 4. 主な応答（エンジン → ホスト）

| 応答 | 意味 |
| ---- | ---- |
| `pong <n>` | ping の応答 |
| `status <text>` | 探索中の状態（進捗表示用） |
| `nodestats <nodes> <time>` | 探索ノード数と経過時間 |
| `=== <mv>` | 着手決定（例: `=== f5`） |
| `search <mv> <eval> <depth>` | 探索結果の着手評価 |

## 5. 本書 UART プロトコルとの比較

| 項目 | 本書（UART） | NBoard Protocol |
| ---- | ------------ | --------------- |
| トランスポート | UART（物理シリアル） | stdin/stdout（パイプ） |
| 対象 | 自作 CPU ハード（FPGA / MCU / 等） | ソフトウェアエンジン |
| 局面入力 | `BO...` 64 文字 row-major | GGF 形式（テキスト） |
| 着手通知 | `MOf5` | `move f5` / `=== f5` |
| Ping | `PI` / `PO` | `ping n` / `pong n` |
| バージョン問い合わせ | `VE` / `VE<名前>` | `nboard <version>` |
| 思考深度の指定 | なし（CPU 任せ） | `set depth <n>` で指定可 |
| 進捗通知 | なし | `status` / `nodestats` あり |
| 終局通知 | `EB` / `EW` / `ED` | GGF に埋め込む（明示コマンドなし） |

## 6. CPU 対戦への使えるか

用途次第:

- ✅ **ソフトウェア CPU（Edax など既製エンジン）を tommieChat に繋ぎたい**
  → NBoard Protocol で接続するのが最短。エンジンをサブプロセス起動して
  stdin/stdout で会話
- ❌ **自作 FPGA / MCU を UART 経由で繋ぎたい**
  → NBoard Protocol は stdin/stdout 前提で物理シリアルを想定していない。
  [本書 UART プロトコル](61-UARTプロトコル仕様.md)のほうが適している
- 🤔 **両方対応したい**
  → tommieChat サーバー側で「NBoard アダプタ」と「UART アダプタ」の 2 種類を
  用意し、どちらも同じ内部インターフェースに揃える設計がクリーン

## 7. tommieChat への具体応用

もし既製の強い CPU（Edax など）を tommieChat に入れたい場合:

1. Nakama サーバー上で Edax を subprocess 起動
2. NBoard Protocol で `set game <GGF>` → `go` → `=== <mv>` のループ
3. 受け取った着手を通常の対局メッセージとしてクライアントに broadcast

自作 CPU 枠（本書プロトコル）と既製強豪 CPU 枠（NBoard Protocol）を両方持つと、

- 「初心者向け自作 CPU 大会」
- 「強豪 AI による対局解析 / 指導モード」

を同じシステムで提供できる。

## 参考資料

- NBoard 公式: <https://www.orbanova.com/nboard/>（NBoard 同梱ドキュメントに
  プロトコル仕様が含まれる）
- Edax（NBoard Protocol 実装の代表例）: <https://github.com/abulmo/edax-reversi>
- GGF (Generic Game Format) 仕様: WOF 系 DB や Edax のドキュメントを参照
