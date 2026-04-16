/**
 * E2E テスト: 部屋の移動
 *
 * ログイン後に部屋を作成し、その部屋へ移動、元の部屋に戻る一連のフローを検証する。
 * worldId 切替 + match 再参加 + チャンク再読込の整合性を確認する。
 *
 * 前提:
 *   - Nakama サーバが起動済み
 */
import { test, expect, type ConsoleMessage } from "@playwright/test";

const LOGIN_DONE = /snd initPos/;
const ROOM_NAME = `e2e_room_${Date.now()}`;

test.describe("部屋の移動", () => {
  test("部屋を作成し、移動して、元の部屋に戻れる", async ({ page }) => {
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

    // 初回の worldId=0 での getWorldMatch を確認
    expect(logs.some((l) => /snd getWorldMatch worldId=0/.test(l.text)),
      "初回 getWorldMatch worldId=0 が見つからない").toBe(true);

    // ── 2. 部屋一覧パネルを開く ──
    // menu-rooms ボタンはメニュー内（非表示）のため JavaScript で直接クリック
    await page.evaluate(() => {
      (document.getElementById("menu-rooms") as HTMLButtonElement)?.click();
    });

    const roomPanel = page.locator("#room-list-panel");
    await expect(roomPanel).toBeVisible({ timeout: 5_000 });

    // 部屋一覧が表示されるまで待機し、現在の部屋数を記録
    await expect(page.locator("#room-list-tbody > tr").first()).toBeVisible({ timeout: 5_000 });
    const initialCount = await page.locator("#room-list-tbody > tr").count();

    // ── 3. 新しい部屋を作成 ──
    // ダイアログハンドラを事前登録（部屋名 → サイズの順で prompt が出る）
    let dialogCount = 0;
    page.on("dialog", async (dialog) => {
      dialogCount++;
      if (dialogCount === 1) {
        // 部屋名
        await dialog.accept(ROOM_NAME);
      } else {
        // サイズ
        await dialog.accept("4");
      }
    });

    await page.locator("#room-create-btn").click();

    // 部屋が作成されて一覧に 1 行追加されるまで待機
    await expect(page.locator("#room-list-tbody > tr")).toHaveCount(initialCount + 1, { timeout: 10_000 });

    // 新しい部屋の行が表示されている
    const newRoomRow = page.locator(`#room-list-tbody > tr:has-text("${ROOM_NAME}")`);
    await expect(newRoomRow).toBeVisible();

    // ── 4. 新しい部屋に移動 ──
    logs.length = 0;

    // waitForEvent を先に登録してからクリック（イベント取りこぼし防止）
    const moveToNewRoom = page.waitForEvent("console", {
      predicate: (msg) => /snd getWorldMatch worldId=[1-9]/.test(msg.text()),
      timeout: 15_000,
    });
    await newRoomRow.click();
    await moveToNewRoom;

    // initPos が再送信される
    await page.waitForEvent("console", {
      predicate: (msg) => LOGIN_DONE.test(msg.text()),
      timeout: 10_000,
    });

    // 新しい worldId で joinMatch が呼ばれている
    const logTexts = logs.map((l) => l.text);
    expect(logTexts.some((t) => /snd joinMatch/.test(t)), "snd joinMatch が見つからない").toBe(true);

    // ── 5. 元の部屋 (World 0) に戻る ──
    logs.length = 0;

    // 部屋一覧が再描画されるのを待つ（ポーリング約1秒間隔）
    await page.waitForTimeout(2000);

    // ⭐️が付いていない行（= 現在の部屋でない行）のうち最初の行をクリック
    // ※ World 0 は ⭐️なしで表示される（現在は新しい部屋にいるため）
    const backToWorld0 = page.waitForEvent("console", {
      predicate: (msg) => /snd getWorldMatch worldId=0/.test(msg.text()),
      timeout: 15_000,
    });
    // owner列が "(system)" の行 = World 0
    await page.locator('#room-list-tbody > tr:has(td:text("(system)"))').click();
    await backToWorld0;

    // initPos 再送信
    await page.waitForEvent("console", {
      predicate: (msg) => LOGIN_DONE.test(msg.text()),
      timeout: 10_000,
    });

    // ── 6. エラーチェック ──
    const allLogs = logs;
    const errors = allLogs.filter((l) => l.type === "error");
    expect(errors, `予期しない console.error: ${errors.map((e) => e.text).join("\n")}`).toHaveLength(0);

    console.log(`\n── 部屋移動テスト コンソールログ (${allLogs.length} 件) ──`);
    for (const l of allLogs) {
      console.log(`  [${l.type}] ${l.text.slice(0, 200)}`);
    }
  });
});
