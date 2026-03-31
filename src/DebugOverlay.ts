import type { GameScene } from "./GameScene";
import { Scene, Color3, Color4, Vector3, SceneInstrumentation, EngineInstrumentation } from "@babylonjs/core";
import { CHUNK_SIZE, WORLD_SIZE } from "./WorldConstants";
import { profSetEnabled, profReset } from "./Profiler";

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
            game.clampToViewport(debugOverlay);
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
            if (menuDebugBtn) menuDebugBtn.textContent = "　 デバッグツール";
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

    {
        const menuBtn    = document.getElementById("menu-btn")!;
        const menuPopup  = document.getElementById("menu-popup")!;
        const cookieReset = document.getElementById("menu-cookie-reset")!;

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
             "chat-history-panel", "ping-panel", "debug-overlay"].forEach(id => {
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

        const updateMobileLayout = () => {
            if (!isMobileMenu) return;
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
                    chatContainer.style.left = anyVisible ? "" : "0";
                    chatContainer.style.right = anyVisible ? "" : "0";
                    chatContainer.style.background = anyVisible ? "" : "transparent";
                }
            } else {
                const ptDiv = document.getElementById("portrait-divider");
                const cvs = document.getElementById("renderCanvas");
                if (anyVisible) {
                    savedPtDivider = gCk("ptDivider") || savedPtDivider;
                    if (ptDiv) ptDiv.style.display = "";
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
                    chatContainer.style.background = anyVisible ? "" : "transparent";
                }
            }
            // CSS変数の反映を待ってからリサイズ
            requestAnimationFrame(() => game.engine.resize());
        };

        const makeToggle = (btnId: string, targetId: string, label: string, cookieKey: string) => {
            const btn    = document.getElementById(btnId);
            const target = document.getElementById(targetId);
            if (!btn || !target) return;
            toggleRegistry.push({ btnId, targetId, label, cookieKey });

            if (gCk(cookieKey) === "0") {
                target.style.display = "none";
                btn.textContent = "　 " + label;
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
                            if (otherBtn) otherBtn.textContent = "　 " + reg.label;
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
                    game.clampToViewport(target);
                }
                btn.textContent = (visible ? "　" : "✓") + " " + label;
                sCk(cookieKey, visible ? "0" : "1");
                updateMobileLayout();
            });
        };
        makeToggle("menu-serversettings", "server-settings-panel", "サーバ設定",    "showSrvSettings");
        makeToggle("menu-serverlog",      "server-log-panel",      "サーバ接続ログ", "showSrvLog");
        makeToggle("menu-userlist",       "user-list-panel",       "プレイヤーリスト",  "showUserList");
        makeToggle("menu-chathistory",    "chat-history-panel",    "チャット履歴",  "showChatHist");
        makeToggle("menu-ping",           "ping-panel",            "Ping グラフ",   "showPing");
        makeToggle("menu-ccu",            "ccu-panel",             "同接グラフ",    "showCcu");
        makeToggle("menu-debug",          "debug-overlay",         "デバッグツール", "showDebug");
        makeToggle("menu-about",          "about-panel",           "tommieChatについて", "showAbout");
        makeToggle("menu-login",          "displayname-panel",     "表示名設定",       "showDisplayName");

        // 右上クリック: ユーザID → プレイヤーリスト、ping/FPS → Pingグラフ
        const pdEl = document.getElementById("ping-display");
        if (pdEl) {
            let pdAction: "userlist" | "ping" | "serverlog" | null = null;
            pdEl.addEventListener("pointerdown", (e) => {
                const target = e.target as HTMLElement;
                if (target.id === "pd-uid") {
                    pdAction = "userlist";
                } else if (target.id === "pd-badge") {
                    pdAction = "serverlog";
                } else if (target.id === "pd-ping" || !!target.closest?.("#pd-ping")) {
                    pdAction = "ping";
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
        scaleSelect.value = initScaleStr;

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
        });
    }

    const aaSelect = document.getElementById("aaSelect") as HTMLSelectElement;
    if (aaSelect) {
        aaSelect.addEventListener("change", () => {
            game.setMSAA(parseInt(aaSelect.value));
        });
    }

    let isLODEnabled = false;
    if (lodBtn) {
        lodBtn.addEventListener("click", () => {
            isLODEnabled = !isLODEnabled;
            lodBtn.innerText = isLODEnabled ? "On" : "Off";
            if (isLODEnabled) lodBtn.classList.remove("off");
            else lodBtn.classList.add("off");
        });
    }

    if (farClipInput && game.camera) {
        farClipInput.addEventListener("change", (e) => {
            const val = parseFloat((e.target as HTMLSelectElement).value);
            if (!isNaN(val) && val > 0) {
                game.camera.maxZ = val;
                game.scene.fogEnd = val;
            }
        });
    }

    const aoiVisBtn = document.getElementById("aoiVisBtn") as HTMLButtonElement;
    if (aoiVisBtn) {
        aoiVisBtn.addEventListener("click", () => {
            game.aoiManager.aoiVisEnabled = !game.aoiManager.aoiVisEnabled;
            aoiVisBtn.innerText = game.aoiManager.aoiVisEnabled ? "On" : "Off";
            if (game.aoiManager.aoiVisEnabled) aoiVisBtn.classList.remove("off");
            else aoiVisBtn.classList.add("off");
            game.aoiManager.updateAOILines();
        });
    }

    const camAutoRotBtn = document.getElementById("camAutoRotBtn") as HTMLButtonElement;
    if (camAutoRotBtn) {
        camAutoRotBtn.addEventListener("click", () => {
            game.camAutoRotate = !game.camAutoRotate;
            camAutoRotBtn.innerText = game.camAutoRotate ? "On" : "Off";
            if (game.camAutoRotate) camAutoRotBtn.classList.remove("off");
            else camAutoRotBtn.classList.add("off");
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
        cloudToggleBtn.addEventListener("click", () => {
            game.cloudSystem.setEnabled(!game.cloudSystem.enabled);
            cloudToggleBtn.innerText = game.cloudSystem.enabled ? "On" : "Off";
            if (game.cloudSystem.enabled) cloudToggleBtn.classList.remove("off");
            else cloudToggleBtn.classList.add("off");
        });
    }

    const remoteAoiBtn = document.getElementById("remoteAoiBtn") as HTMLButtonElement;
    if (remoteAoiBtn) {
        remoteAoiBtn.addEventListener("click", () => {
            game.aoiManager.setRemoteAoiEnabled(!game.aoiManager.remoteAoiEnabled);
            remoteAoiBtn.innerText = game.aoiManager.remoteAoiEnabled ? "On" : "Off";
            if (game.aoiManager.remoteAoiEnabled) remoteAoiBtn.classList.remove("off");
            else remoteAoiBtn.classList.add("off");
        });
    }

    const aoiRadiusSelect = document.getElementById("aoiRadiusSelect") as HTMLSelectElement;
    if (aoiRadiusSelect) {
        aoiRadiusSelect.addEventListener("change", (e) => {
            const val = parseInt((e.target as HTMLSelectElement).value, 10);
            if (!isNaN(val) && val > 0) {
                game.aoiManager.aoiRadius = val;
                game.aoiManager.updateAOI();
            }
        });
    }

    const maxZoomSelect = document.getElementById("maxZoomSelect") as HTMLSelectElement;
    if (maxZoomSelect && game.camera) {
        maxZoomSelect.addEventListener("change", (e) => {
            const val = parseFloat((e.target as HTMLSelectElement).value);
            if (!isNaN(val) && val > 0) {
                game.camera.upperRadiusLimit = val;
            }
        });
    }

    if (fovSelect && fovInput && game.camera) {
        fovInput.addEventListener("input", (e) => {
            const val = parseFloat((e.target as HTMLInputElement).value);
            if (!isNaN(val) && val > 0) {
                game.camera.fov = val * Math.PI / 180;
                const optionExists = Array.from(fovSelect.options).some(opt => opt.value === val.toString());
                if (optionExists) {
                    fovSelect.value = val.toString();
                }
            }
        });

        fovSelect.addEventListener("change", (e) => {
            const target = e.target as HTMLSelectElement;
            const val = parseFloat(target.value);
            if (!isNaN(val) && val > 0) {
                game.camera.fov = val * Math.PI / 180;
                fovInput.value = target.value;
            }
        });
    }

    if (fogBtn) {
        let isFogEnabled = true;
        fogBtn.addEventListener("click", () => {
            isFogEnabled = !isFogEnabled;
            game.scene.fogMode = isFogEnabled ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
            fogBtn.innerText = isFogEnabled ? "On" : "Off";
            if (isFogEnabled) fogBtn.classList.remove("off");
            else fogBtn.classList.add("off");
        });
    }

    if (fogColorInput) {
        fogColorInput.addEventListener("input", (e) => {
            const val = (e.target as HTMLInputElement).value;
            const newColor = Color3.FromHexString(val);
            game.scene.fogColor = newColor;
            game.scene.clearColor = new Color4(newColor.r, newColor.g, newColor.b, 1.0);
        });
    }

    if (autoChatBtn) {
        const npcMessages: { text: string; aa?: boolean }[] = [
            // 1行 短め
            { text: "こんにちは！⭐️" }, { text: "今日もいい天気だね。" }, { text: "何か面白いことある？" },
            { text: "ここは好きな場所だよ。" }, { text: "また会えたね！" }, { text: "ちょっと疲れたな〜" },
            { text: "このあたりは静かでいいね。" }, { text: "どこから来たの？" }, { text: "冒険に出かけようよ！" },
            { text: "今日のランチは何だろう？" }, { text: "やっほー！" }, { text: "w" }, { text: "おつ" },
            { text: "よろしく！" }, { text: "なるほど〜" }, { text: "それな" }, { text: "うける" },
            // 1行 長め
            { text: "今日はとても良い天気で散歩日和ですね！みんなでピクニックに行きませんか？" },
            { text: "このワールドは広くて色々な場所があるから探検するのが楽しいよね！！" },
            { text: "あのさあ、昨日見つけた秘密の場所に案内してあげようか？すごく景色がいいところなんだよ" },
            { text: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" },
            // 2行
            { text: "おはよう！\n今日も一日がんばろう！" },
            { text: "ねえねえ、聞いて！\nさっき面白いもの見つけたよ！" },
            { text: "お腹すいた〜\nどこかにレストランないかな？" },
            // 3行
            { text: "今日の予定：\n午前：探検\n午後：建築" },
            { text: "やあ！元気？\n最近どうしてた？\nまた一緒に遊ぼうよ！" },
            { text: "注意事項\nここから先は危険地帯です\n十分気をつけてください" },
            // 最大行（5行）
            { text: "本日のお知らせ\n新しいエリアが追加されました\n東の森の奥に洞窟があります\n宝箱が隠されているらしい\nみんなで探しに行こう！" },
            { text: "第1回チャット大会\n日時：今日の15時〜\n場所：中央広場\n参加費：無料\nたくさんの参加お待ちしてます！" },
            // 英文
            { text: "Hi!" }, { text: "Hello there!" }, { text: "GG" }, { text: "lol" }, { text: "brb" },
            { text: "Nice to meet you! Welcome to the world!" },
            { text: "What a beautiful day for an adventure, don't you think?" },
            { text: "Hey, have you seen the new area?\nIt's really cool!" },
            { text: "Pro tip:\nDon't forget to save\nbefore you explore!" },
            { text: "Welcome to tommieChat!\nFeel free to look around\nMeet new friends\nBuild something cool\nHave fun!" },
            // 顔文字・エモーション
            { text: "(´・ω・｀)" }, { text: "ｷﾀ━━━(ﾟ∀ﾟ)━━━!!" }, { text: "(；´Д｀)" }, { text: "( ﾟДﾟ)ﾊｧ?" },
            { text: "ﾜﾛﾀwww" }, { text: "(´;ω;｀)ﾌﾞﾜｯ" }, { text: "( ´∀｀)σ)∀`)" }, { text: "m9(^Д^)ﾌﾟｷﾞｬｰ" },
            { text: "orz" }, { text: "(ノ∀`)ｱﾁｬｰ" }, { text: "( ^ω^)おっ" }, { text: "＼(^o^)／ｵﾜﾀ" },
            { text: "ちょwwおまwww" }, { text: "ぬるぽ" }, { text: "ｶﾞｯ" },
            { text: "草" }, { text: "草生える🌱" }, { text: "まじかよ😂" }, { text: "つらい😭" },
            { text: "やば〜〜〜✨✨✨" }, { text: "かわいい💕" }, { text: "それめっちゃわかる🥺" },
            { text: "神ゲーすぎん？🔥🔥" }, { text: "え、待って待って😳" }, { text: "うぇーい🍻" },
            { text: "おけまる⭕" }, { text: "りょ👍" }, { text: "あざます🙏" },
            { text: "今日も推しが尊い🙏✨" }, { text: "ガチで草なんだがwww" },
            { text: "は？ﾏｼﾞ？\nまじだった(´・ω・｀)" },
            { text: "速報🚨\nワイ、ログインに成功🎉\nなお何もすることがない模様😇" },
            // 境界値テスト
            { text: "a" },                                                    // 1文字（最小幅）
            { text: "1234567890123456789012345678901234567890" },              // 40文字ちょうど（MAX_CHARS境界）
            { text: "12345678901234567890123456789012345678901" },             // 41文字（...切り詰め確認）
            { text: " " },                                                    // 空白のみ（非表示になるか）
            { text: "1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890\n1234567890123456789012345678901234567890" },  // 5行×40文字（最大面積）
            // レンダリング確認
            { text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz" }, // 半角英数長文
            { text: "■□●○◆◇★☆♪♫〒〶※†‡§¶" },                                // 全角記号
            { text: "🏴\u200D☠️👨\u200D👩\u200D👧\u200D👦🇯🇵🏳️\u200D🌈" },                          // サロゲートペア・複合絵文字
            { text: "Hello世界🌍123！mixed混在テスト" },                       // 混在テスト
            { text: "https://example.com/very/long/path/to/page?q=test" },    // URL
            { text: "wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww" },            // 連続記号
            // AA（アスキーアート）
            { text: "　 ∧＿∧\n（　´∀｀）\n（　　　　）\n｜ ｜　|\n（＿_)＿)", aa: true },
            // 多言語テスト — 中国語（簡体）
            { text: "(Chinese)你好！" }, { text: "(Chinese)欢迎来到这个世界！大家一起玩吧～" },
            { text: "(Chinese)今天天气真好\n我们去探险吧！" },
            // 韓国語
            { text: "(Korean)안녕하세요!" }, { text: "(Korean)여기 정말 재미있어요! 같이 놀아요～" },
            { text: "(Korean)오늘의 공지\n새로운 지역이 추가되었습니다\n많은 참여 부탁드립니다!" },
            // タイ語（結合文字テスト）
            { text: "(Thai)สวัสดีครับ!" }, { text: "(Thai)ยินดีต้อนรับสู่โลกนี้!" },
            { text: "(Thai)วันนี้อากาศดีมาก\nไปผจญภัยกันเถอะ!" },
            // アラビア語（RTLテスト）
            { text: "(Arabic)مرحبا!" }, { text: "(Arabic)أهلاً وسهلاً بكم في هذا العالم!" },
            { text: "(Arabic)إعلان مهم\nتم إضافة منطقة جديدة\nاستمتعوا!" },
            // ヒンディー語（デーヴァナーガリー・リガチャテスト）
            { text: "(Hindi)नमस्ते!" }, { text: "(Hindi)इस दुनिया में आपका स्वागत है!" },
            { text: "(Hindi)आज का मौसम बहुत अच्छा है\nचलो साहसिक यात्रा पर चलते हैं!" },
        ];
        let autoChatTimer: ReturnType<typeof setTimeout> | null = null;
        let isAutoChatOn = false;

        const setAAMode = (on: boolean) => {
            const btn = document.getElementById("aaModeBtn") as HTMLButtonElement | null;
            if (!btn) return;
            const current = btn.classList.contains("on");
            if (current !== on) btn.click();
        };

        const sendAutoMsg = async (entry: { text: string; aa?: boolean }) => {
            if (entry.aa) setAAMode(true);
            try { await game.nakama.sendChatMessage(entry.text); } catch { /* ignore */ }
            if (entry.aa) setAAMode(false);
        };

        const scheduleNext = () => {
            const delay = 1500 + Math.random() * 2500;
            autoChatTimer = setTimeout(async () => {
                if (!isAutoChatOn) return;
                const entry = npcMessages[Math.floor(Math.random() * npcMessages.length)];
                await sendAutoMsg(entry);
                scheduleNext();
            }, delay);
        };
        autoChatBtn.addEventListener("click", () => {
            isAutoChatOn = !isAutoChatOn;
            autoChatBtn.textContent = isAutoChatOn ? "On" : "Off";
            if (isAutoChatOn) {
                autoChatBtn.classList.remove("off");
                // 即座に1つ送信してから次をスケジュール
                const entry = npcMessages[Math.floor(Math.random() * npcMessages.length)];
                sendAutoMsg(entry);
                scheduleNext();
            } else {
                autoChatBtn.classList.add("off");
                if (autoChatTimer !== null) { clearTimeout(autoChatTimer); autoChatTimer = null; }
            }
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
            });
        }
    }

    if (npcAutoChatBtn) {
        npcAutoChatBtn.addEventListener("click", () => {
            game.npcSystem.isNpcChatOn = !game.npcSystem.isNpcChatOn;
            npcAutoChatBtn.textContent = game.npcSystem.isNpcChatOn ? "On" : "Off";
            if (game.npcSystem.isNpcChatOn) npcAutoChatBtn.classList.remove("off");
            else npcAutoChatBtn.classList.add("off");
        });
    }

    if (npcVisBtn) {
        npcVisBtn.addEventListener("click", () => {
            const visible = !game.npcSystem.npc001.isEnabled();
            game.npcSystem.setEnabled(visible);
            npcVisBtn.textContent = visible ? "On" : "Off";
            if (visible) npcVisBtn.classList.remove("off");
            else npcVisBtn.classList.add("off");
        });
    }

    if (buildModeBtn) {
        buildModeBtn.addEventListener("click", () => {
            game.buildMode = !game.buildMode;
            buildModeBtn.textContent = game.buildMode ? "On" : "Off";
            buildModeBtn.classList.toggle("off", !game.buildMode);
            const indicator = document.getElementById("build-mode-indicator");
            if (indicator) {
                indicator.style.display = game.buildMode ? "" : "none";
                if (game.buildMode) indicator.textContent = "🔨 ビルドモード（B/ESCキーで解除）";
            }
            if (game.buildMode) game.refreshPreviewBlock();
            else game.previewBlock.isVisible = false;
        });
    }

    if (speechTrimBtn) {
        speechTrimBtn.addEventListener("click", () => {
            const on = !speechTrimBtn.classList.contains("on");
            speechTrimBtn.textContent = on ? "On" : "Off";
            speechTrimBtn.classList.toggle("on", on);
            speechTrimBtn.classList.toggle("off", !on);
        });
    }

    if (aaModeBtn) {
        aaModeBtn.addEventListener("click", () => {
            const on = !aaModeBtn.classList.contains("on");
            aaModeBtn.textContent = on ? "On" : "Off";
            aaModeBtn.classList.toggle("on", on);
            aaModeBtn.classList.toggle("off", !on);

            if (on) {
                const trimBtn = document.getElementById("speechTrimBtn") as HTMLButtonElement | null;
                if (trimBtn) {
                    trimBtn.textContent = "Off";
                    trimBtn.classList.remove("on");
                    trimBtn.classList.add("off");
                }
                const fontSel = document.getElementById("speechFontSelect") as HTMLSelectElement | null;
                if (fontSel) fontSel.value = "sans-serif";
                const leadSel = document.getElementById("speechLeadingSelect") as HTMLSelectElement | null;
                if (leadSel) leadSel.value = "1.0";
            }
        });
    }

    if (avatarThickInput) {
        avatarThickInput.addEventListener("input", () => {
            const v = Math.max(1, Math.min(50, parseInt(avatarThickInput.value, 10) || 5));
            game.avatarDepth = v / 100;
            game.applyAvatarDepth();
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
            game.nakama.sendInitPos(0, 0).catch(() => {});

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
            game.nakama.sendMoveTarget(x, z).catch(() => {});
            game.aoiManager.updateAOI();
        });
    }

    const avatarSelect = document.getElementById("avatarSelect") as HTMLSelectElement | null;
    if (avatarSelect) {
        avatarSelect.value = game.playerTextureUrl;
        avatarSelect.addEventListener("change", () => {
            game.playerTextureUrl = avatarSelect.value;
            game.avatarSystem.changeAvatarTexture(game.playerBox, game.playerTextureUrl);
            game.nakama.sendAvatarChange(game.playerTextureUrl).catch(() => {});
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
            game.nakama.sendAvatarChange(url, cc, cr).catch(() => {});
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
        if (frameCount % 30 === 0) {
            const fpsNum = Math.min(99, Math.floor(game.engine.getFps()));
            const fps = String(fpsNum).padStart(2, "0");
            if (fv) fv.innerText = fps;
            const pd = document.getElementById("ping-display");
            if (pd) {
                const uid = game.selfNameLabel || ("@" + (game.nakama.getSession()?.username ?? ""));
                const fpsStr = String(fps).padStart(2, "\u2007");
                const mono = 'style="font-variant-numeric:tabular-nums;"';
                const pingCursor = 'style="cursor:pointer;"';
                const badgeCursor = 'cursor:pointer;';
                const pingLabel = isMobileDev ? "" : "ping=";
                const fpsLabel = "FPS";
                if (game.latestPingAvg !== null && game.latestPingAvg < 0) {
                    pd.innerHTML = `<span id="pd-badge" style="background:#8b2020;color:#fff;padding:2px 6px;border-radius:3px;${badgeCursor}">● 未接続</span> 回線切断中 <span id="pd-ping" ${pingCursor}><span ${mono}>${fpsStr}</span>${fpsLabel}</span>`;
                    pd.style.color = "#ff4444";
                } else if (game.latestPingAvg !== null) {
                    const pingStr = String(game.latestPingAvg).padStart(3, "\u2007");
                    pd.innerHTML = `<span id="pd-badge" style="background:#2d8a2d;color:#fff;padding:2px 6px;border-radius:3px;${badgeCursor}">ON</span> <span id="pd-uid" style="cursor:pointer;">${uid}</span> <span id="pd-ping" ${pingCursor}>${pingLabel}<span ${mono}>${pingStr}</span>ms <span ${mono}>${fpsStr}</span>${fpsLabel}</span>`;
                    pd.style.color = "";
                } else {
                    pd.innerHTML = `<span id="pd-badge" style="background:#8b2020;color:#fff;padding:2px 6px;border-radius:3px;${badgeCursor}">● 未接続</span> <span id="pd-ping" ${pingCursor}>${pingLabel}<span ${mono}>\u2007--</span>ms <span ${mono}>${fpsStr}</span>${fpsLabel}</span>`;
                    pd.style.color = "";
                }
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
