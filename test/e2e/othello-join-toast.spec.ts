/**
 * E2E テスト: オセロ参加通知の吹き出しトースト表示
 *
 * 仕様: doc/20-仕様書.md ⭐️トースト / ⭐️通知の案
 *
 * 検証内容:
 *   1. 相手（白）がゲームに参加 → オーナー（黒）にトーストが表示される
 *      - 文字列: "{opponentName}が見つかりました。ゲーム番号:{gameNo:3桁}"
 *   2. 参加者（白）本人にはトーストが表示されない
 *   3. オーナー側でオセロパネル表示中なら吹き出しスキップ
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

/** ブラウザ内の game.nakama.socket.rpc を呼び出すヘルパー */
async function callRpc<T>(page: Page, name: string, payload: object): Promise<T> {
  return await page.evaluate(async ({ name, payload }) => {
    const w = window as unknown as { game: { nakama: { socket: { rpc: (n: string, p: string) => Promise<{ payload?: string }> } } } };
    const result = await w.game.nakama.socket.rpc(name, JSON.stringify(payload));
    return JSON.parse(result.payload ?? "{}");
  }, { name, payload });
}

test.describe("オセロ参加通知トースト", () => {
  test("相手参加 → オーナーにトースト表示、参加者には表示されない", async ({ browser }) => {
    const ctxBlack = await browser.newContext();
    const ctxWhite = await browser.newContext();
    const pageBlack = await ctxBlack.newPage();
    const pageWhite = await ctxWhite.newPage();

    try {
      await waitForAutoLogin(pageBlack);
      await waitForAutoLogin(pageWhite);

      // オーナー（黒）がゲーム作成
      const create = await callRpc<{ gameId: string; gameNo: number; status: string }>(
        pageBlack, "othelloCreate", { worldId: 0 }
      );
      expect(create.gameId).toBeTruthy();
      expect(create.status).toBe("waiting");
      const gameNo3 = String(create.gameNo).padStart(3, "0");

      // パネルが開いていたら閉じる（作成時に自動表示される場合があるため）
      await pageBlack.evaluate(() => {
        const p = document.getElementById("othello-panel");
        if (p && p.style.display !== "none") p.style.display = "none";
      });

      // 相手（白）が参加
      const join = await callRpc<{ status: string }>(
        pageWhite, "othelloJoin", { gameId: create.gameId }
      );
      expect(join.status).toBe("playing");

      // オーナー側にトーストが表示される
      const toast = pageBlack.locator(".toast-bubble");
      await expect(toast).toBeVisible({ timeout: 5_000 });

      // 文字列パターンを検証: "...が見つかりました。ゲーム番号:XXX"
      const toastText = await toast.textContent();
      expect(toastText, `toast text: ${toastText}`).toMatch(/が見つかりました。ゲーム番号:\d{3}/);
      expect(toastText).toContain(`ゲーム番号:${gameNo3}`);

      // 参加者（白）側にはトーストが出ない
      const toastWhite = pageWhite.locator(".toast-bubble");
      await expect(toastWhite).toHaveCount(0);
    } finally {
      await ctxBlack.close();
      await ctxWhite.close();
    }
  });

  test("オーナー側でオセロパネル表示中 → 吹き出しスキップ", async ({ browser }) => {
    const ctxBlack = await browser.newContext();
    const ctxWhite = await browser.newContext();
    const pageBlack = await ctxBlack.newPage();
    const pageWhite = await ctxWhite.newPage();

    const logsBlack: string[] = [];
    pageBlack.on("console", (m) => { logsBlack.push(m.text()); });

    try {
      await waitForAutoLogin(pageBlack);
      await waitForAutoLogin(pageWhite);

      // オーナーがパネルを開く
      await pageBlack.evaluate(() => {
        const p = document.getElementById("othello-panel");
        if (p) p.style.display = "";
      });
      await expect(pageBlack.locator("#othello-panel")).toBeVisible();

      // ゲーム作成
      const create = await callRpc<{ gameId: string; gameNo: number }>(
        pageBlack, "othelloCreate", { worldId: 0 }
      );
      const gameNo3 = String(create.gameNo).padStart(3, "0");

      // 相手が参加
      await callRpc(pageWhite, "othelloJoin", { gameId: create.gameId });

      // 通知到着を待つ（スキップ判定ログの出現で確認）
      await expect.poll(
        () => logsBlack.some(t => t.includes(`Othello notif skipped (panel visible): gameNo=${gameNo3}`)),
        { timeout: 5_000, message: "skip ログを待機中" }
      ).toBe(true);

      // トーストは表示されない
      const toast = pageBlack.locator(".toast-bubble");
      await expect(toast).toHaveCount(0);
    } finally {
      await ctxBlack.close();
      await ctxWhite.close();
    }
  });
});
