// クッキーが非表示設定のパネルをDOMレンダリング前にCSSで隠す（フラッシュ防止）
(function() {
    var map = [
        ["showSrvSettings", "server-settings-panel"],
        ["showSrvLog",      "server-log-panel"],
        ["showUserList",    "user-list-panel"],
        ["showChatHist",    "chat-history-panel"],
        ["showDebug",       "debug-overlay"],
        ["showPing",        "ping-panel"],
        ["showBookmarks",   "bookmark-panel"],
        ["showRooms",       "room-list-panel"],
        ["showOthello",     "othello-panel"]
    ];
    var getCookie = function(name) {
        var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
        return m ? decodeURIComponent(m[1]) : null;
    };
    var hidden = map.filter(function(p) { return getCookie(p[0]) === "0"; });
    var rules = hidden.map(function(p) { return "#" + p[1] + "{display:none}"; });
    if (rules.length) {
        // 全パネル非表示ならデバイダー非表示＆全画面化
        if (hidden.length === map.length) {
            rules.push(":root{--ls-divider:100%;--pt-divider:100vh}");
            rules.push("#landscape-divider{display:none}");
            rules.push("#portrait-divider{display:none}");
        }
        var style = document.createElement("style");
        style.id = "panel-flash-guard";
        style.textContent = rules.join("");
        document.head.appendChild(style);
    }
})();
