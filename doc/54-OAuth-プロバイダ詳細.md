# OAuth プロバイダ詳細

[53-設計-認証システム.md](53-設計-認証システム.md) の補足。
個別 OAuth プロバイダ(Google / X)に関する詳細情報をまとめる。

---

## 1. Google OAuth2 でサーバに保存される情報

「Google でログイン」したとき、tommieChat サーバ側には何が保存されるのか?
プライバシー設計と GDPR 対応のために整理する。

### 1.1 OAuth フローで取得できる情報(標準スコープ)

Google OAuth2 のデフォルトスコープ `openid email profile` で取得できる項目:

| フィールド | 内容 | 例 |
| ---- | ---- | ---- |
| `sub` | Google 内部 ID(不変) | `109876543210123456789` |
| `email` | メールアドレス | `taro@gmail.com` |
| `email_verified` | メール検証済みフラグ | `true` |
| `name` | 表示名 | `山田 太郎` |
| `given_name` | 名 | `太郎` |
| `family_name` | 姓 | `山田` |
| `picture` | プロフィール画像 URL | `https://lh3.googleusercontent.com/.../photo.jpg` |
| `locale` | 言語設定 | `ja` |

#### 取得できないもの(追加スコープが必要)

- 連絡先 / 友達リスト → `contacts.readonly` 必要(かつ Google 審査必要)
- カレンダー → `calendar.readonly` 必要
- 性別・誕生日 → People API + 追加スコープ必要
- 電話番号 → 通常取得不可

→ tommieChat は `openid email profile` 以外を**要求しない**方針が良い(審査不要、ユーザーの警戒感も低い)。

### 1.2 Nakama がデフォルトで保存する情報

`authenticateGoogle(token)` を呼んだとき、Nakama は内部で以下を保存する:

```text
users テーブル
├ id              ← Nakama が UUID で生成(変わらない内部 ID)
├ username        ← Nakama が自動生成 (例: "user_3f8a2b...")
├ display_name    ← Google の name をコピー
├ avatar_url      ← Google の picture URL をコピー
├ lang_tag        ← Google の locale
├ email           ← Google の email
├ google_id       ← Google の sub
├ create_time
└ update_time
```

ポイント:

- **`google_id` (= Google sub)** が認証の鍵。これで「同じ Google アカウントの再ログイン」を判別
- **`email` は Nakama テーブルに直接保存される**(Google 側で email 変更されても自動同期はされない)
- **`avatar_url` は Google の URL がそのまま入る** — 画像本体はサーバに保存されない
- ユーザーが Google アカウントを削除しても、tommChat 側のレコードは残り続ける(明示削除が必要)

### 1.3 tommieChat で実際に何を保存すべきか

#### 必須(Nakama 標準)

| 項目 | 理由 |
| ---- | ---- |
| `google_id` (sub) | 認証の鍵。これがないと再ログイン不可 |
| `users.id` (内部 UUID) | tommChat 内部の永続 ID |

#### 推奨(初期値として保存、後でユーザーが変更可能)

| 項目 | 理由 |
| ---- | ---- |
| `display_name` (Google name) | 初期表示名として便利。ユーザーが後で変更可能 |
| `avatar_url` (Google picture URL) | 初期アイコン。ただし URL 直リンクには注意(後述) |
| `email` | 復旧用・通知用。ただし表示はしない |

#### 保存しないほうがよい

| 項目 | 理由 |
| ---- | ---- |
| `given_name` / `family_name` | tommChat に本名は不要。匿名性を維持 |
| `locale` | 言語は別途ユーザー設定で管理 |
| `email_verified` | Google で verified なら常に true。保存意味薄 |

### 1.4 アバター URL の注意点

Google の `picture` URL (`lh3.googleusercontent.com/...`) を直リンクで使うと:

- ✅ 簡単、容量ゼロ、自動更新
- ❌ 他プレイヤーがそのプロフィールを見ると Google に**アクセス元 IP が漏れる**
- ❌ Google 側 URL が変わると 404
- ❌ Google アカウント削除で消える
- ❌ CSP `img-src` に `https://lh3.googleusercontent.com` を追加する必要

→ プライバシー重視なら**初回ログイン時にダウンロードして MinIO に保存**するのが望ましい。
   tommChat は MinIO を持っているので相性が良い。

### 1.5 GDPR / 個人情報の扱い

EU ユーザーを想定するなら:

| 要件 | tommChat での対応 |
| ---- | ---- |
| 保存項目の明示 | プライバシーポリシーに記載 |
| ユーザーの取得要求 | `getAccount` RPC で自分のデータを取得可能に |
| 削除要求 | アカウント削除 RPC を実装(`users` レコードと関連データを論理削除) |
| 同意 | ログイン画面で「Google から取得する情報」を明示 |
| データ移行 | エクスポート機能(JSON ダウンロード) |

国内サービスとして始めるなら厳格な GDPR 対応は不要だが、**設計時点で「削除可能」なデータモデル**にしておく。

### 1.6 tommieChat 推奨の保存設計

```text
users (Nakama 標準)
├ id              ← 内部 UUID (これが tommChat 内部 ID)
├ username        ← @user_xxx
├ display_name    ← 初期は Google name、後でユーザー変更可
├ avatar_url      ← 初期は Google picture URL → 将来的に MinIO に再保存
├ email           ← Google email (表示はしない、復旧・通知用)
├ google_id       ← Google sub (認証の鍵)
└ ...

(独自テーブル不要 — Nakama 標準で完結)
```

→ **Go プラグインに追加コードは不要**。`socket.authenticateGoogle(idToken)` を呼ぶだけで全部 Nakama がやってくれる。

---

## 2. X プロファイルの取得方法 — スクレイピング vs API

「X のアイコンと表示名を tommChat に表示したい。X アカウントの URL を叩けば取れる?」
の回答。

### 2.1 結論

**2023 年以降、X(Twitter)はスクレイピング不可になった**。

- 旧 Twitter (〜2022): `https://twitter.com/username` を fetch すればプロフィール HTML が返ってきた
- 現 X (2023〜): **ログイン必須の壁**ができ、未ログインでアクセスすると「X にログイン」画面にリダイレクトされる
- nitter 等のミラーサイトもほぼ全滅(2024 年に主要インスタンスが停止)

→ **API 経由以外で X プロフィールを取得する手段はほぼ無い**。

### 2.2 過去はどうだったか

#### 〜2022 (旧 Twitter)

```bash
curl https://twitter.com/jack
# → HTML が返ってきて、og:image, og:title, og:description で
#   アイコン URL、表示名、bio を取得可能
```

実際、多くのサービスがこれで済ませていた:

- リンクプレビュー(Slack, Discord, LINE 等)
- SNS 集約サービス(BuzzFeed, Togetter)
- アカウント検証ツール

#### 2023-04 以降 (Elon 買収後)

- 未ログインアクセスを段階的にブロック
- 2023-06: 完全ログインウォール化
- 2023-07: API Free ティアの大幅縮小
- 2024: nitter ミラー全滅(API の閉鎖が原因)

```bash
curl https://x.com/jack
# → ログインページの HTML が返るだけ。プロフィール情報なし
```

Cloudflare のボット対策も入っており、curl/fetch ではほぼアクセス不可。

### 2.3 X API との違い

| 観点 | スクレイピング(過去) | X API(現在) |
| ---- | ---- | ---- |
| 認証 | 不要 | OAuth 2.0 + Developer 登録必須 |
| ToS | グレー(robots.txt 違反の可能性) | 明示的に許可 |
| レート制限 | なし(緩い) | 厳格(`users/me` は 75 req/15min) |
| 安定性 | HTML 構造変更で壊れる | API 仕様変更で壊れる(頻度高) |
| 取得情報 | 公開ページに見える範囲 | スコープに応じて(`users.read` で表示名・アイコン) |
| コスト | $0 | Free〜$5000/月(変動) |
| **現在の可否** | **不可(ログインウォール)** | 可(認証必須) |

### 2.4 「X 表示名・アイコンを使いたい」場合の現実的な選択肢

#### 案 A: X OAuth ログイン時に初回コピー(推奨)

「Sign in with X」ログインフローを実装し、その時に取得した情報を tommChat に保存する:

```text
ユーザーが「X でログイン」をクリック
  ↓
X OAuth 2.0 PKCE フロー
  ↓
access_token を取得
  ↓
GET /2/users/me?user.fields=name,profile_image_url
  ↓
display_name と avatar_url を tommChat の users テーブルにコピー
  ↓
以後、X API は呼ばない(初回ログイン時だけ)
```

メリット:

- API 呼び出しが**ログイン時 1 回だけ**(レート制限の心配なし)
- アイコン画像は MinIO に保存して以後ローカル配信
- X 側の仕様変更で壊れても**保存済みデータは無事**
- Free ティアで運用可能(`users/me` は無料枠で叩ける、ただし将来は不明)

デメリット:

- ユーザーが X 側でアイコン変更しても tommChat には反映されない
  → 「同期」ボタンを設置し、ユーザーが任意のタイミングで再取得できるようにする

#### 案 B: 定期同期(非推奨)

毎日全ユーザーの `users/me` を叩いて最新を取得:

- ❌ レート制限に引っかかる(無料枠で 75 req/15min)
- ❌ X 仕様変更で停止リスク
- ❌ 必要のない API コール

#### 案 C: ユーザーに手動入力させる

X 連携をせず、tommChat 内でアイコンと表示名を別途設定:

- ✅ X 依存ゼロ
- ✅ プライバシー良好
- ❌ 「X と同じアイコンにしたい」ニーズに応えられない

### 2.5 tommieChat 推奨

[53-設計-認証システム.md 10章](53-設計-認証システム.md#10-x-twitter-oauth-のコスト詳細) と組み合わせ:

```text
1. X OAuth は当面見送り (Phase 3 以降)
2. 実装するなら「案 A: 初回コピー戦略」
3. アイコン画像は MinIO に保存(Google 同様)
4. ユーザーが任意で「X から再取得」ボタンを押せる
5. X API が壊れたら認証だけ無効化、保存済みデータは継続使用
```

### 2.6 補足: Open Graph タグの過去と現在

過去の旧 Twitter は HTML に Open Graph タグを埋めていた:

```html
<meta property="og:title" content="Jack" />
<meta property="og:image" content="https://pbs.twimg.com/profile_images/.../photo.jpg" />
<meta property="og:description" content="bitcoin" />
```

これがあれば**認証なしで** Slack / Discord / LINE 等がリンクプレビューを表示できた。

現在の X は:

- ログインウォールで HTML 自体が返らない
- og タグも消滅(返ってくるのはログインページの og タグ)
- 結果として X リンクのプレビュー機能は世界中のサービスで壊れた

→ **「URL を叩けば取れる」時代は終わった**。OAuth 経由以外に方法がない。

---

## 3. 関連ドキュメント

- [53-設計-認証システム.md](53-設計-認証システム.md) — 認証システム全体設計
- [52-設計-フレンドシステム.md](52-設計-フレンドシステム.md) — フレンドシステム
- [92-セキュリティレビュー.md](92-セキュリティレビュー.md) — CSP・セキュリティヘッダ
