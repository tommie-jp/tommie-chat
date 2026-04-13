// OAuth2 認可コールバック
// ─────────────────────────────────────────
// Google OAuth2 のリダイレクト先 (redirect_uri) として使用される。
// パターン1（ポップアップ方式）: 親ウィンドウへ postMessage でコードを返す。
// パターン2（リダイレクト方式）: window.opener が無い → トップレベル遷移と判断し、
//                            sessionStorage にコードを退避してアプリ本体 (/) へリダイレクト。
//                            アプリ本体側 (google-oauth.js) が起動時に sessionStorage を読み出して処理する。
//
// state パラメータは CSRF 対策のため必ず照合する。
// 期待する state は呼び出し側が sessionStorage["oauth_state"] に保存している。

(function () {
    "use strict";

    var msgEl = document.getElementById("msg");
    var errEl = document.getElementById("err");

    function showError(msg) {
        if (msgEl) msgEl.textContent = "認証エラー";
        if (errEl) errEl.textContent = msg;
        console.warn("oauth-callback:", msg);
    }

    var params = new URLSearchParams(location.search);
    var code = params.get("code");
    var state = params.get("state");
    var oauthError = params.get("error");

    if (oauthError) {
        showError("Google 側エラー: " + oauthError);
        return;
    }
    if (!code || !state) {
        showError("認可コードまたは state が欠落しています");
        return;
    }

    // CSRF: state 検証
    var expectedState = null;
    try { expectedState = sessionStorage.getItem("oauth_state"); }
    catch (e) { console.warn("oauth-callback: sessionStorage 読み込み失敗", e); }

    if (!expectedState || expectedState !== state) {
        showError("state 不一致 — リクエストが改ざんされた可能性があります");
        return;
    }

    // state は使い捨て
    try { sessionStorage.removeItem("oauth_state"); } catch (e) { console.warn(e); }

    // コードを sessionStorage に保存（親ウィンドウのポーリングが検知する）
    // COOP により window.opener が null になるケースがあるため、
    // postMessage 方式と sessionStorage 方式の両方を試みる。
    try {
        sessionStorage.setItem("oauth_pending_code", code);
    } catch (e) {
        showError("sessionStorage 書き込み失敗: " + (e && e.message ? e.message : String(e)));
        return;
    }

    if (window.opener && !window.opener.closed) {
        // ─── ポップアップ方式: 親ウィンドウへ postMessage ───
        try {
            window.opener.postMessage(
                { type: "google-oauth-code", code: code },
                location.origin
            );
        } catch (e) { void e; }
        if (msgEl) msgEl.textContent = "認証完了";
        setTimeout(function () { try { window.close(); } catch (e) { void e; } }, 300);
    } else {
        // ─── COOP / リダイレクト方式: sessionStorage に保存済み ───
        // ポップアップとして開かれた場合: 親のポーリングが sessionStorage を検知する
        // リダイレクト方式の場合: アプリ本体へ戻る
        if (msgEl) msgEl.textContent = "認証完了 — このタブを閉じてください";
        // ポップアップ内なら自動で閉じる試行、無理ならユーザーに閉じてもらう
        setTimeout(function () { try { window.close(); } catch (e) { void e; } }, 1000);
    }
})();
