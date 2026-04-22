# 設計: リバーシ CPU ブリッジ (Node.js) — 将来オプション

自作ハードウェアのリバーシ CPU を nakama 上の**別アカウントの常駐 bot** として 24/7 公開するためのヘッドレスブリッジ設計メモ。

> **現時点の主力路線は [doc/reversi/59-設計-外部CPU接続.md](reversi/59-設計-外部CPU接続.md) の Web Serial 接続代行方式**。
> 本ドキュメントはそれとは用途が異なる「CPU 本人を独立した nakama アカウントとして 24/7 常駐させたい」場合の設計で、**当面は実装しない**。
>
> | 文書 | 運用形態 | 接続方式 | 実装優先度 |
> | --- | --- | --- | --- |
> | **doc/reversi/59** | **人間 A が自作 CPU を持ち込んで代理接続** | ブラウザ Web Serial | **主力・優先** |
> | 本ドキュメント (doc/51) | 自作 CPU を独立アカウントで 24/7 常駐 | Node.js + `serialport` | 将来検討 |
>
> Web Serial 方式で蓄積した UART プロトコル ([doc/reversi/59 §UART プロトコル仕様](reversi/59-設計-外部CPU接続.md)) は本ドキュメントでも流用する前提。

## 背景・狙い

- 「CPU 製作者が PC を開いて毎回接続する」ではなく、**CPU ボット自身を nakama の独立プレイヤーとしてロビーに常駐させたい**ケース
- 例: 大会運営主催の「いつでも挑戦可能な CPU」、自作 CPU のレーティング蓄積
- ブラウザ上で AI を動かすと端末性能で強さがバラつく・タブを閉じると消える
- Windows11 / Raspberry Pi + Node.js でヘッドレスブリッジを組む方が 24/7 運用向き

## 全体構成

段階的に 3 つの形を取る:

**初期形（CLI 疎通確認）**:

```text
[人間オペレータ] ─キーボード─ [Node.js ブリッジ (CLI)]
                                   └─ WSS ─→ nakama
```

通信経路と「CPU と対戦」フロー全体の疎通確認のみを目的とする開発用モード。人間がターミナルに着手 (`d3` 等) をタイプする。本番運用はしない。

**本番形（Node.js が自律、内部 AI）**:

```text
[Node.js ブリッジ] (内部にリバーシルール + AI)
     └─ WSS ─→ nakama
```

ブリッジ内のルール＋AI で合法手を自動生成、24/7 常駐。

**最終形（UART 統合後）**:

```text
[自作CPU (MCU)] ─UART─ [USB] ─ [Node.js ブリッジ]
                                   └─ WSS ─→ nakama
```

内部 AI を MCU に差し替え、本来の自作ハード CPU で対戦。

## アーキテクチャ比較

### Node.js ブリッジ (採用)

- 24/7 常駐可能（タスクスケジューラ / `nssm` でサービス化）
- 独立した nakama 識別 → ロビーに `🤖 自作CPU` として常駐
- `serialport` パッケージで UART 直結、WebSerial の制約なし
- UI (tommieChat) とボット実装を分離できる
- 再接続・リザイン等の運用処理が書きやすい

### WebSerial (ブラウザ直結) の制約 [不採用]

- ブラウザタブを閉じたら CPU も消える
- バックグラウンドタブはスロットルされ AI 思考中断の恐れ
- Chromium 系のみ対応 (Firefox/Safari 非対応)
- ユーザ ID が人間と同じ（人間 vs 自作 CPU 不可）
- ポート権限付与のユーザジェスチャが毎セッション必要

## 認証方針

### 第 1 段階: デバイス認証（初期実装）

- 初回起動時に UUID を生成し `data/device-id.txt` に永続化
- `client.authenticateDevice(deviceId)` で認証
- 表示名を `updateAccount` で `🤖 自作CPU-v1` 等に設定
- 実装 5 行で済む

### 第 2 段階: Google 認証（推奨・BAN 実効性向上のため）

次のいずれかに該当したら移行する:

- device_id ファイル喪失で別人になるのを避けたい
- **悪用時に BAN を確実に効かせたい**（後述セキュリティ方針参照）

device_id 方式は盗まれても攻撃者が新しい UUID を自作すれば別ユーザとして再登録可能で、`user_id` ベースの BAN が実質機能しない。Google 認証なら nakama に記録される Google subject ID 単位で BAN できるため、**BAN 回避に Google アカウント自体の新規作成 (電話認証等) が必要**となり抑止力が上がる。

1. tommieChat で通常通り Google ログイン → nakama が `Session { token, refresh_token }` を返す
2. tommieChat にデバッグメニュー項目を追加:「CPU ブリッジ用トークン出力」
3. `{ token, refresh_token }` を JSON で download → `tokens.json`
4. ユーザが Windows11 のブリッジフォルダに配置
5. ブリッジは `Session.restore(token, refresh_token)` で復元、`sessionRefresh` で自動更新

注意:

- `tokens.json` は nakama 成りすまし可能な秘密。git に入れない
- nakama の `--session.refresh_token_expiry_sec` を長め (例: 30 日) に設定し、月 1 回の再ログインで済むようにする
- Node.js 側に Google OAuth を実装しないので `googleapis` も `client_secret` 配布も不要

## リポジトリ構成

当面は tommieChat 本体リポジトリの `bridge/` サブディレクトリに配置する。複雑化したら別リポジトリへ切り出す。

```text
24-mmo-Tommie-chat/
├── bridge/                     # ← 新規追加
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts            # エントリ・再接続ループ
│   │   ├── nakama.ts           # nakama 接続・マッチ参加
│   │   ├── cli.ts              # 手動入力 CLI (初期形)
│   │   ├── reversi.ts          # リバーシルール (フェーズ 3 で追加)
│   │   ├── ai.ts               # 内部 AI (フェーズ 3 で追加)
│   │   ├── uart.ts             # serialport ラッパ (フェーズ 5 で追加)
│   │   └── config.ts           # device_id, 設定
│   ├── data/
│   │   └── device-id.txt       # 初回生成・永続化 (.gitignore)
│   ├── .env.example
│   └── README.md
├── src/                        # 既存: tommieChat ブラウザ側
├── nakama/                     # 既存: サーバ
└── ...
```

`bridge/` は独立した npm プロジェクトとして `package.json` を持ち、本体の依存とは分離する。

依存パッケージ:

- `@heroiclabs/nakama-js` — nakama SDK
- `zod` — 設定バリデーション
- `pino` — 構造化ログ
- `serialport` + `@serialport/parser-readline` — UART (フェーズ 5 で追加)

## UART プロトコル

フェーズ 5 で設計する。当面は後回し。Node.js 側にリバーシルール＋内部 AI を持たせて自立動作させる。

## セキュリティ方針

### 守備範囲の明確化

このセクションで設計する role ベース API 制限が守るのは **bot 認証情報漏洩時の被害限定** のみ。一般ユーザによる悪用（通常アカウントで荒らす・スパム投稿・連続マッチ作成等）はこの設計範囲外で、[92-セキュリティレビュー.md](92-セキュリティレビュー.md) 側で対策する。

| 目的 | 対策箇所 |
| --- | --- |
| bot 認証情報漏洩時の被害限定 | **本ドキュメント** (role ベース API 制限) |
| bot 偽装防止 | **本ドキュメント** (role ベース判定) |
| 悪用発覚時の追跡・対処 | **本ドキュメント** (管理画面 + BAN) |
| 一般ユーザの悪用防止 | [92-セキュリティレビュー.md](92-セキュリティレビュー.md)（Google 認証必須化・レート制限・コンテンツフィルタ・行動監視） |

### 脅威モデル

| 脅威 | 対策 |
| --- | --- |
| `device-id.txt` / `tokens.json` 盗難 → bot ID で成りすまし | 認証方式 + role ベース権限絞り |
| 第三者が別 CPU アカウントで `🤖 自作CPU-fake` を作り偽装 | CPU ボット ID は storage で明示登録、role=othello_cpu のみ CPU 扱い |
| 改造ブリッジが bot ID でチャット爆撃・地形破壊 | role ベース API 制限（bot は該当 RPC ブロック） |
| 悪用発覚時の BAN 回避 | Google 認証で subject ID BAN を効かせる |
| 一般ユーザ ID での荒らし全般 | **範囲外** → [92-セキュリティレビュー.md](92-セキュリティレビュー.md) |

### 認証方式と BAN 実効性

- **device_id 認証**: 秘密が漏れると攻撃者は新しい UUID を生成して再登録可能。`user_id` BAN は機能しない
- **Google 認証**: Google subject ID 単位で BAN 可能。**回避には Google アカウント新規作成 (電話認証等) が必要**で抑止効果がある
- → 正式運用時は Google 認証に移行する方針（フェーズ 6）

### サーバ側 (nakama) 対策（最重要）

#### プレイヤー種別 (Role) ベースの権限管理

既存の `ADMIN_UIDS` を一般化し、正式な役割 (role) 体系を導入する:

```go
type PlayerRole string
const (
    RoleGeneral    PlayerRole = "general"     // 一般ユーザ (デフォルト)
    RoleAdmin      PlayerRole = "admin"       // 管理者
    RoleOthelloCPU PlayerRole = "othello_cpu" // リバーシ CPU ボット
)
```

- デフォルトは `general`
- デフォルトは `general`
- 将来 `moderator` / `guest` 等を足す場合も同じ仕組みに乗る

#### Role の保存戦略

nakama 再起動を避けるため、admin だけを env でブートストラップし、それ以外の role は storage で動的管理する。

##### admin: env でブートストラップ

```env
ADMIN_UIDS=uid1,uid2           # 既存の仕組みをそのまま利用
```

- 初期管理者を env で固定。これが無いと誰も管理 RPC を叩けない
- 起動時に map 化して O(1) 判定
- admin の追加・削除は env 書き換え + 再起動（頻度低）

##### othello_cpu 等: storage で動的管理

```text
collection: "player_roles" (system owned)
key: <userID>
value: {
  "role": "othello_cpu",
  "granted_by": "<adminUID>",
  "granted_at": "2026-04-21T10:00:00Z"
}
```

- admin が管理 RPC で付与・剥奪 → 再起動不要
- 将来 `moderator` 等を追加する際も同じコレクションに同居
- 書き込みは admin 権限者のみ、読み取りはサーバランタイムのみ (`ReadPermission=0, WritePermission=0`)

#### Role キャッシュ戦略

storage 読み取りを RPC 毎にやると遅いので、`account.metadata.role` にミラーして高速判定する:

1. 管理 RPC が `player_roles` を更新したら同時に対象ユーザの `account.metadata.role` も `updateAccount` で書き込む
2. クライアント認証時 (`AfterAuthenticate` フック) にも storage → metadata の整合チェックを走らせ、乖離があれば metadata を再同期
3. `BeforeRpc` / `BeforeRt` では `ctx` から user の metadata を読む（DB 呼ばない）
4. role 変更時は対象ユーザの既存セッションを強制切断して再ログインを促す（metadata は新規セッションで反映）

#### 権限マトリクス

| API | general | admin | othello_cpu |
| --- | --- | --- | --- |
| `othelloMove` / `Join` / `Resign` / `Subscribe` | ✓ | ✓ | ✓ |
| `othelloCreate` / `Invite` | ✓ | ✓ | ✗ |
| `othelloComment` (自由文) | ✓ | ✓ | ✗（定型句のみ） |
| `othelloCancel` / `InviteReject` / `History` | ✓ | ✓ | ✗ (Cancel/History) / ✓ (InviteReject) |
| `setBlock` | ✓ | ✓ | ✗ |
| `createRoom` / `deleteRoom` | ✓ | ✓ | ✗ |
| `socket.writeChatMessage` | ✓ | ✓ | ✗ |
| `socket.joinChat` | ✓ | ✓ | ✗ |
| `updateAccount` (表示名・アバター変更) | ✓ | ✓ | ✗（初期設定後ロック） |
| `socket.sendMatchState` | ✓ | ✓ | ✗（リバーシで不使用） |
| nakama Console ログイン | ✗ | ✓ | ✗ |
| 全ユーザ BAN/強制切断 RPC | ✗ | ✓ | ✗ |

#### 実装骨子

```go
// metadata から読むヘルパ (BeforeRpc/BeforeRt で使う高速版)
func getPlayerRole(ctx context.Context) PlayerRole {
    meta, _ := ctx.Value(runtime.RUNTIME_CTX_USER_SESSION_VARS).(map[string]string)
    if r, ok := meta["role"]; ok { return PlayerRole(r) }
    // env でブートストラップされた admin
    userID, _ := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
    if _, ok := adminUIDs[userID]; ok { return RoleAdmin }
    return RoleGeneral
}

// BeforeRpc フック
initializer.RegisterBeforeRpc("othelloComment", func(ctx, ...) {
    if getPlayerRole(ctx) == RoleOthelloCPU {
        if !isFixedPhrase(payload.text) {
            return nil, runtime.NewError("cpu can only send fixed phrases", 7)
        }
    }
    return payload, nil
})

// BeforeRt フック (WebSocket メッセージ)
initializer.RegisterBeforeRt("ChannelJoin", func(...) {
    if getPlayerRole(ctx) == RoleOthelloCPU {
        return nil, runtime.NewError("forbidden for othello_cpu", 7)
    }
    return envelope, nil
})
```

#### 管理 RPC (admin 限定)

すべて冒頭で `getPlayerRole(ctx) != RoleAdmin` を弾く。

| RPC | 引数 | 機能 |
| --- | --- | --- |
| `admin_list_users` | `{query?, role?, limit, cursor}` | 全ユーザ一覧。表示名・メール検索、role フィルタ、BAN 状態含む |
| `admin_grant_role` | `{userID, role}` | `player_roles` と `account.metadata.role` を同時更新。既存セッションを強制切断 |
| `admin_revoke_role` | `{userID}` | role を `general` に戻す。storage から該当レコード削除 |
| `admin_ban_user` | `{userID, reason, durationSec?}` | nakama 標準 `BanUsers` API 使用。`account.disabled_time` 設定。既存セッション即切断。理由は `admin_audit` コレクションに記録 |
| `admin_unban_user` | `{userID}` | `UnbanUsers` で解除 |
| `admin_audit_log` | `{limit, cursor}` | 管理操作履歴を取得 |

BAN は nakama のアカウント無効化機構を使う。同一 Google subject ID で再ログインしても同 user_id にマップされるので BAN 継続（第 2 段階の Google 認証前提で実効性あり）。

#### tommieChat 管理画面

既存のデバッグオーバーレイ ([src/DebugOverlay.ts](../src/DebugOverlay.ts)) の admin モード内に「ユーザ管理」タブを追加する。

##### 画面構成

- **検索バー**: 表示名・メールアドレス部分一致
- **フィルタ**: role (`all` / `general` / `admin` / `othello_cpu`)、BAN 状態 (`all` / `active` / `banned`)
- **一覧テーブル**:
  - 表示名
  - user_id 下 8 桁
  - role（プルダウンで変更）
  - オンライン状態
  - BAN 状態・解除予定時刻
  - 操作ボタン (`BAN` / `Unban` / `Kick`)
- **BAN ダイアログ**: 理由テキスト入力 + 期間 (`1日` / `7日` / `30日` / `永久`)
- **操作履歴**: 画面下部に直近 20 件の監査ログ（誰が誰をいつ何の理由で操作したか）

##### UI 実装上の注意

- admin モードの既存判定フロー (`NakamaService.isAdmin()` 相当) を流用
- role 変更 / BAN は confirm ダイアログで二段階確認（誤操作防止）
- 成功時は操作履歴に即時反映し、一覧も再取得
- 自分自身の admin 剥奪・BAN は UI でブロック（最後の admin が消えて詰む事故防止）

#### 偽装防止

- `🤖` プレフィックス表示名だけでは CPU 扱いしない（role ベースで判定）
- tommieChat 側の「CPU と対戦」ボタンは `role=othello_cpu` の user_id のみ列挙

#### レート制限

- CPU bot は同時 N 局まで（例: 10）
- 着手間隔の下限 (1 秒 1 手以上)
- マッチ作成・招待頻度の上限（CPU は Create/Invite 禁止なので 0）

### クライアント側 (ブリッジ) 対策

1. **CLI は stdin のみ**
   - ネットワーク listener を作らない（Web GUI なし方針とも整合）
   - 外部から到達不能

2. **資格情報の保管**
   - `data/device-id.txt` / `tokens.json` は Windows ユーザプロファイル配下
   - `icacls` で自分のみ RW
   - `.gitignore` に追加、`bridge/data/` はリポジトリに含めない

3. **コード改造の検出**
   - 正規ブリッジからは version 情報 + 短い識別トークンを `rpc_ping` で送る（任意の後付け）
   - サーバ側でログに残し、異常動作時の相関分析に使用

### 運用対策

- **BAN 手順の文書化** — 悪用発覚時に nakama コンソールから Google subject ID / user_id 単位で BAN する手順を [92-セキュリティレビュー.md](92-セキュリティレビュー.md) に追記
- **監視** — bot アカウントの行動ログ（着手時刻・対戦相手・異常パターン）を記録

### 許可／禁止 API 一覧

リバーシは現状すべて RPC ベースで動作（マッチデータ `sendMatchState` は不使用）。盤面更新は nakama 通知でブリッジに push される。

参照: [nakama/go_src/main.go](../nakama/go_src/main.go) L5082-5090, [src/NakamaService.ts](../src/NakamaService.ts) L1054-1134

#### リバーシ RPC

| RPC | bot | 用途・理由 |
| --- | --- | --- |
| `othelloCreate` | ✗ 禁止 | マッチ作成は人間側がやる |
| `othelloJoin` | ✓ 許可 | 招待された対局に参加 (`watch=false`) |
| `othelloMove` | ✓ 許可 | 着手 (`{gameId, row, col}`) |
| `othelloResign` | ✓ 許可 | 投了・切断前クリーンアップ |
| `othelloCancel` | ✗ 禁止 | bot は作らないので不要 |
| `othelloComment` | △ 限定許可 | 定型句のみ (`よろしく` / `ありがとう` 等)。自由文禁止 |
| `othelloInvite` | ✗ 禁止 | bot から人間を招待させない |
| `othelloInviteReject` | ✓ 許可 | 多重招待時の辞退 |
| `othelloHistory` | ✗ 禁止 | 運用に不要 |
| `othelloSubscribe` | ✓ 許可 | ロビー／招待通知の購読（必須） |
| `ping` | ✓ 許可 | ヘルスチェック |

#### WebSocket 受信 (push)

| 種類 | bot の扱い |
| --- | --- |
| Notification `type: othelloUpdate` (盤面更新) | **必須で処理** |
| Notification `type: othelloList` (ロビー一覧) | 購読中のみ受信、無視可 |
| Notification `type: othelloBlocks` (地形更新) | **無視**（CPU と無関係） |
| Invitation 通知（人間からの対戦招待） | **必須で処理**（自動 accept or reject） |

#### 禁止すべき nakama 標準 API

リバーシ以外の荒らし経路を塞ぐ:

- `socket.writeChatMessage` — チャット投稿完全禁止
- `socket.joinChat` — ワールドチャット参加禁止（リバーシ内コメントは `othelloComment` RPC 経由）
- `setBlock` RPC — 地形破壊禁止
- `createRoom` / `deleteRoom` RPC — 部屋操作禁止
- `updateAccount` REST — 表示名・テクスチャは初期設定後ロック
- `socket.sendMatchState` — リバーシで使わないので禁止で問題なし

#### 二重の絞り込み

1. **ブリッジ側 (自主規制)**: [bridge/src/nakama.ts](../bridge/src/nakama.ts) に許可リストをハードコードし、許可 RPC のラッパ関数以外を生やさない
2. **サーバ側 (強制)**: nakama の `BeforeRt` / `BeforeRpc` フックで bot ID を判定し、禁止 API をリジェクト

改造版ブリッジでは 1 は迂回可能なので **2 が本命**。1 は安全装置。

## 実装フェーズ

### フェーズ 1: nakama 疎通（半日）

- `bridge/` ディレクトリ作成、TypeScript セットアップ
- `.env` から設定読み込み
- device_id 生成・永続化 (`data/device-id.txt`)
- `authenticateDevice` → `socket.connect` → `rpc('ping', ...)` で疎通確認
- 表示名を `🤖 自作CPU` に設定

**完了判定**: tommieChat のユーザ一覧に online で表示される。

### フェーズ 2: 「CPU と対戦」機能の新規実装（2〜3 日）

tommieChat 側にもこの機能がまだ無いため、サーバ・クライアント・ブリッジを合わせて実装する。

#### 2a. サーバ側 (nakama)

- 既存のリバーシマッチ生成 RPC を拡張、または専用 RPC `oth_invite_cpu` を新設
- CPU ボットを一覧可能にする方法を決める:
  - 案 A: 特別な表示名マーカー (`🤖` プレフィックス) でクライアント側フィルタ
  - 案 B: Nakama Group に `cpu-bots` を作り所属ユーザを CPU 扱い
  - 案 C: `storage` に CPU ユーザ ID リストを置く
- CPU 呼び出し通知: 招待チャネル (既存 `oth_invite` 系?) で CPU ボットに通知

#### 2b. クライアント側 (tommieChat)

- リバーシロビーに「CPU と対戦」ボタンを追加
- 押下で `oth_invite_cpu` 呼び出し → CPU 応答でマッチ参加

#### 2c. ブリッジ側（疎通確認用 CLI）

疎通確認と開発デバッグ専用の CLI。本番運用モードではない。

- ロビー招待を監視、自動 accept
- `socket.joinMatch` → `onMatchData` で盤面受信
- ターミナルに盤面を ASCII アートで表示（`A`〜`H` × `1`〜`8`）
- プロンプトで `d3` のような座標 / `pass` / `resign` を受け付け
- 不正手はローカルで弾いて再プロンプト（最低限の合法手チェックのみ）
- 入力を `sendMatchState` で返送

手動プレイを長期運用する必要はない（それが要るなら tommieChat で CPU アカウントに直接ログインすれば済む）。CLI は「通信路が動くか」の確認道具として割り切る。

**完了判定**: tommieChat から「CPU と対戦」で即マッチ成立、ターミナルで 1 局通して打ち切れる。

### フェーズ 3: Node.js の自律化（本番運用モード）

CLI は疎通確認用なので、本番運用は自律 AI に移行する。

- `reversi.ts`: 合法手生成・反転処理・終局判定（フェーズ 2 で最低限作った分を拡張）
- `ai.ts`:
  - レベル 0: ランダム
  - レベル 1: greedy (取れる石最大)
  - レベル 2: 角優先 + αβ 探索 (depth 4〜6)
  - 設定で切替 (`AI_LEVEL=2`)
- モード切替: `MODE=cli` (疎通確認) / `MODE=auto` (本番) を `.env` で指定
- 対局中のログで思考時間・探索ノード数を記録

**完了判定**: `MODE=auto` で無人対戦が合法手で成立。tommieChat 側からは常時対戦可能に見える。

### フェーズ 4: 運用耐性（半日）

- nakama WS 切断の自動再接続（指数バックオフ、最大 60 秒間隔）
- オフライン表現（表示名末尾に `(offline)` 等）
- `pino` で JSON ログ、日次ローテーション
- Windows サービス化: `nssm install tommie-cpu-bridge node dist/index.js`

**完了判定**: PC 再起動後、自動起動・nakama 接続・ロビー常駐まで自動。

### フェーズ 5 (将来): UART 統合

- MCU 側 UART コマンド仕様を設計
- `serialport` + `Readline` パーサで行単位受信
- 思考タイムアウト → 警告ログ + リザイン送出
- 盤面ハッシュ突合で同期ズレ検出
- 内部 AI は「UART 切断時のフォールバック」として残す

**完了判定**: 内部 AI ではなく MCU の着手で対戦が成立。

### フェーズ 6 (任意): Google 認証移行

- tommieChat にトークンエクスポート UI 追加
- ブリッジに `Session.restore` + `sessionRefresh` ループ実装
- device_id 方式と両対応（`tokens.json` があれば優先）

## 配布・パッケージング

開発中は `node dist/index.js` で動かせばよいが、他人の PC で動かす・サービス化する段階では単一 exe 化を検討する。

### パッケージャの選択

フェーズの進行に応じて切り替え:

| フェーズ | パッケージャ | 理由 |
| --- | --- | --- |
| 1〜3 (純 JS) | **Node.js SEA** (Single Executable Applications) | Node 21+ 公式、追加依存なし |
| 5〜 (`serialport` 追加後) | **@yao-pkg/pkg** | ネイティブモジュール (`.node`) のバンドルが得意 |

#### Node.js SEA（初期）

Node 標準機能。`sea-config.json` で設定、`postject` で Node バイナリにブロブ注入。

```bash
cat > sea-config.json <<EOF
{ "main": "dist/index.js", "output": "sea-prep.blob" }
EOF
node --experimental-sea-config sea-config.json
node -e "require('fs').copyFileSync(process.execPath, 'bridge.exe')"
npx postject bridge.exe NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

- 利点: 公式、将来性、ライセンス整理不要
- 欠点: ネイティブモジュールの組込みが面倒（`.node` を別配置して動的 require）

#### @yao-pkg/pkg（UART 統合後）

Vercel pkg の後継コミュニティ版。`package.json` の `pkg.assets` でネイティブ `.node` を同梱できる。

```bash
npm install -g @yao-pkg/pkg
pkg . --targets node20-win-x64 --output dist/bridge.exe
```

```json
// package.json
{
  "pkg": {
    "targets": ["node20-win-x64"],
    "assets": ["node_modules/serialport/**/*.node"]
  }
}
```

### ビルドスクリプト

`bridge/package.json` に両方のレシピを用意して、移行しやすくしておく:

```json
{
  "scripts": {
    "build": "tsc",
    "build:exe": "node --experimental-sea-config sea-config.json && node scripts/make-sea.js",
    "build:exe:pkg": "pkg . --targets node20-win-x64 --output dist/bridge.exe"
  }
}
```

### サイズ・配布

- exe 単体で **80〜100 MB** (Node v20 同梱)。UPX 圧縮は Defender 誤検知増のため非推奨
- 配布 zip 構成: `bridge.exe` + (pkg の場合) `.node` ファイル + `.env.example` + `README.md`

### Windows 11 特有の考慮

1. **コード署名 (Authenticode)**: 未署名だと SmartScreen 警告。長期運用なら EV 証明書（年 3〜20 万円）検討
2. **Defender 誤検知**: SEA/pkg 共に初期は誤検知されやすい。Microsoft に誤検知報告で緩和
3. **サービス化**: `nssm install tommie-cpu-bridge C:\path\to\bridge.exe` で Windows サービス化、PC 起動時に自動開始
4. **インストーラ化 (任意)**: Inno Setup / NSIS で `.msi` / `.exe` インストーラにすれば、サービス登録・アンインストールまで自動化

### フェーズ 4 との関係

[フェーズ 4](#フェーズ-4-運用耐性半日) の「Windows サービス化」は `node dist/index.js` 経由でも `bridge.exe` 経由でも実行可能:

```bash
# 開発中 (Node インストール必要)
nssm install tommie-cpu-bridge "C:\Program Files\nodejs\node.exe" "C:\path\bridge\dist\index.js"

# 配布後 (Node 不要)
nssm install tommie-cpu-bridge "C:\path\bridge.exe"
```

## 実行環境

常駐運用を前提とするため、ホストは据置前提の Linux/Windows マシン:

| ホスト | 用途 | 備考 |
| --- | --- | --- |
| Windows 11 ネイティブ | 本番常駐の第一候補 | `serialport` ネイティブバインディング最も素直、`nssm` でサービス化 |
| Raspberry Pi (Linux) | 本番常駐の代替 | 省電力で 24/7 運用向き、`systemd` でサービス化 |
| WSL2 Ubuntu24 | 開発メイン | フェーズ 1〜3 (純 JS) は OS 非依存、UART 検証は usbipd-win 必須 |

> **Android は本路線の対象外**。Android + ブラウザ経由でシリアルを扱うのは [doc/reversi/59](reversi/59-設計-外部CPU接続.md) の路線。

## 確定事項

- **本ドキュメントは将来オプション**。当面は [doc/reversi/59](reversi/59-設計-外部CPU接続.md) の Web Serial 接続代行方式を優先実装する
- **用途は「独立アカウントでの 24/7 常駐 bot」**に限定。人間 A が自作 CPU を持ち込んで代理接続するユースケースは doc/59 の範囲
- **UART プロトコルは doc/reversi/61 と共通**（`SB\n` / `MOd3\n` 等、送信は LF のみ）。本路線でも同仕様を流用する
- **リポジトリは tommieChat 本体の `bridge/` サブディレクトリ**。複雑化したら別リポジトリへ切り出す
- **Android + Termux ルートは不採用**。`termux-usb` fd が raw usbfs で `read/write` 不可 (EINVAL)、USB-シリアル変換チップのプロトコル自力実装が必要なため。常駐は Windows/RasPi に限る
- **GUI は作らない**。手動プレイしたい場合は tommieChat で CPU アカウントにログインすれば足りる
- **本番運用は Google 認証推奨**。独立アカウント運用なので BAN 実効性のため

## 関連ドキュメント

- [10-ブラウザ側ファイル構成.md](10-ブラウザ側ファイル構成.md)
- [11-RPC関数一覧.md](11-RPC関数一覧.md)（リバーシ `oth*` RPC の参照用）
- [50-設計-部屋システム.md](50-設計-部屋システム.md)
