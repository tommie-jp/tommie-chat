/**
 * E2E テスト: ログアウト → 再ログイン
 *
 * 自動ログイン → ログアウト → 手動で再ログイン の一連フローを検証する。
 * セッション管理（Cookie / WebSocket）の整合性を確認する。
 *
 * 前提:
 *   - Nakama サーバが起動済み
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

const LOGIN_DONE = /snd initPos/;

test.describe("ログアウト → 再ログイン", () => {
  test("ログアウト後にログインフォームが復帰し、再ログインできる", async ({ page }) => {
    const logs: { type: string; text: string }[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      logs.push({ type: msg.type(), text: msg.text() });
    });

    // ── 1. 自動ログイン ──
    await page.goto("/");
    await page.waitForEvent("console", {
      predicate: (msg) => LOGIN_DONE.test(msg.text()),
      timeout: 30_000,
    });

    // ログイン後: login-row は非表示
    await expect(page.locator("#login-row")).toBeHidden();

    // ── 2. ログアウト ──
    // settings-logout-btn は server-settings-panel 内（非表示パネル）にあるため
    // JavaScript で直接クリックする
    await page.evaluate(() => {
      (document.getElementById("settings-logout-btn") as HTMLButtonElement)?.click();
    });

    // ログアウト確認パネルが表示される
    await expect(page.locator("#logout-panel")).toBeVisible();

    // 確認ボタンをクリック
    await page.locator("#logout-confirm-btn").click();

    // ── 3. ログアウト後の状態確認 ──
    // login-row が再表示される
    await expect(page.locator("#login-row")).toBeVisible({ timeout: 5_000 });

    // ログアウトのコンソールログを確認
    expect(logs.some((l) => l.text.includes("snd logout")), "snd logout が見つからない").toBe(true);

    // ログインボタンが再表示されている
    await expect(page.locator("#loginBtn")).toBeVisible();

    // loginName 入力が有効化されている
    const loginInput = page.locator("#loginName");
    await expect(loginInput).toBeEnabled();

    // ── 4. 再ログイン ──
    const reloginUser = `relogin_${Date.now()}`;
    await loginInput.fill(reloginUser);
    logs.length = 0; // ログをリセット

    await page.locator("#loginBtn").click();

    // 再ログイン完了を待機
    await page.waitForEvent("console", {
      predicate: (msg) => LOGIN_DONE.test(msg.text()),
      timeout: 30_000,
    });

    // ── 5. 再ログイン後の状態確認 ──
    // login-row が再び非表示
    await expect(page.locator("#login-row")).toBeHidden();

    // チャット入力欄が表示
    await expect(page.locator("#chatInput")).toBeVisible();

    // コンソールログで再ログインシーケンスを確認
    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /snd Connect/.test(t)), "再ログイン: snd Connect が見つからない").toBe(true);
    expect(logTexts.some((t) => new RegExp(`snd Login username: ${reloginUser}`).test(t)),
      "再ログイン: snd Login が見つからない").toBe(true);
    expect(logTexts.some((t) => /snd initPos/.test(t)), "再ログイン: snd initPos が見つからない").toBe(true);

    // console.error チェック
    const errors = logs.filter((l) => l.type === "error");
    expect(errors, `予期しない console.error: ${errors.map((e) => e.text).join("\n")}`).toHaveLength(0);

    console.log(`\n── 再ログイン後のコンソールログ (${logs.length} 件) ──`);
    for (const l of logs) {
      console.log(`  [${l.type}] ${l.text.slice(0, 200)}`);
    }
  });
});
