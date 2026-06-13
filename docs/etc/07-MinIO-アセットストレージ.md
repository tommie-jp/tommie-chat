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
- [バックアップとリストア](#バックアップとリストア)
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

nginx で十分なもの（`/public/` → `dist/` 同梱配信）:

- ビルド済みの HTML/JS/CSS (`dist/`)
- 開発者が用意した固定アセット (マップ、エフェクト)
- **静的な音源ファイル** — `public/sounds/notification.mp3` など全ユーザー共通・不変のもの
- **デフォルトアバター群** — `public/avatars/*.png`（`nakama/doStatic-set-avatars.sh` が `nakama/avatars.json` を元に配置）

MinIO が必要なもの（`/s3/` プロキシ経由）:

- ユーザーがアップロードしたアバター — S3 API で受け取り、`avatars` バケットに保存（`/s3/avatars/*.png`）
- Nakama から動的にファイル管理 — Go ランタイムから S3 API でアセットの読み書き
- UGC (ユーザー生成コンテンツ) — ユーザーが素材を投稿・共有する仕組み

### 判断基準: 静的アセット vs MinIO

**原則**: 「全ユーザー共通・バージョンに紐付く不変アセット」は `/public/`、「ユーザー固有・動的・大量」は MinIO。

| 観点 | `/public/` (静的配信) | MinIO (`/s3/`) |
| ------ | ------ | ------ |
| ライフサイクル | コードと一緒にリリース | ユーザー操作でいつでも追加/削除 |
| ファイル数 | 有限・既知 | 無制限に増える |
| バージョン整合性 | コードと同じリリースに紐付き回帰しづらい | 別系統、壊すと UI と不整合になり得る |
| CSP | `'self'` のみで足りる | `media-src`/`img-src` に別オリジン追記が必要（設定次第） |
| Service Worker | オフライン対応しやすい | クロスオリジンで CORS/キャッシュ設定が必要 |
| 障害範囲 | SPA 本体と運命共同体（分かりやすい） | MinIO 障害で該当機能のみ停止 |
| iOS/iPad Safari | AudioContext/HTMLAudio 解禁が安定 | クロスオリジンだと decode 失敗事例あり |

**例:**

- `notification.mp3` → `/public/sounds/` が正解（全ユーザー共通・不変・再生タイミング＝コードと密接）
- **デフォルトアバター** → `/public/avatars/` が正解（有限・既知・ユーザーの大多数はここから選ぶ）
- **ユーザーがアップロードしたアバター** → MinIO `/s3/avatars/` が正解（UGC・無制限に増える）
- マップタイル・効果音ライブラリ → `/public/` が基本、UGC 部分のみ MinIO

### アバターの二段構成: `/avatars/` と `/s3/avatars/`

現状、アバター画像の UGC アップロード機能は設計上の目標ではあるが、
実際にユーザーが自前素材を投稿するケースは少ないと想定している。
大多数のユーザーはデフォルトアバター群から選ぶため、**既知のデフォルト群を
静的配信側に置くことで MinIO 障害の影響範囲を大幅に縮小できる**。

URL の名前空間:

| URL プレフィックス | 配信経路 | 用途 | ライフサイクル |
| ------ | ------ | ------ | ------ |
| `/avatars/NNN-xxx.png` | nginx 静的配信 (`dist/avatars/`) | デフォルトアバター群 | コードと一緒にリリース |
| `/s3/avatars/*.png` | nginx → MinIO プロキシ | ユーザーアップロード (将来) | UGC |

クライアント側のバリデーション ([src/utils.ts](../src/utils.ts) `isAvatarUrl`) と
サーバ側 (`nakama/go_src/main.go` `sanitizeTextureUrl`) は両方のプレフィックスを許可する。

#### `public/avatars/` の更新フロー

`public/avatars/` は git 管理外（`.gitignore` 済み）。`nakama/avatars.json` を
正とし、`nakama/doStatic-set-avatars.sh` が配置する。

```bash
# ローカルPNGから public/avatars/ へ配置（差分コピー）
./nakama/doStatic-set-avatars.sh

# ミラーモード（ローカルに無いファイルは削除）
./nakama/doStatic-set-avatars.sh --prune
```

スクリプトの動作:

- `nakama/avatars.json` の `enable: true` エントリの `png_paths` を `public/avatars/` にコピー
- 命名規則は `doS3-set-avatars.sh` と同じ `NNN-<filename>.png`（親ディレクトリの先頭数字を3桁ゼロ埋め）
- `enable != true` のエントリに該当するファイルが残っていれば削除
- 最後に `public/avatars/manifest.json` を生成（`{"files":["001-...png",...]}`）

ブラウザ側のアバター一覧取得は `manifest.json` を fetch する
([src/utils.ts](../src/utils.ts) `fetchAvatarList`)。MinIO の S3 XML ListBucketResult を
パースする経路は使わないため、MinIO 障害時でもアバター選択UIは動作する。

#### ビルド時の同梱

`public/` は Vite のビルドで `dist/` にコピーされるため、`npm run build` 後の
`dist/avatars/` 配下にデフォルトアバターが含まれる。デプロイ時 `doDeploy.sh` が
`dist/` を本番サーバへ転送するため、ブラウザからは `/avatars/*.png` として
nginx 直接配信される。

#### 既存ユーザーへの影響

`localStorage.spriteAvatarUrl` に旧形式 `/s3/avatars/NNN-xxx.png` が残っているユーザーは、
[src/GameScene.ts](../src/GameScene.ts) `loadAvatarUrlFromStorage` が初回読込時に
自動で `/avatars/NNN-xxx.png` に書き換える。
サーバ側 `user_meta/initial_avatar_idx` はインデックス整数で保存しているため影響なし。

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

`doDeploy.sh` が MinIO のセットアップを自動で行います:

- `.env` に `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` を自動生成
- `docker-compose.prod.yml` で MinIO を `127.0.0.1` バインド + `restart: unless-stopped` で起動
- 起動後に `avatars`, `assets`, `uploads` バケットを作成し public-read ポリシーを設定
- 本番用 `nginx.conf` に `/s3/` → MinIO プロキシを自動設定

手動でのデプロイは不要ですが、ローカルの既存データを移行する場合は以下の手順を使用します。

### データ移行: volume をエクスポート → インポート

#### 1. ローカル: volume をエクスポート

```bash
cd nakama
docker compose run --rm -v nakama_minio_data:/data -v $(pwd):/backup \
  alpine tar czf /backup/minio-data.tar.gz -C / data
```

#### 2. ローカル: さくらVPS へ転送

```bash
scp minio-data.tar.gz user@sakura-vps:/path/to/nakama/
```

#### 3. さくらVPS: volume にインポート

```bash
cd /path/to/nakama

# コンテナを起動して volume を作成
docker compose up -d minio
docker compose down

# データをインポート
docker compose run --rm -v nakama_minio_data:/data -v $(pwd):/backup \
  alpine tar xzf /backup/minio-data.tar.gz -C /
```

#### 4. さくらVPS: 本番起動

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d minio
```

#### デプロイ時に必要なもの

| 項目 | 方法 |
| ------ | ------ |
| イメージ | `docker compose pull` (公式イメージ) |
| データ | volume を tar でエクスポート → scp → インポート |
| 設定 | `docker-compose.yml` は Git で管理済み |
| パスワード | `.env` で本番用に変更 |

#### データの更新デプロイ

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

## バックアップとリストア

### 自動バックアップ

`doDeploy.sh` はコンテナ停止前に MinIO ボリュームを自動バックアップする。

- 保存先: `nakama/backup/minio-data-YYYYMMDD-HHMMSS.tar.gz`
- 3世代まで保持（それ以前は自動削除）
- PostgreSQL ボリュームは毎回削除されるが、MinIO ボリュームは保持される

### 手動バックアップ

```bash
cd nakama

# MinIO ボリューム名を確認
docker volume ls | grep minio_data

# バックアップ（例: tommchat-prod_minio_data）
mkdir -p backup
docker run --rm \
  -v tommchat-prod_minio_data:/data:ro \
  -v $(pwd)/backup:/backup \
  alpine tar czf /backup/minio-data-$(date +%Y%m%d-%H%M%S).tar.gz -C / data
```

### リストア

```bash
cd nakama

# ボリュームを作成（存在しない場合）
docker volume create tommchat-prod_minio_data

# バックアップからリストア
docker run --rm \
  -v tommchat-prod_minio_data:/data \
  -v $(pwd)/backup:/backup \
  alpine tar xzf /backup/minio-data-XXXXXXXX-XXXXXX.tar.gz -C /

# MinIO を起動して確認
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d minio
```

### MinIO データコピースクリプト

`doMigrateMinIO.sh` でローカルと VPS 間の MinIO ボリュームデータをコピーできる。
開発環境（WSL2 Ubuntu 24.04）から実行する。

```bash
# ローカル → VPS（デプロイ時）
./nakama/doMigrateMinIO.sh mmo.tommie.jp

# VPS → ローカル（開発環境に持ってくる）
./nakama/doMigrateMinIO.sh mmo.tommie.jp --pull
```

処理の流れ:

1. 転送元の MinIO ボリュームを検出
2. Docker volume を tar.gz にエクスポート
3. SCP で転送先に送信
4. 転送先の Docker volume にインポート
5. 転送先の MinIO を自動再起動

push 時はエクスポートした tar.gz を `nakama/backup/` にも保存する（3世代保持）。

## 本番環境の注意事項

- `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` は `doDeploy.sh` が自動生成する（手動変更不要）
- TLS (HTTPS) は `doSetupHTTPS.sh` で設定する（ホスト nginx が HTTPS 終端、MinIO は HTTP のまま）
- `doDeploy.sh` は PostgreSQL ボリュームのみ削除し、MinIO ボリュームは保持する
- `doDeploy.sh` はコンテナ停止前に MinIO ボリュームを `nakama/backup/` に自動バックアップする
- `docker-compose.prod.yml` で `restart: unless-stopped` 設定済み
