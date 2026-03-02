// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  // 開発サーバーの設定
  server: {
    port: 3000,
    open: true, // 起動時にブラウザを開く
  },
  // ビルド時の最適化
  build: {
    sourcemap: true, // デバッグしやすくする
    chunkSizeWarningLimit: 1000, // Babylon.js は大きいので制限を緩和
  },
  // アセットのベースパス（GitHub Pagesなどに出す場合は調整が必要）
  base: './',
});
