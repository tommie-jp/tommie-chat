/**
 * E2E テスト: チャット送受信
 *
 * 2つのブラウザページを開き、片方で送信したメッセージが
 * もう片方のチャットオーバーレイに表示されることを検証する。
 *
 * 前提:
 *   - Nakama サーバが起動済み
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

const LOGIN_DONE = /snd initPos/;
const CHAT_MSG = "e2e_test_" + Date.now();

/** 自動ログインでログイン完了まで待機するヘルパー */
async function waitForAutoLogin(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForEvent("console", {
    predicate: (msg) => LOGIN_DONE.test(msg.text()),
    timeout: 30_000,
  });
}

test.describe("チャット送受信", () => {
  test("2ページ間でチャットメッセージが送受信できる", async ({ browser }) => {
    // ── 2つの独立したコンテキスト（別セッション）を作成 ──
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const logs2: string[] = [];
    page2.on("console", (msg: ConsoleMessage) => {
      logs2.push(msg.text());
    });

    // ── 両方ログイン ──
    await waitForAutoLogin(page1);
    await waitForAutoLogin(page2);

    // 少し待って互いの AOI_ENTER を受信させる
    await page2.waitForTimeout(2000);

    // ── page1 からチャット送信 ──
    const chatInput = page1.locator("#chatInput");
    const sendBtn = page1.locator("#sendBtn");
    await expect(chatInput).toBeVisible();
    await chatInput.fill(CHAT_MSG);
    await sendBtn.click();

    // ── page2 で受信確認 ──
    // チャットオーバーレイにメッセージが表示されるまで待機
    const overlay2 = page2.locator("#chat-overlay");
    await expect(overlay2.locator(`.chat-ol-line:has-text("${CHAT_MSG}")`)).toBeVisible({
      timeout: 10_000,
    });

    // コンソールログでも受信を確認
    const hasChat = logs2.some((t) => t.includes("rcv op=13 CHAT") || t.includes("CHAT"));
    console.log(`page2 CHAT受信ログ: ${hasChat}`);

    // ── page1 側のチャットオーバーレイにも自分のメッセージが出ている ──
    const overlay1 = page1.locator("#chat-overlay");
    await expect(overlay1.locator(`.chat-ol-line:has-text("${CHAT_MSG}")`)).toBeVisible({
      timeout: 5_000,
    });

    // ── クリーンアップ ──
    await ctx1.close();
    await ctx2.close();
  });
});
