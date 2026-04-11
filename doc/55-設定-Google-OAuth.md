# 設定: Google OAuth 2.0 クライアント作成手順

[doc/53-設計-認証システム.md](53-設計-認証システム.md) §8 の最小実装で必要となる Google Cloud Console 側の設定手順。
本ドキュメントは Web アプリケーション用 OAuth 2.0 クライアントを発行し、tommieChat に組み込むまでの一連の作業をまとめる。

## 0. 前提

- Google アカウント（Workspace でも個人でも可）
- 課金設定は **不要**（Sign in with Google は無料枠で使える）
- 対象環境: dev (`localhost:5173`) / staging (`mmo-test.tommie.jp`) / prod (`mmo.tommie.jp`)

---

## 1. プロジェクトを作成

1. <https://console.cloud.google.com/> を開く
2. 画面上部のプロジェクト選択ドロップダウン（左上「Google Cloud」の右）→ **「新しいプロジェクト」**
3. 以下を入力して **「作成」**
   - **プロジェクト名**: `tommieChat`（任意）
   - **組織**: 個人なら「組織なし」のまま
4. 作成後、上部ドロップダウンで `tommieChat` を選択しておく

---

## 2. OAuth 同意画面（OAuth consent screen）を設定

OAuth クライアントを作る前に「同意画面」の設定が必須。

1. 左メニュー → **「APIとサービス」** → **「OAuth 同意画面」**
2. **User Type** を選択
   - **External**（外部）を選択 → **「作成」**
   - （Workspace 組織アカウントの場合のみ「Internal」が選べる）
3. **アプリ情報** を入力

   | 項目 | 値 |
   | --- | --- |
   | アプリ名 | `tommieChat` |
   | ユーザーサポートメール | 自分のメール |
   | アプリのロゴ | （任意。後でも可） |

4. **アプリのドメイン**（任意だが本番運用なら埋める）

   | 項目 | 値 |
   | --- | --- |
   | アプリケーションのホームページ | `https://mmo.tommie.jp` |
   | プライバシーポリシー URL | `https://mmo.tommie.jp/privacy`（後で用意） |
   | 利用規約 URL | `https://mmo.tommie.jp/terms`（後で用意） |

5. **承認済みドメイン** に追加
   - `tommie.jp`
6. **デベロッパー連絡先情報** に自分のメール → **「保存して次へ」**
7. **スコープ** ページ
   - 「**スコープを追加または削除**」をクリック
   - 以下 3 つにチェックを入れて「更新」
     - `.../auth/userinfo.email`
     - `.../auth/userinfo.profile`
     - `openid`
   - → **「保存して次へ」**
8. **テストユーザー** ページ
   - 「テストユーザーを追加」で自分の Google アカウントメールを追加
   - 開発中は **テストモード** のまま運用可（テストユーザーのみログイン可能、最大 100 人）
   - → **「保存して次へ」**
9. **概要** を確認 → **「ダッシュボードに戻る」**

> **公開ステータス**: 「テスト中」のままだと登録したテストユーザーしかログインできない。
> 一般公開する場合は「アプリを公開」ボタンを押す（Google の検証が必要になる場合あり）。
> 最初はテスト中で OK。

---

## 3. OAuth 2.0 クライアント ID を作成

1. 左メニュー → **「APIとサービス」** → **「認証情報」**
2. 上部 **「+ 認証情報を作成」** → **「OAuth クライアント ID」**
3. **アプリケーションの種類**: **「ウェブ アプリケーション」** を選択
4. **名前**: `tommieChat Web Client`（任意）
5. **承認済みの JavaScript 生成元**（Authorized JavaScript origins）に追加

   ```text
   http://localhost:5173
   https://mmo-test.tommie.jp
   https://mmo.tommie.jp
   ```

6. **承認済みのリダイレクト URI**（Authorized redirect URIs）に追加

   ```text
   http://localhost:5173/oauth-callback.html
   https://mmo-test.tommie.jp/oauth-callback.html
   https://mmo.tommie.jp/oauth-callback.html
   ```

   末尾スラッシュ・大文字小文字・パスは **完全一致** が必要。
   実装側 (`public/js/google-oauth.js`) は `location.origin + "/oauth-callback.html"` で構築するのでこの形で揃える。

7. **「作成」** をクリック
8. ダイアログに **クライアント ID** と **クライアント シークレット** が表示される
   - **クライアント ID**: `123456789012-abcdefg.apps.googleusercontent.com`
   - **クライアント シークレット**: `GOCSPX-xxxxxxxxxxxxxxxxxxxx`
   - **両方コピーして安全な場所に保存**（シークレットは後から再表示も可能だが、漏洩時は即ローテーション）

---

## 4. tommieChat 側に設定を反映

以下は Cloud Console で発行した Client ID / Client Secret を開発環境・本番環境に行き渡らせる手順。
**Client ID はコミット OK、Client Secret はコミット禁止**（必ず `nakama/.env` 経由で注入）。

### 4-1. クライアント側 — `index.html` の `<meta>` に Client ID を書き込む

`index.html` 冒頭の `<meta name="google-oauth-client-id">` に Client ID を直接書く。

```html
<meta name="google-oauth-client-id" content="123456789012-abcdefg.apps.googleusercontent.com">
```

> Client ID は **公開しても安全**（Web アプリ用 OAuth クライアントは Origin 制約で守られる）。
> ただし Client **Secret** は絶対にクライアント側（`index.html` / `public/js/**` / `src/**`）に置かない。

Client ID を変更したら再ビルドが必要:

```bash
npm run build
```

### 4-2. サーバ側 — `nakama/.env`（git 管理外）に Secret を追加

`nakama/.env` を開いて Client ID / Secret を追加（既存行があれば上書き）。

```bash
# nakama/.env
ADMIN_UIDS=<既存の UID リスト>
GOOGLE_CLIENT_ID=123456789012-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxx
```

`nakama/.env` が `.gitignore` 済みであることを必ず確認（プロジェクトルートの `.gitignore` に `.env` / `.env.*` 登録済み）。

```bash
grep -n '^\.env' .gitignore
git check-ignore -v nakama/.env   # → nakama/.env が ignore されていることを確認
```

docker-compose 側は `nakama/docker-compose.yml` と `nakama/docker-compose.prod.yml` で
`--runtime.env GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}` / `--runtime.env GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET:-}` を参照するよう既に組み込み済み。

### 4-3. dev 環境で反映・動作確認

```bash
# Go プラグインをビルド（main.go を編集した場合のみ）
bash nakama/doBuild.sh --fresh

# Nakama コンテナを再起動（TOMMIE_PROD=1 で本番 overlay）
bash nakama/doRestart.sh
```

環境変数が正しく注入されているか確認:

```bash
docker exec tommchat-dev-nakama-1 env | grep GOOGLE_CLIENT_ID
# → GOOGLE_CLIENT_ID=123456789012-abcdefg.apps.googleusercontent.com

# Secret は echo しない運用が望ましいが、ローカル dev で確認だけしたい場合:
docker exec tommchat-dev-nakama-1 sh -c 'echo ${GOOGLE_CLIENT_SECRET:+set}'
# → "set" と出れば環境変数が入っている（値そのものは出力されない）
```

Nakama 起動ログに以下のようなエラーが出ていないことを確認:

```bash
docker compose -f nakama/docker-compose.yml logs nakama | grep -i "google\|oauth"
```

- `rpcLinkGoogleByCode: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 未設定` → `.env` が読み込まれていない
- `BeforeLinkGoogle: aud mismatch` → `index.html` の Client ID と `nakama/.env` の `GOOGLE_CLIENT_ID` がずれている

ブラウザで `http://localhost:5173` を開き、ログイン → メニュー → サーバ設定 → 「🅖 Google でアカウント保存」をクリック。
ポップアップで Google 認証 → 「✅ Google アカウントを紐付けました」が出れば dev は OK。

### 4-4. ステージング (mmo-test) へデプロイ・確認

本番へ出す前に必ず `mmo-test.tommie.jp` で確認する（CSP・nginx 差分で本番のみ起きる問題があるため）。

```bash
# フロント (dist) と nginx 設定をステージングに配る
bash nakama/doDeploy-remote.sh mmo-test

# 初回のみ: リモート側の nakama/.env に GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定
ssh <user>@mmo-test.tommie.jp
cd ~/tommie-chat/nakama
vi .env   # GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を追記
TOMMIE_PROD=1 bash doRestart.sh
exit
```

iPhone Safari の **通常タブ** と **PWA standalone** の両方で:

1. ログイン → メニュー → サーバ設定パネルを開く
2. 「アカウント情報」セクションが表示される
3. 「🅖 Google でアカウント保存」ボタンをクリック
4. ポップアップが開いて Google 認証 → アカウント選択 → 同意 → ポップアップが閉じる
5. 「✅ Google アカウントを紐付けました」と表示される
6. 「アカウント情報」が「✅ 保存済み」に変わる

PWA でポップアップが開けない場合はリダイレクト方式へ自動フォールバックし、アプリに戻ってきた後に自動でリンクが完了する（[public/js/google-oauth.js](../public/js/google-oauth.js) 参照）。

### 4-5. 本番 (mmo.tommie.jp) へ反映

ステージングで確認できたら本番へ。手順は 4-4 と同じ（`nakama/.env` 更新 + `TOMMIE_PROD=1 bash doRestart.sh`）。
本番は Cloud Console で **別の OAuth クライアント** を発行して ID/Secret を分離するのが望ましい（漏洩時の影響範囲を限定）。

### 4-6. Secret ローテーション時の手順

Secret を入れ替えたくなったら:

1. Cloud Console → 認証情報 → 該当クライアント → **「シークレットをリセット」**（旧値は即無効化）
2. 新しい `GOCSPX-...` をコピー
3. 対象環境の `nakama/.env` の `GOOGLE_CLIENT_SECRET` を書き換え
4. `bash nakama/doRestart.sh`（本番は `TOMMIE_PROD=1` 付き）
5. 再度 4-3 / 4-4 のブラウザ確認

> **注意**: Cloud Console の「シークレットをリセット」には grace period がないため、
> `.env` 更新 → Nakama 再起動まで一気に実施すること（途中でトークン交換が失敗する時間帯が発生する）。

---

## 5. よくあるエラーと対処

| エラー | 原因 | 対処 |
| --- | --- | --- |
| `redirect_uri_mismatch` | リダイレクト URI が完全一致していない | Cloud Console で URI を再確認。末尾スラッシュ・大文字小文字・スキーム (http/https) を厳密に揃える |
| `access_blocked: アプリは Google の確認プロセスを完了していません` | テストモードでテストユーザー未登録 | 同意画面 → テストユーザーに自分のメールを追加 |
| `invalid_client` | Client ID/Secret の不一致 or `.env` 未反映 | `docker exec nakama env \| grep GOOGLE` で環境変数を確認 |
| ポップアップが開かない（iOS Safari） | クリックハンドラ内で `await` を挟んでいる、または PWA で開かれている | 実装は同期 `window.open` 済み。それでも弾かれる場合は自動でリダイレクト方式にフォールバックする |
| `link failed: cannot link ... already linked` | その Google アカウントが別の Nakama ユーザーに既にリンク済み | 既存アカウントでログインするか、Nakama Console から旧リンクを削除 |

---

## 6. 推奨セキュリティ運用

- **Client Secret は git に絶対コミットしない** — `nakama/.env` を `.gitignore` で除外
- **本番用と開発用でクライアントを分ける** — Cloud Console で OAuth Client を 2 つ作り、`mmo-test` 用と `mmo.tommie.jp` 用を分離するとさらに安全（漏洩時の影響範囲を限定）
- **シークレットローテーション** — Cloud Console の認証情報ページで「シークレットをリセット」可能。漏洩疑いがあれば即実行
- **公開時の検証** — テストユーザー上限 (100) を超える前に Cloud Console で「アプリを公開」→ Google の検証申請（プライバシーポリシー URL が必要）

---

## 7. 関連ドキュメント

- [53-設計-認証システム.md](53-設計-認証システム.md) — 認証システム全体の設計方針（§8 最小実装、§13 OAuth フロー方式選定）
- [54-OAuth-プロバイダ詳細.md](54-OAuth-プロバイダ詳細.md) — Google / Apple / X など各プロバイダの比較
- [92-セキュリティレビュー.md](92-セキュリティレビュー.md) — CSP・セキュリティヘッダ

---

## 参考リンク

- Google Cloud Console: <https://console.cloud.google.com/apis/credentials>
- OAuth 同意画面ガイド: <https://support.google.com/cloud/answer/10311615>
- Sign in with Google ドキュメント: <https://developers.google.com/identity/protocols/oauth2/web-server>
