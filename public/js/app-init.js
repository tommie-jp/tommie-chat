// アプリバージョン・更新日の定数（ここだけ変更する）
var APP_VERSION = "0.1.29";
var APP_COMMIT_COUNTER = "1010";
var APP_DATE    = "2026/04/15";

document.title = "tommieChat " + APP_VERSION;

// ブラウザ標準の右クリック/長押しコンテキストメニューを抑止
document.addEventListener("contextmenu", function(e) { e.preventDefault(); });

document.addEventListener("DOMContentLoaded", function() {
    var el;
    el = document.getElementById("val-ver");
    if (el) el.textContent = APP_VERSION;

    el = document.getElementById("val-update");
    if (el) el.textContent = APP_DATE;

    el = document.getElementById("app-footer-version");
    if (el) {
        var dateDot = APP_DATE.replace(/\//g, ".");
        var isDev = !!document.querySelector('script[src*="@vite/client"]');
        var devTag = "";
        if (isDev) {
            var now = new Date();
            devTag = " " + ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
        }
        var isMobile = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
        var ftEl = document.getElementById("app-footer-text");
        if (ftEl) {
            var ftTip = "tommieChat\n"
                + "バージョン " + APP_VERSION + "\n"
                + "コミット番号 " + APP_COMMIT_COUNTER + "\n"
                + "更新日 " + APP_DATE + "\n"
                + "\n"
                + "操作方法\n"
                + (isMobile
                    ? "  移動: 地面をタップ\n  カメラ回転: 1本指ドラッグ\n  ズーム: ピンチイン/アウト\n  発言: セリフ入力 → 送信ボタン\n  改行: Shift+Enter"
                    : "  移動: 地面をクリック\n  カメラ回転: 右ドラッグ\n  カメラ平行移動: 中ボタンドラッグ\n  ズーム: ホイール\n  発言: セリフ入力 → Enter\n  改行: Shift+Enter")
                + "\n\n© 2026 tommie.jp\n\nクリックすると「tommieChatについて」パネルを開きます。";
            ftEl.setAttribute("title", ftTip);
            ftEl.innerHTML = isMobile
                ? '<span class="ft-label" style="color:#333;text-shadow:0 0 3px #fff, 0 0 6px #fff;">tommieChat ' + APP_VERSION + ' #' + APP_COMMIT_COUNTER + devTag + '</span>'
                : '<span class="ft-label">tommieChat ' + APP_VERSION + ' #' + APP_COMMIT_COUNTER + ' ' + dateDot + devTag + '</span>';
        }
    }

    el = document.getElementById("label-ver");
    if (el) el.setAttribute("title",
        "01.Ver\nアプリケーションバージョン番号\n初期値: " + APP_VERSION +
        "\n典型的なMMO: 定期更新あり\nMinecraft: Java 1.21.x, 定期スナップショット更新");

    el = document.getElementById("label-update");
    if (el) el.setAttribute("title",
        "02.Update\n最終更新日\n初期値: " + APP_DATE +
        "\n典型的なMMO: 週〜月単位で更新\nMinecraft: スナップショット毎週〜正式版数ヶ月単位");

    // ===== カスタムツールチップ（PC/スマホ共通） =====
    // PC: クリックで表示 / スマホ: 長押しで表示 / どちらも画面タップ/クリックで消去
    var tooltipEl = document.createElement("div");
    tooltipEl.id = "mobile-tooltip";
    document.body.appendChild(tooltipEl);
    tooltipEl.addEventListener("touchend", function() { if (tooltipVisible) hideTooltip(); });
    tooltipEl.addEventListener("click", function() { if (tooltipVisible) hideTooltip(); });

    var tooltipTimer = null;
    var tooltipVisible = false;
    var LONG_PRESS_MS = 500;
    var tooltipSourceEl = null; // ツールチップの表示元要素
    var tooltipShowTime = 0; // 表示直後のclick誤消去防止用

    function showTooltip(text, posX, posY, sourceEl) {
        if (window.__tooltipsDisabled) return;
        tooltipEl.textContent = text;
        tooltipEl.style.display = "block";
        tooltipVisible = true;
        tooltipShowTime = Date.now();
        var vw = window.innerWidth;
        var tw = Math.min(280, vw - 20);
        tooltipEl.style.maxWidth = tw + "px";
        tooltipEl.style.left = "0";
        tooltipEl.style.top = "0";
        tooltipEl.style.bottom = "";
        requestAnimationFrame(function() {
            var th = tooltipEl.offsetHeight;
            var rect = sourceEl ? sourceEl.getBoundingClientRect() : null;
            // fixed要素の座標系を取得（iOS Safari キーボード表示時の補正）
            var fixedRef = tooltipEl.getBoundingClientRect();
            var offsetX = fixedRef.left;  // left:0 の実際の位置
            var offsetY = fixedRef.top;   // top:0 の実際の位置
            var elTop = (rect ? rect.top : posY) - offsetY;
            var elBottom = (rect ? rect.bottom : posY + 20) - offsetY;
            var elLeft = (rect ? rect.left : posX) - offsetX;
            var x = Math.min(Math.max(5, elLeft), vw - tw - 5);
            tooltipEl.style.left = x + "px";
            // 要素のすぐ上に配置。収まらなければ要素のすぐ下
            if (elTop - th - 6 >= 0) {
                tooltipEl.style.top = (elTop - th - 6) + "px";
            } else {
                tooltipEl.style.top = (elBottom + 6) + "px";
            }
        });
    }

    function hideTooltip() {
        tooltipEl.style.display = "none";
        tooltipVisible = false;
        tooltipSourceEl = null;
    }

    // title属性を持つ要素を探す
    function findTitleEl(target) {
        var el = target;
        for (var i = 0; i < 4 && el && el !== document.body; i++) {
            if (el.getAttribute && (el.getAttribute("title") || (el.dataset && el.dataset.titleBackup))) return el;
            el = el.parentElement;
        }
        return null;
    }
    function getTitleText(el) {
        return el.getAttribute("title") || (el.dataset && el.dataset.titleBackup) || "";
    }

    // キャプチャフェーズで長押し後のclickを抑止（ボタン等のハンドラより先に止める）
    document.addEventListener("click", function(e) {
        if (suppressNextClick) {
            suppressNextClick = false;
            e.stopImmediatePropagation();
            e.preventDefault();
            return;
        }
        if (tooltipVisible) {
            hideTooltip();
            e.stopImmediatePropagation();
            e.preventDefault();
            return;
        }
    }, true);

    // title属性のブラウザ標準ツールチップを抑制
    document.addEventListener("pointerenter", function(e) {
        var el = findTitleEl(e.target);
        if (el && el.getAttribute("title")) {
            el.dataset.titleBackup = el.getAttribute("title");
            el.removeAttribute("title");
        }
    }, true);
    document.addEventListener("pointerleave", function(e) {
        var el = e.target;
        if (el && el.dataset && el.dataset.titleBackup) {
            el.setAttribute("title", el.dataset.titleBackup);
            delete el.dataset.titleBackup;
        }
    }, true);

    // PC: マウスホバーでツールチップ表示
    var isTouchDevice = matchMedia("(pointer:coarse)").matches;
    if (!isTouchDevice) {
        var hoverEl = null;
        var hoverTimer = null;
        document.addEventListener("mouseover", function(e) {
            var el = findTitleEl(e.target);
            if (el === hoverEl) return;
            hoverEl = el;
            clearTimeout(hoverTimer);
            if (!el) return;
            hoverTimer = setTimeout(function() {
                if (!tooltipVisible) {
                    tooltipSourceEl = el;
                    showTooltip(getTitleText(el), 0, 0, el);
                }
            }, 800);
        });
        document.addEventListener("mouseout", function(e) {
            var el = findTitleEl(e.target);
            if (el === hoverEl) {
                hoverEl = null;
                clearTimeout(hoverTimer);
                hoverTimer = null;
                if (tooltipVisible && tooltipSourceEl === el) hideTooltip();
            }
        });
    }

    // PC/スマホ共通: 長押しでツールチップ表示
    var tooltipJustShown = false;
    var suppressNextClick = false;

    // PC: pointerdown/pointerup で長押し検出
    document.addEventListener("pointerdown", function(e) {
        if (e.pointerType === "touch") return; // タッチはtouchstart側で処理
        tooltipJustShown = false;
        var el = findTitleEl(e.target);
        if (!el) return;
        tooltipTimer = setTimeout(function() {
            tooltipSourceEl = el;
            showTooltip(getTitleText(el), e.clientX, e.clientY, el);
            tooltipJustShown = true;
        }, LONG_PRESS_MS);
    });
    document.addEventListener("pointerup", function(e) {
        if (e.pointerType === "touch") return;
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
        if (tooltipJustShown) {
            suppressNextClick = true;
            tooltipJustShown = false;
        }
    });
    document.addEventListener("pointermove", function(e) {
        if (e.pointerType === "touch") return;
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
    });

    // スマホ: touchstart/touchend で長押し検出
    document.addEventListener("touchstart", function(e) {
        tooltipJustShown = false;
        var el = findTitleEl(e.target);
        if (!el) return;
        tooltipTimer = setTimeout(function() {
            tooltipSourceEl = el;
            showTooltip(getTitleText(el), 0, 0, el);
            tooltipJustShown = true;
        }, LONG_PRESS_MS);
    }, { passive: true });

    document.addEventListener("touchend", function() {
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
        if (tooltipJustShown) {
            suppressNextClick = true;
            tooltipJustShown = false;
        }
    }, { passive: true });

    document.addEventListener("touchmove", function() {
        clearTimeout(tooltipTimer);
        tooltipTimer = null;
    }, { passive: true });

    // blockOpacitySelect → blockOpacityInput 連動（インラインハンドラから移行）
    var opSel = document.getElementById("blockOpacitySelect");
    var opInp = document.getElementById("blockOpacityInput");
    if (opSel && opInp) {
        opSel.addEventListener("change", function() { opInp.value = this.value; });
    }
});
