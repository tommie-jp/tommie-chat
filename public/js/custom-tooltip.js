// カスタムツールチップ: title属性 → data-tip に変換し、画面内に収める
window.__tooltipsDisabled = document.cookie.indexOf("tooltips=0") !== -1;
(function() {
    var tip = document.getElementById("custom-tooltip");
    var showTimer = null;
    var currentEl = null;

    // 全 title 属性を data-tip に変換（ネイティブツールチップを無効化）
    document.querySelectorAll("[title]").forEach(function(el) {
        if (!el.getAttribute("data-tip")) {
            el.setAttribute("data-tip", el.getAttribute("title"));
        }
        el.removeAttribute("title");
    });
    // 動的に追加される title も対処（MutationObserver）
    new MutationObserver(function(muts) {
        muts.forEach(function(m) {
            if (m.type === "attributes" && m.attributeName === "title") {
                var el = m.target;
                var t = el.getAttribute("title");
                if (t) { el.setAttribute("data-tip", t); el.removeAttribute("title"); }
            }
            if (m.type === "childList") {
                m.addedNodes.forEach(function(n) {
                    if (n.nodeType === 1) {
                        n.querySelectorAll && n.querySelectorAll("[title]").forEach(function(c) {
                            c.setAttribute("data-tip", c.getAttribute("title"));
                            c.removeAttribute("title");
                        });
                        if (n.getAttribute && n.getAttribute("title")) {
                            n.setAttribute("data-tip", n.getAttribute("title"));
                            n.removeAttribute("title");
                        }
                    }
                });
            }
        });
    }).observe(document.body, { attributes: true, attributeFilter: ["title"], childList: true, subtree: true });

    function show(el) {
        if (window.__tooltipsDisabled) return;
        var text = el.getAttribute("data-tip");
        if (!text) return;
        currentEl = el;
        tip.textContent = text;
        tip.style.display = "block";
        // 位置計算（ソフトキーボード表示時は visualViewport を使用）
        var vv = window.visualViewport;
        var vw = vv ? vv.width : window.innerWidth;
        var vh = vv ? vv.height : window.innerHeight;
        var vpTop = vv ? vv.pageTop : window.scrollY;
        var vpLeft = vv ? vv.pageLeft : window.scrollX;
        var rect = el.getBoundingClientRect();
        var tw = tip.offsetWidth, th = tip.offsetHeight;
        // ページ上の絶対座標
        var absTop = rect.top + window.scrollY;
        var absBottom = rect.bottom + window.scrollY;
        var absLeft = rect.left + window.scrollX;
        // visual viewport 内での相対位置を計算
        var relBottom = absBottom - vpTop;
        var relTop = absTop - vpTop;
        var left = absLeft + rect.width / 2 - tw / 2;
        var top;
        // 要素が visual viewport の下半分、または下に収まらない場合は上に表示
        if (relBottom + th + 6 > vh - 4 || relTop > vh / 2) {
            top = absTop - th - 6;
        } else {
            top = absBottom + 6;
        }
        // visual viewport 内に収める
        var minTop = vpTop + 4;
        var maxTop = vpTop + vh - th - 4;
        if (top > maxTop) top = maxTop;
        if (top < minTop) top = minTop;
        var minLeft = vpLeft + 4;
        var maxLeft = vpLeft + vw - tw - 4;
        if (left > maxLeft) left = maxLeft;
        if (left < minLeft) left = minLeft;
        tip.style.left = left + "px";
        tip.style.top = top + "px";
    }

    function hide() {
        clearTimeout(showTimer); showTimer = null;
        currentEl = null;
        tip.style.display = "none";
    }

    var hasTouch = "ontouchstart" in window;

    // PC: hover（タッチデバイスでは無効）
    if (!hasTouch) {
        document.addEventListener("pointerover", function(e) {
            var el = e.target.closest("[data-tip]");
            if (!el) { hide(); return; }
            clearTimeout(showTimer);
            showTimer = setTimeout(function() { show(el); }, 400);
        });
        document.addEventListener("pointerout", function() { hide(); });
    }

    // モバイル: touch イベントで長押し（pointercancel に影響されない）
    if (hasTouch) {
        var pressTimer = null;
        var tipShown = false;  // 長押しでツールチップが表示されたか
        var hiddenByTap = false; // ツールチップをタップで閉じたか
        var startX = 0, startY = 0; // touchstart位置（移動しきい値用）
        document.addEventListener("touchstart", function(e) {
            tipShown = false;
            hiddenByTap = false;
            var touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            var hitEl = document.elementFromPoint(touch.clientX, touch.clientY);
            // ツールチップ自体をタップ → 閉じるだけ（背面に貫通しない）
            if (hitEl === tip || (hitEl && tip.contains(hitEl))) { hide(); hiddenByTap = true; return; }
            var el = hitEl && hitEl.closest("[data-tip]");
            // ツールチップ外タップで閉じる
            if (!el) { if (currentEl) { hide(); hiddenByTap = true; } return; }
            // 表示中の同じ要素をタップ → 閉じる
            if (currentEl === el) { hide(); hiddenByTap = true; return; }
            // 長押し500msで表示（ヘッダー含む全要素共通。指が動いたらキャンセル）
            pressTimer = setTimeout(function() { show(el); pressTimer = null; tipShown = true; }, 500);
        }, { passive: true });
        var blockClick = false;
        document.addEventListener("touchend", function(e) {
            clearTimeout(pressTimer);
            if (tipShown || hiddenByTap) {
                tipShown = false;
                hiddenByTap = false;
                blockClick = true;
                if (e.cancelable) e.preventDefault();
                setTimeout(function() { blockClick = false; }, 400);
            }
        });
        // click イベントをキャプチャフェーズで止める（iOS PWA で確実に抑制）
        document.addEventListener("click", function(e) {
            if (blockClick) {
                blockClick = false;
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
        document.addEventListener("touchcancel", function() { clearTimeout(pressTimer); }, { passive: true });
        document.addEventListener("touchmove", function(e) {
            if (!pressTimer) return;
            var touch = e.touches[0];
            var dx = touch.clientX - startX, dy = touch.clientY - startY;
            // 10px以上動いたら長押しキャンセル（指のブレは無視）
            if (dx * dx + dy * dy > 100) {
                clearTimeout(pressTimer); pressTimer = null; headerMoved = true;
            }
        }, { passive: true });
    }
    document.addEventListener("scroll", hide, true);
})();
