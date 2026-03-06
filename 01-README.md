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

- [x] BUG-2026-03-01
  - ブラウザをリサイズすると、立方体が見えなくなる（範囲外に行ってしまう）

---

## ディレクトリ構成

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
- 起動

```bash
cd ./nakama
docker-compose up -d

```

- [nakamaサーバのダッシュボードURL](http://127.0.0.1:7351)
  - <http://127.0.0.1:7351>
- ユーザー名
  - `admin`
- パスワード
  - `password`

---

- USERID制限
  - Nakama の authenticateCustom の第1引数（custom ID）には絵文字が使えません（英数字と ._@+- のみ許可）

---

## Postgres

公式の docker-compose.yml をそのまま起動している場合、PostgreSQLの接続情報は以下のようになっています。

ホスト: 127.0.0.1 (または localhost)
ポート: 5432
データベース名: nakama
ユーザー名: nakama(postgresではないので注意)
パスワード: localdb

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
```

---
2. ユーザー「nakama」のパスワードを「localdb」に強制変更する

SQL
ALTER USER nakama WITH PASSWORD 'localdb';
※ ALTER ROLE と表示されれば成功です。

---

## メモ

地面をBキー＋クリックで立方体


---
