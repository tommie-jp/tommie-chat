# LAN 配布用 Docker 対応

社内 LAN 等で tommieChat を HTTP のみで動かすために必要な修正の調査メモ。

## 背景

- 本番環境は HTTPS 前提（`mmo.tommie.jp`）
- 他の人が手軽に試せるよう、`docker compose up` だけで動く構成にしたい
- LAN 環境ではドメイン名・SSL 証明書がないため HTTP で動かす必要がある

## 現状：クライアントコードの HTTP/HTTPS 対応状況

クライアント側はすでに **HTTP と HTTPS の両方に自動対応** している。

| 箇所 | 方式 | 評価 |
| ---- | ---- | ---- |
| WebSocket プロトコル (`NakamaService.ts:32,144,251`) | `location.protocol` で `ws://` / `wss://` を自動切替 | OK |
| Cookie Secure フラグ (`NakamaService.ts:158`) | HTTPS 時のみ `;Secure` 付与 | OK |
| Nakama SDK の useSSL (`NakamaService.ts:144,226`) | `location.protocol === "https:"` で自動判定 | OK |
| UIPanel.ts の Cookie | Secure フラグなし（HTTP でも動作） | OK |
| PWA manifest (`public/manifest.json`) | `start_url: "./"` 相対パス | OK |
| Vite dev サーバー (`vite.config.ts`) | すべて HTTP ベース | OK |
| docker-compose.yml ベース | 内部通信はすべて HTTP | OK |

## 問題箇所（修正が必要）

### 1. nginx.conf の CSP `connect-src`（致命的）

`doDeploy.sh` が生成する本番 nginx.conf の CSP:

```text
connect-src 'self' wss://*.tommie.jp https://cdn.babylonjs.com ...
```

- `wss://*.tommie.jp` がハードコード
- LAN では `ws://192.168.x.x` で接続するため **WebSocket がブロックされる**

### 2. nginx.conf の Origin チェック（致命的）

```nginx
if ($http_origin ~* "^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$") { set $origin_ok "Y"; }
if ($http_origin ~* "^https?://@@HOST_REGEX@@(:[0-9]+)?$") { set $origin_ok "Y"; }
```

- `localhost`、`127.0.0.1`、デプロイホスト名のみ許可
- LAN の IP アドレス（`192.168.x.x` 等）からのリクエストが **403** になる

### 3. `doDeploy.sh` の DEPLOY\_HOSTNAME 必須チェック（致命的）

```bash
case "$DETECTED" in
    ""|localhost|localhost.*)
        fail "DEPLOY_HOSTNAME が未設定で ..."
```

- `localhost` だと失敗する
- LAN 環境では正式なドメイン名がない場合が多い

### 4. 開発モードは Vite dev サーバー必須（運用上の問題）

- 現在の `nginx.conf`（dev 用）は Vite dev サーバー（`:3000`）へのリバースプロキシ
- 配布用には `npm run build` 済みの静的ファイルを直接配信する nginx 設定が必要

### 5. Service Worker が HTTP で動かない（軽微）

- ブラウザの仕様で HTTP では Service Worker を登録できない
- `sw-register.js` が dev モードでは自動無効化するため、実害なし
- オフラインキャッシュが効かないだけで、アプリ自体は正常動作

## 解決案：LAN 用 docker-compose overlay の追加

既存構成を変更せず、LAN 用のファイルを追加する。

### ファイル構成

```text
nakama/
  docker-compose.yml          # ベース（既存・変更なし）
  docker-compose.dev.yml      # 開発用（既存・Vite 必須）
  docker-compose.prod.yml     # 本番用（既存・HTTPS 前提）
  docker-compose.lan.yml      # [新規] LAN用（HTTP、静的配信）
  nginx.conf                  # 開発用（既存）
  nginx.lan.conf              # [新規] LAN用 nginx 設定
```

### `nginx.lan.conf` の方針

- 静的ファイル配信（`/usr/share/nginx/html`）
- CSP の `connect-src` を `'self' ws: wss:` に緩和（任意のホスト名/IP で接続可）
- Origin チェックなし or プライベート IP 範囲を許可
- Nakama API / WebSocket / MinIO S3 へのリバースプロキシ
- SPA フォールバック（`try_files`）

### `docker-compose.lan.yml` の方針

- ポート 80 を `0.0.0.0:80:80` で公開
- `nginx.lan.conf` をマウント
- `restart: unless-stopped`（安定運用向け）
- 環境変数のデフォルト値で動作（`.env` 不要）

### 使い方（想定）

```bash
# 1. フロントエンドをビルド
npm run build

# 2. LAN モードで起動
cd nakama
docker compose -f docker-compose.yml -f docker-compose.lan.yml up -d

# 3. LAN 内の端末からアクセス
# http://<サーバーの LAN IP> でアクセス可能
```

### CSP の違い（本番 vs LAN）

| ディレクティブ | 本番 | LAN |
| --- | --- | --- |
| `script-src` | `'self' 'wasm-unsafe-eval' cdn.babylonjs.com accounts.google.com` | `'self' 'wasm-unsafe-eval' cdn.babylonjs.com` |
| `connect-src` | `'self' wss://*.tommie.jp cdn.babylonjs.com oauth2.googleapis.com` | `'self' ws: wss: cdn.babylonjs.com` |
| `frame-src` | `accounts.google.com` | `'none'` |
| `form-action` | `'self' accounts.google.com` | `'self'` |

LAN 版では Google OAuth 関連を除外（LAN でも Google 認証を使いたい場合は別途設定）。

## セキュリティ評価

### LAN 内での利用 → 概ね OK

- 社内 LAN は通常信頼されたネットワーク（同僚しかいない）
- 社内ツール（Jenkins、GitLab、Redmine 等）も HTTP で運用されているケースは多い
- tommieChat のやり取りはチャットとブロック配置なので、機密度は低い

### 外部公開した場合 → HTTP はダメ

| リスク | 影響 |
| --- | --- |
| 盗聴 | セッショントークン・チャット内容が平文。Wi-Fi 等で傍受可能 |
| セッションハイジャック | デバイス ID / Nakama トークンが丸見え。なりすまし可能 |
| 中間者改ざん | JS を差し替えられる。XSS どころかフル制御される |
| CSP 緩和 | 上記の中間者攻撃がなければ、CSP 緩和自体の追加リスクは限定的 |

CSP は「HTTPS が前提の二重防御」であり、HTTP で中間者攻撃が可能な状況では
CSP があっても意味がない。
**HTTP であること自体が最大のリスクで、CSP 緩和は二次的な問題。**

### セキュリティ方針

**「LAN 版は外部公開しない」を前提にして、それを明示する。**

1. **doc / README に明記** --
   「LAN 版は社内ネットワーク専用。外部公開には本番構成（HTTPS）を使うこと」
2. **起動時の警告** --
   コンソールに「HTTP モードで起動中。外部公開には doSetupHTTPS.sh を使用してください」
   と表示する
3. **外部公開したい人向けの導線** --
   `doDeploy.sh` → `doSetupHTTPS.sh` の既存フローに誘導する

外部公開するなら本番構成（HTTPS + CSP + Origin チェック）一択。
LAN 版を外部に出す運用は想定しない。

なお、HTTP で動く OSS サーバーソフト（Minecraft サーバー、Gitea、Rocket.Chat 等）は
すべて同じ問題を抱えており、tommieChat 固有の問題ではない。
ライセンス/利用規約で「外部公開は利用者の責任」と免責し、
ドキュメントで HTTPS 本番構成への導線を示す、という一般的な対応で十分。

## 追加検討事項

- **Go プラグイン（`world.so`）のビルド**: Linux 環境必須。配布時は事前ビルド済みを含める
- **MinIO バケット初期化**: 初回起動時に `avatars` / `assets` バケットを作成する仕組みが必要
  （`doDeploy.sh` のステップ 10 相当をエントリポイントスクリプト等で自動化）
- **Google OAuth**: LAN では通常使えない（リダイレクト URI にプライベート IP を登録できない）。
  デバイス ID 認証のみで動作するようにする
