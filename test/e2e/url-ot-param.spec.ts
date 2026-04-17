/**
 * E2E テスト: URL パラメータ ?ot でのオセロパネル表示
 *
 * 仕様: doc/20-仕様書.md ⭐️URLスキーム規約
 *   - ?ot=123 オセロパネル表示 + オセロゲーム番号123を処理
 *   - ?ot (値なし) オセロパネル表示のみ
 *   - ?ot= (空値) オセロパネル表示のみ
 *   - ?ot=abc (非数値) オセロパネル表示のみ
 *   - URL パラメータなし パネル自動オープンなし
 *
 * 前提:
 *   - Vite dev サーバが起動済み (webServer で自動起動)
 *   - Nakama サーバが起動済み
 */
import { test, expect, type ConsoleMessage, type Page } from "@playwright/test";

/** ログイン完了を示すコンソールメッセージのパターン */
const LOGIN_DONE_PATTERN = /snd initPos/;

/** コンソールログ収集ヘルパー */
function collectLogs(page: Page) {
  const logs: { type: string; text: string }[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    logs.push({ type: msg.type(), text: msg.text() });
  });
  return logs;
}

/** ログイン完了まで待機 */
async function waitForLogin(page: Page) {
  await page.waitForEvent("console", {
    predicate: (msg) => LOGIN_DONE_PATTERN.test(msg.text()),
    timeout: 30_000,
  });
}

test.describe("URL パラメータ ?ot", () => {
  test("?ot=1 (存在しないゲーム番号): パネルが開き、not-found 警告が出る", async ({ page }) => {
    const logs = collectLogs(page);
    await page.goto("/?ot=1");
    await expect(page.locator("#renderCanvas")).toBeVisible();
    await waitForLogin(page);

    // オセロパネルが表示される
    await expect(page.locator("#othello-panel")).toBeVisible({ timeout: 10_000 });

    // 捕捉ログの確認
    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /URL \?ot=1 captured/.test(t)), "?ot=1 captured ログなし").toBe(true);
    expect(logTexts.some((t) => /URL \?ot=1 → オセロパネルを開く/.test(t)), "パネルオープンログなし").toBe(true);

    // gameNo=1 は存在しないので not-found 警告
    await expect.poll(() => logs.some((l) => /オセロゲーム番号1は存在しないか/.test(l.text)), {
      timeout: 10_000,
      message: "not-found 警告ログを待機中",
    }).toBe(true);
  });

  test("?ot (値なし): パネルのみ開く", async ({ page }) => {
    const logs = collectLogs(page);
    await page.goto("/?ot");
    await expect(page.locator("#renderCanvas")).toBeVisible();
    await waitForLogin(page);

    await expect(page.locator("#othello-panel")).toBeVisible({ timeout: 10_000 });

    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /URL \?ot captured \(no gameNo/.test(t)), "?ot (no gameNo) captured ログなし").toBe(true);
    expect(logTexts.some((t) => /URL \?ot → オセロパネルを開く/.test(t)), "パネルオープンログなし").toBe(true);

    // gameNo なしなので not-found 警告は出ない
    const notFoundLogs = logs.filter((l) => /存在しないか終了済み/.test(l.text));
    expect(notFoundLogs, "?ot のみで not-found 警告が誤って出た").toHaveLength(0);
  });

  test("?ot= (空値): パネルのみ開く", async ({ page }) => {
    const logs = collectLogs(page);
    await page.goto("/?ot=");
    await expect(page.locator("#renderCanvas")).toBeVisible();
    await waitForLogin(page);

    await expect(page.locator("#othello-panel")).toBeVisible({ timeout: 10_000 });

    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /URL \?ot captured \(no gameNo/.test(t)), "?ot= captured ログなし").toBe(true);
  });

  test("?ot=abc (非数値): パネルのみ開く", async ({ page }) => {
    const logs = collectLogs(page);
    await page.goto("/?ot=abc");
    await expect(page.locator("#renderCanvas")).toBeVisible();
    await waitForLogin(page);

    await expect(page.locator("#othello-panel")).toBeVisible({ timeout: 10_000 });

    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /URL \?ot captured \(no gameNo/.test(t)), "?ot=abc captured ログなし").toBe(true);

    const notFoundLogs = logs.filter((l) => /存在しないか終了済み/.test(l.text));
    expect(notFoundLogs, "?ot=abc で not-found 警告が誤って出た").toHaveLength(0);
  });

  test("パラメータなし: パネルは自動オープンされない", async ({ page }) => {
    const logs = collectLogs(page);
    await page.goto("/");
    await expect(page.locator("#renderCanvas")).toBeVisible();
    await waitForLogin(page);

    // ログイン後しばらく待って、パネルが開かれていないことを確認
    await page.waitForTimeout(1_000);
    await expect(page.locator("#othello-panel")).toBeHidden();

    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /URL \?ot/.test(t)), "?ot 関連ログが出ている").toBe(false);
  });
});
