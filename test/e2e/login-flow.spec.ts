/**
 * E2E テスト: ログインフロー
 *
 * 検証内容:
 *   1. 自動ログイン: ページを開くだけで WebSocket 接続 → match 参加まで完了
 *   2. 手動ログイン: ?login 付きでフォーム操作 → ログイン完了
 *   3. コンソールに error レベルのログが出ていない
 *   4. 3D canvas が描画されている
 *
 * 前提:
 *   - Vite dev サーバが起動済み (npm run dev) ※ config の webServer で自動起動
 *   - Nakama サーバが起動済み (docker compose up -d)
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

/** ログイン完了を示すコンソールメッセージのパターン */
const LOGIN_DONE_PATTERN = /snd initPos/;

/** 許容するコンソール error のパターン（Babylon.js 等サードパーティ由来） */
const IGNORED_ERRORS = [
  /favicon\.ico/,
  /ERR_CONNECTION_REFUSED/,
];

/** コンソールログ収集ヘルパー */
function collectLogs(page: import("@playwright/test").Page) {
  const logs: { type: string; text: string }[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    logs.push({ type: msg.type(), text: msg.text() });
  });
  return logs;
}

/** 収集したログを stdout に出力（レポート用） */
function dumpLogs(logs: { type: string; text: string }[]) {
  console.log(`\n── コンソールログ (${logs.length} 件) ──`);
  for (const l of logs) {
    console.log(`  [${l.type}] ${l.text.slice(0, 200)}`);
  }
}

/** console.error のうち無視できないものを抽出 */
function unexpectedErrors(logs: { type: string; text: string }[]) {
  return logs.filter((l) => {
    if (l.type !== "error") return false;
    return !IGNORED_ERRORS.some((pattern) => pattern.test(l.text));
  });
}

test.describe("ログインフロー", () => {
  test("自動ログイン: ページを開くだけで正常にログイン完了する", async ({ page }) => {
    const logs = collectLogs(page);

    // ── 1. ページ読み込み（?login なし → 自動ログイン発動） ──
    await page.goto("/");

    // canvas が存在する
    await expect(page.locator("#renderCanvas")).toBeVisible();

    // ── 2. 自動ログイン完了を待機 ──
    // "snd initPos" がコンソールに出るまで待つ
    await page.waitForEvent("console", {
      predicate: (msg) => LOGIN_DONE_PATTERN.test(msg.text()),
      timeout: 30_000,
    });

    // ── 3. ログイン後の状態確認 ──
    // ログイン行が非表示になっている
    await expect(page.locator("#login-row")).toBeHidden();

    // チャット入力欄が表示されている
    await expect(page.locator("#chatInput")).toBeVisible();

    // ── 4. コンソールエラーチェック ──
    dumpLogs(logs);
    const errors = unexpectedErrors(logs);
    expect(errors, `予期しない console.error が ${errors.length} 件:\n${errors.map((e) => e.text).join("\n")}`).toHaveLength(0);

    // ── 5. キーとなるログメッセージの確認 ──
    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /snd Connect/.test(t)), "snd Connect が見つからない").toBe(true);
    expect(logTexts.some((t) => /snd Login/.test(t)), "snd Login が見つからない").toBe(true);
    expect(logTexts.some((t) => /snd getWorldMatch/.test(t)), "snd getWorldMatch が見つからない").toBe(true);
    expect(logTexts.some((t) => /snd initPos/.test(t)), "snd initPos が見つからない").toBe(true);
  });

  test("手動ログイン: ?login 付きでフォーム操作からログイン完了する", async ({ page }) => {
    const logs = collectLogs(page);
    const testUser = `e2etest_${Date.now()}`;

    // ── 1. ページ読み込み（?login → 自動ログイン無効、フォーム表示） ──
    await page.goto("/?login");
    await page.waitForLoadState("networkidle");

    // canvas が存在する
    await expect(page.locator("#renderCanvas")).toBeVisible();

    // ログインフォームが表示されている
    const loginInput = page.locator("#loginName");
    const loginBtn = page.locator("#loginBtn");
    await expect(loginInput).toBeVisible();
    await expect(loginBtn).toBeVisible();

    // ── 2. ログイン実行 ──
    await loginInput.fill(testUser);
    await loginBtn.click();

    // "snd initPos" がコンソールに出るまで待つ
    await page.waitForEvent("console", {
      predicate: (msg) => LOGIN_DONE_PATTERN.test(msg.text()),
      timeout: 30_000,
    });

    // ── 3. ログイン後の状態確認 ──
    // ログイン行が非表示になっている
    await expect(page.locator("#login-row")).toBeHidden();

    // チャット入力欄が表示されている
    await expect(page.locator("#chatInput")).toBeVisible();

    // ── 4. コンソールエラーチェック ──
    dumpLogs(logs);
    const errors = unexpectedErrors(logs);
    expect(errors, `予期しない console.error が ${errors.length} 件:\n${errors.map((e) => e.text).join("\n")}`).toHaveLength(0);

    // ── 5. キーとなるログメッセージの確認 ──
    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /snd Connect/.test(t)), "snd Connect が見つからない").toBe(true);
    expect(logTexts.some((t) => /snd Login/.test(t)), "snd Login が見つからない").toBe(true);
    expect(logTexts.some((t) => /snd getWorldMatch/.test(t)), "snd getWorldMatch が見つからない").toBe(true);
    expect(logTexts.some((t) => /snd initPos/.test(t)), "snd initPos が見つからない").toBe(true);
  });
});
