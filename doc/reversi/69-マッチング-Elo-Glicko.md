# 69-マッチング-Elo-Glicko

2026-04-24

tommieChat のレーティング／マッチング機能の設計メモ。

**主目的**: **自作オセロ CPU の強さを定量評価する** こと。
[58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md) と
[59-設計-外部CPU接続.md](59-設計-外部CPU接続.md) で接続できるようにした
外部 CPU の順位付けと、大会結果の公平な集計が本命用途。

**副次目的**: 人間プレイヤー同士のカジュアル対戦にも**おまけ**として同じ
仕組みを流用する。ただし本書の主眼ではない。人間用レートは「CPU レートを
校正するためのアンカー」としての価値がメインで、SNS 的な自慢要素は
二次的と割り切る。

関連:

- [56-設計-対戦リバーシ.md](56-設計-対戦リバーシ.md)
- [58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md) — **本書の主目的**
- [59-設計-外部CPU接続.md](59-設計-外部CPU接続.md)
- [61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md)
- [65-Edax統合検討.md](65-Edax統合検討.md) — 校正用の強豪 CPU 候補

## 目次

- [1. マッチングアルゴリズムの概観](#1-マッチングアルゴリズムの概観)
- [2. Elo レーティング](#2-elo-レーティング)
- [3. Glicko / Glicko-2](#3-glicko--glicko-2)
- [4. Elo と Glicko の比較表](#4-elo-と-glicko-の比較表)
- [5. tommieChat への実装方針（CPU 評価が主目的）](#5-tommiechat-への実装方針cpu-評価が主目的)
- [6. 参考](#6-参考)

## 1. マッチングアルゴリズムの概観

本書は「対戦者を選ぶ」「勝敗から強さを数値化する」の 2 つを扱う。
tommieChat では **CPU の強さを定量化することが主目的** で、マッチングは
その測定を効率化する手段として位置付ける。

| 要素 | 役割 | tommieChat での主用途 |
| ---- | ---- | ---- |
| **レーティング** | 強さを数値で推定 | 自作 CPU の順位付け、大会結果の集計 |
| **マッチメイキング** | 当てるべき相手を選ぶ | CPU 間の対戦スケジューリング、校正用の人間対局割当 |

### 1.1 CPU 評価が主目的であることの含意

- 対象数が**少ない**（CPU は数十〜数百、人間の数万規模と桁違い）
- 対象の強さが**ほぼ不変**（CPU のバージョン更新までは定常）
- 対戦数を**意図的に積める**（サーバ側でスケジュールして 24/7 回せる）
- **再現性がある**（同じシード・同じ盤面なら同じ結果。校正に使える）

これらの特性は Elo より **Glicko-2 / WHR に追い風**。少サンプルで信頼区間
（RD）を扱える方式が設計にフィットする。

### 1.2 人間プレイヤーの位置付け

- カジュアル対戦は楽しみとして提供する
- 人間同士のレートは **CPU レートを絶対値で校正するアンカー**として価値あり
  （人間のトッププレイヤー = WOF 公式レートが外部参照として使える）
- ただし UI の派手な演出（ランク表示、リーダーボード誇示、勝率マウント）は
  本サービスの方向性（アバターチャット SNS）と合わないので抑制する

### 1.3 主要なレーティングアルゴリズム

| 方式 | 発案者 | 採用例 |
| ---- | ---- | ---- |
| **Elo** | Arpad Elo (1960s) | FIDE（チェス）、USCF、リバーシ WOF、サッカーFIFA 等 |
| **Glicko** | Mark Glickman (1995) | FICS、一部のオンラインゲーム |
| **Glicko-2** | Mark Glickman (2001) | Lichess（チェス）、各種 Web 対戦サービス |
| **TrueSkill / TrueSkill2** | Microsoft Research | Xbox Live、Halo 等（チーム戦向け） |
| **WHR (Whole-History Rating)** | Rémi Coulom (2008) | 囲碁 KGS、強豪エンジンのベンチ |

リバーシのような **1v1・確率的要素なし・引分あり** のゲームでは Elo か
Glicko 系を使うのが一般的。以下、その 2 本を詳しく見る。

## 2. Elo レーティング

### 2.1 基本式

プレイヤー A（レーティング `Ra`）とプレイヤー B（`Rb`）の対局で、A が勝つ
確率の**期待値** `Ea` は次のロジスティック関数で与える。

```text
Ea = 1 / (1 + 10^((Rb - Ra) / 400))
Eb = 1 - Ea
```

対局結果 `Sa`（勝 = 1.0、引分 = 0.5、負 = 0.0）を使い、レーティングを更新する。

```text
Ra' = Ra + K * (Sa - Ea)
Rb' = Rb + K * (Sb - Eb)
```

- **K 係数**: 1 局での変動幅。トップ層ほど小さく、初心者ほど大きく設定する
  のが通例（FIDE では 10〜40、オンライン対戦では 16〜32 をよく使う）
- **400** という定数: 「レート差 400 ⇒ 期待勝率 10 倍差（≈91%）」となるよう
  歴史的に決まった値

### 2.2 特徴

- 計算が極端に単純。片手で実装できる
- 局後に即座に反映できる（バッチ計算不要）
- **ゼロサム**: A が得た分だけ B が失う → インフレ/デフレが理論上発生しない
- 引分も `Sa = 0.5` で自然に扱える（リバーシの引分は普通の出来事）

### 2.3 弱点

- **不確実性を表現できない**: 新規ユーザーと 1000 局打ったベテランが同じ
  「1500」だったとき、両者の信頼度は全然違うのに区別できない
- **ブランク期間に弱い**: 半年休んだ人が戻ってきても、レートは休む前のまま。
  実力が落ちている可能性を表現する仕組みがない
- **K 係数の設計が職人芸**: 新規ユーザー用の K を大きく、ベテラン用を小さく、
  の切り替えをどこでやるかが設計者次第

これらの弱点を埋めるために作られたのが Glicko 系。

### 2.4 FIDE での K 値実例（参考）

| 対象 | K |
| ---- | -- |
| レート 2400 未満のベテラン | 20 |
| レート 2400 以上 | 10 |
| 30 局未満の新規 | 40 |

## 3. Glicko / Glicko-2

### 3.1 Glicko（1995）

Elo を **ベイズ推定** として再定式化したもの。プレイヤーの強さを
「点」ではなく「正規分布」として扱う。

内部状態:

- `r`: レーティング（平均）
- `RD` (Rating Deviation): 不確実性（標準偏差）。小さいほど信頼度が高い

更新式のキモは次の 2 点。

1. **経過時間で RD を増やす**: 最後に対局してから時間が経つほど、プレイヤーの
   真の実力の不確実性が増えていくはず、という直感を数式化
2. **RD が大きい相手との対局はレートの動きが鈍る**: 相手がフラフラなら
   勝敗から得られる情報量が少ない、とベイズ的に扱う

`r` の更新量は Elo に似た形だが、K に相当する係数が **自分と相手の RD から
動的に決まる**。

### 3.2 Glicko-2（2001）

Glicko の後継。`r` と `RD` に加えて **ボラティリティ `σ`** を導入して
「ある時期は調子が乱れやすい/安定している」という時間的な変動傾向を明示的に
扱う。

推奨初期値（Glickman の論文より）:

```text
r    = 1500
RD   = 350
σ    = 0.06
τ    = 0.3〜1.2 (システム定数、低いほどボラティリティが滑らか)
```

**計算単位**: 対局ごとではなく「**rating period**」と呼ぶ一定区間（例: 1 日、
1 週間）の対局をまとめて処理するのが本来の設計。period 内で 10〜15 局程度の
対局数が目安（論文中の推奨）。期間中に対局が無かったプレイヤーは `RD` が
広がるだけ、`r` と `σ` は変わらない。

ただし実運用上は period = 1 局（即時更新）で回している実装（Lichess 含む）も
多く、大きな問題は出ていないとされる。

### 3.3 Glicko-2 更新アルゴリズム概略

1. `r`, `RD`, `σ` を内部単位 `μ`, `φ`, `σ` へ変換（`μ = (r-1500)/173.7178`、
   `φ = RD/173.7178`）
2. 期間中の全対局から `v` (variance) と `Δ` (improvement) を算出
3. 反復法（Illinois algorithm 等）で新しい σ' を求める
4. 新しい φ' と μ' を計算し、外部単位の r', RD', σ' に戻す

実装行数は Elo の 10〜20 倍だが、既製ライブラリ（後述）を使えば自前で
書く必要はない。

### 3.4 特徴

- **「まだ信頼できないプレイヤー」を自然に表現**できる（= 高 RD 状態）
- 休眠プレイヤーの RD が時間で広がり、復帰後は変動が大きくなる（実力変化を
  素早く拾える）
- ボラティリティで「調子が乱れたとき」の追従性が Elo より良い
- マッチング側で RD を見て「不確実なプレイヤー同士を当てる」等の派生戦略が
  取れる（RD が高い = 情報量が少ない = 対局させてレートを確定させるべき）

### 3.5 弱点

- 計算が複雑。初学者が手で実装するとバグりやすい
- Rating period の設計判断が増える（即時 vs バッチ）
- プレイヤーから見て「なぜ今回これだけ動いた？」が直感的に説明しづらい

## 4. Elo と Glicko の比較表

| 観点 | Elo | Glicko / Glicko-2 |
| ---- | ---- | ---- |
| 内部状態 | `r` のみ | `r`, `RD` (, `σ`) |
| 不確実性表現 | なし（K 係数で間接的に） | あり（RD） |
| 時間経過 | 反映されない | RD が広がる |
| 計算コスト | 極小 | 中（反復計算あり） |
| 即時更新 | 自然 | 本来はバッチ、即時運用も可 |
| 実装コスト | 1 時間 | ライブラリ推奨 |
| 引分の扱い | Sa=0.5 で自然 | 同上 |
| マッチング側で使える情報 | r のみ | r + RD でウィンドウ設計可 |
| 採用例（リバーシ/オセロ） | WOF 公式 | オンライン対戦各所 |

## 5. tommieChat への実装方針（CPU 評価が主目的）

### 5.1 方針（結論）

**具体像**: 10 体前後の CPU リーグ + 下端アンカー 1 体で、毎日 1 回の総当たりを
自動実行する。Glicko-2 で **日次バッチ更新**。人間対戦は同じ仕組みを流用
するおまけ。

主目的が CPU 評価なので、**最初から Glicko-2 を採用** する。Elo に寄り道しない。
理由:

- 評価対象数が少ない（10 体前後を想定）
- 毎日 20 対局/CPU を積める → Glickman 論文推奨の「1 period 10〜15 局」を
  自然に満たす
- 新規登録された CPU は RD が大きい状態から始まり、対局を重ねて素早く
  正しい位置へ落とし込める
- 人間対戦はおまけとして同じ仕組みを流用するだけ

フェーズ計画:

| Phase | 目的 | 内容 | 実装規模 |
| ---- | ---- | ---- | ---- |
| **A. CPU リーグ基盤** | 日次総当たりによる CPU 評価 | Google 認証 + CPU 登録 + 日次総当たりランナー + Glicko-2 日次バッチ + 下端アンカー (合法手プログラム) | 5〜7 人日 |
| **B. 大会モード** | イベント開催 | 総当たり / スイスドロー、順位表出力、追加アンカー (Edax 等) | 2〜3 人日 |
| **C. 人間カジュアル流用** | おまけ機能 | 同じ rating テーブルに人間レコードを載せ、ロビー対戦で更新 | 1 人日 |

Phase A/B を本丸、C は時間が余ったらで可。

### 5.2 実装範囲の切り分け

| レイヤ | 追加/変更 |
| ---- | ---- |
| DB (PostgreSQL) | `reversi_rating` コレクション（CPU/人間を同居）、`reversi_cpu_meta` コレクション（CPU 個体情報）、`reversi_match_log` コレクション（対局履歴） |
| サーバ (Go, [nakama/go_src/main.go](../../nakama/go_src/main.go)) | RPC `reversiRatingGet` / `reversiLeaderboard` / `reversiRegisterCpu` / `reversiQueueCpuMatch`、内部関数 `updateRatingGlicko2()`、対局終了フック、**CPU 対戦ランナー** (goroutine) |
| クライアント ([src/NakamaService.ts](../../src/NakamaService.ts)) | RPC ラッパ群 + CPU 登録 UI との結線 |
| UI ([src/UIPanel.ts](../../src/UIPanel.ts)) | CPU 一覧 / レーティング表、新規 CPU 登録フォーム、大会モード UI。人間プレイヤー向けは対局結果トーストに ΔR 表示のみ |
| 対局終了 | 既存 `othelloApplyMove` で `status="finished"` に遷移するタイミングで `updateRatingGlicko2()` を呼ぶ。**CPU vs CPU / CPU vs 人間 / 人間 vs 人間のすべてで同じ経路** |

### 5.3 DB スキーマ（Nakama storage）

Nakama は PostgreSQL の `storage` テーブルに key-value で保存する慣習
（[doc/04-DB-スキーマ.md](../04-DB-スキーマ.md) 参照）。

#### `reversi_rating`（CPU / 人間で共通）

キー = エンティティ ID（CPU なら `cpu:<cpu_id>`、人間なら Nakama UID）。

```json
{
  "kind": "cpu",
  "r": 1500.0,
  "rd": 350.0,
  "sigma": 0.06,
  "wins": 0,
  "losses": 0,
  "draws": 0,
  "last_played_at": 0,
  "anchor": false
}
```

- `kind`: `"cpu"` または `"player"`
- `anchor`: true のとき **校正アンカー**（Edax 等、外部で絶対レートが既知）。
  対局してもレート値は更新せず、相手の更新にのみ寄与する
- 初期値: 新規 CPU / 人間とも `r=1500, rd=350, sigma=0.06`

#### `reversi_cpu_meta`（CPU 個体情報）

キー = `<cpu_id>`。

```json
{
  "cpu_id": "tommie-cpu-v1",
  "owner_uid": "user-uid-xxx",
  "display_name": "とみーちゃん",
  "age_years": 15,
  "connection": "serial",
  "version": "1.0.3",
  "registered_at": 1714000000,
  "engine_hint": "minimax depth=6",
  "active": true
}
```

- `display_name`: owner 申告の名前（§5.12 年齢表示）
- `age_years`: サーバ算出。日次バッチ後に `computeAge(r)` で更新
- `connection`: `"serial"` / `"websocket"` / `"internal"`（Edax 等内蔵型）
- `version` が変わったら「別個体」として扱うかは登録者の選択
  （§5.6 CPU バージョン変更の扱い）

#### `reversi_match_log`（対局履歴・軽量）

キー = `<match_id>` (ULID)。対局後にサーバが書き込む不可変ログ。

```json
{
  "match_id": "01HXXX...",
  "black": "cpu:tommie-cpu-v1",
  "white": "cpu:tommie-cpu-v2",
  "winner": 1,
  "moves": "f5d6c3d3c4...",
  "played_at": 1714001234,
  "rating_before": { "black": {"r":1500,"rd":350}, "white": {"r":1500,"rd":350} },
  "rating_after":  { "black": {"r":1508,"rd":332}, "white": {"r":1492,"rd":332} },
  "event": "ladder"
}
```

- `moves`: `61 §6.1 MO` 形式の連結（`f5d6...`）
- `event`: `"ladder"` / `"tournament:<id>"` / `"casual"`
- 大会結果の再現・レート算定監査に使う

### 5.4 オプション: Elo の単純実装（参考）

本方針では採用しないが、小規模実験や他サービスとの比較のために Elo 計算を
ドロップインで入れたい場合の最小実装を参考として残す（未読飛ばしてよい）。

#### 5.4.1 計算（Go 側）

```go
// nakama/go_src/rating_elo.go（新規想定）
package main

import "math"

const (
    eloDefaultK      = 32  // 50 局未満
    eloVeteranK      = 16  // 50 局以上
    eloDefaultRating = 1500
)

type EloResult struct {
    NewRatingA float64
    NewRatingB float64
    DeltaA     float64
    DeltaB     float64
}

// scoreA: A から見た結果 (1.0 勝 / 0.5 引分 / 0.0 負)
func calcElo(ra, rb float64, scoreA float64, kA, kB int) EloResult {
    ea := 1.0 / (1.0 + math.Pow(10, (rb-ra)/400.0))
    eb := 1.0 - ea
    dA := float64(kA) * (scoreA - ea)
    dB := float64(kB) * ((1.0 - scoreA) - eb)
    return EloResult{
        NewRatingA: ra + dA, NewRatingB: rb + dB,
        DeltaA: dA, DeltaB: dB,
    }
}

func pickK(totalGames int) int {
    if totalGames < 50 {
        return eloDefaultK
    }
    return eloVeteranK
}
```

#### 5.4.2 対局終了フック

[nakama/go_src/main.go](../../nakama/go_src/main.go) の `othelloApplyMove`
（`status` が `"finished"` に遷移する場所）から次を呼ぶ。

```go
// 既存の終局処理の直後に追加
if newStatus == "finished" {
    if err := applyRatingUpdate(ctx, nk, blackUID, whiteUID, winner); err != nil {
        logger.Warn("rating update failed: %v", err)
        // レーティング更新失敗でも対局結果そのものは成立させる
    }
}
```

```go
func applyRatingUpdate(ctx context.Context, nk runtime.NakamaModule,
    blackUID, whiteUID string, winner int) error {
    // CPU 戦はスキップ (§5.6)
    if isCpuUID(blackUID) || isCpuUID(whiteUID) {
        return nil
    }
    a, err := loadRating(ctx, nk, blackUID)
    if err != nil { return err }
    b, err := loadRating(ctx, nk, whiteUID)
    if err != nil { return err }
    var scoreA float64
    switch winner {
    case 1: scoreA = 1.0  // 黒勝ち
    case 2: scoreA = 0.0  // 白勝ち
    case 3: scoreA = 0.5  // 引分
    default: return nil
    }
    kA := pickK(a.Wins + a.Losses + a.Draws)
    kB := pickK(b.Wins + b.Losses + b.Draws)
    res := calcElo(a.R, b.R, scoreA, kA, kB)
    a.R = res.NewRatingA
    b.R = res.NewRatingB
    // 戦績更新
    updateCounts(&a, scoreA)
    updateCounts(&b, 1.0-scoreA)
    a.LastPlayedAt = time.Now().Unix()
    b.LastPlayedAt = time.Now().Unix()
    if err := saveRating(ctx, nk, blackUID, a); err != nil { return err }
    if err := saveRating(ctx, nk, whiteUID, b); err != nil { return err }
    return nil
}
```

`loadRating` / `saveRating` は `nk.StorageRead` / `nk.StorageWrite` で
`reversi_rating` コレクションを読み書きするだけ（Nakama の一般的な流儀、
既存の `w<id>_chunk_X_Z` と同じ作り）。

#### 5.4.3 クライアント

[src/NakamaService.ts](../../src/NakamaService.ts) にラッパを追加。

```ts
export interface ReversiRating {
    r: number;
    rd: number;
    sigma: number;
    wins: number;
    losses: number;
    draws: number;
    lastPlayedAt: number;
}

async reversiRatingGet(uid: string): Promise<ReversiRating | null> {
    const res = await this.socket?.rpc("reversiRatingGet", JSON.stringify({ uid }));
    return res?.payload ? JSON.parse(res.payload) as ReversiRating : null;
}
```

UI 側は既存の対局結果ダイアログ / プレイヤーパネルにレートと ΔR を
差し込むだけで可視化できる。

### 5.5 Phase A 本体: Glicko-2 の実装

#### 5.5.1 ライブラリ選定

自前実装は反復解法（Illinois / Brent / Ridder）が絡んでバグりやすいので、
既製ライブラリを使うのが定石。2026-04 現在の主要候補は次の 3 つ。

##### Go（Nakama サーバ側）

| 候補 | API の作り | メンテ状況 | License | 採否 |
| ---- | ---- | ---- | ---- | ---- |
| `github.com/jlouis/glicko2` | 関数 1 本 `Rank()` | 現役 | MIT | **採用候補 1** |
| `github.com/artasparks/goglicko` | 小さな型 + `CalculateRating` | 低メンテ | MIT | 採用候補 2 |
| `github.com/zelenin/go-glicko2` | Player / RatingPeriod / Match | **2025-03 Archived** | MIT | ✗ 非推奨（メンテ停止） |
| `github.com/gregandcin/go-glicko2` | zelenin のフォーク | 不活発 | MIT | ✗ |

**採用方針**: `jlouis/glicko2` を第一候補とする。理由:

- 現役メンテ、Go modules 対応済み
- API が関数 1 本（`Rank` と `Skip` のみ）で、Nakama の RPC ハンドラから
  薄く呼ぶ用途に合う
- 数値解法に **Ridder 法** を採用。論文原典の Newton-Raphson より反復回数が
  安定して少なく、`tau` を小さく取っても無限ループしにくい（実装者メモより）
- 依存ゼロ（標準ライブラリのみ）。Nakama プラグインの `.so` サイズに効く

##### TypeScript（クライアント側で試算したい場合のみ）

| 候補 | 特徴 | License |
| ---- | ---- | ---- |
| `glicko2.ts` (animafps) | TypeScript 書き。races/teams 拡張あり | MIT |
| `glicko2-lite` (KenanY) | 最小実装、依存ゼロ | MIT |
| `glicko2` (mmai) | 古参、JavaScript | MIT |

tommieChat のアーキでは**レート計算はサーバ一元**（改ざん防止）なので、
クライアントで計算する必要はない。`reversiRatingGet` RPC で数値を受け取って
表示するだけで足りるため、通常 npm 側は不要。デバッグや試算ツールを作る
場合のみ `glicko2-lite` 程度を引く。

#### 5.5.2 Rating period の設計

本方針（10 CPU・日次総当たり）では **日次バッチ更新** が原典に沿う最良の選択。
Glickman 論文 (2012) の推奨「1 period あたり 10〜15 局」と、日次総当たりの
「1 CPU あたり 20 対局/日」がほぼ一致する。

| 方式 | 長所 | 短所 | 本方針での採否 |
| ---- | ---- | ---- | ---- |
| **日次バッチ**（1 日 = 1 period） | 論文原典通り、σ が実力変動を素直に拾う、10 CPU 規模に最適 | UI にすぐ反映されない | **採用** |
| 即時更新（1 局 = 1 period） | UX が良い、実装簡単 | σ の精度が落ちる | 不採用（CPU 対局は即時フィードバックが重要ではない） |
| 時間単位バッチ | 中間案 | CPU リーグでは必要ない | 不採用 |

日次バッチ運用の流れ:

1. 日次ランナーが 1 日分の全対局を `reversi_match_log` に蓄積
2. 全対局完了後、CPU ごとに当日の対局を全部集めて `Rank()` を 1 回呼ぶ
3. `r`, `rd`, `σ` を `reversi_rating` に書き戻す
4. 更新後のレートで leaderboard を生成

**人間カジュアル対戦（Phase C）は即時更新** に戻す。人間側は対局頻度が
まばらで日次バッチだとほぼ休眠扱いになるため。`kind="cpu"` と
`kind="player"` で分岐する。

#### 5.5.3 実装差分（jlouis/glicko2 使用）

jlouis/glicko2 の API は次の 2 本のみ。

```go
// 対局あり
Rank(r, rd, sigma float64, opponents []Opponent, tau float64) (nr, nrd, nsigma float64)
// 期間中に対局無し（RD だけ広げる）
Skip(r, rd, sigma float64) (nrd float64)

// Opponent は interface
type Opponent interface {
    R()     float64  // 相手のレート
    RD()    float64  // 相手の RD
    Sigma() float64  // 相手のボラティリティ
    SJ()    float64  // この対局の結果: 1.0 勝 / 0.5 引分 / 0.0 負
}
```

日次総当たり終了時に呼ぶバッチ実装：

```go
// nakama/go_src/rating_glicko2.go（新規想定）
package main

import "github.com/jlouis/glicko2"

const glickoTau = 0.5 // システム定数 (0.3〜1.2、低いほど滑らか)

type gOpponent struct {
    r, rd, sigma, sj float64
}

func (o gOpponent) R() float64     { return o.r }
func (o gOpponent) RD() float64    { return o.rd }
func (o gOpponent) Sigma() float64 { return o.sigma }
func (o gOpponent) SJ() float64    { return o.sj }

// 1 CPU 分の当日対局結果をまとめて Rank() を 1 回呼ぶバッチ関数。
// matches: 当 CPU から見た相手と結果の配列。
type DailyMatch struct {
    OppR, OppRD, OppSigma float64
    Score                 float64 // 1.0 / 0.5 / 0.0
}

func updateDaily(r *Rating, matches []DailyMatch) {
    if len(matches) == 0 {
        // 対局なし: Skip で RD だけ広げる
        r.RD = glicko2.Skip(r.R, r.RD, r.Sigma)
        if r.RD > 350.0 {
            r.RD = 350.0
        }
        return
    }
    opps := make([]glicko2.Opponent, len(matches))
    for i, m := range matches {
        opps[i] = gOpponent{m.OppR, m.OppRD, m.OppSigma, m.Score}
    }
    nr, nrd, nsig := glicko2.Rank(r.R, r.RD, r.Sigma, opps, glickoTau)
    r.R, r.RD, r.Sigma = nr, nrd, nsig
}

// 日次総当たり完了後に全 CPU を一括更新する。重要: 全 Rank() 呼び出しは
// **当日開始時点のレート** を使う。Rank → 書き戻しを 1 体ずつ逐次でやると
// 後続 CPU が更新後の値を参照して歪む。2-pass で実装する。
func runDailyBatch(allRatings map[string]*Rating, dailyMatches map[string][]DailyMatch) {
    snapshot := make(map[string]Rating, len(allRatings))
    for id, r := range allRatings {
        snapshot[id] = *r  // 当日開始値を固定
    }
    for id, matches := range dailyMatches {
        r := allRatings[id]
        if r == nil { continue }
        if isAnchor(id) { continue }  // anchor はレート更新しない
        // 相手側は必ず snapshot を使う
        fixed := make([]DailyMatch, len(matches))
        for i, m := range matches {
            oppSnap := snapshot[m.OppID]  // DailyMatch に OppID も足す前提
            fixed[i] = DailyMatch{
                OppR: oppSnap.R, OppRD: oppSnap.RD, OppSigma: oppSnap.Sigma,
                Score: m.Score,
            }
        }
        updateDaily(r, fixed)
    }
}
```

**重要なポイント**:

- 日次バッチの `runDailyBatch` は **当日開始時のスナップショット** を使う。
  これは Glicko-2 の period セマンティクス（period 内の全対局は同じ初期状態
  から計算）の厳密な実装
- 参加しなかった CPU（NO-SHOW）は `Skip` を 1 回呼んで RD だけ広げる
- anchor は `updateDaily` をスキップ（`anchor=true` フラグで分岐）
- `tau` は Glickman 論文の推奨 0.5 を採用。日次バッチで σ が暴れるようなら
  0.3 まで下げる
- Phase C（人間カジュアル対戦）では即時更新の小さな関数を別途用意する
  （1 対局 = 1 match の `Rank()` を即呼ぶ。日次バッチとは別経路）

### 5.6 CPU 評価に特化した注意点

- **下端アンカー: 「ひよこ」（合法手プログラム）**: Glicko-2 は相対値しか
  決まらないのでアンカーが必要。本方針では **「合法手の先頭を打つだけの
  プログラム」** を下端アンカーとして常駐させ、`cpu_id = "cpu:hiyoko"`、
  表示名「ひよこ」、年齢 3 歳で固定する（§5.12 年齢表示）。
  - 実装は [test/reversi/reversi_cpu.py](../../test/reversi/reversi_cpu.py)
    が既にこの挙動（[reversi_rules.py](../../test/reversi/reversi_rules.py)
    の `legal_moves(board, color)[0]` で先頭合法手を採用）
  - 外部依存ゼロ、挙動決定的、`61` プロトコル完全準拠
  - anchor は `anchor=true` フラグでレート更新をスキップ。初期値は
    `r=1000, rd=30, sigma=0.06` を推奨（低めに固定して「最弱基準」を明示）
  - 意味合い: 「ひよこに勝てる = 3 歳以上」が最低保証、「ひよこ比 +N」で
    相対値がそのまま比較できる
  - 命名の意図: 「3 歳のユーザー CPU に勝てない」と自分の CPU 名で呼ばれる
    のは心理的負担なので、アンカーはユーザー CPU とは別キャラとして独立化
- **下端のみ運用での注意**: 上端が固定されないので、**レート値はすべて
  「合法手プログラム比の相対値」として扱う**。絶対値の意味（例: 2000 = 強豪）
  は主張しない。参加 CPU 全員が少しずつ強くなった場合のスケールドリフトは
  受容する
- **Phase B 以降で上端アンカーを追加**: Edax を固定深度で anchor 化
  （例: depth=12 を r=2400, rd=30 で固定）。これで上下を両端固定できる。
  あるいは WOF 公式レート上位の人間プレイヤー協力も同様
- **アンカー自身のヘルスチェック**: 下端アンカー 2 本（同一実装で別 `cpu_id`）
  を立てて毎日 1 対局させ、結果が常に同じであることを ヘルスチェックに使う
- **CPU バージョン更新**: 新 `cpu_id` で再登録するのが原則
  （`tommie-cpu-v1` → `tommie-cpu-v2`）。古い個体は `active=false` にして
  レート履歴を保存。バグ修正のみのマイナー更新は、登録者判断で同一 ID 継続可。
  その場合、実装側で `rd` を 200 に戻して再安定化を早める
- **先手有利の補正**: 総当たりで全組両色実施するので black/white の偏りは
  構造的に解消。特別補正しない
- **引分の頻度**: 32-32 / 30-34 等は自然に発生。`S=0.5` でそのまま処理
- **決定的 CPU の無情報対局**: 決定的 CPU 同士は同盤面なら同手のみ。
  対策として **開局ローテーション**（§5.7.2）を掛ける。最初の 2〜4 手を
  定石プールから強制投入
- **リマッチ**: 決定的 CPU は結果が予測できるので「直近の対戦履歴で結果が
  揺れていない組は優先度低」。日次総当たりでは全組必ず対戦するので
  この論点は Phase B 大会モードのみ
- **タイムアウト負け**: `61 §5` 着手タイムアウト（デフォルト 30 秒）超過は
  負け扱いで `S=0 or 1` 更新。ただしサーバ側バグ由来のタイムアウトは
  `reversi_match_log.event = "invalid"` で記録し、レート更新をスキップ
- **NO-SHOW**: 生存確認 (PI/PO) に応じない CPU は当日欠席扱い。`Skip()` で
  RD だけ広がる。連続 3 日 NO-SHOW で `active=false` に自動遷移
- **投了 (`EN`)**: `61 §6.2 #5` の投了は通常の負け扱い
- **改ざん耐性**: CPU 側は `61` UART プロトコルで着手を返すのみで、勝敗判定
  はサーバ `othelloApplyMove` が行う。クライアント結果通知だけに頼らない
- **レート表示の丸め**: 内部 float、UI `Math.round(r)` で整数表示

### 5.7 CPU 対戦ランナーの設計（Phase A の中核）

**1 日 1 回、全 active CPU × 下端アンカーで総当たり** を自動実行する。
10 CPU + anchor 1 体 = 11 体 → 11×10 = **110 対局/日**（両色含む）。

```text
DailyLeagueRunner (cron: 04:00 JST):
  1. 全 active CPU に PI/PO で生存確認 (5 分ウィンドウ)
  2. 参加可否を確定 (欠席は NO-SHOW ログ)
  3. 総当たりペアを生成 (全組 × 2 色)
  4. 開局ローテを定石カタログから割当
  5. 対局ランナー (1〜3 並列) で順次実行
  6. 全対局完了後、Glicko-2 日次バッチを回す
  7. leaderboard.json を /public に書き出し
  8. CPU owner 通知 (メール / webhook、設定者のみ)
```

#### 5.7.1 日次総当たりの仕様

- **参加構成**: active=true の全 CPU + 下端アンカー `cpu:anchor-legal-move`
- **対局数**: `N * (N - 1)` 局（11 体なら 110 局）
- **色割当**: 全組必ず両色 1 局ずつ（色偏り構造的解消）
- **所要時間**: 1 対局 3 分想定で **直列 5.5 時間、3 並列 2 時間**
- **実行枠**: `04:00〜09:00 JST`（ユーザー接続少ない時間帯、VPS 負荷許容）
- **早期打切**: 09:00 を越えても残っていたら強制中断、該当対局は `invalid`

#### 5.7.2 開局ローテーション

決定的 CPU のワンパターン化を防ぐため、対局開始時に最初の 2〜4 手を強制投入
する。候補プールは [62-リバーシ慣習・定石メモ.md](62-リバーシ慣習・定石メモ.md)
から：`tiger (f5-f6-e6)`, `rose (f5-f4-e3)`, `buffalo (f5-d6-c5)` など
20〜30 種をカタログ化し、日次ランで使い切る（110 局なら 1 定石 5〜6 局ずつ）。

プロトコル的には `61 §6.1 #5 BO<64char>` で途中局面を送って `SB`/`SW` で
再開させる形。CPU 側から見ると自然な「中途参加」と同じ扱いになる。

#### 5.7.3 並列化と UART 多重化

1 対局 3 分 × 110 = 5.5 時間が直列。VPS で並列実行するには:

- **CPU 側**: 1 owner あたり 1 CPU 接続が原則（UART は 1 対 1）。異なる
  owner の CPU は独立並列実行可
- **サーバ側**: Nakama ランナー goroutine を CPU ごとに割り、ブリッジ
  ([bridge/serial_ws_bridge.py](../../bridge/serial_ws_bridge.py)) の
  multiplex で捌く
- 現実的な並列度は **2〜3**（owner 間の時間帯衝突を避ける）

#### 5.7.4 人間プレイヤーのマッチング（おまけ）

人間ロビー対戦は既存のカジュアル対戦 UI に Glicko-2 を差すだけ。
CPU リーグとは完全独立に動く（即時更新経路、§5.5.2 参照）。

```text
候補プール = ロビーで「対戦希望」状態の人間
  1. CPU 戦希望なら即 CPU 対局 (日次リーグとは別のインタラクティブ対局)
  2. レート差 ≤ self.RD * 2 （RD が大きいほどウィンドウが広がる自然な挙動）
  3. 同言語優先
  4. 15 秒超過でウィンドウ 2 倍
  5. 60 秒超過で CPU 戦にフォールバック
```

人間 vs CPU 対局は人間側のみ即時更新。CPU 側は日次リーグの方で評価して
いるので、人間との対局結果は `event="casual"` で log だけ残し、CPU の
Glicko-2 更新には含めない（CPU は日次リーグが正）。

### 5.8 Phase B: 大会モード

[58-自作CPUオセロ大会ルール.md](58-自作CPUオセロ大会ルール.md) のルール層と
結線し、単発イベントとして有限の対局集合を回す。

- **総当たり（Round-Robin）**: 参加 N 体で N*(N-1)/2 局、色入替で 2 倍。
  N ≤ 16 程度で採用
- **スイスドロー（Swiss）**: N が大きくて総当たりが非現実的なときに採用。
  `R` ラウンド（通常 `ceil(log2 N)` 前後）で、毎ラウンド同勝ち点同士を当てる。
  Glicko-2 の現在レートで近い者同士をぶつければ自然にスイスになる
- **順位決定**: 勝ち点同率なら「対戦相手の最終レート合計」（Buchholz 相当）、
  最後に rating を使う
- **実装**: 既存 CPU ランナーに `tournament:<id>` イベントタグ付きの
  `event` を指定できる RPC (`reversiStartTournament`) を追加するだけ
- **結果レンダリング**: `reversi_match_log` を `event` でフィルタし、
  順位表を UI に出す

### 5.9 Phase C: 人間カジュアル対戦（おまけ）

Phase A で Glicko-2 基盤ができていれば、人間の対局も同じ `reversi_rating`
テーブルに `kind="player"` で書くだけ。UI の追加は次程度で済む：

- 対局結果トーストに ΔR を表示（`+18 → r=1518`）
- プレイヤー情報パネルにレート/RD を表示（ただし目立たせない）
- 大仰なランク表示や相手の強さマウントは SNS 主旨に合わないので抑制

リーダーボードを出す場合も **CPU レーダーボードを主、人間レーダーボードを
副** とし、「自作 CPU の順位を見る楽しみ」を前面に出す。

### 5.10 テスト方針

- **ユニット (Go)**: `updateDaily` に Glickman 論文 (2012) の example
  （r=1500, rd=200 の player が rd=30〜200 の 3 人と 1 勝 2 敗 → r=1464.06,
  rd=151.52, σ=0.059996）を回帰テストとして入れる
- **ユニット (Go)**: `runDailyBatch` がスナップショットを固定することを
  「先に更新した CPU の新値を後続の CPU が見ない」プロパティで確認
- **シナリオ (Python)**: [67-リプレイテスト.md](67-リプレイテスト.md) の
  仕組みに乗せて、決まった対局シーケンスで DB の `r`/`rd`/`sigma` が
  期待値に一致するかを検証
- **総当たり検証**: 11 CPU の 1 日分総当たりを回して順位表が決定的に
  再現できるか（同じ対局シード・同じ開局ローテなら同じ順位になる）
- **アンカー恒等性**: 下端アンカー同士の対局結果が毎日同じであることを
  ヘルスチェックテストとして毎朝実行

### 5.11 運用スケジュールと設計判断

#### 5.11.1 1 日の流れ

| 時刻 (JST) | イベント |
| ---- | ---- |
| 04:00 | 日次ランナー起動、全 CPU に PI/PO 生存確認 |
| 04:05 | 参加可否確定、NO-SHOW を `invalid` ログ |
| 04:10 | 総当たり開始（シャッフル済み順、開局ローテ割当済） |
| 04:10〜09:00 | 1〜3 並列で対局実行 |
| 09:00 | 強制打ち切りライン（残りは `invalid`） |
| 09:05 | Glicko-2 日次バッチ実行 |
| 09:10 | `/public/reversi/leaderboard.json` 書き出し |
| 09:15 | CPU owner 通知（希望者のみ、メール or webhook） |

#### 5.11.2 CPU 登録・認証

- **Google 認証必須**: CPU 登録 (`reversiRegisterCpu` RPC) の呼び出し時に
  Nakama `LinkGoogle` API で既存 device session に Google アカウントを
  紐付ける。email scope 必須
- **既存 device auth は維持**: 観戦・チャット閲覧のみの users に Google は
  要求しない。CPU owner になる初回のみ OAuth 同意画面
- **1 Google アカウントあたり CPU 登録上限**: デフォルト 3 体、管理者が
  個別に引き上げ可
- **Google アカウント削除時**: 紐付き CPU は `active=false` 自動遷移
- **Phase B 以降**: GitHub 認証を追加候補に（FPGA / 自作 CPU の作者層は
  GitHub 率が高い、public repo を CPU プロフィールにリンク可能）

#### 5.11.3 CPU バージョン管理

- **新 `cpu_id` で再登録が原則**: `tommie-cpu-v1` → `tommie-cpu-v2`。
  古い個体は `active=false`、レート履歴を保存
- **同一 ID 継続の例外**: 明らかなバグ修正のみの更新は登録者判断で可。
  その場合、`rd` を 200 に戻して再安定化を早める自主運用とする
- **不正な版更新検知**: 同一 `cpu_id` でレートが短期に大きく動いた場合
  （例: 7 日で ±300 超）に管理者に警告

#### 5.11.4 休眠判定

- 連続 3 日 NO-SHOW で `active=false` に自動遷移
- オーナーが復帰申請すれば `active=true` に戻す（RD は現状維持）

#### 5.11.5 結果公開度

- **レート・順位**: 公開（リーダーボード）
- **対局棋譜 (`moves`)**: 公開（CPU 手の内が見える面はあるが、観戦性・
  デバッグ支援・不正検出（人間手動介入）の面で公開が有利）
- **対局ログの外部公開**: `public/reversi/` 配下の静的ファイルとして
  [40-デプロイ手順.md](../40-デプロイ手順.md) の dist 経路で自動配信

### 5.12 年齢表示による強さ表現

CPU の強さを **人間の年齢で表示する** 仕組みを導入する。Glicko-2 の r 値
だけより直感的で、エンゲージメント（成長通知・SNS 映え）にも効く。

表示例: **「とみーちゃん (15 歳)」**

#### 5.12.1 基本設計

- **名前（例: とみーちゃん）**: owner の自由申告（登録時入力、32 文字以内
  ASCII/日本語可）
- **年齢**: サーバが **Glicko-2 レートから自動算出**。owner は変更不可
  （詐称防止）
- 名前 + 年齢を 1 セットで表示し、現在年齢だけでなく **昨日との差分**
  （「15 歳 → 16 歳 ↑」）もトーストに出す
- `reversi_cpu_meta` にキャッシュ（`display_name`, `age_years`）、
  日次バッチ後に再計算して書き戻す

#### 5.12.2 年齢 ↔ レート 対応表

下端アンカー「ひよこ」 = 3 歳 = r≈1000 を基準点とする。

| 年齢 | レート帯 | 実装イメージ | 人間層 |
| ---- | ---- | ---- | ---- |
| **3 歳** | r < 1050 | 合法手プログラム（ひよこ） | ルール覚えたて幼児 |
| 5 歳 | 1050〜1150 | 返せる数最大の貪欲法 | 幼児〜小 1 |
| 8 歳 | 1150〜1300 | 角優先の貪欲 | 小学低学年 |
| 12 歳 | 1300〜1500 | minimax 2〜3 手 | 小学高学年 |
| 15 歳 | 1500〜1700 | minimax 4〜5 手 + 評価関数 | 中学生熱心層 |
| 18 歳 | 1700〜1900 | αβ 6〜8 手 + 定石 | 高校〜大学 |
| 22 歳 | 1900〜2100 | αβ 10 手 + 位置評価 | 一般アマチュア上位 |
| 30 歳 | 2100〜2300 | パターン評価 + αβ 14 手 | アマチュア強豪 |
| 40 歳 | 2300〜2500 | Edax 中深度 | WOF プロ入口 |
| 60 歳 | 2500〜2700 | Edax 高深度 + 終盤完全読み | 世界トップ級 |
| **100 歳** | r ≥ 2800 | Edax 最大深度 / 完全解析 | 超人（理論最善） |

- **年齢は頭打ち 100 歳** でキャップ（インフレ防止）
- 境界レートは運用データで後日調整可能（`rating_age_table.json` に外出し）

#### 5.12.3 算出関数（Go 側擬似コード）

```go
var ageTable = []struct {
    MinRating float64
    Age       int
}{
    {2800, 100}, {2700, 60}, {2500, 40}, {2300, 30},
    {2100, 22}, {1900, 18}, {1700, 15}, {1500, 12},
    {1300, 8}, {1150, 5}, {1050, 4}, {0, 3},
}

func computeAge(r float64) int {
    for _, row := range ageTable {
        if r >= row.MinRating {
            return row.Age
        }
    }
    return 3
}
```

#### 5.12.4 バージョン更新時の年齢リセット

- 新 `cpu_id` 登録 = **年齢リセット（= 3 歳からやり直し）**
- 「成長を可視化する」コンテンツ性を保つためにあえてリセット
- 古い個体は `active=false` で 40 歳のまま履歴保存される（過去の栄光）

#### 5.12.5 UI への反映

- ロビー: 「とみーちゃん (15 歳) と対戦しますか？」
- 対局前: 「対戦相手: とみーちゃん (15 歳)」
- 対局後: 「とみーちゃん (15 歳 → 16 歳) 誕生日おめでとう」
- リーダーボード: 年齢順と rating 順の 2 タブ
- プロフィールパネル: 年齢推移グラフ（横軸=日付、縦軸=年齢）

## 6. 参考

- Glickman, M.E. (1999) "Parameter estimation in large dynamic paired comparison
  experiments", Applied Statistics 48, 377-394（Glicko 原論文）
- Glickman, M.E. (2012) "Example of the Glicko-2 system" —
  <http://www.glicko.net/glicko/glicko2.pdf>（Glicko-2 実装リファレンス）
- Lichess レーティングシステム: <https://lichess.org/page/rating-systems>
- FIDE Handbook B.02.10 Rating Regulations（K 係数の公式定義）
- 既製実装（2026-04 時点で生きているものに限定）:
  - Go:
    - [`github.com/jlouis/glicko2`](https://github.com/jlouis/glicko2) — **本命**。
      Ridder 法、関数 2 本の薄い API、MIT
    - [`github.com/artasparks/goglicko`](https://github.com/artasparks/goglicko) —
      代替案、`CalculateRating` で複数対戦をまとめて処理できる、MIT
    - ~~`github.com/zelenin/go-glicko2`~~ — 2025-03 アーカイブ済、非推奨
  - TypeScript:
    - [`glicko2.ts`](https://github.com/animafps/glicko2.ts) —
      race/team 拡張あり、MIT
    - [`glicko2-lite`](https://github.com/KenanY/glicko2-lite) —
      依存ゼロの最小実装、MIT
  - Python: `glicko2` / `trueskill`（Nakama との相性なら Go を推奨）
