/**
 * E2E テスト: オセロ参加トーストをタップ → パネル遷移 + URL 反映
 *
 * 仕様: doc/20-仕様書.md step 6
 *   - 吹き出し通知タップでリンク先アクセス → オセロパネル表示
 *   - URL反映: history.pushState で URL を `?ot={gameNo}` に更新
 *   - ブラウザ「戻る」で元の画面に戻れる
 *
 * 前提: Vite dev サーバ + Nakama サーバが起動済み
 */
import { test, expect, type Page } from "@playwright/test";

const LOGIN_DONE = /snd initPos/;

async function waitForAutoLogin(page: Page) {
  await page.goto("/");
  await page.waitForEvent("console", {
    predicate: (msg) => LOGIN_DONE.test(msg.text()),
    timeout: 30_000,
  });
}

async function callRpc<T>(page: Page, name: string, payload: object): Promise<T> {
  return await page.evaluate(async ({ name, payload }) => {
    const w = window as unknown as { game: { nakama: { socket: { rpc: (n: string, p: string) => Promise<{ payload?: string }> } } } };
    const result = await w.game.nakama.socket.rpc(name, JSON.stringify(payload));
    return JSON.parse(result.payload ?? "{}");
  }, { name, payload });
}

test.describe("オセロトーストタップ", () => {
  test("タップ → URL が ?ot={gameNo} に更新 + パネル表示", async ({ browser }) => {
    const ctxBlack = await browser.newContext();
    const ctxWhite = await browser.newContext();
    const pageBlack = await ctxBlack.newPage();
    const pageWhite = await ctxWhite.newPage();

    try {
      await waitForAutoLogin(pageBlack);
      await waitForAutoLogin(pageWhite);

      // オーナー（黒）がゲーム作成
      const create = await callRpc<{ gameId: string; gameNo: number }>(
        pageBlack, "othelloCreate", { worldId: 0 }
      );
      // パネルが自動表示されたら閉じる
      await pageBlack.evaluate(() => {
        const p = document.getElementById("othello-panel");
        if (p && p.style.display !== "none") p.style.display = "none";
      });

      // 相手（白）が参加 → オーナーにトースト配信
      await callRpc(pageWhite, "othelloJoin", { gameId: create.gameId });

      const toast = pageBlack.locator(".toast-bubble");
      await expect(toast).toBeVisible({ timeout: 5_000 });

      // タップ前 URL は / （?ot なし）
      const urlBefore = new URL(pageBlack.url());
      expect(urlBefore.searchParams.has("ot")).toBe(false);

      // タップ
      await toast.click();

      // URL が ?ot={gameNo} に更新される
      await expect.poll(() => new URL(pageBlack.url()).searchParams.get("ot"), { timeout: 5_000 })
        .toBe(String(create.gameNo));

      // オセロパネルが表示される
      await expect(pageBlack.locator("#othello-panel")).toBeVisible({ timeout: 5_000 });

      // トーストは消えている（タップで dismiss）
      await expect(toast).toHaveCount(0);
    } finally {
      await ctxBlack.close();
      await ctxWhite.close();
    }
  });

  test("タップ後、ブラウザ戻るで URL が元に戻る", async ({ browser }) => {
    const ctxBlack = await browser.newContext();
    const ctxWhite = await browser.newContext();
    const pageBlack = await ctxBlack.newPage();
    const pageWhite = await ctxWhite.newPage();

    try {
      await waitForAutoLogin(pageBlack);
      await waitForAutoLogin(pageWhite);

      const create = await callRpc<{ gameId: string; gameNo: number }>(
        pageBlack, "othelloCreate", { worldId: 0 }
      );
      await pageBlack.evaluate(() => {
        const p = document.getElementById("othello-panel");
        if (p && p.style.display !== "none") p.style.display = "none";
      });

      await callRpc(pageWhite, "othelloJoin", { gameId: create.gameId });

      const toast = pageBlack.locator(".toast-bubble");
      await expect(toast).toBeVisible({ timeout: 5_000 });
      await toast.click();

      // URL 更新を待つ
      await expect.poll(() => new URL(pageBlack.url()).searchParams.get("ot"), { timeout: 5_000 })
        .toBe(String(create.gameNo));

      // ブラウザ戻る
      await pageBlack.goBack();

      // URL が元に戻る（?ot なし）
      await expect.poll(() => new URL(pageBlack.url()).searchParams.has("ot"), { timeout: 5_000 })
        .toBe(false);
    } finally {
      await ctxBlack.close();
      await ctxWhite.close();
    }
  });
});
