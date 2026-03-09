import { GameScene } from "./GameScene";

declare const APP_VERSION: string;
declare const APP_DATE: string;

// console.log / warn / error に時刻プレフィックスを付与
for (const method of ["log", "warn", "error"] as const) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
        const now = new Date();
        const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
        orig(ts, ...args);
    };
}

console.log(`tommieChat v${APP_VERSION} (${APP_DATE})`);

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
if (canvas) {
    new GameScene(canvas);
} else {
    console.error("Canvas element 'renderCanvas' not found!");
}