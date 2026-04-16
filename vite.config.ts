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
        timeout: 0,          // プロキシリクエストのソケットタイムアウトを無効化
        configure: (proxy) => {
          // WebSocket プロキシのソケット設定を強化（テスト高負荷時の切断防止）
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.setTimeout(0);
            socket.setKeepAlive(true, 30000);
          });
          proxy.on('open', (proxySocket) => {
            proxySocket.setTimeout(0);
            proxySocket.setKeepAlive(true, 30000);
          });
          proxy.on('error', (err, _req, _res) => {
            console.error('[vite ws proxy]', err.message);
          });
        },
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
