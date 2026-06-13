# テスト環境: ngrok と VPSステージングの使い分け

Google OAuth 認証など「HTTPS + 外部からアクセス可能なURL」が必要なテストで、
ngrok と VPSステージング (`mmo-test.tommie.jp`) のどちらを使うか整理する。

## 結論（使い分け）

| フェーズ | 使う環境 | 理由 |
| -------- | -------- | ---- |
| 実装の試行錯誤（OAuthまわりを何度も書き換え） | **ngrok + Vite** | HMRで即反映、デプロイ不要 |
| 実装が固まった後の最終確認 | **VPS (mmo-test)** | 本番相当のCSP/nginx設定で差分を拾える |
| 本番リリース直前 | **VPS (mmo-test)** | CLAUDE.md の「ステージング検証」方針に従う |

**原則**: 試行錯誤は ngrok、確認は VPS。

## 比較表

| 観点 | ngrok | VPS (mmo-test) |
| ---- | ----- | -------------- |
| 反映速度 | HMR で即時 ✅ | `doDeploy.sh` で約1.5分 |
| URL固定 | 無料版は毎回変わる / 有料版は固定 | 固定 ✅ |
| TLS証明書 | ngrok発行 | Let's Encrypt（本番と同じ） ✅ |
| CSP/nginx検証 | dev構成のまま → 本番差異を拾えない | 本番相当 ✅ |
| Google Console登録 | URL変わるたび更新（無料版） | 1回登録すれば済む ✅ |
| iPhone実機テスト | モバイル回線でも可 ✅ | 同じく可 ✅ |
| 警告ページ | 無料版は初回挟まる | なし ✅ |
| コスト | 無料 or 有料 ($10/月) | VPS運用コストのみ |

## ngrok セットアップ

### 1. ngrok を nginx (port 80) にトンネル

Vite 単体ではなく `docker-compose.dev.yml` の nginx に向けるのがポイント。
nginx が `/` → Vite、`/ws` `/rpc` 等 → Nakama に振り分けてくれるため、
WebSocket（Nakama）もそのまま通る。

```bash
ngrok http 192.168.1.40:80
# → https://xxxx.ngrok-free.app が発行される
```

### 2. Vite設定に ngrok ホストを許可

`vite.config.ts`:

```ts
server: {
  host: true,
  allowedHosts: ['.ngrok-free.app', '.ngrok.app'],
  hmr: { clientPort: 443 },
}
```

### 3. Google Cloud Console に ngrok URL を登録

OAuth 2.0 クライアントID の編集画面で以下を追加（VPSと併記でOK）:

- **承認済みのJavaScript生成元**: `https://xxxx.ngrok-free.app`
- **承認済みのリダイレクトURI**: `https://xxxx.ngrok-free.app/<コールバックパス>`

### 4. iPhone Safari で `https://xxxx.ngrok-free.app` を開く

初回は ngrok 無料版の警告ページが出るのでタップで通過。

## 無料版 ngrok の弱点

- **URLが起動ごとに変わる** → Google Console の登録を毎回更新する必要がある
- 起動のたびに10秒程度の手間が発生し、試行錯誤回数が多いと地味に煩わしい

## 有料版 ngrok (Reserved Domain) 推奨ケース

月 $10 で固定ドメイン（例: `https://tommie-dev.ngrok-free.app`）が取れる。

- Google Console 登録が1回で済む
- URL固定なので PWA化テストも可能
- OAuth 試行錯誤を週に何度もやるフェーズなら元が取れる

## クライアント側の挙動メモ

[src/NakamaService.ts](../src/NakamaService.ts) の Nakama 接続先は以下で決まる:

- host = `location.hostname`
- port = `location.port || (https ? 443 : 80)`

そのため ngrok URL でアクセスすれば Nakama も同じホスト経由で接続される。
nginx が WebSocket をプロキシしていれば追加設定なしで動く。

## 関連ドキュメント

- [55-設定-Google-OAuth.md](55-設定-Google-OAuth.md) — Google OAuth クライアント作成手順
- [53-設計-認証システム.md](53-設計-認証システム.md) — 認証設計
- [40-デプロイ手順.md](40-デプロイ手順.md) — VPSへのデプロイ手順
- [42-LAN接続手順.md](42-LAN接続手順.md) — LAN内からの開発サーバーアクセス
