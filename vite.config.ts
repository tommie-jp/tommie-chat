// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  // 開発サーバーの設定
  server: {
    port: 3000,
    host: true, // 0.0.0.0でリッスン（LAN/スマホからのアクセス用）
    allowedHosts: true, // Docker nginx からのプロキシを許可
    open: true, // 起動時にブラウザを開く
    proxy: {
      '/v2': {
        target: 'http://localhost:7350',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:7350',
        changeOrigin: true,
        ws: true,
      },
      '/s3/avatars': {
        target: 'http://localhost:9000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/s3/, ''),
      },
    },
  },
  // ビルド時の最適化
  build: {
    sourcemap: true, // デバッグしやすくする
    chunkSizeWarningLimit: 1000, // Babylon.js は大きいので制限を緩和
  },
  // アセットのベースパス（GitHub Pagesなどに出す場合は調整が必要）
  base: './',
});
