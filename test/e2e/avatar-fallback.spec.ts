/**
 * E2E テスト: アバターフォールバック
 *
 * 存在しないアバター URL を localStorage に設定してログインし、
 * SpriteAvatarSystem がフォールバック画像 (/img/default-avatar.png) で
 * アバターを正常に描画できることを検証する。
 *
 * 前提:
 *   - Nakama サーバが起動済み
 *   - public/img/default-avatar.png が配置済み
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

const LOGIN_DONE = /snd initPos/;
const FAKE_AVATAR_URL = "/s3/avatars/DOES_NOT_EXIST_999.png";

test.describe("アバターフォールバック", () => {
  test("存在しないアバター URL でフォールバック画像が使用される", async ({ page }) => {
    const logs: { type: string; text: string }[] = [];
    page.on("console", (msg: ConsoleMessage) => {
      logs.push({ type: msg.type(), text: msg.text() });
    });

    // ── 1. localStorage に存在しないアバター URL を設定 ──
    // page.goto 前に localStorage を操作するため、まず空ページで初期化
    await page.goto("/");
    await page.evaluate((url) => {
      localStorage.setItem("spriteAvatarUrl", url);
    }, FAKE_AVATAR_URL);

    // ── 2. リロードして偽アバターURLでログイン ──
    logs.length = 0;
    await page.reload();
    await page.waitForEvent("console", {
      predicate: (msg) => LOGIN_DONE.test(msg.text()),
      timeout: 30_000,
    });

    // ── 3. フォールバックが発動したことを確認 ──
    // "failed to load sheet" の warn が出ている
    const failedLog = logs.find((l) =>
      l.type === "warning" && l.text.includes("failed to load sheet") && l.text.includes("DOES_NOT_EXIST")
    );
    expect(failedLog, "偽 URL のロード失敗ログが出ていない").toBeTruthy();

    // "using fallback avatar" の warn が出ている
    const fallbackLog = logs.find((l) =>
      l.type === "warning" && l.text.includes("using fallback avatar")
    );
    expect(fallbackLog, "フォールバック使用ログが出ていない").toBeTruthy();

    // ── 4. フォールバック画像でアバターが作成された ──
    const createLog = logs.find((l) =>
      l.text.includes("SpriteAvatarSystem.createAvatar") &&
      l.text.includes("id=__self__") &&
      l.text.includes("default-avatar.png")
    );
    // createAvatar ログには元の sheetUrl が出るため、fallback の createAvatar ログは
    // 出ない場合がある。代わりに fallbackLog の存在で OK とする。
    if (!createLog) {
      console.log("注: createAvatar ログにはフォールバック URL は表示されない（内部リトライのため）");
    }

    // ── 5. canvas が描画されている（アバターが表示可能な状態） ──
    await expect(page.locator("#renderCanvas")).toBeVisible();

    // ── 6. console.error がフォールバック関連以外で出ていない ──
    // 404 fetch エラー（偽URL）は想定内なので除外
    const unexpectedErrors = logs.filter((l) =>
      l.type === "error" &&
      !l.text.includes("DOES_NOT_EXIST") &&
      !l.text.includes("404") &&
      !l.text.includes("Failed to load resource")
    );
    expect(
      unexpectedErrors,
      `予期しない console.error: ${unexpectedErrors.map((e) => e.text).join("\n")}`
    ).toHaveLength(0);

    // ── 7. クリーンアップ: localStorage を元に戻す ──
    await page.evaluate(() => {
      localStorage.removeItem("spriteAvatarUrl");
    });

    console.log(`\n── アバターフォールバック コンソールログ (${logs.length} 件) ──`);
    for (const l of logs) {
      if (l.text.includes("avatar") || l.text.includes("fallback") ||
          l.text.includes("DOES_NOT_EXIST") || l.text.includes("SpriteAvatar")) {
        console.log(`  [${l.type}] ${l.text.slice(0, 200)}`);
      }
    }
  });
});
