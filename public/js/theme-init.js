// テーマ初期化（FOUC防止: body直後に実行）
(function() {
    var m = document.cookie.match(/(?:^|; )uiTheme=([^;]*)/);
    var t = m ? decodeURIComponent(m[1]) : "pop1";
    document.body.classList.add(t === "dark" ? "theme-dark" : "theme-pop1");
})();
