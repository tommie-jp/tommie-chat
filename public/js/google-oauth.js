// Google OAuth2 アカウントリンク（方式 B ポップアップ + 方式 A リダイレクトフォールバック）
// ─────────────────────────────────────────
// 設計方針: doc/53-設計-認証システム.md §13 参照
//
// iOS Safari ではユーザー操作直後の同期 window.open しかブロックされない。
// クリックハンドラ内で window.open を呼ぶ前に await や fetch を挟むと
// ポップアップブロッカーに弾かれるため、最初の処理として popup を開く。
//
// グローバル `window.tommieGoogleOAuth` に API を生やす:
//   - getClientId(): string | null     設定された Google OAuth Client ID
//   - setClientId(id: string): void    （任意。通常は <meta> タグから読む）
//   - startLink(): { popup, promise }  クリックハンドラ内で同期実行する想定
//   - resumeFromRedirect(): string|null  リダイレクトフォールバック後のコード回収
//
// CSP: connect-src に https://oauth2.googleapis.com を追加（コード→トークン交換は Go 側）

(function () {
    "use strict";

    var REDIRECT_PATH = "/oauth-callback.html";
    var GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
    var SCOPE = "openid email profile";

    // Client ID は <meta name="google-oauth-client-id" content="..."> から取得
    function getClientId() {
        var meta = document.querySelector('meta[name="google-oauth-client-id"]');
        var id = meta && meta.getAttribute("content");
        if (id && id.trim() && id.indexOf("YOUR_") !== 0) return id.trim();
        return null;
    }

    function randomState() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        // フォールバック: 32文字の hex
        var arr = new Uint8Array(16);
        if (window.crypto && crypto.getRandomValues) {
            crypto.getRandomValues(arr);
        } else {
            for (var i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
        }
        return Array.prototype.map.call(arr, function (b) {
            return ("0" + b.toString(16)).slice(-2);
        }).join("");
    }

    function buildAuthUrl(state) {
        var clientId = getClientId();
        if (!clientId) throw new Error("Google OAuth Client ID 未設定");
        var params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: location.origin + REDIRECT_PATH,
            response_type: "code",
            scope: SCOPE,
            state: state,
            access_type: "online",
            prompt: "select_account",
            include_granted_scopes: "true"
        });
        return GOOGLE_AUTH_URL + "?" + params.toString();
    }

    /**
     * クリックハンドラ内で同期的に呼び出すこと。
     *
     * @param {Object} [opts]
     * @param {function():Object} [opts.captureState]  リダイレクト前にゲーム状態を返す関数
     *                                                  （roomId / position / camera 等）
     * @returns {{ popup: Window|null, promise: Promise<string> }}
     *          promise は認可コードを resolve する。
     *          ポップアップがブロックされた場合はリダイレクト方式へ自動切替し、
     *          promise は resolve せずページ遷移する。
     */
    function startLink(opts) {
        opts = opts || {};
        var clientId = getClientId();
        if (!clientId) {
            return {
                popup: null,
                promise: Promise.reject(new Error("Google OAuth Client ID 未設定"))
            };
        }

        var state = randomState();
        try { sessionStorage.setItem("oauth_state", state); }
        catch (e) { console.warn("google-oauth: sessionStorage 書き込み失敗", e); }

        var url = buildAuthUrl(state);

        // ─── まず同期的に window.open（iOS Safari ポップアップブロッカー対策）───
        var popup = null;
        try {
            popup = window.open(url, "google-oauth", "width=500,height=650,menubar=no,toolbar=no");
        } catch (e) {
            console.warn("google-oauth: window.open 例外", e);
        }

        if (!popup || popup.closed || typeof popup.closed === "undefined") {
            // ─── ポップアップブロックされた → リダイレクト方式へフォールバック ───
            console.warn("google-oauth: ポップアップブロック検知 → リダイレクト方式へ");
            try {
                var resume = opts.captureState ? opts.captureState() : null;
                if (resume) {
                    sessionStorage.setItem("oauth_resume_state", JSON.stringify(resume));
                }
            } catch (e) {
                console.warn("google-oauth: resume state 保存失敗", e);
            }
            location.href = url;
            return {
                popup: null,
                promise: new Promise(function () { /* never resolves */ })
            };
        }

        // ─── ポップアップ方式: postMessage 待ち ───
        var promise = new Promise(function (resolve, reject) {
            var done = false;
            var pollTimer = null;

            function cleanup() {
                window.removeEventListener("message", onMessage);
                if (pollTimer) clearInterval(pollTimer);
            }

            function onMessage(e) {
                if (e.origin !== location.origin) return;
                if (!e.data || e.data.type !== "google-oauth-code") return;
                done = true;
                cleanup();
                try { popup.close(); } catch (err) { void err; }
                resolve(String(e.data.code));
            }

            window.addEventListener("message", onMessage);

            // ポップアップが手動で閉じられた場合の検知
            pollTimer = setInterval(function () {
                if (done) return;
                if (popup.closed) {
                    cleanup();
                    reject(new Error("ポップアップが閉じられました"));
                }
            }, 500);
        });

        return { popup: popup, promise: promise };
    }

    /**
     * リダイレクトフォールバックから戻ってきた場合に呼ぶ。
     * @returns {{ code: string, resumeState: any|null } | null}
     */
    function resumeFromRedirect() {
        var code = null;
        var resumeState = null;
        try { code = sessionStorage.getItem("oauth_pending_code"); }
        catch (e) { console.warn("google-oauth: sessionStorage 読み込み失敗", e); return null; }
        if (!code) return null;
        try { sessionStorage.removeItem("oauth_pending_code"); }
        catch (e) { console.warn(e); }
        try {
            var raw = sessionStorage.getItem("oauth_resume_state");
            if (raw) {
                resumeState = JSON.parse(raw);
                sessionStorage.removeItem("oauth_resume_state");
            }
        } catch (e) {
            console.warn("google-oauth: resume state 読み込み失敗", e);
        }
        return { code: code, resumeState: resumeState };
    }

    window.tommieGoogleOAuth = {
        getClientId: getClientId,
        startLink: startLink,
        resumeFromRedirect: resumeFromRedirect
    };
})();
