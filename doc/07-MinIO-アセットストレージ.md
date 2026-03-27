# MinIO アセットストレージ (S3互換)

tommieChat のアバタースプライトシートや共通アセットを管理するための
S3互換オブジェクトストレージ。MinIO を Docker コンテナで運用する。

## 目次

- [なぜ MinIO を使うのか](#なぜ-minio-を使うのか)
- [サービス情報](#サービス情報)
- [起動・停止](#起動停止)
- [ポート公開](#ポート公開)
- [管理コンソール](#管理コンソール)
- [バケット構成 (推奨)](#バケット構成-推奨)
- [Nakama との連携](#nakama-との連携)
- [Web (nginx) からのアクセス](#web-nginx-からのアクセス)
- [mc (MinIO Client) によるバケット作成](#mc-minio-client-によるバケット作成)
- [ローカルテスト手順](#ローカルテスト手順)
- [自動テスト](#自動テスト)
- [本番デプロイ手順（さくらVPS）](#本番デプロイ手順さくらvps)
- [本番環境の注意事項](#本番環境の注意事項)

## なぜ MinIO を使うのか

### nginx 静的配信との比較

| 項目 | nginx 静的ファイル配信 | MinIO (S3互換) |
| ------ | ------ | ------ |
| ファイル配置 | サーバーのディレクトリに直接配置 | API またはGUIでアップロード |
| デプロイ | git push / scp / rsync | volume コピー / mc mirror |
| ファイル追加 | サーバーにSSHして配置 | GUI / CLI / API でアップロード |
| アクセス制御 | nginx設定で制御 | バケット単位でポリシー設定 |
| ユーザーアップロード | 自前で実装が必要 | S3 API で標準対応 |
| メタデータ | ファイルシステムのみ | オブジェクトごとにメタデータ付与可 |
| バージョニング | git 等で別途管理 | バケット機能で自動管理 |
| スケーラビリティ | 単一サーバー | 分散ストレージ対応 |
| パフォーマンス | 高速 (直接配信) | ほぼ同等 (nginx プロキシ経由) |
| 運用コスト | なし (nginx に同梱) | コンテナ1つ追加 |

### tommieChat での使い分け

nginx で十分なもの:

- ビルド済みの HTML/JS/CSS (`dist/`)
- 開発者が用意した固定アセット (マップ、エフェクト)

MinIO が必要なもの:

- ユーザーがアバターをアップロード — S3 API で受け取り、バケットに保存
- Nakama から動的にファイル管理 — Go ランタイムから S3 API でアセットの読み書き
- UGC (ユーザー生成コンテンツ) — ユーザーが素材を投稿・共有する仕組み

### 従来のファイルアップロードとの違い

従来: `ブラウザ → nginx → Nakama (Go) → ファイルシステムに保存`
MinIO: `ブラウザ → nginx → Nakama (Go) → MinIO に保存`

| 項目 | 自前実装 | S3 API (MinIO) |
| ------ | ------ | ------ |
| 保存処理 | `os.WriteFile()` + パス管理 | `client.PutObject()` 1行 |
| ファイル名衝突 | UUID生成 + 重複チェック実装 | バケット内キーで自動管理 |
| 容量制限 | ディスク監視を自前実装 | バケットクォータで設定 |
| ファイル削除 | `os.Remove()` + ゴミ掃除 | `client.RemoveObject()` |
| 一覧取得 | `os.ReadDir()` + ソート実装 | `client.ListObjects()` でメタデータ付き |
| 不正ファイル対策 | MIMEチェック自前実装 | Content-Type 自動判定 + ポリシーで制限 |
| ユーザー別制限 | 全部自前実装 | IAMポリシーでユーザー別バケット制御 |
| 将来の移行 | 作り直し | AWS S3 / Cloudflare R2 に API互換で移行可 |

S3 API を使うことで、Nakama の Go コードはビジネスロジック
(「このユーザーはアップロードできるか？」「ファイルサイズは制限内か？」)
だけに集中できる。

### メタデータ管理方針

S3 オブジェクトにはメタデータを付与できるが、検索やフィルタはできない。
tommieChat では Nakama が既に PostgreSQL を使っているため、
**ファイルの属性・出典情報は全て PostgreSQL で管理** し、
MinIO はファイルの保存・配信だけに専念する。

| 管理対象 | 保存先 | 理由 |
| ------ | ------ | ------ |
| ファイル実体 | MinIO | S3 API で保存・配信 |
| 出典情報 (作者, ライセンス, URL) | PostgreSQL | SQLで一元管理 |
| 検索属性 (カテゴリ, タグ, 性別) | PostgreSQL | SQLで検索・フィルタ |
| アップロード情報 (ユーザー, 日時) | PostgreSQL | ユーザー管理と統合 |

## サービス情報

| 項目 | 値 |
| ------ | ------ |
| イメージ | `minio/minio:latest` |
| S3 API | `minio:9000` (コンテナ内) |
| 管理コンソール | `minio:9001` (コンテナ内) |
| データ永続化 | Docker volume `minio_data` |

## 起動・停止

`nakama/` ディレクトリで実行する。

```bash
cd nakama

# 開発時 (ポート公開あり)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d minio

# 本番 (ポート公開なし、コンテナ間通信のみ)
docker compose up -d minio

# 停止
docker compose down minio

# ログ確認
docker compose logs -f minio

# 状態確認
docker compose ps minio
```

## ポート公開

`docker-compose.yml` では `expose` のみ (コンテナ間通信)。
ホストからのアクセスは `docker-compose.dev.yml` で開発時のみ公開する。

| ポート | 用途 | 本番 | 開発 |
| ------ | ------ | ------ | ------ |
| 9000 | S3 API | expose | ports |
| 9001 | 管理コンソール | expose | ports |

## 管理コンソール

開発時のみブラウザで <http://localhost:9001> にアクセス可能。
`docker-compose.dev.yml` を併用して起動する必要がある。

```bash
cd nakama
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d minio
```

### ログイン

- URL: <http://localhost:9001>
- ユーザー: `minioadmin` (デフォルト)
- パスワード: `minioadmin` (デフォルト)

環境変数 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` で変更可能。

### 主な機能

#### Object Browser (ファイル管理)

- 左メニュー「Object Browser」でバケット一覧を表示
- バケットを選択してファイルをブラウズ
- 「Upload」ボタンでファイルをドラッグ&ドロップアップロード
- ファイルを選択してダウンロード・削除・プレビュー
- フォルダの作成・ファイルの移動も可能

#### Buckets (バケット管理)

- 左メニュー「Buckets」でバケットの作成・削除
- 「Access Policy」で公開設定 (private / public / custom)
- バージョニング・オブジェクトロックの有効化

#### Access Keys (アクセスキー管理)

- 左メニュー「Access Keys」でアクセスキーの発行・無効化
- アプリケーション用にルートキーとは別のキーを発行できる
- キーごとにポリシー (読み取り専用等) を設定可能

#### Monitoring (監視)

- 左メニュー「Monitoring」でダッシュボードを表示
- ストレージ使用量・リクエスト数・帯域を確認

### よくある操作例

**バケットを作成して公開設定にする:**

1. 「Buckets」→「Create Bucket」→ バケット名を入力 → 「Create Bucket」
2. 作成したバケットの「Manage」→「Access Policy」→「public」に変更

**ファイルをアップロードする:**

1. 「Object Browser」→ バケットを選択
2. 「Upload」→「Upload File」→ ファイルを選択またはドラッグ&ドロップ

**既存バケットを公開設定にする (Access Denied 対処):**

バケットはデフォルトで `Private` のため、S3 API 経由のアクセスは拒否される。
CLI でポリシーを変更する:

```bash
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc anonymous set download local/バケット名
```

変更後 `http://localhost:9000/バケット名/ファイル名` でアクセス可能になる。

注: 管理コンソール (Community Edition) ではバケットのアクセスポリシー変更画面が
表示されない場合がある。その場合は CLI を使用すること。

**共有リンクを取得する:**

1. 「Object Browser」→ ファイルを選択
2. 「Share」→ 有効期限を設定 → リンクをコピー

## バケット構成 (推奨)

| バケット名 | 用途 | アクセス |
| ------ | ------ | ------ |
| `avatars` | アバタースプライトシート | public-read |
| `assets` | 共通アセット (マップ、エフェクト等) | public-read |
| `uploads` | ユーザーアップロード素材 | private |

## Nakama との連携

### 接続情報の設定

`docker-compose.yml` の nakama サービスに以下の環境変数を追加済み:

```yaml
--runtime.env MINIO_ENDPOINT=minio:9000
--runtime.env MINIO_ACCESS_KEY=${MINIO_ROOT_USER:-minioadmin}
--runtime.env MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD:-minioadmin}
--runtime.env MINIO_USE_SSL=false
```

Go ランタイムからは `ctx.GetEnv("MINIO_ENDPOINT")` 等で参照できる。

### Go ランタイムからの利用例

```go
import "github.com/minio/minio-go/v7"

client, err := minio.New("minio:9000", &minio.Options{
    Creds:  credentials.NewStaticV4("minioadmin", "minioadmin", ""),
    Secure: false,
})
```

## Web (nginx) からのアクセス

`nakama/nginx.conf` に `/s3/` リバースプロキシを追加済み:

```nginx
location /s3/ {
    proxy_pass http://minio:9000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
}
```

ブラウザからのアクセス例: <http://localhost/s3/avatars/sprite.png>

`/assets/` は既存の静的ファイルキャッシュ用のため、MinIO には `/s3/` パスを使用する。

`docker-compose.yml` の web サービスは minio への依存 (`depends_on`) を設定済み。
minio が healthy になるまで nginx は起動しない (502 エラー回避)。

## mc (MinIO Client) によるバケット作成

```bash
# コンテナ内で実行
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/avatars
docker compose exec minio mc mb local/assets
docker compose exec minio mc mb local/uploads

# public-read ポリシー設定
docker compose exec minio mc anonymous set download local/avatars
docker compose exec minio mc anonymous set download local/assets
```

## ローカルテスト手順

### 1. MinIO を起動

```bash
cd nakama
docker compose up -d minio
docker compose ps minio  # healthy を確認
```

### 2. バケットを作成

```bash
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/avatars
docker compose exec minio mc anonymous set download local/avatars
```

### 3. ファイルをアップロード

```bash
# ホスト側のファイルをコンテナ経由でアップロード
docker compose cp ../lib/babylon-rpgmaker-sprites/sample.png minio:/tmp/sample.png
docker compose exec minio mc cp /tmp/sample.png local/avatars/sample.png

# アップロード確認 (ファイル一覧)
docker compose exec minio mc ls local/avatars/
```

### 4. ブラウザから参照

nginx 経由 (web サービス起動済みの場合):

```text
http://localhost/s3/avatars/sample.png
```

MinIO に直接アクセス (ポート公開時):

```text
http://localhost:9000/avatars/sample.png
```

### 5. 管理コンソールで確認

ブラウザで <http://localhost:9001> にアクセスし、
minioadmin / minioadmin でログイン。バケットやファイルをGUIで管理できる。

### 6. ファイルの削除

```bash
# 個別削除
docker compose exec minio mc rm local/avatars/sample.png

# バケット内全削除
docker compose exec minio mc rm --recursive --force local/avatars/
```

### ポート公開 (開発時)

ホストから直接アクセスするには `docker-compose.dev.yml` を併用する:

```bash
cd nakama
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d minio
```

これにより 9000 (S3 API) と 9001 (管理コンソール) がホストに公開される。
本番では `docker-compose.yml` のみ使用し、ポートは公開しない。

## 自動テスト

`test/minio/doTest-minio.sh` で MinIO の疎通テストを実行できる。

プロジェクトルート (`24-mmo-Tommie-chat/`) で実行する。

```bash
cd 24-mmo-Tommie-chat

# MinIO 起動
docker compose -f nakama/docker-compose.yml up -d minio

# テスト実行
./test/minio/doTest-minio.sh
```

テスト内容:

1. コンテナ起動確認 (healthcheck)
2. mc alias 設定
3. テスト用バケット作成
4. ファイルアップロード
5. ファイル参照 (内容一致確認)
6. ファイル一覧
7. ファイル削除
8. バケット削除 (クリーンアップ)

テスト用バケット (`test-minio-tmp`) は終了時に自動削除される。

## 本番デプロイ手順（さくらVPS）

イメージは公式 (`minio/minio:latest`) をそのまま使うため DockerHub へのプッシュは不要。
コピーが必要なのは volume のデータのみ。

### 1. ローカル: volume をエクスポート

```bash
cd nakama
docker compose run --rm -v nakama_minio_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/minio-data.tar.gz -C / data
```

### 2. ローカル: さくらVPS へ転送

```bash
scp minio-data.tar.gz user@sakura-vps:/path/to/nakama/
```

### 3. さくらVPS: volume にインポート

```bash
cd /path/to/nakama

# コンテナを起動して volume を作成
docker compose up -d minio
docker compose down

# データをインポート
docker compose run --rm -v nakama_minio_data:/data -v $(pwd):/backup \
  alpine tar xzf /backup/minio-data.tar.gz -C /
```

### 4. さくらVPS: 本番起動

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d minio
```

### デプロイ時に必要なもの

| 項目 | 方法 |
| ------ | ------ |
| イメージ | `docker compose pull` (公式イメージ) |
| データ | volume を tar でエクスポート → scp → インポート |
| 設定 | `docker-compose.yml` は Git で管理済み |
| パスワード | `.env` で本番用に変更 |

### データの更新デプロイ

ローカルでファイルを追加・変更した後、本番に反映する場合:

```bash
# volume 全体の再エクスポート → 転送 → インポート
# (上記手順 1〜3 を再実行)
```

ファイル数が増えてきた場合は `mc mirror` で差分同期も可能:

```bash
# ローカルから本番へ差分同期
docker compose exec minio mc alias set prod https://minio.example.com PROD_KEY PROD_SECRET
docker compose exec minio mc mirror --overwrite local/avatars prod/avatars

# ドライラン (確認用、実際には転送しない)
docker compose exec minio mc mirror --dry-run local/avatars prod/avatars
```

## 本番環境の注意事項

- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` を必ず変更する
- TLS (HTTPS) を有効化する
- バックアップ戦略を検討する (`mc mirror` 等)
- `restart: "no"` を `restart: unless-stopped` に変更する
