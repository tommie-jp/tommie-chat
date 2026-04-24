// tommieChat Service Worker
// CACHE_VERSION は APP_VERSION と同期（doVersionUp.sh が自動更新）
// バージョンを変更するとキャッシュが自動クリアされます
const CACHE_VERSION = "v0.1.64";
const CACHE_NAME = "tommiechat-" + CACHE_VERSION;

// キャッシュ対象（アプリシェル）
const PRECACHE_URLS = [
  "./",
  "./favicon.png",
  "./icon-192.png",
  "./icon-512.png",
];

// インストール: プリキャッシュ
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  // 待機中の新SWを即座にアクティベート
  self.skipWaiting();
});

// アクティベート: 古いキャッシュを削除
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("tommiechat-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  // 既存のクライアントを新SWで制御
  self.clients.claim();
});

// フェッチ: ネットワーク優先、失敗時にキャッシュフォールバック
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // WebSocket、Nakama API、S3 はキャッシュしない
  if (
    req.url.includes("/ws") ||
    req.url.includes("/v2/") ||
    req.url.includes("/s3/")
  ) {
    return;
  }

  // POST等はスキップ
  if (req.method !== "GET") return;

  event.respondWith(
    fetch(req)
      .then((response) => {
        // 正常なレスポンスをキャッシュに保存（206 Partial Content は Cache API で put 不可のため除外）
        if (response.ok && response.status !== 206) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      })
      .catch(() => {
        // ネットワーク失敗 → キャッシュから返す
        return caches.match(req);
      })
  );
});
