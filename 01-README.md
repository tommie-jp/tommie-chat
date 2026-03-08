# MMO Node.jS test

---

- Node.jsでTypeScriptのテストプログラム。
- 2026/03/01時点での最新の書き方を試す。
- 実行方法
  - `npm run dev`　TS実行
  - `npm run check` 型チェック
  - `npm run build`　TSコンパイル
  - `npm run start`　JS実行
- Node.js v24 LTS
  
---

## TODO & BUG


- [ ] 地上テーブル更新アルゴリズムの改良
  - [ ] 16x16チャンク化
    - [ ] サーバサイド
    - [ ] クライアントサイド
  - [ ] 一旦、更新のあったチャンク単位で送受信
  - [ ] １箇所だけ更新に対応
- [ ] LANからiPhoneでブラウズ
- [ ] デプロイ準備
  - [ ] 調査：Webサーバ コンテナが必要？
    - [ ] nakamaコンテナに含まれている？
- [ ] 本番デプロイ(さくらVPS)
- [ ] GitHub：プロジェクト作成
- [ ] サーバ接続ログ：サーバサイドtommieChatのバージョンを返す
  - nakamaバージョンには残す。

- [x] BUG-2026-03-01
  - ブラウザをリサイズすると、立方体が見えなくなる（範囲外に行ってしまう）

---

## ディレクトリ構成（簡易）

```text
24-mmo-Tommie-chat/
├── public/              # 静的アセット（ビルドされずそのままコピーされる）
│   ├── models/          # .glb, .gltf ファイル
│   └── textures/        # .jpg, .png 等
├── src/                 # ソースコード
│   ├── shaders/         # カスタムシェーダー (.glsl)
│   ├── app.ts           # Babylon.js のメインロジック
│   └── main.ts          # エントリーポイント
├── index.html           # Canvas要素を配置
├── package.json
└── vite.config.ts       # Vite の詳細設定
```

---

## ディレクトリ構成（詳細）

- 更新：2026/03/08

```text

24-mmo-Tommie-chat/
├── src/                     # クライアント側ソースコード (TypeScript)
│   ├── main.ts              # エントリーポイント
│   ├── GameScene.ts         # Babylon.js のゲームシーンロジック
│   ├── NakamaService.ts     # Nakama サーバとの通信サービス
│   └── typescript.svg       # SVGアセット
├── public/                  # 静的アセット（ビルド時にそのままコピー）
│   ├── favicon.png          # ファビコン
│   ├── vite.svg             # Vite ロゴ
│   └── textures/            # テクスチャファイル (.ktx2)
│       ├── cube.ktx2
│       ├── pic1.ktx2
│       └── pic2.ktx2
├── nakama/                  # MMOサーバー (Nakama) 関連
│   ├── docker-compose.yml   # Nakama + PostgreSQL のコンテナ構成
│   ├── doLog.sh             # ログ確認スクリプト
│   ├── doPSQL.sh            # PostgreSQL 接続スクリプト
│   ├── doRestart.sh         # 再起動スクリプト
│   ├── package.json
│   └── tsconfig.json
├── dist/                    # ビルド出力先
├── doc/                     # ドキュメント
│   ├── 01-nakama-概要.txt
│   └── 02-nakama-サーバ構築.txt
├── pic/                     # 画像素材・変換スクリプト
│   ├── png2ktx.sh           # PNG → KTX2 変換スクリプト
│   ├── pic1.png
│   └── pic2.png
├── ss/                      # スクリーンショット/動画
├── work/                    # 作業用ファイル (KTX-Software .deb等)
├── index.html               # メインHTML (Canvas要素)
├── package.json             # クライアント側依存関係
├── tsconfig.json            # TypeScript 設定
├── vite.config.ts           # Vite ビルド設定
├── 01-README.md             # プロジェクト説明・TODO
└── 24-mmo.code-workspace    # VSCode ワークスペース設定

```

- 概要

- クライアント側 (src/): Babylon.js を使った3D MMOクライアント。Vite でビルド・開発サーバーを起動
- サーバー側 (nakama/): Nakama (Docker) を使ったMMOサーバー。PostgreSQL をバックエンドDBとして使用
- テクスチャ変換: pic/ に元画像を置き、toktx で KTX2 に変換して public/textures/ に配置するワークフロー

---

## ポート番号（Windows 11 からのアクセス）

WSL2 上の Docker で動作。Windows ブラウザからは `localhost` でアクセス可能。

| ポート | URL | 用途 |
| --- | --- | --- |
| 5432 | `localhost:5432` | PostgreSQL（DB クライアントから接続） |
| 7349 | `localhost:7349` | Nakama gRPC API |
| 7350 | `localhost:7350` | Nakama クライアント API（ブラウザゲームの接続先） |
| 7351 | <http://localhost:7351> | Nakama 管理ダッシュボード（admin / password） |
| 9090 | <http://localhost:9090> | Prometheus ダッシュボード |
| 9100 | （内部専用） | Nakama メトリクス（Prometheus が内部で収集、外部公開なし） |

## Docker構成

3つのサービスで構成。

| サービス | イメージ | ポート | 役割 |
| --- | --- | --- | --- |
| postgres | postgres:16-alpine | 5432 | データベース |
| nakama | heroiclabs/nakama:3.35.0 | 7349, 7350, 7351 | MMOゲームサーバー |
| prometheus | prom/prometheus | 9090 | メトリクス監視 |

### postgres

- DB名: `nakama`, ユーザー: `nakama`, パスワード: `localdev`
- 名前付きボリューム `data` でデータ永続化
- ヘルスチェックで起動完了を確認

### nakama

- 起動時にDBマイグレーション (`migrate up`) を実行後、サーバーを起動
- `./` (nakamaディレクトリ) を `/nakama/data` にマウント → `main.js` がランタイムに読み込まれる
- 主要ポート
  - 7350: クライアントAPI (ブラウザからの接続先)
  - 7351: 管理ダッシュボード (admin/password)
  - 7349: gRPC API
  - 9100: Prometheusメトリクス
- セッション有効期限: 7200秒 (2時間)
- ログレベル: DEBUG

### prometheus

- Nakama のメトリクス (`nakama:9100`) を15秒間隔でスクレイピング
- ダッシュボード: `http://localhost:9090`

### 依存関係

prometheus (起動) → nakama (起動) → postgres (ヘルスチェックOK後)

---

- デバッグ用
  - ショートカットキー（Ctrl + Shift + I）による開閉機能

- クロームのコンソールログの以下は無視してよい

```text
Download the React DevTools for a better development experience: https://react.dev/link/react-devtools

Blocked aria-hidden on an element because its descendant retained focus...
```

- Babylon.js（およびWebGPU/WebGL環境）で利用する場合、
- basisuよりも圧倒的に toktx がおすすめです。

```bash
toktx --t2 --encode uastc --genmipmap output.ktx2 input_transparent.png
```

---

## Nakama

- MMOサーバー
- [nakamaサーバのダッシュボードURL](http://127.0.0.1:7351)
  - <http://127.0.0.1:7351>
- ユーザー名: `admin`
- パスワード: `password`
- USERID制限: Nakama の authenticateCustom の第1引数（custom ID）には絵文字が使えません（英数字と ._@+- のみ許可）

> `docker compose`（スペース区切り・v2）を使用。`docker-compose`（ハイフン・v1）は非推奨。

### 基本操作

```bash
cd ./nakama
```

| コマンド | 説明 |
| --- | --- |
| `docker compose up -d` | 全サービスをバックグラウンドで起動 |
| `docker compose down` | 全サービスを停止・コンテナ削除 |
| `docker compose restart` | 全サービスを再起動 |
| `docker compose restart nakama` | Nakama のみ再起動 |
| `docker compose ps` | コンテナの稼働状態を確認 |

### ログ

| コマンド | 説明 |
| --- | --- |
| `docker compose logs nakama` | Nakama のログを表示 |
| `docker compose logs -f nakama` | Nakama のログをリアルタイム表示 |
| `docker compose logs --tail 100 nakama` | 直近100行のログを表示 |
| `docker compose logs` | 全サービスのログを表示 |

### Go プラグインビルド & 反映

```bash
# 1. Go プラグインをビルド
cd ./nakama/go_src
bash build.sh

# 2. Nakama を再起動して反映
cd ..
docker compose restart nakama
```

### データ管理

| コマンド | 説明 |
| --- | --- |
| `docker compose down` | コンテナ削除（データは保持） |
| `docker compose down -v` | コンテナ削除 + ボリューム削除（DB初期化） |

### トラブルシューティング

```bash
# コンテナの状態確認
docker compose ps

# Nakama のヘルスチェック状態
docker inspect --format='{{.State.Health.Status}}' nakama-nakama-1

# 全コンテナを停止・削除して再構築
docker compose down
docker compose up -d
```

---

## Postgres

公式の docker-compose.yml をそのまま起動している場合、PostgreSQLの接続情報は以下のようになっています。

ホスト: 127.0.0.1 (または localhost)
ポート: 5432
データベース名: nakama
ユーザー名: nakama(postgresではないので注意)
パスワード: localdev（localdbではない）

### PSQLコマンド

```bash
# 1. postgresコンテナ内でpsqlコマンドを実行してログインします
docker compose exec postgres psql -U nakama -d nakama

# --- ここからpsqlのプロンプト (nakama=#) に変わります ---

# 2. テーブルの一覧を表示する
\dt

# 3. 特定のテーブル（例: users）の構造（カラム情報など）を確認する
\d users

# 4. psqlを終了して元のターミナルに戻る
\q


---
2. ユーザー「nakama」のパスワードを「localdb」に強制変更する

SQL
ALTER USER nakama WITH PASSWORD 'localdb';
※ ALTER ROLE と表示されれば成功です。

```

---

## メモ

地面をBキー＋クリックで立方体

---

## テスト用

```text
1
2
3
4
5
6
7
8
9
10

012345678911234567892123456789312345678941234567895123456789

- 半角40文字

a234567891123456789212345678931234567894

- 1行 半角41文字

a2345678911234567892123456789312345678941

- 2行 半角41文字

a2345678911234567892123456789312345678941
b2345678911234567892123456789312345678941

- 6行 半角41文字

a2345678911234567892123456789312345678941
b2345678911234567892123456789312345678941
c2345678911234567892123456789312345678941
d2345678911234567892123456789312345678941
e2345678911234567892123456789312345678941
f2345678911234567892123456789312345678941

- x

3
4
5
6
7
8
9
10

- 複数行 空白トリムを確認

 先頭に半角空白あり

- 複数行 顔文字

　 ∧＿∧
　（　´∀｀）
　（　　　　）
　｜ ｜　|
　（_＿）＿）

- 顔文字
  
　　　∧∧
　　　(,,ﾟДﾟ)
　　 /　　|
　～（,,＿ﾉ

　　∩＿＿＿∩
　 | ノ　　　　　 ヽ
　/　　●　　　● |
|　　　　( _●_)　 ミ
彡､　　　|∪|　　､｀＼

　　　＿＿＿_
　　／　　 　 　＼
　／　　─　 　 ─＼
／ 　　 （●） 　（●） ＼
|　 　　 　 （__人__）　 　 |
/　　　　 　 ∩ノ ⊃　　／
(　 ＼　／ ＿ノ　|　 |
.＼　“　　／＿＿|　 |
　　＼ ／＿＿＿ ／

```

---

## Prometheus クエリ（Nakama 3.35.0）

<http://localhost:9090> でクエリ実行。

### プレイヤー・セッション

| クエリ | 内容 |
| --- | --- |
| [nakama_sessions](http://localhost:9090/query?g0.expr=nakama_sessions&g0.tab=graph) | アクティブセッション数 |
| [nakama_presences](http://localhost:9090/query?g0.expr=nakama_presences&g0.tab=graph) | プレゼンス数（マッチ参加者等） |
| [nakama_socket_ws_opened - nakama_socket_ws_closed](http://localhost:9090/query?g0.expr=nakama_socket_ws_opened%20-%20nakama_socket_ws_closed&g0.tab=graph) | 現在の WebSocket 接続数 |

### マッチ

| クエリ | 内容 |
| --- | --- |
| [nakama_authoritative_matches](http://localhost:9090/query?g0.expr=nakama_authoritative_matches&g0.tab=graph) | 稼働中のマッチ数 |

### API パフォーマンス

| クエリ | 内容 |
| --- | --- |
| [rate(nakama_Rpc_count[5m])](http://localhost:9090/query?g0.expr=rate(nakama_Rpc_count%5B5m%5D)&g0.tab=graph) | RPC コール数/秒 |
| [rate(nakama_overall_count[5m])](http://localhost:9090/query?g0.expr=rate(nakama_overall_count%5B5m%5D)&g0.tab=graph) | 全 API コール数/秒 |
| [nakama_Rpc_latency_ms](http://localhost:9090/query?g0.expr=nakama_Rpc_latency_ms&g0.tab=graph) | RPC レイテンシ |

### データベース

| クエリ | 内容 |
| --- | --- |
| [nakama_db_in_use_conns](http://localhost:9090/query?g0.expr=nakama_db_in_use_conns&g0.tab=graph) | DB アクティブ接続数 |
| [nakama_db_total_open_conns](http://localhost:9090/query?g0.expr=nakama_db_total_open_conns&g0.tab=graph) | DB 総接続数 |

---

## GOについて

Nakama の場合、Go 一択がおすすめです。理由:

Go は遅くない — 「JSと同程度」は誤解です。Go はコンパイル言語で、一般的にJSの2〜5倍高速です。Cより遅いのは事実ですが、ゲームサーバ用途では十分すぎる性能です。

Nakama 公式の推奨 — Nakama 自体が Go で書かれており、Go プラグインはネイティブ実行されます。JS/Lua ランタイムはインタプリタ経由なので、Go プラグインの方が高速です。

Go vs Lua vs JS（Nakama内）:

Go: ネイティブ速度、型安全、並行処理が得意
Lua: 軽量だが機能制限あり
JS: TypeScript→JSにトランスパイル必要、VMオーバーヘッドあり
今回のチャンク排他制御のように sync.RWMutex が使えるのも Go の強みです。JS/Lua ではこのレベルの並行制御はできません。

結論: Nakama 拡張には Go が最適です。現在の選択は正しいです。

---
