import { GameScene } from "./GameScene";

// キャンバス要素を取得してGameSceneを初期化
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
if (canvas) {
    new GameScene(canvas);
} else {
    console.error("Canvas element 'renderCanvas' not found!");
}