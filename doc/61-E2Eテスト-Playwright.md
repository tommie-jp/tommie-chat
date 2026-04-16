# E2E テスト (Playwright)

## 概要

Playwright を使ったブラウザ E2E テスト。
実際のブラウザ（Chromium headless）でページを開き、ログインフローやコンソールログを自動検証する。

## 既存テストとの棲み分け

| テスト種別         | ツール                              | 対象                                         |
| ------------------ | ----------------------------------- | -------------------------------------------- |
| プロトコル整合性   | Vitest + nakama-js (`npm run test`) | snd/rcv、AOI、同接                           |
| E2E / UI 動作      | Playwright (`npm run test:e2e`)     | ログインフロー、UI 表示、コンソールエラー検出 |
| シェルスクリプト   | `test/doTest-*.sh`                  | サーバ再起動込みの結合テスト                 |

## 実行方法

```bash
# 通常実行（失敗時のみスクリーンショット/動画保存）
npm run test:e2e

# トレース付き実行（操作の詳細を記録）
npm run test:e2e:trace

# トレース閲覧
npx playwright show-trace test/e2e/results/<テスト名>/trace.zip
```

## 前提条件

- Nakama サーバが起動済み (`docker compose up -d`)
- Vite dev サーバは Playwright が自動起動する（起動済みならそのまま再利用）

## ファイル構成

```text
playwright.config.ts          設定ファイル（ポート 3000、Chromium headless）
test/e2e/
  login-flow.spec.ts          ログインフローテスト
  results/                    スクリーンショット・動画・トレース（.gitignore 済み）
  report/                     HTML レポート（.gitignore 済み）
```

## 現在のテスト

### login-flow.spec.ts

| テスト名 | 内容 |
|----------|------|
| 自動ログイン | `/` を開く → 自動ログイン完了 → コンソールエラーなし |
| 手動ログイン | `/?login` を開く → フォーム入力 → ボタンクリック → ログイン完了 |

検証項目:

- canvas (`#renderCanvas`) が表示される
- ログイン後に `#login-row` が非表示になる
- チャット入力欄 (`#chatInput`) が表示される
- コンソールに `snd Connect` / `snd Login` / `snd getWorldMatch` / `snd initPos` が出力される
- `console.error` が出ていない

## テスト追加のおすすめ候補

優先度順:

1. **チャット送受信** — 2 ページ同時操作で送受信を検証
2. **ログアウト → 再ログイン** — セッション管理の整合性
3. **部屋の移動** — worldId 切替 + match 再参加
4. **モバイルレイアウト** — viewport 切替でスクリーンショット比較
5. **テーマ切替** — `body.theme-dark` の CSS 回帰チェック

## テストの書き方

```typescript
import { test, expect } from "@playwright/test";

test("テスト名", async ({ page }) => {
  // コンソールログ収集
  const logs: { type: string; text: string }[] = [];
  page.on("console", (msg) => {
    logs.push({ type: msg.type(), text: msg.text() });
  });

  await page.goto("/");

  // 要素の確認
  await expect(page.locator("#renderCanvas")).toBeVisible();

  // コンソールログベースの待機
  await page.waitForEvent("console", {
    predicate: (msg) => /snd initPos/.test(msg.text()),
    timeout: 30_000,
  });

  // エラーチェック
  const errors = logs.filter((l) => l.type === "error");
  expect(errors).toHaveLength(0);
});
```

## 設定詳細

`playwright.config.ts` の主要設定:

| 項目 | 値 | 説明 |
|------|-----|------|
| `baseURL` | `http://localhost:3000` | Vite dev サーバ（vite.config.ts の port に合わせる） |
| `headless` | `true` | WSL 環境のためヘッドレス実行 |
| `timeout` | 60 秒 | テスト全体のタイムアウト |
| `screenshot` | `only-on-failure` | 失敗時のみスクリーンショット保存 |
| `video` | `retain-on-failure` | 失敗時のみ動画保存 |
| `webServer.command` | `npx vite --no-open` | テスト時に dev サーバを自動起動 |
| `webServer.reuseExistingServer` | `true` | 既に起動済みなら再利用 |
