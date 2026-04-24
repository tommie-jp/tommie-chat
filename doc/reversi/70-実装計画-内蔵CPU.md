# 70-実装計画-内蔵CPU

2026-04-24

Nakama サーバに **リバーシ CPU を内蔵** し、シリアル接続なしで常時対戦可能にする
計画。[test/reversi/reversi_cpu.py](../../test/reversi/reversi_cpu.py) 相当の
「合法手の先頭を打つ」CPU を Go で書き、Nakama match ループから直接呼び出す。

## 目的

1. **常時稼働の CPU 対戦相手**（シリアル・別プロセス不要）
2. [69-マッチング-Elo-Glicko.md](69-マッチング-Elo-Glicko.md) §5.6 の下端アンカー
   **「ひよこ (3歳)」を Nakama に常駐**
3. §5.7 の日次総当たりランナーの CPU 実体として利用可能
4. 将来の多段難易度（貪欲法、minimax 等）の土台

## 現状との関係

| 要素 | 現在 | Go 内蔵後 |
| ---- | ---- | ---- |
| `reversi_cpu.py` | UART 越しの参考 CPU (開発・テスト用) | 維持 (ハードウェア CPU のリファレンス実装) |
| `reversi_rules.py` | Python ルール | Go にポート (`reversi_rules.go`) |
| ブラウザから CPU 対戦 | シリアル必須 | **シリアル不要**、Nakama 内で完結 |
| UART プロトコル | [61-UARTプロトコル仕様.md](61-UARTプロトコル仕様.md) | 無関係 (内蔵 CPU は関数呼び出し) |

## アーキテクチャ

```text
[Client (browser)] ──RPC/match msg──▶ [Nakama othello match]
                                            │
                                            ├─ human opponent: client input 待ち
                                            │
                                            └─ CPU opponent: computeMove() 直接呼び出し
                                                  │
                                                  ▼
                                            [reversi_cpu.go]
                                              ├─ reversi_rules.go
                                              └─ computeMove(board, color) → (r,c)
```

内蔵 CPU は **関数呼び出し**で完結。UART シミュレーションは行わない。UART 越しの
外部 CPU とは別経路だが、Nakama match 上は同じ「CPU プレイヤー」として扱う。

## ファイル構成

```text
nakama/go_src/
  main.go                   既存 (~3000 行)。Phase 3 で CPU 判定フックを追加
  reversi_rules.go          新規 (Phase 1): ルールエンジン (100-150 LOC)
  reversi_cpu.go            新規 (Phase 2): 内蔵 CPU (first-legal-move、50 LOC)
  reversi_rules_test.go     新規 (Phase 1): 単体テスト
  reversi_cpu_test.go       新規 (Phase 2): 単体テスト
```

main.go 肥大化を防ぐため **新ファイル分離**。ポート側 (Phase 3) は既存
`othelloApplyMove` 周辺に数十行の追加だけに抑える。

## フェーズ分割

### Phase 1: ルールエンジン Go ポート (0.5〜1 人日)

- `reversi_rules.go` に [reversi_rules.py](../../test/reversi/reversi_rules.py)
  を書き写し
  - `BLACK=1 / WHITE=2 / EMPTY=0` 定数
  - `FindFlips(board Board, r, c int, color int8) []Pos`
  - `LegalMoves(board Board, color int8) []Pos`
  - `ApplyMove(board *Board, r, c int, color int8) bool`
  - `BoardFromBO(s string) (Board, bool)` / `BoardToBO(board Board) string`
  - `InitBoard() Board`
- 盤面型: `type Board [64]int8` で固定長・ヒープ不要
- 座標: `type Pos struct { Row, Col int }`、row\*8+col で Board へアクセス
- **テスト**: §7 初期盤面、代表的な着手、合法手列挙、BO 変換往復

### Phase 2: 内蔵 CPU コア (0.5 人日)

- `reversi_cpu.go`:

  ```go
  type CpuEngine interface {
      NextMove(board Board, color int8) (row, col int, pass bool)
  }

  type HiyokoCpu struct{}

  func (HiyokoCpu) NextMove(board Board, color int8) (int, int, bool) {
      moves := LegalMoves(board, color)
      if len(moves) == 0 { return 0, 0, true }
      return moves[0].Row, moves[0].Col, false
  }
  ```

- 将来の多段難易度は同じ interface を実装する新型で拡張
- **テスト**: Python `reversi_cpu.py` が同じ盤面で同じ手を返すことを検証

### Phase 3: Nakama match への結線 (1〜2 人日)

- main.go の othello match ループに CPU 判定を追加:

  ```go
  // othelloApplyMove 完了後、次プレイヤーが CPU なら自動で着手をスケジュール
  if isCpuEntity(state.CurrentTurnUID) {
      go scheduleCpuMove(matchId, state)
  }
  ```

- `scheduleCpuMove`:
  - 300〜800 ms の「思考中」演出遅延 (UX のため)
  - `engine.NextMove(state.Board, state.Turn)` 呼び出し
  - 結果を既存の着手適用経路に流し込み
  - `othelloUpdate` を全購読者にブロードキャスト
- CPU エンティティ UID: `cpu:hiyoko` 形式で sentinel。`isCpuEntity` は prefix 判定

### Phase 4: ロビー UI (0.5 人日)

- リバーシロビー ([src/UIPanel.ts](../../src/UIPanel.ts)) に
  **「CPU 対戦（ひよこ 3歳）」ボタン**を追加
- RPC: `createCpuGame(cpuId)` → サーバ側で match 作成、黒/白抽選、CPU 側スロットに
  `cpu:hiyoko` UID を設定して start
- 既存の `createRoom` / `join` 経路に乗せる

### Phase 5: CPU 登録メタ・レーティング結線 (1 人日、[69 §5](69-マッチング-Elo-Glicko.md) 実装時に同時)

- Nakama storage に `reversi_cpu_meta` / `reversi_rating` コレクションを作成
- ひよこを固定レコードで作成:

  ```json
  {"cpu_id":"cpu:hiyoko","display_name":"ひよこ","age_years":3,
   "connection":"internal","active":true}
  ```

- `reversi_rating` に `{"r":1000,"rd":30,"anchor":true}` で登録
- 対局終了時: CPU 側は anchor=true なので更新せず、人間側のみ Glicko-2 で更新

## 想定スケジュール

| Phase | 工数 | 依存 |
| ---- | ---- | ---- |
| 1. ルール Go ポート | 0.5〜1 日 | なし |
| 2. 内蔵 CPU コア | 0.5 日 | Phase 1 |
| 3. Nakama match 結線 | 1〜2 日 | Phase 1, 2 |
| 4. ロビー UI | 0.5 日 | Phase 3 |
| 5. レーティング結線 | 1 日 (69 §5 と同時) | 69 §5 の基盤 |
| **合計** | **3.5〜5 日** | |

Phase 1〜4 だけでも「CPU 対戦が常時できる」状態は達成可能。レーティング (Phase 5)
は後続で OK。

## 技術的な留意点

1. **決定性**: `HiyokoCpu` は決定的なので、同じ盤面 + 同じ色 → 同じ手。単体テスト
   しやすい一方、**同じ人間が繰り返し遊ぶと飽きる** → [69 §5.7.2](69-マッチング-Elo-Glicko.md)
   の**開局ローテーション**を match 作成時に入れる (最初の 2〜4 手を定石プールから
   強制投入)
2. **思考時間の演出**: CPU が瞬答すると人間は「考えてない相手」と感じる。
   300〜800 ms の `time.Sleep` で遅延させると UX◎
3. **サーバリソース**: HiyokoCpu は CPU < 1ms、メモリ 0。1000 並列対局でも軽い
4. **Go 版と Python 版の整合**: 両方とも「合法手の先頭」を返すが、
   `LegalMoves` の順序が実装依存。Python は `r=0..7, c=0..7` の行優先。Go も
   同じにして決定性を保つ
5. **Match 管理**: 既存 othello match が Nakama Match API か カスタム state か
   事前調査が必要
6. **テストシナリオ互換**:
   [test/reversi/cpu_tester/cases/game_rule/*.json](../../test/reversi/cpu_tester/cases/game_rule/)
   の JSON ケースを Go 単体テストから読ませれば、**Python CPU と Go CPU の
   挙動一致を自動検証**できる

## 必要な事前調査 (Phase 3 着手前)

1. `main.go` の othello match 実装が Nakama Match API か カスタム state か
2. `othelloApplyMove` が現状どこから呼ばれるか (RPC のみ？ match loop からも？)
3. 既存の match 参加者管理 (`black`/`white` UID) に CPU sentinel を混入可能か
4. RPC 側で勝者判定・終局処理が走るタイミング (CPU 側の move もこの経路に乗せるか)

## 派生で得られるもの

- **24/7 ベンチマーク**: Hiyoko vs Hiyoko で 1 日 10,000 対局回して Nakama の
  対局ログ容量・レイテンシを実負荷計測できる
- **定石自動検出のデータ源**: 多数対局ログから序盤パターン抽出
  ([62-リバーシ慣習・定石メモ.md](62-リバーシ慣習・定石メモ.md))
- **新規 CPU 作者向けチュートリアル**: Go 版コードを公開し「まずこれを改造して
  自分の CPU を作る」スタートポイントに

## 進捗

- [x] Phase 1 完了（2026-04-24: reversi_rules.go / reversi_rules_test.go）
- [x] Phase 2 完了（2026-04-25: reversi_cpu.go HiyokoCpu + 8 テスト）
- [x] Phase 3 完了（2026-04-25: rpcOthelloCreateCpu + scheduleCpuMove + rpcOthelloMove フック、思考時間ランダム 300〜800ms）
- [x] Phase 4 完了（2026-04-25: リバーシロビーに「ひよこ(3歳)と対戦」ボタン、`othelloCreateCpu` RPC ラッパ）
- [ ] Phase 5 (69 §5 と併せて)
