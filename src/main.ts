import { GameScene } from "./GameScene";

declare const APP_VERSION: string;
declare const APP_DATE: string;

console.log(`tommieChat v${APP_VERSION} (${APP_DATE})`);

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
if (canvas) {
    new GameScene(canvas);
} else {
    console.error("Canvas element 'renderCanvas' not found!");
}