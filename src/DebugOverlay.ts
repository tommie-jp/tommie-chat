import type { GameScene } from "./GameScene";
import { Scene, Color3, Color4, Vector3, SceneInstrumentation, EngineInstrumentation } from "@babylonjs/core";
import { CHUNK_SIZE, WORLD_SIZE } from "./WorldConstants";
import { profSetEnabled, profReset } from "./Profiler";
import { t } from "./i18n";
import { autoChatMessages } from "./AutoChatMessages";

/** コントロール要素の親行からラベルセルを取得し、デフォルト値と異なる場合に * を付ける */
const _nonDefaultCtrls = new WeakMap<HTMLElement, Set<HTMLElement>>();
const _resetFns = new WeakMap<HTMLElement, Map<HTMLElement, () => void>>();
const _tapTimeMap = new WeakMap<HTMLElement, number>();
const _listenersReady = new WeakSet<HTMLElement>();
function markNonDefault(ctrl: HTMLElement, defaultVal: string, currentVal: string, resetFn?: () => void): void {
    const td = ctrl.closest("td");
    const labelTd = td?.previousElementSibling as HTMLElement | null;
    if (!labelTd) return;
    // 同一ラベルに複数コントロールがある場合でも正しく * を表示
    if (!_nonDefaultCtrls.has(labelTd)) _nonDefaultCtrls.set(labelTd, new Set());
    const nds = _nonDefaultCtrls.get(labelTd)!;
    if (currentVal !== defaultVal) nds.add(ctrl); else nds.delete(ctrl);
    const base = labelTd.textContent!.replace(/\*$/, "");
    labelTd.textContent = nds.size > 0 ? base + "*" : base;
    if (resetFn) {
        if (!_resetFns.has(labelTd)) _resetFns.set(labelTd, new Map());
        _resetFns.get(labelTd)!.set(ctrl, resetFn);
    }
    if (!_listenersReady.has(labelTd)) {
        _listenersReady.add(labelTd);
        labelTd.style.cursor = "pointer";
        const runReset = () => {
            const fns = _resetFns.get(labelTd);
            if (fns) for (const fn of fns.values()) fn();
        };
        labelTd.addEventListener("dblclick", runReset);
        // モバイル: dblclickが発火しないためtouchendでダブルタップ検出
        labelTd.addEventListener("touchend", (e) => {
            const now = Date.now();
            const last = _tapTimeMap.get(labelTd) || 0;
            if (now - last < 400) {
                e.preventDefault();
                runReset();
                _tapTimeMap.set(labelTd, 0);
            } else {
                _tapTimeMap.set(labelTd, now);
            }
        });
    }
}

/** デバッグ設定用Cookie読み書き */
function dbgGetCookie(name: string): string | null {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
}
function dbgSetCookie(name: string, value: string): void {
    document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${60*60*24*365}`;
}

/** 開発者モードの有効/無効を切り替える */
function setDevMode(on: boolean): void {
    if (on) {
        document.body.classList.add("dev-mode");
    } else {
        document.body.classList.remove("dev-mode");
    }
    dbgSetCookie("devMode", on ? "1" : "0");
    const btn = document.getElementById("devModeBtn");
    if (btn) btn.textContent = on ? "On" : "Off";
}

function isDevMode(): boolean {
    return document.body.classList.contains("dev-mode");
}

// 起動時の開発者モード判定（URLパラメータまたはCookie）
(function initDevMode() {
    const urlDev = new URLSearchParams(location.search).has("dev");
    const cookieDev = dbgGetCookie("devMode") === "1";
    if (urlDev || cookieDev) {
        document.body.classList.add("dev-mode");
    }
})();

export function setupDebugOverlay(game: GameScene): void {
    const isMobileDev = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
    const scaleSelect = document.getElementById("scaleSelect") as HTMLSelectElement;

    const lodBtn = document.getElementById("lodBtn") as HTMLButtonElement;
    const farClipInput = document.getElementById("farClipInput") as HTMLSelectElement;
    const fovSelect = document.getElementById("fovSelect") as HTMLSelectElement;
    const fovInput = document.getElementById("fovInput") as HTMLInputElement;
    const fogBtn = document.getElementById("fogBtn") as HTMLButtonElement;
    const fogColorInput = document.getElementById("fogColorInput") as HTMLInputElement;
    const dofBtn = document.getElementById("dofBtn") as HTMLButtonElement;

    const glossInput = document.getElementById("glossInput") as HTMLInputElement;
    const autoChatBtn = document.getElementById("autoChatBtn") as HTMLButtonElement;
    const npcAutoChatBtn = document.getElementById("npcAutoChatBtn") as HTMLButtonElement;
    const npcVisBtn = document.getElementById("npcVisBtn") as HTMLButtonElement;
    const buildModeBtn = document.getElementById("buildModeBtn") as HTMLButtonElement;
    const speechTrimBtn = document.getElementById("speechTrimBtn") as HTMLButtonElement;
    const aaModeBtn = document.getElementById("aaModeBtn") as HTMLButtonElement;
    const avatarThickInput = document.getElementById("avatarThickInput") as HTMLInputElement;
    const profileStartBtn = document.getElementById("profileStartBtn") as HTMLButtonElement;
    const profileStopBtn = document.getElementById("profileStopBtn") as HTMLButtonElement;
    const profileLogBtn = document.getElementById("profileLogBtn") as HTMLButtonElement;
    const serverProfileBtn = document.getElementById("serverProfileBtn") as HTMLButtonElement;

    const resetViewBtn   = document.getElementById("resetViewBtn")   as HTMLButtonElement;
    const topViewBtn     = document.getElementById("topViewBtn")     as HTMLButtonElement;
    const defaultPosBtn  = document.getElementById("defaultPosBtn")  as HTMLButtonElement;

    const debugOverlay   = document.getElementById("debug-overlay")      as HTMLElement;
    const debugTitleBar  = document.getElementById("debug-title-bar")    as HTMLElement;
    const debugMinBtn    = document.getElementById("debug-minimize-btn") as HTMLButtonElement;
    const debugRestBtn   = document.getElementById("debug-restore-btn")  as HTMLButtonElement;

    const debugBody = document.getElementById("debug-body") as HTMLElement;

    if (debugOverlay && debugTitleBar && debugMinBtn && debugRestBtn && debugBody) {

        const setCookie = (name: string, value: string) => {
            document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${60*60*24*365}`;
        };
        const getCookie = (name: string): string | null => {
            const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
            return m ? decodeURIComponent(m[1]) : null;
        };
        let isMaximized = false;
        const saveDebugState = () => {
            const overlayRect = debugOverlay.getBoundingClientRect();
            const isMinimized = debugOverlay.classList.contains("minimized");
            setCookie("dbgLeft", String(Math.round(overlayRect.left)));
            setCookie("dbgTop",  String(Math.round(overlayRect.top)));
            if (!isMinimized && !isMaximized) {
                setCookie("dbgWidth",  String(Math.round(overlayRect.width)));
                setCookie("dbgHeight", String(Math.round(overlayRect.height)));
            }
            setCookie("dbgMin", isMinimized ? "1" : "0");
        };

        const savedLeft  = getCookie("dbgLeft");
        const savedTop   = getCookie("dbgTop");
        const savedWidth = getCookie("dbgWidth");
        const savedHeight= getCookie("dbgHeight");
        const savedMin   = getCookie("dbgMin");

        debugOverlay.style.right = "";
        if (!isMobileDev) {
            if (savedLeft  !== null) debugOverlay.style.left  = savedLeft  + "px";
            if (savedTop   !== null) debugOverlay.style.top   = savedTop   + "px";
            if (savedWidth !== null && savedMin !== "1") debugOverlay.style.width  = savedWidth + "px";
            if (savedHeight!== null && savedMin !== "1") debugOverlay.style.height = savedHeight + "px";
            if (savedMin === "1") debugOverlay.classList.add("minimized");
            if (!isMobileDev) game.clampToViewport(debugOverlay);
        }

        let isDragging = false;
        let dragOX = 0, dragOY = 0;

        debugTitleBar.addEventListener("pointerdown", (e: PointerEvent) => {
            if ((e.target as HTMLElement).tagName === "BUTTON") return;
            if (isMobileDev && matchMedia("(orientation:landscape)").matches) return;
            isDragging = true;
            const rect = debugOverlay.getBoundingClientRect();
            dragOX = e.clientX - rect.left;
            dragOY = e.clientY - rect.top;
            debugTitleBar.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        document.addEventListener("pointermove", (e: PointerEvent) => {
            if (!isDragging) return;
            debugOverlay.style.left = Math.max(0, e.clientX - dragOX) + "px";
            debugOverlay.style.top  = Math.max(0, e.clientY - dragOY) + "px";
        });
        document.addEventListener("pointerup", () => {
            if (isDragging) { isDragging = false; saveDebugState(); }
        });

        let savedOverlayHeight = "";
        let savedOverlayWidth  = "";
        debugMinBtn.addEventListener("click", () => {
            debugOverlay.style.display = "none";
            document.cookie = `showDebug=${encodeURIComponent("0")};path=/;max-age=${60*60*24*365}`;
            const menuDebugBtn = document.getElementById("menu-debug");
            if (menuDebugBtn) menuDebugBtn.textContent = "　 " + t("menu.debug");
        });
        debugRestBtn.addEventListener("click", () => {
            debugOverlay.classList.remove("minimized");
            isMaximized = false;
            debugOverlay.style.width  = savedOverlayWidth  || (savedWidth  !== null ? savedWidth  + "px" : "270px");
            debugOverlay.style.height = savedOverlayHeight || (savedHeight !== null ? savedHeight + "px" : "");
            saveDebugState();
        });

        let savedMaxWidth = "", savedMaxHeight = "", savedMaxLeft = "", savedMaxTop = "";
        debugTitleBar.addEventListener("dblclick", (e: MouseEvent) => {
            if ((e.target as HTMLElement).tagName === "BUTTON") return;
            if (debugOverlay.classList.contains("minimized")) {
                debugRestBtn.click();
                return;
            }
            if (!isMaximized) {
                savedMaxWidth  = debugOverlay.style.width;
                savedMaxHeight = debugOverlay.style.height;
                savedMaxLeft   = debugOverlay.style.left;
                savedMaxTop    = debugOverlay.style.top;
                debugOverlay.style.width  = (window.innerWidth  - 30) + "px";
                debugOverlay.style.height = (window.innerHeight - 30) + "px";
                debugOverlay.style.left   = "15px";
                debugOverlay.style.top    = "15px";
                isMaximized = true;
            } else {
                debugOverlay.style.width  = savedMaxWidth  || (savedWidth  !== null ? savedWidth  + "px" : "270px");
                debugOverlay.style.height = savedMaxHeight || (savedHeight !== null ? savedHeight + "px" : "");
                debugOverlay.style.left   = savedMaxLeft   || (savedLeft   !== null ? savedLeft   + "px" : "");
                debugOverlay.style.top    = savedMaxTop    || (savedTop    !== null ? savedTop    + "px" : "15px");
                isMaximized = false;
                saveDebugState();
            }
        });

        const resizeObserver = new ResizeObserver(() => {
            if (!debugOverlay.classList.contains("minimized") && !isMaximized) saveDebugState();
        });
        resizeObserver.observe(debugOverlay);
    }

    // --- 00.DevMode ボタン ---
    const devModeBtn = document.getElementById("devModeBtn") as HTMLButtonElement;
    if (devModeBtn) {
        devModeBtn.textContent = isDevMode() ? "On" : "Off";
        devModeBtn.addEventListener("click", () => {
            setDevMode(!isDevMode());
            // ping-display のDOM再構築を強制
            const pd = document.getElementById("ping-display");
            if (pd) (pd as any).__pdState = null;
        });
    }

    {
        const menuBtn    = document.getElementById("menu-btn")!;
        const menuPopup  = document.getElementById("menu-popup")!;
        const cookieReset = document.getElementById("menu-cookie-reset")!;

        // --- ハンバーガーメニュー3回タップで開発者モード切り替え ---
        let menuTapCount = 0;
        let menuTapTimer: ReturnType<typeof setTimeout> | null = null;
        menuBtn.addEventListener("dblclick", (e) => e.preventDefault());
        menuBtn.addEventListener("pointerdown", () => {
            menuTapCount++;
            if (menuTapTimer) clearTimeout(menuTapTimer);
            menuTapTimer = setTimeout(() => { menuTapCount = 0; }, 800);
            if (menuTapCount >= 3) {
                menuTapCount = 0;
                setDevMode(!isDevMode());
                const pd = document.getElementById("ping-display");
                if (pd) (pd as any).__pdState = null;
            }
        });

        /** メニューを閉じる（選択項目のフラッシュ＋フェードアウト） */
        const closeMenu = (selectedBtn?: HTMLElement) => {
            if (!menuPopup.classList.contains("open")) return;
            if (selectedBtn) {
                selectedBtn.classList.add("menu-flash");
                selectedBtn.addEventListener("animationend", () => selectedBtn.classList.remove("menu-flash"), { once: true });
            }
            const delay = selectedBtn ? 250 : 0;
            setTimeout(() => {
                menuPopup.classList.add("menu-fade-out");
                menuPopup.addEventListener("animationend", () => {
                    menuPopup.classList.remove("open", "menu-fade-out");
                }, { once: true });
            }, delay);
        };
        // GameScene 経由で他ファイルからも呼べるようにする
        (game as any).closeMenu = closeMenu;

        menuBtn.addEventListener("click", () => {
            if (menuPopup.classList.contains("open")) {
                closeMenu();
            } else {
                menuPopup.classList.remove("menu-fade-out");
                menuPopup.classList.add("open");
            }
        });
        // iOS: 長押しコピーメニュー抑制
        menuBtn.addEventListener("contextmenu", (e) => e.preventDefault());

        // メニュー外クリックで閉じる
        document.addEventListener("mousedown", (e) => {
            if (!menuPopup.classList.contains("open")) return;
            const t = e.target as HTMLElement;
            if (t.closest("#menu-popup") || t.closest("#menu-btn")) return;
            closeMenu();
        });

        cookieReset.addEventListener("click", () => {
            ["server-settings-panel", "server-log-panel", "user-list-panel",
             "chat-history-panel", "chat-settings-panel", "ping-panel", "debug-overlay"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = "none";
            });
            document.cookie.split(";").forEach(c => {
                const name = c.trim().split("=")[0];
                if (name) document.cookie = `${name}=;path=/;max-age=0`;
            });
            const maxAge = `path=/;max-age=${60 * 60 * 24 * 365}`;
            document.cookie = `showSrvSettings=0;${maxAge}`;
            document.cookie = `showSrvLog=0;${maxAge}`;
            document.cookie = `showUserList=0;${maxAge}`;
            document.cookie = `showChatHist=0;${maxAge}`;
            document.cookie = `showPing=0;${maxAge}`;
            document.cookie = `showDebug=0;${maxAge}`;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const pad = 15;
            const dbgW = 270,  dbgH = Math.min(vh - pad * 2, 600),
                         dbgT = 45,         dbgL = Math.max(pad, vw - dbgW - pad);
            const ulW  = 140,  ulH  = 200,         ulL  = Math.max(pad, vw - ulW  - pad),  ulT  = dbgT + 36 + 10;
            const chW  = 280,  chH  = Math.min(360, vh - pad * 2), chL  = pad,             chT  = pad;
            const ssL  = pad,                      ssT  = chT + chH + 10;
            const slW  = Math.min(320, vw - chW - dbgW - pad * 3),
                         slH  = 200,
                         slL  = chL + chW + pad,   slT  = pad;
            document.cookie = `dbgLeft=${dbgL};${maxAge}`;
            document.cookie = `dbgTop=${dbgT};${maxAge}`;
            document.cookie = `dbgWidth=${dbgW};${maxAge}`;
            document.cookie = `dbgHeight=${dbgH};${maxAge}`;
            document.cookie = `ulLeft=${ulL};${maxAge}`;
            document.cookie = `ulTop=${ulT};${maxAge}`;
            document.cookie = `ulWidth=${ulW};${maxAge}`;
            document.cookie = `ulHeight=${ulH};${maxAge}`;
            document.cookie = `chatHistLeft=${chL};${maxAge}`;
            document.cookie = `chatHistTop=${chT};${maxAge}`;
            document.cookie = `chatHistWidth=${chW};${maxAge}`;
            document.cookie = `chatHistHeight=${chH};${maxAge}`;
            document.cookie = `srvLeft=${ssL};${maxAge}`;
            document.cookie = `srvTop=${ssT};${maxAge}`;
            document.cookie = `slLeft=${slL};${maxAge}`;
            document.cookie = `slTop=${slT};${maxAge}`;
            document.cookie = `slWidth=${slW};${maxAge}`;
            document.cookie = `slHeight=${slH};${maxAge}`;
            location.reload();
        });

        // パネル表示 ON/OFF トグル
        const gCk = (k: string): string | null => {
            const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
            return m ? decodeURIComponent(m[1]) : null;
        };
        const sCk = (k: string, v: string) =>
            document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;

        const isMobileMenu = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
        const toggleRegistry: { btnId: string; targetId: string; label: string; cookieKey: string }[] = [];

        let savedDivider = gCk("lsDivider") || "60%";
        if (savedDivider === "100%") savedDivider = "60%";

        let savedPtDivider = gCk("ptDivider") || "60vh";
        if (savedPtDivider === "100%" || savedPtDivider === "100vh") savedPtDivider = "60vh";
        // 旧クッキー（%単位）をvhに変換
        if (savedPtDivider.endsWith("%")) savedPtDivider = savedPtDivider.replace("%", "vh");
        // 30〜75%にクランプ
        { const v = parseFloat(savedPtDivider); if (!isNaN(v)) savedPtDivider = Math.max(30, Math.min(75, v)) + "vh"; }

        const updateMobileLayout = () => {
            if (!isMobileMenu) return;
            // モバイル: パネルのインラインheight/widthをクリア（CSS !importantに任せる）
            for (const reg of toggleRegistry) {
                const el = document.getElementById(reg.targetId);
                if (el) { el.style.height = ""; el.style.width = ""; }
            }
            const anyVisible = toggleRegistry.some(reg => {
                const el = document.getElementById(reg.targetId);
                return el && el.style.display !== "none";
            });
            const isLandscape = matchMedia("(orientation:landscape)").matches;
            if (isLandscape) {
                const divider = document.getElementById("landscape-divider");
                const cvs = document.getElementById("renderCanvas");
                if (anyVisible) {
                    savedDivider = gCk("lsDivider") || savedDivider;
                    if (divider) divider.style.display = "";
                    document.documentElement.style.setProperty("--ls-divider", savedDivider);
                    if (cvs) cvs.style.height = "";
                } else {
                    const cur = getComputedStyle(document.documentElement).getPropertyValue("--ls-divider").trim();
                    if (cur && cur !== "100%") savedDivider = cur;
                    if (divider) divider.style.display = "none";
                    document.documentElement.style.setProperty("--ls-divider", "100%");
                    if (cvs) cvs.style.height = "100vh";
                }
                const chatContainer = document.getElementById("chat-container");
                if (chatContainer) {
                    if (anyVisible) {
                        chatContainer.style.left = "";
                        chatContainer.style.right = "";
                        chatContainer.style.width = "";
                        chatContainer.style.maxWidth = "";
                        chatContainer.style.bottom = "";
                    } else {
                        // パネル非表示: 右下に短く配置
                        chatContainer.style.left = "auto";
                        chatContainer.style.right = "8px";
                        chatContainer.style.width = "40%";
                        chatContainer.style.maxWidth = "400px";
                        chatContainer.style.bottom = "";
                    }
                    chatContainer.style.background = anyVisible ? "" : "transparent";
                    // --ls-panel-bottom を再計算（パネルをセリフ入力の上に制限）
                    requestAnimationFrame(() => {
                        const rect = chatContainer.getBoundingClientRect();
                        const viewH = window.innerHeight;
                        const bottomFromViewport = viewH - rect.bottom;
                        document.documentElement.style.setProperty("--ls-panel-bottom", (rect.height + bottomFromViewport + 4) + "px");
                    });
                }
                // セリフ入力: パネル表示時は全幅、非表示時はコンテナ内全幅（コンテナが短い）
                const chatInput = document.getElementById("chatInput") as HTMLTextAreaElement | null;
                if (chatInput) {
                    chatInput.style.flexGrow = "1";
                    chatInput.style.width = "auto";
                }
            } else {
                const ptDiv = document.getElementById("portrait-divider");
                const cvs = document.getElementById("renderCanvas");
                if (anyVisible) {
                    savedPtDivider = gCk("ptDivider") || savedPtDivider;
                    if (ptDiv) ptDiv.style.display = "none";
                    document.documentElement.style.setProperty("--pt-divider", savedPtDivider);
                    document.body.classList.add("sp-panel-visible");
                    if (cvs) cvs.style.height = "";
                } else {
                    const cur = getComputedStyle(document.documentElement).getPropertyValue("--pt-divider").trim();
                    if (cur && cur !== "100%" && cur !== "100vh") savedPtDivider = cur;
                    if (ptDiv) ptDiv.style.display = "none";
                    document.documentElement.style.setProperty("--pt-divider", "100vh");
                    document.body.classList.remove("sp-panel-visible");
                    if (cvs) cvs.style.height = "100vh";
                }
                const chatContainer = document.getElementById("chat-container");
                if (chatContainer) {
                    chatContainer.style.left = "";
                    chatContainer.style.right = "";
                    chatContainer.style.width = "";
                    chatContainer.style.maxWidth = "";
                    chatContainer.style.background = anyVisible ? "" : "transparent";
                }
            }
            // CSS変数の反映を待ってからリサイズ + ミニマップクランプ
            requestAnimationFrame(() => {
                game.engine.resize();
                for (const cb of game.onDividerMove) cb();
            });
        };

        type MK = Parameters<typeof t>[0];
        const makeToggle = (btnId: string, targetId: string, labelKey: MK, cookieKey: string) => {
            const btn    = document.getElementById(btnId);
            const target = document.getElementById(targetId);
            if (!btn || !target) return;
            toggleRegistry.push({ btnId, targetId, label: labelKey, cookieKey });

            if (gCk(cookieKey) === "0") {
                target.style.display = "none";
                btn.textContent = "　 " + t(labelKey);
            }

            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                closeMenu(btn);
                const visible = target.style.display !== "none";

                if (isMobileMenu && !visible) {
                    for (const reg of toggleRegistry) {
                        if (reg.targetId === targetId) continue;
                        const otherPanel = document.getElementById(reg.targetId);
                        const otherBtn   = document.getElementById(reg.btnId);
                        if (otherPanel && otherPanel.style.display !== "none") {
                            otherPanel.style.display = "none";
                            if (otherBtn) otherBtn.textContent = "　 " + t(reg.label as MK);
                            sCk(reg.cookieKey, "0");
                        }
                    }
                }

                if (visible) {
                    // 非表示にする前にサイズ・位置をクッキーに保存
                    const r = target.getBoundingClientRect();
                    sCk(targetId + "_w", String(Math.round(r.width)));
                    sCk(targetId + "_h", String(Math.round(r.height)));
                    sCk(targetId + "_t", String(Math.round(r.top)));
                    sCk(targetId + "_l", String(Math.round(r.left)));
                }
                target.style.display = visible ? "none" : "";
                if (!visible) {
                    // パネル表示時: クッキーから復元、小さすぎ/画面外ならデフォルト
                    const pad = 15;
                    const defaults: Record<string, { w: number; h: number; top: number; left: number }> = {
                        "debug-overlay":         { w: 310, h: 0,   top: 45,  left: window.innerWidth - 310 - pad },
                        "user-list-panel":       { w: 420, h: 280, top: pad, left: window.innerWidth - 420 - 300 },
                        "chat-history-panel":    { w: 360, h: 400, top: pad, left: pad },
                        "chat-settings-panel":   { w: 240, h: 0,   top: 80,  left: window.innerWidth - 240 - 320 },
                        "server-log-panel":      { w: 380, h: 240, top: 120, left: window.innerWidth - 380 - pad },
                        "server-settings-panel": { w: 210, h: 0,   top: pad, left: window.innerWidth - 210 - 460 },
                        "ping-panel":            { w: 300, h: 160, top: pad, left: window.innerWidth - 300 - 300 },
                        "ccu-panel":             { w: 300, h: 160, top: pad, left: window.innerWidth - 300 - 610 },
                        "about-panel":           { w: 380, h: 0,   top: -1, left: -1 },  // -1 = CSS中央配置を使用
                        "displayname-panel":     { w: 280, h: 0,   top: 80, left: pad },
                    };
                    const d = defaults[targetId];
                    if (d) {
                        const ck = (k: string) => { const v = gCk(targetId + "_" + k); return v !== null ? parseInt(v, 10) : NaN; };
                        let w = ck("w"), h = ck("h"), t = ck("t"), l = ck("l");
                        const minW = d.w * 0.5;
                        const minH = d.h * 0.5;
                        const vw = window.innerWidth, vh = window.innerHeight;
                        // サイズが小さすぎるか無効ならデフォルト
                        if (isNaN(w) || w < minW) w = d.w;
                        if (isNaN(h) || (d.h > 0 && h < minH)) h = d.h;
                        // クッキーに有効な位置があるか
                        const hasValidPos = !isNaN(l) && !isNaN(t)
                            && l >= -w / 2 && l <= vw - 30
                            && t >= 0 && t <= vh - 30;
                        target.style.width  = w + "px";
                        target.style.height = d.h > 0 ? h + "px" : "auto";
                        target.style.transform = "";
                        if (hasValidPos) {
                            // クッキーから復元
                            target.style.top    = t + "px";
                            target.style.left   = l + "px";
                            target.style.right  = "auto";
                        } else if (d.left === -1) {
                            // 画面中央にピクセル値で配置
                            target.style.left = "0px";
                            target.style.top = "0px";
                            target.style.right = "auto";
                            // 一旦レンダリングしてサイズを取得し中央に配置
                            const rect = target.getBoundingClientRect();
                            target.style.left = Math.round((window.innerWidth - rect.width) / 2) + "px";
                            target.style.top = Math.round((window.innerHeight - rect.height) / 2) + "px";
                        } else {
                            target.style.top    = d.top + "px";
                            target.style.left   = d.left + "px";
                            target.style.right  = "auto";
                        }
                    }
                    if (!isMobileDev) game.clampToViewport(target);
                }
                btn.textContent = (visible ? "　" : "✓") + " " + t(labelKey);
                sCk(cookieKey, visible ? "0" : "1");
                updateMobileLayout();
                // モバイル: clampToViewportのインラインheight/widthをクリア
                if (isMobileDev) {
                    target.style.height = "";
                    target.style.width = "";
                }
            });
        };
        makeToggle("menu-serversettings", "server-settings-panel", "menu.serversettings", "showSrvSettings");
        makeToggle("menu-serverlog",      "server-log-panel",      "menu.serverlog",     "showSrvLog");
        makeToggle("menu-userlist",       "user-list-panel",       "menu.userlist",      "showUserList");
        makeToggle("menu-chathistory",    "chat-history-panel",    "menu.chathistory",   "showChatHist");
        makeToggle("menu-chatsettings",  "chat-settings-panel",   "menu.chatsettings",  "showChatSettings");
        makeToggle("menu-ping",           "ping-panel",            "menu.ping",          "showPing");
        makeToggle("menu-ccu",            "ccu-panel",             "menu.ccu",           "showCcu");
        makeToggle("menu-debug",          "debug-overlay",         "menu.debug",         "showDebug");
        makeToggle("menu-about",          "about-panel",           "menu.about",         "showAbout");
        makeToggle("menu-login",          "displayname-panel",     "menu.displayname",   "showDisplayName");

        // 右上クリック: バッジ→サーバーログ、ユーザID→表示名変更、ping→Pingグラフ、FPS→デバッグツール
        const pdEl = document.getElementById("ping-display");
        if (pdEl) {
            let pdAction: "userlist" | "ping" | "fps" | "serverlog" | null = null;
            pdEl.addEventListener("pointerdown", (e) => {
                const target = e.target as HTMLElement;
                if (target.id === "pd-uid") {
                    pdAction = "userlist";
                } else if (target.id === "pd-badge") {
                    pdAction = "serverlog";
                } else if (target.id === "pd-ccu" || !!target.closest?.("#pd-ccu")) {
                    pdAction = "userlist";
                } else if (target.id === "pd-ping" || !!target.closest?.("#pd-ping")) {
                    pdAction = "ping";
                } else if (target.id === "pd-fps" || !!target.closest?.("#pd-fps")) {
                    pdAction = "fps";
                } else {
                    pdAction = null;
                    return;
                }
                e.stopPropagation();
                e.preventDefault();
            }, true);
            pdEl.addEventListener("click", (e) => {
                if (!pdAction) return;
                e.stopPropagation();
                e.preventDefault();
                if (pdAction === "userlist") document.getElementById("menu-login")?.click();
                else if (pdAction === "ping") document.getElementById("menu-ping")?.click();
                else if (pdAction === "fps") document.getElementById("menu-debug")?.click();
                else if (pdAction === "serverlog") document.getElementById("menu-serverlog")?.click();
                pdAction = null;
            }, true);
        }

        // 右下アプリ名クリック → tommieChatについて
        const footerEl = document.getElementById("app-footer-version");
        if (footerEl) {
            footerEl.addEventListener("click", () => {
                document.getElementById("menu-about")?.click();
            });
        }

        updateMobileLayout();
        window.addEventListener("orientationchange", () => setTimeout(updateMobileLayout, 200));
        if (isMobileMenu) {
            const mo = new MutationObserver(updateMobileLayout);
            for (const reg of toggleRegistry) {
                const el = document.getElementById(reg.targetId);
                if (el) mo.observe(el, { attributes: true, attributeFilter: ["style"] });
            }
        }
    }

    const playerPosVal = document.getElementById("val-player-pos");
    const chunkVal = document.getElementById("val-chunk");
    const aoiVal = document.getElementById("val-aoi");
    const camInfoVal = document.getElementById("val-cam-info");

    const fv = document.getElementById("val-fps");
    const cv = document.getElementById("val-cpu");
    const gv = document.getElementById("val-gpu");
    const dv = document.getElementById("val-draw");
    const mv = document.getElementById("val-mesh");
    const matv = document.getElementById("val-mats");
    const bv = document.getElementById("val-bones");
    const rv = document.getElementById("val-jsram");
    const tv = document.getElementById("val-texram");
    const geov = document.getElementById("val-georam");
    const iv = document.getElementById("val-indices");
    const pv = document.getElementById("val-polys");
    const ov = document.getElementById("val-occlq");
    const apiv = document.getElementById("val-api");
    const profv = document.getElementById("val-profile");

    const isWebGPU = (game.engine as any).isWebGPU || game.engine.name === "WebGPU";
    if (apiv) apiv.innerText = isWebGPU ? "WebGPU" : "WebGL2";

    // ブラウザ種別 & 起動モード
    {
        const bv = document.getElementById("val-browser");
        if (bv) {
            const ua = navigator.userAgent;
            const isPWA = window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
            const mode = isPWA ? "PWA" : "Browser";
            let browser = "Unknown";
            const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
            if (/CriOS/.test(ua)) browser = "Chrome(iOS)";
            else if (/Chrome/.test(ua) && !/Edg/.test(ua)) browser = isIOS ? "Chrome(iOS)" : "Chrome";
            else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = isIOS ? "Safari(iOS)" : "Safari";
            else if (/Firefox/.test(ua)) browser = isIOS ? "Firefox(iOS)" : "Firefox";
            else if (/Edg/.test(ua)) browser = "Edge";
            bv.innerText = `${browser} / ${mode}`;
            bv.style.cursor = "pointer";
            let uaExpanded = false;
            bv.addEventListener("click", () => {
                uaExpanded = !uaExpanded;
                if (uaExpanded) {
                    bv.innerText = navigator.userAgent;
                    bv.style.whiteSpace = "normal";
                    bv.style.wordBreak = "break-all";
                    bv.style.fontSize = "10px";
                } else {
                    bv.innerText = `${browser} / ${mode}`;
                    bv.style.whiteSpace = "";
                    bv.style.wordBreak = "";
                    bv.style.fontSize = "";
                }
            });
        }
    }

    // --- テーマ切替 ---
    const themeSelect = document.getElementById("themeSelect") as HTMLSelectElement | null;
    if (themeSelect) {
        const getThemeCookie = (): string | null => {
            const m = document.cookie.match(/(?:^|; )uiTheme=([^;]*)/);
            return m ? decodeURIComponent(m[1]) : null;
        };
        const setThemeCookie = (v: string) => {
            document.cookie = `uiTheme=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
        };
        const applyTheme = (theme: string) => {
            document.body.classList.remove("theme-dark", "theme-pop1");
            if (theme === "dark") document.body.classList.add("theme-dark");
            else document.body.classList.add("theme-pop1");
        };
        const saved = getThemeCookie() ?? "pop1";
        themeSelect.value = saved;
        applyTheme(saved);
        markNonDefault(themeSelect, "pop1", saved, () => {
            themeSelect.value = "pop1"; applyTheme("pop1"); setThemeCookie("pop1"); markNonDefault(themeSelect, "pop1", "pop1");
        });
        themeSelect.addEventListener("change", () => {
            console.log("Theme change:", themeSelect.value, "classList:", document.body.classList.toString());
            applyTheme(themeSelect.value);
            setThemeCookie(themeSelect.value);
            markNonDefault(themeSelect, "pop1", themeSelect.value);
            console.log("Theme applied:", document.body.classList.toString());
        });
    }

    // --- チャットオーバーレイ行数 ---
    const chatOlMaxSelect = document.getElementById("chatOlMaxSelect") as HTMLSelectElement | null;
    if (chatOlMaxSelect) {
        const getChatOlCookie = (): string | null => {
            const m = document.cookie.match(/(?:^|; )chatOlMax=([^;]*)/);
            return m ? decodeURIComponent(m[1]) : null;
        };
        const setChatOlCookie = (v: string) => {
            document.cookie = `chatOlMax=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
        };
        const savedOl = getChatOlCookie() ?? "5";
        chatOlMaxSelect.value = savedOl;
        (game as any).setChatOverlayMax?.(parseInt(savedOl));
        markNonDefault(chatOlMaxSelect, "5", savedOl, () => {
            chatOlMaxSelect.value = "5"; (game as any).setChatOverlayMax?.(5); setChatOlCookie("5"); markNonDefault(chatOlMaxSelect, "5", "5");
        });
        chatOlMaxSelect.addEventListener("change", () => {
            const val = parseInt(chatOlMaxSelect.value);
            (game as any).setChatOverlayMax?.(val);
            setChatOlCookie(chatOlMaxSelect.value);
            markNonDefault(chatOlMaxSelect, "5", chatOlMaxSelect.value);
        });
    }

    // --- チャットオーバーレイ 背景色・透明度 ---
    const chatOlOverlay = document.getElementById("chat-overlay");
    const chatOlBgColor = document.getElementById("chatOlBgColor") as HTMLInputElement | null;
    const chatOlBgAlpha = document.getElementById("chatOlBgAlpha") as HTMLSelectElement | null;
    const chatOlFontColor = document.getElementById("chatOlFontColor") as HTMLInputElement | null;
    const chatOlFontSize = document.getElementById("chatOlFontSize") as HTMLSelectElement | null;

    const olCk = (k: string): string | null => {
        const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
        return m ? decodeURIComponent(m[1]) : null;
    };
    const olSCk = (k: string, v: string) => {
        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
    };

    const hexToRgb = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return { r, g, b };
    };

    const applyOlBg = () => {
        if (!chatOlOverlay) return;
        const color = chatOlBgColor?.value ?? "#000000";
        const alpha = chatOlBgAlpha?.value ?? "0.45";
        const { r, g, b } = hexToRgb(color);
        // CSS変数で各行の背景に反映
        chatOlOverlay.style.setProperty("--ol-bg", `rgba(${r},${g},${b},${alpha})`);
    };

    const applyOlFont = () => {
        if (!chatOlOverlay) return;
        const color = chatOlFontColor?.value ?? "#ffffff";
        const size = chatOlFontSize?.value ?? "13";
        chatOlOverlay.style.setProperty("--ol-color", color);
        chatOlOverlay.style.fontSize = size + "px";
    };

    // 初期値をCookieから復元
    if (chatOlBgColor) { const v = olCk("chatOlBgColor"); if (v) chatOlBgColor.value = v; }
    if (chatOlBgAlpha) { const v = olCk("chatOlBgAlpha"); if (v) chatOlBgAlpha.value = v; }
    if (chatOlFontColor) { const v = olCk("chatOlFontColor"); if (v) chatOlFontColor.value = v; }
    if (chatOlFontSize) { const v = olCk("chatOlFontSize"); if (v) chatOlFontSize.value = v; }
    applyOlBg();
    applyOlFont();

    // 初期 * 表示
    if (chatOlBgColor) markNonDefault(chatOlBgColor, "#dfeed4", chatOlBgColor.value, () => {
        chatOlBgColor!.value = "#dfeed4"; applyOlBg(); olSCk("chatOlBgColor", "#dfeed4"); markNonDefault(chatOlBgColor!, "#dfeed4", "#dfeed4");
    });
    if (chatOlBgAlpha) markNonDefault(chatOlBgAlpha, "0.45", chatOlBgAlpha.value, () => {
        chatOlBgAlpha!.value = "0.45"; applyOlBg(); olSCk("chatOlBgAlpha", "0.45"); markNonDefault(chatOlBgAlpha!, "0.45", "0.45");
    });
    if (chatOlFontColor) markNonDefault(chatOlFontColor, "#5c5c5c", chatOlFontColor.value, () => {
        chatOlFontColor!.value = "#5c5c5c"; applyOlFont(); olSCk("chatOlFontColor", "#5c5c5c"); markNonDefault(chatOlFontColor!, "#5c5c5c", "#5c5c5c");
    });
    if (chatOlFontSize) markNonDefault(chatOlFontSize, "13", chatOlFontSize.value, () => {
        chatOlFontSize!.value = "13"; applyOlFont(); olSCk("chatOlFontSize", "13"); markNonDefault(chatOlFontSize!, "13", "13");
    });
    // イベントハンドラ
    chatOlBgColor?.addEventListener("input", () => { applyOlBg(); olSCk("chatOlBgColor", chatOlBgColor!.value); markNonDefault(chatOlBgColor!, "#dfeed4", chatOlBgColor!.value); });
    chatOlBgAlpha?.addEventListener("change", () => { applyOlBg(); olSCk("chatOlBgAlpha", chatOlBgAlpha!.value); markNonDefault(chatOlBgAlpha!, "0.45", chatOlBgAlpha!.value); });
    chatOlFontColor?.addEventListener("input", () => { applyOlFont(); olSCk("chatOlFontColor", chatOlFontColor!.value); markNonDefault(chatOlFontColor!, "#5c5c5c", chatOlFontColor!.value); });
    chatOlFontSize?.addEventListener("change", () => {
        applyOlFont(); olSCk("chatOlFontSize", chatOlFontSize!.value); markNonDefault(chatOlFontSize!, "13", chatOlFontSize!.value);
        // フォントサイズ変更時にmax-heightを再計算
        (game as any).setChatOverlayMax?.((game as any).chatOverlayMax ?? 5);
    });

    // --- チャットオーバーレイ 時刻色・名前色 ---
    const chatOlTimeColor = document.getElementById("chatOlTimeColor") as HTMLInputElement | null;
    const chatOlNameColor = document.getElementById("chatOlNameColor") as HTMLInputElement | null;

    const applyOlPartColors = () => {
        if (!chatOlOverlay) return;
        if (chatOlTimeColor) chatOlOverlay.style.setProperty("--ol-time-color", chatOlTimeColor.value);
        if (chatOlNameColor) chatOlOverlay.style.setProperty("--ol-name-color", chatOlNameColor.value);
    };

    if (chatOlTimeColor) { const v = olCk("chatOlTimeColor"); if (v) chatOlTimeColor.value = v; }
    // 名前色: Cookie未設定なら見やすいランダム色を選択
    if (chatOlNameColor) {
        const v = olCk("chatOlNameColor");
        if (v) {
            chatOlNameColor.value = v;
        } else {
            const palette = [
                "#2a7a2a", "#c03030", "#2060c0", "#b05800",
                "#7030a0", "#008080", "#c06090", "#505050",
                "#1a6a4a", "#a04080", "#3070a0", "#906020",
            ];
            chatOlNameColor.value = palette[Math.floor(Math.random() * palette.length)];
            olSCk("chatOlNameColor", chatOlNameColor.value);
        }
    }
    // selfNameColor を設定
    if (chatOlNameColor) game.nakama.selfNameColor = chatOlNameColor.value;
    applyOlPartColors();
    if (chatOlTimeColor) markNonDefault(chatOlTimeColor, "#999999", chatOlTimeColor.value, () => {
        chatOlTimeColor!.value = "#999999"; applyOlPartColors(); olSCk("chatOlTimeColor", "#999999"); markNonDefault(chatOlTimeColor!, "#999999", "#999999");
    });
    if (chatOlNameColor) markNonDefault(chatOlNameColor, "#2a7a2a", chatOlNameColor.value, () => {
        chatOlNameColor!.value = "#2a7a2a"; applyOlPartColors(); olSCk("chatOlNameColor", "#2a7a2a"); markNonDefault(chatOlNameColor!, "#2a7a2a", "#2a7a2a");
    });

    chatOlTimeColor?.addEventListener("input", () => { applyOlPartColors(); olSCk("chatOlTimeColor", chatOlTimeColor!.value); markNonDefault(chatOlTimeColor!, "#999999", chatOlTimeColor!.value); });
    let nameColorDebounce: ReturnType<typeof setTimeout> | null = null;
    chatOlNameColor?.addEventListener("input", () => {
        applyOlPartColors();
        olSCk("chatOlNameColor", chatOlNameColor!.value);
        markNonDefault(chatOlNameColor!, "#2a7a2a", chatOlNameColor!.value);
        game.nakama.selfNameColor = chatOlNameColor!.value;
        // デバウンス: 300ms 操作が止まってからサーバーへ通知
        if (nameColorDebounce) clearTimeout(nameColorDebounce);
        nameColorDebounce = setTimeout(() => {
            game.nakama.sendNameColor(chatOlNameColor!.value);
        }, 300);
    });

    // --- チャットオーバーレイ 折り返し ---
    const chatOlWrapBtn = document.getElementById("chatOlWrapBtn") as HTMLButtonElement | null;
    if (chatOlWrapBtn && chatOlOverlay) {
        let olWrap = (olCk("chatOlWrap") ?? "1") === "1";
        const applyOlWrap = () => {
            chatOlOverlay!.classList.toggle("chat-ol-wrap", olWrap);
            chatOlWrapBtn.textContent = olWrap ? "On" : "Off";
            chatOlWrapBtn.classList.toggle("off", !olWrap);
        };
        applyOlWrap();
        markNonDefault(chatOlWrapBtn, "On", chatOlWrapBtn.textContent!, () => {
            olWrap = true; applyOlWrap(); olSCk("chatOlWrap", "1"); markNonDefault(chatOlWrapBtn, "On", "On");
        });
        chatOlWrapBtn.addEventListener("click", () => {
            olWrap = !olWrap;
            applyOlWrap();
            olSCk("chatOlWrap", olWrap ? "1" : "0");
            markNonDefault(chatOlWrapBtn, "On", chatOlWrapBtn.textContent!);
        });
    }

    // --- チャットオーバーレイ 影 ---
    const chatOlShadowBtn = document.getElementById("chatOlShadowBtn") as HTMLButtonElement | null;
    const chatOlShadowColor = document.getElementById("chatOlShadowColor") as HTMLInputElement | null;
    if (chatOlShadowBtn && chatOlShadowColor && chatOlOverlay) {
        let olShadowOn = (olCk("chatOlShadow") ?? "1") === "1";
        if (olCk("chatOlShadowColor")) chatOlShadowColor.value = olCk("chatOlShadowColor")!;
        const applyOlShadow = () => {
            const c = chatOlShadowColor.value;
            chatOlOverlay!.style.setProperty("--ol-shadow", olShadowOn ? `0 0 3px ${c}, 0 0 6px ${c}` : "none");
            chatOlShadowBtn.textContent = olShadowOn ? "On" : "Off";
            chatOlShadowBtn.classList.toggle("off", !olShadowOn);
            chatOlShadowColor.disabled = !olShadowOn;
            chatOlShadowColor.style.opacity = olShadowOn ? "" : "0.3";
        };
        applyOlShadow();
        markNonDefault(chatOlShadowBtn, "On", chatOlShadowBtn.textContent!, () => {
            olShadowOn = true; chatOlShadowColor.value = "#ffffff";
            applyOlShadow(); olSCk("chatOlShadow", "1"); olSCk("chatOlShadowColor", "#ffffff");
            markNonDefault(chatOlShadowBtn, "On", "On"); markNonDefault(chatOlShadowColor, "#ffffff", "#ffffff");
        });
        markNonDefault(chatOlShadowColor, "#ffffff", chatOlShadowColor.value, () => {
            chatOlShadowColor.value = "#ffffff"; applyOlShadow(); olSCk("chatOlShadowColor", "#ffffff");
            markNonDefault(chatOlShadowColor, "#ffffff", "#ffffff");
        });
        chatOlShadowBtn.addEventListener("click", () => {
            olShadowOn = !olShadowOn;
            applyOlShadow();
            olSCk("chatOlShadow", olShadowOn ? "1" : "0");
            markNonDefault(chatOlShadowBtn, "On", chatOlShadowBtn.textContent!);
        });
        chatOlShadowColor.addEventListener("input", () => {
            applyOlShadow();
            olSCk("chatOlShadowColor", chatOlShadowColor.value);
            markNonDefault(chatOlShadowColor, "#ffffff", chatOlShadowColor.value);
        });
    }

    if (scaleSelect) {
        const initScale = 1 / window.devicePixelRatio;
        const initScaleStr = initScale.toFixed(2);
        const exactMatch = Array.from(scaleSelect.options).find(o => Math.abs(parseFloat(o.value) - initScale) < 0.001);
        if (!exactMatch) {
            const opt = document.createElement("option");
            opt.value = initScaleStr;
            opt.text = `${initScaleStr} (初期値)`;
            const insertBefore = Array.from(scaleSelect.options).find(o => parseFloat(o.value) > initScale);
            scaleSelect.insertBefore(opt, insertBefore ?? null);
        } else {
            exactMatch.text = `${exactMatch.text.replace(/ \(初期値\)$/, "")} (初期値)`;
        }
        const savedScale = dbgGetCookie("dbgScale");
        if (savedScale !== null) {
            const opt = Array.from(scaleSelect.options).find(o => o.value === savedScale);
            if (opt) { scaleSelect.value = savedScale; game.engine.setHardwareScalingLevel(parseFloat(savedScale)); }
            else scaleSelect.value = initScaleStr;
        } else {
            scaleSelect.value = initScaleStr;
        }
        markNonDefault(scaleSelect, initScaleStr, scaleSelect.value, () => {
            scaleSelect.value = initScaleStr;
            game.engine.setHardwareScalingLevel(parseFloat(initScaleStr));
            dbgSetCookie("dbgScale", initScaleStr);
            markNonDefault(scaleSelect, initScaleStr, initScaleStr);
        });

        const labelScale = document.getElementById("label-scale");
        if (labelScale) {
            const dpr = window.devicePixelRatio;
            labelScale.title = [
                "03.Scale",
                "レンダリング解像度スケール（BabylonJS hardwareScalingLevel）",
                `初期値: 1/devicePixelRatio = ${initScale.toFixed(2)}（devicePixelRatio=${dpr.toFixed(2)}）`,
                "初期値: 1 / window.devicePixelRatio を自動計算して設定",
                "DPR=2 → 0.5（Retina/4K → クッキリ）",
                "DPR=1 → 1.0（通常モニター → 無駄なし）",
                "DPR=3 → 0.333... → UIは最近傍の 0.5 を選択",
                "典型的なMMO: 1.0〜2.0（高負荷時は2.0で50%解像度）",
                "Minecraft: 解像度スケール非対応（常にネイティブ）, 描画距離で代替",
            ].join("\n");
        }

        scaleSelect.addEventListener("change", (e) => {
            const target = e.target as HTMLSelectElement;
            const newScale = parseFloat(target.value);
            game.engine.setHardwareScalingLevel(newScale);
            dbgSetCookie("dbgScale", target.value);
            markNonDefault(scaleSelect, initScaleStr, target.value);
        });
    }

    const aaSelect = document.getElementById("aaSelect") as HTMLSelectElement;
    if (aaSelect) {
        const savedAA = dbgGetCookie("dbgAA");
        if (savedAA !== null) { aaSelect.value = savedAA; game.setMSAA(parseInt(savedAA)); }
        markNonDefault(aaSelect, "2", aaSelect.value, () => {
            aaSelect.value = "2"; game.setMSAA(2); dbgSetCookie("dbgAA", "2"); markNonDefault(aaSelect, "2", "2");
        });
        aaSelect.addEventListener("change", () => {
            game.setMSAA(parseInt(aaSelect.value));
            dbgSetCookie("dbgAA", aaSelect.value);
            markNonDefault(aaSelect, "2", aaSelect.value);
        });
    }

    let isLODEnabled = false;
    if (lodBtn) {
        if (dbgGetCookie("dbgLOD") === "1") {
            isLODEnabled = true;
            lodBtn.innerText = "On"; lodBtn.classList.remove("off");
        }
        markNonDefault(lodBtn, "Off", lodBtn.innerText, () => {
            isLODEnabled = false; lodBtn.innerText = "Off"; lodBtn.classList.add("off"); dbgSetCookie("dbgLOD", "0"); markNonDefault(lodBtn, "Off", "Off");
        });
        lodBtn.addEventListener("click", () => {
            isLODEnabled = !isLODEnabled;
            lodBtn.innerText = isLODEnabled ? "On" : "Off";
            if (isLODEnabled) lodBtn.classList.remove("off");
            else lodBtn.classList.add("off");
            dbgSetCookie("dbgLOD", isLODEnabled ? "1" : "0");
            markNonDefault(lodBtn, "Off", lodBtn.innerText);
        });
    }

    if (farClipInput && game.camera) {
        const savedFC = dbgGetCookie("dbgFarClip");
        if (savedFC !== null) { farClipInput.value = savedFC; game.camera.maxZ = parseFloat(savedFC); game.scene.fogEnd = parseFloat(savedFC); }
        markNonDefault(farClipInput, "200", farClipInput.value, () => {
            farClipInput.value = "200"; game.camera.maxZ = 200; game.scene.fogEnd = 200; dbgSetCookie("dbgFarClip", "200"); markNonDefault(farClipInput, "200", "200");
        });
        farClipInput.addEventListener("change", (e) => {
            const val = parseFloat((e.target as HTMLSelectElement).value);
            if (!isNaN(val) && val > 0) {
                game.camera.maxZ = val;
                game.scene.fogEnd = val;
            }
            dbgSetCookie("dbgFarClip", (e.target as HTMLSelectElement).value);
            markNonDefault(farClipInput, "200", (e.target as HTMLSelectElement).value);
        });
    }

    const aoiVisBtn = document.getElementById("aoiVisBtn") as HTMLButtonElement;
    if (aoiVisBtn) {
        if (dbgGetCookie("dbgAoiVis") === "1") {
            game.aoiManager.aoiVisEnabled = true;
            aoiVisBtn.innerText = "On"; aoiVisBtn.classList.remove("off");
            game.aoiManager.updateAOILines();
        }
        markNonDefault(aoiVisBtn, "Off", aoiVisBtn.innerText, () => {
            game.aoiManager.aoiVisEnabled = false; aoiVisBtn.innerText = "Off"; aoiVisBtn.classList.add("off"); game.aoiManager.updateAOILines(); dbgSetCookie("dbgAoiVis", "0"); markNonDefault(aoiVisBtn, "Off", "Off");
        });
        aoiVisBtn.addEventListener("click", () => {
            game.aoiManager.aoiVisEnabled = !game.aoiManager.aoiVisEnabled;
            aoiVisBtn.innerText = game.aoiManager.aoiVisEnabled ? "On" : "Off";
            if (game.aoiManager.aoiVisEnabled) aoiVisBtn.classList.remove("off");
            else aoiVisBtn.classList.add("off");
            game.aoiManager.updateAOILines();
            dbgSetCookie("dbgAoiVis", game.aoiManager.aoiVisEnabled ? "1" : "0");
            markNonDefault(aoiVisBtn, "Off", aoiVisBtn.innerText);
        });
    }

    const camAutoRotBtn = document.getElementById("camAutoRotBtn") as HTMLButtonElement;
    if (camAutoRotBtn) {
        const savedCamRot = dbgGetCookie("dbgCamAutoRot");
        if (savedCamRot !== null) {
            game.camAutoRotate = savedCamRot === "1";
            camAutoRotBtn.innerText = game.camAutoRotate ? "On" : "Off";
            if (game.camAutoRotate) camAutoRotBtn.classList.remove("off");
            else camAutoRotBtn.classList.add("off");
        }
        markNonDefault(camAutoRotBtn, "On", camAutoRotBtn.innerText, () => {
            game.camAutoRotate = true; camAutoRotBtn.innerText = "On"; camAutoRotBtn.classList.remove("off"); dbgSetCookie("dbgCamAutoRot", "1"); markNonDefault(camAutoRotBtn, "On", "On");
        });
        camAutoRotBtn.addEventListener("click", () => {
            game.camAutoRotate = !game.camAutoRotate;
            camAutoRotBtn.innerText = game.camAutoRotate ? "On" : "Off";
            if (game.camAutoRotate) camAutoRotBtn.classList.remove("off");
            else camAutoRotBtn.classList.add("off");
            dbgSetCookie("dbgCamAutoRot", game.camAutoRotate ? "1" : "0");
            markNonDefault(camAutoRotBtn, "On", camAutoRotBtn.innerText);
        });
    }

    const eastUpBtn = document.getElementById("eastUpBtn") as HTMLButtonElement;
    if (eastUpBtn) {
        eastUpBtn.addEventListener("click", () => {
            game.camera.beta = 0;
            game.camera.alpha = Math.PI / 2;
            const a = game.aoiManager.lastAOI;
            const CS = CHUNK_SIZE;
            const aoiW = (a.maxCX - a.minCX + 1) * CS;
            const aoiD = (a.maxCZ - a.minCZ + 1) * CS;
            const aspect = game.engine.getAspectRatio(game.camera);
            const vFov = game.camera.fov;
            const rForHeight = (aoiD / 2) / Math.tan(vFov / 2);
            const rForWidth = (aoiW / 2) / (Math.tan(vFov / 2) * aspect);
            const maxR = game.camera.upperRadiusLimit ?? 200;
            game.camera.radius = Math.min(Math.max(rForHeight, rForWidth) * 1.05, maxR);
            if (!game.aoiManager.aoiVisEnabled) {
                game.aoiManager.aoiVisEnabled = true;
                game.aoiManager.updateAOILines();
                if (aoiVisBtn) { aoiVisBtn.innerText = "On"; aoiVisBtn.classList.remove("off"); }
            }
            game.camAutoRotate = false;
            if (camAutoRotBtn) {
                camAutoRotBtn.innerText = "Off";
                camAutoRotBtn.classList.add("off");
            }
            game.cloudSystem.setEnabled(false);
            const cloudBtn = document.getElementById("cloudToggleBtn") as HTMLButtonElement;
            if (cloudBtn) { cloudBtn.innerText = "Off"; cloudBtn.classList.add("off"); }
            if (!game.aoiManager.remoteAoiEnabled) {
                game.aoiManager.setRemoteAoiEnabled(true);
                const rBtn = document.getElementById("remoteAoiBtn") as HTMLButtonElement;
                if (rBtn) { rBtn.innerText = "On"; rBtn.classList.remove("off"); }
            }
        });
    }

    const cloudToggleBtn = document.getElementById("cloudToggleBtn") as HTMLButtonElement;
    if (cloudToggleBtn) {
        const savedCloud = dbgGetCookie("dbgCloud");
        if (savedCloud !== null) {
            game.cloudSystem.setEnabled(savedCloud === "1");
            cloudToggleBtn.innerText = game.cloudSystem.enabled ? "On" : "Off";
            if (game.cloudSystem.enabled) cloudToggleBtn.classList.remove("off");
            else cloudToggleBtn.classList.add("off");
        }
        markNonDefault(cloudToggleBtn, "On", cloudToggleBtn.innerText, () => {
            game.cloudSystem.setEnabled(true); cloudToggleBtn.innerText = "On"; cloudToggleBtn.classList.remove("off"); dbgSetCookie("dbgCloud", "1"); markNonDefault(cloudToggleBtn, "On", "On");
        });
        cloudToggleBtn.addEventListener("click", () => {
            game.cloudSystem.setEnabled(!game.cloudSystem.enabled);
            cloudToggleBtn.innerText = game.cloudSystem.enabled ? "On" : "Off";
            if (game.cloudSystem.enabled) cloudToggleBtn.classList.remove("off");
            else cloudToggleBtn.classList.add("off");
            dbgSetCookie("dbgCloud", game.cloudSystem.enabled ? "1" : "0");
            markNonDefault(cloudToggleBtn, "On", cloudToggleBtn.innerText);
        });
    }

    const remoteAoiBtn = document.getElementById("remoteAoiBtn") as HTMLButtonElement;
    if (remoteAoiBtn) {
        if (dbgGetCookie("dbgRemoteAoi") === "1") {
            game.aoiManager.setRemoteAoiEnabled(true);
            remoteAoiBtn.innerText = "On"; remoteAoiBtn.classList.remove("off");
        }
        markNonDefault(remoteAoiBtn, "Off", remoteAoiBtn.innerText, () => {
            game.aoiManager.setRemoteAoiEnabled(false); remoteAoiBtn.innerText = "Off"; remoteAoiBtn.classList.add("off"); dbgSetCookie("dbgRemoteAoi", "0"); markNonDefault(remoteAoiBtn, "Off", "Off");
        });
        remoteAoiBtn.addEventListener("click", () => {
            game.aoiManager.setRemoteAoiEnabled(!game.aoiManager.remoteAoiEnabled);
            remoteAoiBtn.innerText = game.aoiManager.remoteAoiEnabled ? "On" : "Off";
            if (game.aoiManager.remoteAoiEnabled) remoteAoiBtn.classList.remove("off");
            else remoteAoiBtn.classList.add("off");
            dbgSetCookie("dbgRemoteAoi", game.aoiManager.remoteAoiEnabled ? "1" : "0");
            markNonDefault(remoteAoiBtn, "Off", remoteAoiBtn.innerText);
        });
    }

    const aoiRadiusSelect = document.getElementById("aoiRadiusSelect") as HTMLSelectElement;
    if (aoiRadiusSelect) {
        const savedAoiR = dbgGetCookie("dbgAoiRadius");
        if (savedAoiR !== null) { aoiRadiusSelect.value = savedAoiR; game.aoiManager.aoiRadius = parseInt(savedAoiR, 10); game.aoiManager.updateAOI(); }
        markNonDefault(aoiRadiusSelect, "48", aoiRadiusSelect.value, () => {
            aoiRadiusSelect.value = "48"; game.aoiManager.aoiRadius = 48; game.aoiManager.updateAOI(); dbgSetCookie("dbgAoiRadius", "48"); markNonDefault(aoiRadiusSelect, "48", "48");
        });
        aoiRadiusSelect.addEventListener("change", (e) => {
            const val = parseInt((e.target as HTMLSelectElement).value, 10);
            if (!isNaN(val) && val > 0) {
                game.aoiManager.aoiRadius = val;
                game.aoiManager.updateAOI();
            }
            dbgSetCookie("dbgAoiRadius", (e.target as HTMLSelectElement).value);
            markNonDefault(aoiRadiusSelect, "48", (e.target as HTMLSelectElement).value);
        });
    }

    const maxZoomSelect = document.getElementById("maxZoomSelect") as HTMLSelectElement;
    if (maxZoomSelect && game.camera) {
        const savedMZ = dbgGetCookie("dbgMaxZoom");
        if (savedMZ !== null) { maxZoomSelect.value = savedMZ; game.camera.upperRadiusLimit = parseFloat(savedMZ); }
        markNonDefault(maxZoomSelect, "200", maxZoomSelect.value, () => {
            maxZoomSelect.value = "200"; game.camera.upperRadiusLimit = 200; dbgSetCookie("dbgMaxZoom", "200"); markNonDefault(maxZoomSelect, "200", "200");
        });
        maxZoomSelect.addEventListener("change", (e) => {
            const val = parseFloat((e.target as HTMLSelectElement).value);
            if (!isNaN(val) && val > 0) {
                game.camera.upperRadiusLimit = val;
            }
            dbgSetCookie("dbgMaxZoom", (e.target as HTMLSelectElement).value);
            markNonDefault(maxZoomSelect, "200", (e.target as HTMLSelectElement).value);
        });
    }

    if (fovSelect && fovInput && game.camera) {
        const savedFOV = dbgGetCookie("dbgFOV");
        if (savedFOV !== null) { fovSelect.value = savedFOV; fovInput.value = savedFOV; game.camera.fov = parseFloat(savedFOV) * Math.PI / 180; }
        markNonDefault(fovSelect, "60", fovInput.value, () => {
            fovSelect.value = "60"; fovInput.value = "60"; game.camera.fov = 60 * Math.PI / 180; dbgSetCookie("dbgFOV", "60"); markNonDefault(fovSelect, "60", "60");
        });
        fovInput.addEventListener("input", (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(val) && val > 0) {
                game.camera.fov = val * Math.PI / 180;
                const optionExists = Array.from(fovSelect.options).some(opt => opt.value === val.toString());
                if (optionExists) {
                    fovSelect.value = val.toString();
                }
            }
            dbgSetCookie("dbgFOV", fovInput.value);
            markNonDefault(fovSelect, "60", fovInput.value);
        });

        fovSelect.addEventListener("change", (e) => {
            const target = e.target as HTMLSelectElement;
            const val = parseFloat(target.value);
            if (!isNaN(val) && val > 0) {
                game.camera.fov = val * Math.PI / 180;
                fovInput.value = target.value;
            }
            dbgSetCookie("dbgFOV", target.value);
            markNonDefault(fovSelect, "60", target.value);
        });
    }

    if (fogBtn) {
        let isFogEnabled = true;
        if (dbgGetCookie("dbgFog") === "0") {
            isFogEnabled = false;
            game.scene.fogMode = Scene.FOGMODE_NONE;
            fogBtn.innerText = "Off"; fogBtn.classList.add("off");
        }
        markNonDefault(fogBtn, "On", fogBtn.innerText, () => {
            isFogEnabled = true; game.scene.fogMode = Scene.FOGMODE_LINEAR; fogBtn.innerText = "On"; fogBtn.classList.remove("off"); dbgSetCookie("dbgFog", "1"); markNonDefault(fogBtn, "On", "On");
        });
        fogBtn.addEventListener("click", () => {
            isFogEnabled = !isFogEnabled;
            game.scene.fogMode = isFogEnabled ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
            fogBtn.innerText = isFogEnabled ? "On" : "Off";
            if (isFogEnabled) fogBtn.classList.remove("off");
            else fogBtn.classList.add("off");
            dbgSetCookie("dbgFog", isFogEnabled ? "1" : "0");
            markNonDefault(fogBtn, "On", fogBtn.innerText);
        });
    }

    if (fogColorInput) {
        const savedFogColor = dbgGetCookie("dbgFogColor");
        if (savedFogColor !== null) {
            fogColorInput.value = savedFogColor;
            const c = Color3.FromHexString(savedFogColor);
            game.scene.fogColor = c;
            game.scene.clearColor = new Color4(c.r, c.g, c.b, 1.0);
        }
        markNonDefault(fogColorInput, "#a0d7f3", fogColorInput.value, () => {
            fogColorInput.value = "#a0d7f3"; const c = Color3.FromHexString("#a0d7f3"); game.scene.fogColor = c; game.scene.clearColor = new Color4(c.r, c.g, c.b, 1.0); dbgSetCookie("dbgFogColor", "#a0d7f3"); markNonDefault(fogColorInput, "#a0d7f3", "#a0d7f3");
        });
        fogColorInput.addEventListener("input", (e) => {
            const val = (e.target as HTMLInputElement).value;
            const newColor = Color3.FromHexString(val);
            game.scene.fogColor = newColor;
            game.scene.clearColor = new Color4(newColor.r, newColor.g, newColor.b, 1.0);
            dbgSetCookie("dbgFogColor", val);
            markNonDefault(fogColorInput, "#a0d7f3", val);
        });
    }

    if (autoChatBtn) {
        const npcMessages = autoChatMessages;
        let isAutoChatOn = false;
        let autoChatNextTick = 0;
        let autoChatIndex = 0;
        const AUTO_CHAT_TICKS = 120; // 約2秒 (60fps)

        const setAAMode = (on: boolean) => {
            const btn = document.getElementById("aaModeBtn") as HTMLButtonElement | null;
            if (!btn) return;
            const current = btn.classList.contains("on");
            if (current !== on) btn.click();
        };

        const sendAutoMsg = (entry: { text: string; aa?: boolean }) => {
            if (entry.aa) setAAMode(true);
            game.nakama.sendChatMessage(entry.text).catch((e) => { console.warn("AutoChat sendChatMessage error:", e); });
            if (entry.aa) setAAMode(false);
        };

        const nextInterval = () => AUTO_CHAT_TICKS;

        // レンダーループで tick カウント
        let autoChatTick = 0;
        game.scene.onAfterRenderObservable.add(() => {
            if (!isAutoChatOn) return;
            autoChatTick++;
            if (autoChatTick >= autoChatNextTick) {
                const entry = npcMessages[autoChatIndex % npcMessages.length];
                autoChatIndex++;
                sendAutoMsg(entry);
                autoChatTick = 0;
                autoChatNextTick = nextInterval();
            }
        });

        const stopAutoChat = () => {
            isAutoChatOn = false;
            autoChatBtn.textContent = "Off";
            autoChatBtn.classList.add("off");
            markNonDefault(autoChatBtn, "Off", "Off");
        };
        markNonDefault(autoChatBtn, "Off", autoChatBtn.textContent!, stopAutoChat);
        autoChatBtn.addEventListener("click", () => {
            isAutoChatOn = !isAutoChatOn;
            autoChatBtn.textContent = isAutoChatOn ? "On" : "Off";
            if (isAutoChatOn) {
                autoChatBtn.classList.remove("off");
                // 先頭からリスタート（次のレンダーフレームで即送信）
                autoChatIndex = 0;
                autoChatTick = 0;
                autoChatNextTick = 0;
            } else {
                autoChatBtn.classList.add("off");
            }
            markNonDefault(autoChatBtn, "Off", autoChatBtn.textContent!);
        });
    }

    // --- 34b.AutoWalk ---
    {
        const autoWalkBtn = document.getElementById("autoWalkBtn") as HTMLButtonElement | null;
        const awXInput  = document.getElementById("autoWalkX")  as HTMLInputElement | null;
        const awZInput  = document.getElementById("autoWalkZ")  as HTMLInputElement | null;
        const awDXInput = document.getElementById("autoWalkDX") as HTMLInputElement | null;
        const awDZInput = document.getElementById("autoWalkDZ") as HTMLInputElement | null;
        if (autoWalkBtn) {
            let isOn = false;
            let cornerIdx = 0;

            const getCorners = () => {
                const sx  = parseFloat(awXInput?.value  ?? "0") || 0;
                const sz  = parseFloat(awZInput?.value  ?? "0") || 0;
                const dx  = parseFloat(awDXInput?.value ?? "5") || 5;
                const dz  = parseFloat(awDZInput?.value ?? "5") || 5;
                return [
                    { x: sx,      z: sz },
                    { x: sx + dx, z: sz },
                    { x: sx + dx, z: sz + dz },
                    { x: sx,      z: sz + dz },
                ];
            };

            // レンダーループで到着検知 → 次の頂点をセット
            game.scene.onBeforeRenderObservable.add(() => {
                if (!isOn || game.targetPosition) return;
                const corners = getCorners();
                const c = corners[cornerIdx % corners.length];
                game.targetPosition = new Vector3(c.x, 0, c.z);
                cornerIdx++;
            });

            const stopAutoWalk = () => {
                isOn = false;
                autoWalkBtn.textContent = "Off";
                autoWalkBtn.classList.add("off");
                game.targetPosition = null;
                markNonDefault(autoWalkBtn, "Off", "Off");
            };
            markNonDefault(autoWalkBtn, "Off", autoWalkBtn.textContent!, stopAutoWalk);
            autoWalkBtn.addEventListener("click", () => {
                isOn = !isOn;
                autoWalkBtn.textContent = isOn ? "On" : "Off";
                if (isOn) {
                    autoWalkBtn.classList.remove("off");
                    cornerIdx = 0;
                    game.targetPosition = null;
                } else {
                    autoWalkBtn.classList.add("off");
                    game.targetPosition = null;
                }
                markNonDefault(autoWalkBtn, "Off", autoWalkBtn.textContent!);
            });
        }
    }

    if (npcAutoChatBtn) {
        markNonDefault(npcAutoChatBtn, "Off", npcAutoChatBtn.textContent!, () => {
            game.npcSystem.isNpcChatOn = false;
            npcAutoChatBtn.textContent = "Off";
            npcAutoChatBtn.classList.add("off");
            markNonDefault(npcAutoChatBtn, "Off", "Off");
        });
        npcAutoChatBtn.addEventListener("click", () => {
            game.npcSystem.isNpcChatOn = !game.npcSystem.isNpcChatOn;
            npcAutoChatBtn.textContent = game.npcSystem.isNpcChatOn ? "On" : "Off";
            if (game.npcSystem.isNpcChatOn) npcAutoChatBtn.classList.remove("off");
            else npcAutoChatBtn.classList.add("off");
            markNonDefault(npcAutoChatBtn, "Off", npcAutoChatBtn.textContent!);
        });
    }

    if (npcVisBtn) {
        markNonDefault(npcVisBtn, "Off", npcVisBtn.textContent!, () => {
            game.npcSystem.setEnabled(false);
            npcVisBtn.textContent = "Off";
            npcVisBtn.classList.add("off");
            markNonDefault(npcVisBtn, "Off", "Off");
        });
        npcVisBtn.addEventListener("click", () => {
            const visible = !game.npcSystem.npc001.isEnabled();
            game.npcSystem.setEnabled(visible);
            npcVisBtn.textContent = visible ? "On" : "Off";
            if (visible) npcVisBtn.classList.remove("off");
            else npcVisBtn.classList.add("off");
            markNonDefault(npcVisBtn, "Off", npcVisBtn.textContent!);
        });
    }

    if (buildModeBtn) {
        markNonDefault(buildModeBtn, "Off", buildModeBtn.textContent!, () => {
            game.buildMode = false;
            buildModeBtn.textContent = "Off";
            buildModeBtn.classList.add("off");
            const indicator = document.getElementById("build-mode-indicator");
            if (indicator) indicator.style.display = "none";
            game.previewBlock.isVisible = false;
            markNonDefault(buildModeBtn, "Off", "Off");
        });
        buildModeBtn.addEventListener("click", () => {
            game.buildMode = !game.buildMode;
            buildModeBtn.textContent = game.buildMode ? "On" : "Off";
            buildModeBtn.classList.toggle("off", !game.buildMode);
            const indicator = document.getElementById("build-mode-indicator");
            if (indicator) {
                indicator.style.display = game.buildMode ? "" : "none";
                if (game.buildMode) indicator.textContent = t("buildmode.indicator");
            }
            if (game.buildMode) game.refreshPreviewBlock();
            else game.previewBlock.isVisible = false;
            markNonDefault(buildModeBtn, "Off", buildModeBtn.textContent!);
        });
    }

    // --- Block Color (40) ---
    const blockColorInput = document.getElementById("blockColorInput") as HTMLInputElement | null;
    if (blockColorInput) {
        const savedBlockColor = dbgGetCookie("dbgBlockColor");
        if (savedBlockColor !== null) blockColorInput.value = savedBlockColor;
        markNonDefault(blockColorInput, "#3366ff", blockColorInput.value, () => {
            blockColorInput.value = "#3366ff"; dbgSetCookie("dbgBlockColor", "#3366ff"); markNonDefault(blockColorInput, "#3366ff", "#3366ff");
            if (game.buildMode) game.refreshPreviewBlock();
        });
        blockColorInput.addEventListener("input", () => {
            dbgSetCookie("dbgBlockColor", blockColorInput.value);
            markNonDefault(blockColorInput, "#3366ff", blockColorInput.value);
        });
    }

    if (speechTrimBtn) {
        if (dbgGetCookie("dbgSpeechTrim") === "1") {
            speechTrimBtn.textContent = "On";
            speechTrimBtn.classList.add("on"); speechTrimBtn.classList.remove("off");
        }
        markNonDefault(speechTrimBtn, "Off", speechTrimBtn.textContent!, () => {
            speechTrimBtn.textContent = "Off"; speechTrimBtn.classList.remove("on"); speechTrimBtn.classList.add("off"); dbgSetCookie("dbgSpeechTrim", "0"); markNonDefault(speechTrimBtn, "Off", "Off");
        });
        speechTrimBtn.addEventListener("click", () => {
            const on = !speechTrimBtn.classList.contains("on");
            speechTrimBtn.textContent = on ? "On" : "Off";
            speechTrimBtn.classList.toggle("on", on);
            speechTrimBtn.classList.toggle("off", !on);
            dbgSetCookie("dbgSpeechTrim", on ? "1" : "0");
            markNonDefault(speechTrimBtn, "Off", speechTrimBtn.textContent!);
        });
    }

    if (aaModeBtn) {
        if (dbgGetCookie("dbgAAMode") === "1") {
            aaModeBtn.textContent = "On";
            aaModeBtn.classList.add("on"); aaModeBtn.classList.remove("off");
        }
        markNonDefault(aaModeBtn, "Off", aaModeBtn.textContent!, () => {
            aaModeBtn.textContent = "Off"; aaModeBtn.classList.remove("on"); aaModeBtn.classList.add("off"); dbgSetCookie("dbgAAMode", "0"); markNonDefault(aaModeBtn, "Off", "Off");
        });
        aaModeBtn.addEventListener("click", () => {
            const on = !aaModeBtn.classList.contains("on");
            aaModeBtn.textContent = on ? "On" : "Off";
            aaModeBtn.classList.toggle("on", on);
            aaModeBtn.classList.toggle("off", !on);
            dbgSetCookie("dbgAAMode", on ? "1" : "0");
            markNonDefault(aaModeBtn, "Off", aaModeBtn.textContent!);

            if (on) {
                const trimBtn = document.getElementById("speechTrimBtn") as HTMLButtonElement | null;
                if (trimBtn) {
                    trimBtn.textContent = "Off";
                    trimBtn.classList.remove("on");
                    trimBtn.classList.add("off");
                    markNonDefault(trimBtn, "Off", "Off");
                }
                const fontSel = document.getElementById("speechFontSelect") as HTMLSelectElement | null;
                if (fontSel) fontSel.value = "sans-serif";
                const leadSel = document.getElementById("speechLeadingSelect") as HTMLSelectElement | null;
                if (leadSel) leadSel.value = "1.0";
            }
        });
    }

    if (avatarThickInput) {
        const savedThick = dbgGetCookie("dbgAvatarThick");
        if (savedThick !== null) {
            avatarThickInput.value = savedThick;
            game.avatarDepth = Math.max(1, Math.min(50, parseInt(savedThick, 10) || 5)) / 100;
            game.applyAvatarDepth();
        }
        markNonDefault(avatarThickInput, "5", avatarThickInput.value, () => {
            avatarThickInput.value = "5"; game.avatarDepth = 0.05; game.applyAvatarDepth(); dbgSetCookie("dbgAvatarThick", "5"); markNonDefault(avatarThickInput, "5", "5");
        });
        avatarThickInput.addEventListener("input", () => {
            const v = Math.max(1, Math.min(50, parseInt(avatarThickInput.value, 10) || 5));
            game.avatarDepth = v / 100;
            game.applyAvatarDepth();
            dbgSetCookie("dbgAvatarThick", avatarThickInput.value);
            markNonDefault(avatarThickInput, "5", avatarThickInput.value);
        });
    }

    // --- UID Color (38b) ---
    const uidColorInput = document.getElementById("uidColorInput") as HTMLInputElement | null;
    if (uidColorInput) {
        const savedUidColor = dbgGetCookie("dbgUidColor");
        if (savedUidColor !== null) uidColorInput.value = savedUidColor;
        markNonDefault(uidColorInput, "#00bbfa", uidColorInput.value, () => {
            uidColorInput.value = "#00bbfa"; dbgSetCookie("dbgUidColor", "#00bbfa"); markNonDefault(uidColorInput, "#00bbfa", "#00bbfa");
        });
        uidColorInput.addEventListener("input", () => {
            dbgSetCookie("dbgUidColor", uidColorInput.value);
            markNonDefault(uidColorInput, "#00bbfa", uidColorInput.value);
        });
    }

    // --- Profile ボタン ---
    const profileStatus = document.getElementById("profileStatus") as HTMLSpanElement;
    if (profileStartBtn) {
        profileStartBtn.addEventListener("click", () => {
            game.profiling = true;
            (game as any)._profileHistory.length = 0;
            game.callCounts = {};
            profSetEnabled(true);
            profReset();
            profileStartBtn.disabled = true;
            profileStartBtn.classList.add("off");
            profileStopBtn.disabled = false;
            profileStopBtn.classList.remove("off");
            if (profileStatus) profileStatus.style.display = "";
            console.log("Profile started");
        });
    }
    if (profileStopBtn) {
        profileStopBtn.addEventListener("click", () => {
            game.profiling = false;
            profSetEnabled(false);
            profileStopBtn.disabled = true;
            profileStopBtn.classList.add("off");
            profileStartBtn.disabled = false;
            profileStartBtn.classList.remove("off");
            if (profileStatus) profileStatus.style.display = "none";
            console.log(`Profile stopped — ${(game as any)._profileHistory.length} frames captured`);
        });
    }
    if (profileLogBtn) {
        profileLogBtn.addEventListener("click", () => {
            const w = window as unknown as Record<string, unknown>;
            if (typeof w.profileDump === "function") (w.profileDump as () => void)();
            // サーバ側プロファイルもダンプ
            game.nakama.profileRpc("profileDump").then(payload => {
                if (!payload) { console.log("Profile:Server no response (not logged in?)"); return; }
                const data = JSON.parse(payload);
                console.log(`Profile:Server profiling=${data.profiling}`);
                if (data.functions?.length > 0) {
                    const rows = data.functions
                        .sort((a: any, b: any) => b.totalMs - a.totalMs)
                        .map((f: any) => ({ name: f.name, calls: f.calls, totalMs: Math.round(f.totalMs * 100) / 100, avgUs: Math.round(f.avgUs * 10) / 10, maxUs: Math.round(f.maxUs) }));
                    console.table(rows);
                } else {
                    console.log("Profile:Server no data");
                }
            }).catch(e => { console.warn("Profile:Server error:", e); });
        });
    }

    // --- Server Profile ON/OFF ボタン ---
    let serverProfOn = false;
    if (serverProfileBtn) {
        serverProfileBtn.addEventListener("click", () => {
            serverProfOn = !serverProfOn;
            serverProfileBtn.textContent = serverProfOn ? "On" : "Off";
            serverProfileBtn.classList.toggle("on", serverProfOn);
            serverProfileBtn.classList.toggle("off", !serverProfOn);
            const method = serverProfOn ? "profileStart" : "profileStop";
            game.nakama.profileRpc(method).then(res => {
                console.log(`Profile:Server ${method} → ${res ?? "no response"}`);
            }).catch(e => {
                console.warn(`Profile:Server ${method} error:`, e);
                serverProfOn = !serverProfOn;
                serverProfileBtn.textContent = serverProfOn ? "On" : "Off";
                serverProfileBtn.classList.toggle("on", serverProfOn);
                serverProfileBtn.classList.toggle("off", !serverProfOn);
            });
        });
    }

    if (dofBtn) {
        dofBtn.innerText = "Off";
        dofBtn.classList.add("off");
        dofBtn.disabled = true;
    }

    if (glossInput) {
        const savedGloss = dbgGetCookie("dbgGloss");
        if (savedGloss !== null) {
            glossInput.value = savedGloss;
            const gv = Math.max(0, Math.min(1.0, parseFloat(savedGloss)));
            game.scene.materials.forEach(mat => {
                if (mat.name.endsWith("_frontMat") || mat.name.endsWith("_backMat")) {
                    (mat as any).specularColor = new Color3(gv, gv, gv);
                }
            });
        }
        markNonDefault(glossInput, "0.1", glossInput.value, () => {
            glossInput.value = "0.1"; const gv = 0.1; game.scene.materials.forEach(mat => { if (mat.name.endsWith("_frontMat") || mat.name.endsWith("_backMat")) (mat as any).specularColor = new Color3(gv, gv, gv); }); dbgSetCookie("dbgGloss", "0.1"); markNonDefault(glossInput, "0.1", "0.1");
        });
        glossInput.addEventListener("input", (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(val)) {
                const clampedVal = Math.max(0, Math.min(1.0, val));
                game.scene.materials.forEach(mat => {
                    if (mat.name.endsWith("_frontMat") || mat.name.endsWith("_backMat")) {
                        (mat as any).specularColor = new Color3(clampedVal, clampedVal, clampedVal);
                    }
                });
            }
            dbgSetCookie("dbgGloss", (e.target as HTMLInputElement).value);
            markNonDefault(glossInput, "0.1", (e.target as HTMLInputElement).value);
        });
    }

    if (resetViewBtn && game.camera && game.playerBox) {
        resetViewBtn.addEventListener("click", () => {
            game.camera.alpha = Math.PI / 2 - game.playerBox.rotation.y;
            game.camera.beta = Math.PI / 2.5;
            game.camera.radius = 10.0;
        });
    }

    if (topViewBtn && game.camera && game.playerBox) {
        topViewBtn.addEventListener("click", () => {
            game.camera.alpha = Math.PI / 2 - game.playerBox.rotation.y;
            game.camera.beta = 0;
            game.camera.radius = game.camera.upperRadiusLimit ?? game.camera.radius;
        });
    }

    if (defaultPosBtn && game.playerBox) {
        defaultPosBtn.addEventListener("click", () => {
            game.playerBox.position.set(0, 0, 0);
            game.playerBox.rotation.y = 0;
            game.targetPosition = null;
            game.nakama.sendInitPos(0, 0).catch((e) => console.warn("DebugOverlay:", e));

            game.camera.alpha = Math.PI / 2;
            game.camera.beta = Math.PI / 4;
            game.camera.radius = 10.0;
        });
    }

    const teleportBtn = document.getElementById("teleportBtn") as HTMLButtonElement;
    const teleportX = document.getElementById("teleportX") as HTMLInputElement;
    const teleportZ = document.getElementById("teleportZ") as HTMLInputElement;
    if (teleportBtn && teleportX && teleportZ && game.playerBox) {
        teleportBtn.addEventListener("click", () => {
            const x = parseFloat(teleportX.value);
            const z = parseFloat(teleportZ.value);
            if (isNaN(x) || isNaN(z)) return;
            game.playerBox.position.x = x;
            game.playerBox.position.z = z;
            game.targetPosition = null;
            game.nakama.sendMoveTarget(x, z).catch((e) => console.warn("DebugOverlay:", e));
            game.aoiManager.updateAOI();
        });
    }

    const avatarSelect = document.getElementById("avatarSelect") as HTMLSelectElement | null;
    if (avatarSelect) {
        avatarSelect.value = game.playerTextureUrl;
        avatarSelect.addEventListener("change", () => {
            game.playerTextureUrl = avatarSelect.value;
            game.avatarSystem.changeAvatarTexture(game.playerBox, game.playerTextureUrl);
            game.nakama.sendAvatarChange(game.playerTextureUrl).catch((e) => console.warn("DebugOverlay:", e));
        });
    }

    // スプライトアバター: /s3/avatars/ のファイル一覧を取得してドロップダウンに表示
    const spriteUrlSelect = document.getElementById("spriteUrlSelect") as HTMLSelectElement | null;
    if (spriteUrlSelect) {
        const fetchAvatarList = async () => {
            try {
                const res = await fetch("/s3/avatars/");
                const xml = await res.text();
                const doc = new DOMParser().parseFromString(xml, "application/xml");
                const keys = doc.querySelectorAll("Contents > Key");
                spriteUrlSelect.innerHTML = "";
                keys.forEach(k => {
                    const name = k.textContent ?? "";
                    if (!name) return;
                    const opt = document.createElement("option");
                    opt.value = "/s3/avatars/" + name;
                    opt.textContent = name;
                    spriteUrlSelect.appendChild(opt);
                });
            } catch (e) {
                console.warn("Failed to fetch avatar list from /s3/avatars/:", e);
            }
        };
        fetchAvatarList();

        // localStorage から復元（GameScene が既に読み込み済みなのでUI同期のみ）
        const savedSpriteUrl = localStorage.getItem("spriteAvatarUrl");
        if (savedSpriteUrl) {
            // GameScene が localStorage から既に読み込み済みなので、ドロップダウンの値を合わせるだけ
            spriteUrlSelect.value = savedSpriteUrl;
            // fetchAvatarList完了後に再設定
            fetchAvatarList().then(() => { spriteUrlSelect.value = savedSpriteUrl; });
            const colInput = document.getElementById("spriteCharCol") as HTMLInputElement | null;
            const rowInput = document.getElementById("spriteCharRow") as HTMLInputElement | null;
            if (colInput) colInput.value = String(game.playerCharCol);
            if (rowInput) rowInput.value = String(game.playerCharRow);
        }
    }

    const spriteApplyBtn = document.getElementById("spriteApplyBtn") as HTMLButtonElement | null;
    if (spriteApplyBtn) {
        spriteApplyBtn.addEventListener("click", () => {
            const urlSelect = document.getElementById("spriteUrlSelect") as HTMLSelectElement | null;
            const colInput = document.getElementById("spriteCharCol") as HTMLInputElement | null;
            const rowInput = document.getElementById("spriteCharRow") as HTMLInputElement | null;
            const url = urlSelect?.value?.trim();
            if (!url) return;
            const cc = parseInt(colInput?.value ?? "0", 10) || 0;
            const cr = parseInt(rowInput?.value ?? "0", 10) || 0;
            game.playerTextureUrl = url;
            game.playerCharCol = cc;
            game.playerCharRow = cr;
            localStorage.setItem("spriteAvatarUrl", url);
            localStorage.setItem("spriteAvatarCol", String(cc));
            localStorage.setItem("spriteAvatarRow", String(cr));
            // 自分のアバターをスプライトに切り替え
            const selfId = "__self__";
            const p = game.playerBox.position;
            game.spriteAvatarSystem.createAvatar(selfId, url, cc, cr, p.x, p.z, "", new Color3(1.0, 0.0, 0.0), game.playerBox.rotation.y).then(() => {
                // await中にプレイヤーが動いた場合に備えて最新位置を反映
                const cur = game.playerBox.position;
                game.spriteAvatarSystem.setPosition(selfId, cur.x, cur.z);
                // 既存メッシュアバターを非表示
                game.playerBox.getChildMeshes().forEach(m => m.isVisible = false);
                // 表示名タグを再設定（セッションIDサフィックス含む）
                game.refreshSelfNameTag?.();
            });
            game.nakama.sendAvatarChange(url, cc, cr).catch((e) => console.warn("DebugOverlay:", e));
        });
    }

    const sceneInstrumentation = new SceneInstrumentation(game.scene);
    sceneInstrumentation.captureFrameTime = false;

    const engineInstrumentation = new EngineInstrumentation(game.engine);
    engineInstrumentation.captureGPUFrameTime = false;

    let frameCount = 0;
    let lastTexRAM = "0.0 MB";
    let lastGeoRAM = "0.0 MB";
    let lastOcclusionQueries = "0";
    let instrumentationEnabled = false;

    const debugOverlayEl = document.getElementById("debug-overlay");

    game.scene.onAfterRenderObservable.add(() => {
        frameCount++;

        // ping-display はデバッグパネルとは独立して常時更新
        // DOM要素は状態変化時のみ再構築し、値はテキスト更新のみ（ホバー点滅防止）
        if (frameCount % 30 === 0) {
            const fpsNum = Math.min(99, Math.floor(game.engine.getFps()));
            const fps = String(fpsNum).padStart(2, "0");
            if (fv) fv.innerText = fps;
            const pd = document.getElementById("ping-display");
            if (pd) {
                const uid = game.selfNameLabel || ("@" + (game.nakama.getSession()?.username ?? ""));
                const fpsStr = String(fps).padStart(2, "\u2007");
                // 状態判定: "connected" | "disconnected" | "pending"
                type PdState = "connected" | "disconnected" | "pending";
                let state: PdState;
                if (game.latestPingAvg !== null && game.latestPingAvg < 0) state = "disconnected";
                else if (game.latestPingAvg !== null) state = "connected";
                else state = "pending";

                // 状態またはuidが変わったときだけDOMを再構築
                const stateKey = state + "|" + uid;
                if ((pd as any).__pdState !== stateKey) {
                    (pd as any).__pdState = stateKey;
                    const mono = 'style="font-variant-numeric:tabular-nums;"';
                    const tipBadge = 'title="ログイン状態を示します。\nON: サーバーに接続中\nOFF: サーバーとの接続が切れています\n\nクリックするとサーバーログパネルを開きます。"';
                    const tipUid   = 'title="表示名を示します。\n@はログインIDで、表示名が未設定の場合に表示されます。\nアバターの頭上にも同じ名前が表示され、\n@付きの場合は青色で表示されます。\n\nクリックすると表示名の変更パネルを開きます。"';
                    const tipCcu   = 'title="同接数（CCU）\n現在サーバーに接続中のプレイヤー数です。\n自分を含みます。\n\nクリックするとプレイヤーリストパネルを開きます。"';
                    const tipPing  = 'title="Ping（応答時間）\nサーバへの応答時間をリアルタイムで表示します。\n\n【目安】\n  〜50ms: 快適（LAN内・近距離サーバ）\n 50〜100ms: 良好（一般的なMMOの標準範囲）\n100〜200ms: やや遅い（操作に若干の遅延を感じる）\n200ms〜: 厳しい（アクション操作に支障が出る）\n\n【仕組み】\nWebSocketプロトコルのping/pongではなく、\nアプリ独自の実装です。\nNakamaサーバのRPC関数「ping」を呼び出し、\n送信から応答までの往復時間（ミリ秒）を計測しています。\nそのためサーバ側の処理時間も含まれます。\n\nクリックするとPingグラフパネルを開きます。"';
                    const tipFps   = 'title="FPS（フレームレート）\nFrames Per Second — 1秒あたりの描画回数。\n値が大きいほど映像が滑らかになります。\n\n典型的なMMO: 30〜60fps（60fps目標）\n\nクリックするとデバッグツールパネルを開きます。"';
                    if (state === "disconnected") {
                        pd.innerHTML = `<span id="pd-badge" ${tipBadge} style="background:#8b2020;color:#fff;padding:2px 6px;border-radius:3px;cursor:pointer;">OFF</span> 回線切断中 <span id="pd-fps" ${tipFps} style="cursor:pointer;"><span id="pd-fps-val" ${mono}></span>FPS</span>`;
                        pd.style.color = "#ff4444";
                    } else if (state === "connected") {
                        pd.innerHTML = `<span id="pd-badge" ${tipBadge} style="background:#2d8a2d;color:#fff;padding:2px 6px;border-radius:3px;cursor:pointer;">ON</span> <span id="pd-uid" ${tipUid} style="cursor:pointer;">${uid}</span> <span id="pd-ccu" ${tipCcu} style="cursor:pointer;"><span id="pd-ccu-val" ${mono}></span>人</span> <span id="pd-ping" ${tipPing} style="cursor:pointer;"><span id="pd-ping-val" ${mono}></span>ms</span> <span id="pd-fps" ${tipFps} style="cursor:pointer;"><span id="pd-fps-val" ${mono}></span>FPS</span>`;
                        pd.style.color = "";
                    } else {
                        pd.innerHTML = `<span id="pd-badge" ${tipBadge} style="background:#8b2020;color:#fff;padding:2px 6px;border-radius:3px;cursor:pointer;">OFF</span> <span id="pd-ping" ${tipPing} style="cursor:pointer;"><span id="pd-ping-val" ${mono}></span>ms</span> <span id="pd-fps" ${tipFps} style="cursor:pointer;"><span id="pd-fps-val" ${mono}></span>FPS</span>`;
                        pd.style.color = "";
                    }
                }
                // 値だけテキスト更新（DOM再構築なし）
                const ccuValEl  = document.getElementById("pd-ccu-val");
                if (ccuValEl) {
                    const ccuStr = String(game.userListProfile.userCount);
                    if (ccuValEl.textContent !== ccuStr) ccuValEl.textContent = ccuStr;
                }
                const pingValEl = document.getElementById("pd-ping-val");
                const fpsValEl  = document.getElementById("pd-fps-val");
                if (pingValEl) {
                    const pingStr = (state === "connected")
                        ? String(game.latestPingAvg).padStart(3, "\u2007")
                        : "\u2007--";
                    if (pingValEl.textContent !== pingStr) pingValEl.textContent = pingStr;
                }
                if (fpsValEl && fpsValEl.textContent !== fpsStr) fpsValEl.textContent = fpsStr;
            }
        }

        // パネル非表示時は計測を停止して早期リターン
        if (!debugOverlayEl || debugOverlayEl.style.display === "none") {
            if (instrumentationEnabled) {
                sceneInstrumentation.captureFrameTime = false;
                engineInstrumentation.captureGPUFrameTime = false;
                instrumentationEnabled = false;
            }
            return;
        }
        // パネル表示時のみ instrumentation を有効化
        if (!instrumentationEnabled) {
            sceneInstrumentation.captureFrameTime = true;
            engineInstrumentation.captureGPUFrameTime = true;
            instrumentationEnabled = true;
        }

        if (frameCount % 30 !== 0) return;

        if (sceneInstrumentation.frameTimeCounter && cv) {
            cv.innerText = sceneInstrumentation.frameTimeCounter.lastSecAverage.toFixed(2);
        }

        if (engineInstrumentation.gpuFrameTimeCounter && gv) {
            let gpuTime = engineInstrumentation.gpuFrameTimeCounter.lastSecAverage;
            if (gpuTime > 0) {
                gv.innerText = gpuTime.toFixed(2);
            } else {
                const currentFps = game.engine.getFps();
                const frameTime = currentFps > 0 ? 1000 / currentFps : 0;
                const cpuTime = sceneInstrumentation.frameTimeCounter ? sceneInstrumentation.frameTimeCounter.lastSecAverage : 0;
                gpuTime = Math.max(0, frameTime - cpuTime);
                gv.innerText = `~${gpuTime.toFixed(2)}`;
            }
        }

        if (sceneInstrumentation.drawCallsCounter && dv) {
            dv.innerText = sceneInstrumentation.drawCallsCounter.current.toString();
        }

        const activeMeshes = game.scene.getActiveMeshes();
        if (mv) mv.innerText = activeMeshes.length.toString();

        const activeMaterials = new Set();
        activeMeshes.forEach(m => { if(m.material) activeMaterials.add(m.material.name); });
        if (matv) matv.innerText = activeMaterials.size.toString();

        let activeBones = 0;
        activeMeshes.forEach(m => { if(m.skeleton) activeBones += m.skeleton.bones.length; });
        if (bv) bv.innerText = activeBones.toString();

        const mem = (performance as any).memory;
        if (mem && rv) rv.innerText = (mem.usedJSHeapSize / (1024 * 1024)).toFixed(1) + " MB";

        if (frameCount % 60 === 0) {
            let textureMemoryBytes = 0;
            game.scene.textures.forEach(texture => {
                const size = texture.getSize();
                if (size && size.width && size.height) {
                    const multiplier = texture.noMipmap ? 1.0 : 1.33;
                    textureMemoryBytes += size.width * size.height * 4 * multiplier;
                }
            });
            lastTexRAM = (textureMemoryBytes / (1024 * 1024)).toFixed(1) + " MB";

            let geoMemoryBytes = 0;
            game.scene.meshes.forEach(m => {
                geoMemoryBytes += m.getTotalVertices() * 32;
                const indices = m.getIndices();
                if (indices) geoMemoryBytes += indices.length * 4;
            });
            lastGeoRAM = (geoMemoryBytes / (1024 * 1024)).toFixed(1) + " MB";

            lastOcclusionQueries = game.scene.meshes.filter((m: any) => m.isOcclusionQueryInProgress).length.toString();
        }
        if (tv) tv.innerText = lastTexRAM;
        if (geov) geov.innerText = lastGeoRAM;

        const activeIndices = game.scene.getActiveIndices();
        if (iv) iv.innerText = activeIndices.toString();
        if (pv) pv.innerText = Math.floor(activeIndices / 3).toString();

        if (ov) ov.innerText = lastOcclusionQueries;

        if (profv) {
            const p = game.frameProfile;
            const md = game.nakama.matchDataProfile;
            const ul = game.userListProfile;
            profv.innerText = `pl=${p.playerMove.toFixed(2)} rm=${p.remoteAvatars.toFixed(2)} npc=${p.npc.toFixed(2)} tot=${p.total.toFixed(2)}ms | msg=${md.calls}/s ${md.totalMs.toFixed(1)}ms | ul=${ul.calls}/s ${ul.totalMs.toFixed(0)}ms n=${ul.userCount}`;
        }

        if (playerPosVal && game.playerBox) {
            const pos = game.playerBox.position;
            playerPosVal.innerText = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
            if (chunkVal) {
                const half = WORLD_SIZE / 2;
                const cx = Math.floor((pos.x + half) / CHUNK_SIZE);
                const cz = Math.floor((pos.z + half) / CHUNK_SIZE);
                chunkVal.innerText = `(${cx}, ${cz})`;
            }
        }

        if (aoiVal) {
            const a = game.aoiManager.lastAOI;
            aoiVal.innerText = `(${a.minCX},${a.minCZ})-(${a.maxCX},${a.maxCZ})`;
        }

        if (camInfoVal && game.camera) {
            const a = (game.camera.alpha * 180 / Math.PI).toFixed(0);
            const b = (game.camera.beta * 180 / Math.PI).toFixed(0);
            const r = game.camera.radius.toFixed(1);
            camInfoVal.innerText = `α:${a}°, β:${b}°, r:${r}`;
        }
    });
}
