# tommChat

> **プロジェクトの状態:** 現在、鋭意開発中です。まだサーバ公開していません。近日公開予定。

ブラウザで動く3D MMOチャットゲームです。
Babylon.js + Nakama で構築されたリアルタイムマルチプレイヤー環境で、ブロックを置いたりチャットしたりできます。

## スクリーンショット

（準備中）

## 特徴

- ブラウザだけで動作（インストール不要）
- 3Dワールドでリアルタイムチャット
- ブロック配置によるワールド編集
- 複数ユーザーの同時接続に対応
- デバイス認証によるかんたんログイン

## 技術スタック

| 項目 | 技術 |
|---|---|
| 3Dエンジン | [Babylon.js](https://www.babylonjs.com/) 8.x |
| ゲームサーバー | [Nakama](https://heroiclabs.com/nakama/) 3.35 |
| サーバーロジック | Go |
| フロントエンド | TypeScript |
| ビルドツール | Vite |
| データベース | PostgreSQL 16 |
| コンテナ | Docker Compose |

## 必要な環境

- Node.js v24 LTS
- Docker / Docker Compose
- Go（サーバープラグインのビルドに必要）

## セットアップ

### 1. リポジトリのクローン

```bash
git clone https://github.com/open-tommie/tommie-chat.git
cd tommie-chat
```

### 2. クライアント（フロントエンド）

```bash
npm install
npm run build
```

### 3. サーバー（Nakama）

```bash
# 環境変数の設定
cp nakama/.env.example nakama/.env

# サーバー起動
cd nakama && docker compose up -d && cd ..

# Go プラグインのビルド＆反映
bash nakama/doBuild.sh --fresh
```

### 4. ブラウザで確認

<http://localhost> を開きます（nginx 経由で `dist/` を配信）。

開発中は `npm run dev` で Vite 開発サーバー (<http://localhost:5173>) も使えます。

### 5. テスト

```bash
# 型チェック
npm run check

# ユニットテスト
npm test

# 統合テスト（Nakamaサーバー起動中に実行）
bash test/doAll.sh

# 全ファイル文法チェック
bash test/doLint.sh
```

## ポート番号

| ポート | 用途 |
|---|---|
| 80 | Web フロントエンド (nginx) |
| 5173 | Vite 開発サーバー |
| 5432 | PostgreSQL |
| 6060 | Go pprof プロファイラ |
| 7349 | Nakama gRPC API |
| 7350 | Nakama クライアント API |
| 7351 | Nakama 管理ダッシュボード |
| 9090 | Prometheus メトリクス |

## 操作方法

- **ログイン**: ユーザIDを入力してログインボタン
- **ブロック配置**: Bキー + クリック
- **チャット**: 下部のテキスト入力欄からメッセージ送信

## ディレクトリ構成

```text
tommChat/
├── src/                  # クライアント側ソースコード (TypeScript)
│   ├── main.ts           # エントリーポイント
│   ├── GameScene.ts      # Babylon.js ゲームシーン
│   ├── NakamaService.ts  # Nakama サーバー通信
│   ├── UIPanel.ts        # UI パネル
│   ├── AOIManager.ts     # AOI (Area of Interest) 管理
│   ├── AvatarSystem.ts   # アバター管理
│   ├── ChunkDB.ts        # チャンクデータベース
│   ├── CloudSystem.ts    # 雲エフェクト
│   ├── NPCSystem.ts      # NPC 管理
│   ├── Profiler.ts       # パフォーマンス計測
│   ├── WorldConstants.ts # ワールド定数
│   └── DebugOverlay.ts   # デバッグオーバーレイ
├── public/               # 静的アセット
│   └── textures/         # テクスチャ (.ktx2)
├── nakama/               # サーバー側
│   ├── docker-compose.yml
│   ├── go_src/           # Go サーバープラグイン (main.go)
│   ├── nginx.conf        # リバースプロキシ設定
│   ├── doBuild.sh        # プラグインビルドスクリプト
│   └── doRestart.sh      # サーバー再起動スクリプト
├── test/                 # テストスクリプト・テストコード
│   ├── doAll.sh          # 全テスト一括実行
│   ├── doLint.sh         # 文法チェック
│   ├── doNight.sh        # 夜間長時間テスト
│   ├── doTest-*.sh       # 各種テストスクリプト
│   ├── nakama-*.test.ts  # Vitest テストファイル
│   └── log/              # テストレポート出力先
├── doc/                  # ドキュメント
├── pic/                  # 画像素材・変換スクリプト
├── .github/              # GitHub Actions / Dependabot
├── index.html            # メイン HTML
├── package.json
├── vite.config.ts
├── vitest.config.ts
└── tsconfig.json
```

## 貢献

[CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

## ライセンス

[MIT License](LICENSE)

## 作者

- tommie.jp
- X: [@tommie_nico](https://x.com/tommie_nico)
