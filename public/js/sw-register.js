// Service Worker 登録（本番のみ — vite devでは無効）
var isDev = document.querySelector('script[src*="@vite/client"]') !== null;
if ("serviceWorker" in navigator && !isDev) {
    navigator.serviceWorker.register("/sw.js").then(function(reg) {
        console.log("SW registered, scope:", reg.scope);
        reg.addEventListener("updatefound", function() {
            var newSW = reg.installing;
            if (newSW) {
                newSW.addEventListener("statechange", function() {
                    if (newSW.state === "activated") {
                        console.log("SW updated — new cache active");
                    }
                });
            }
        });
    }).catch(function(err) {
        console.warn("SW registration failed:", err);
    });
} else if ("serviceWorker" in navigator && isDev) {
    // vite dev: 既存のSWを解除
    navigator.serviceWorker.getRegistrations().then(function(regs) {
        regs.forEach(function(r) { r.unregister(); });
        if (regs.length) console.log("SW unregistered (dev mode)");
    });
}
