import type { GameScene } from "./GameScene";
import { Mesh } from "@babylonjs/core";
import { fnv1a64, CHUNK_SIZE } from "./WorldConstants";
import { prof } from "./Profiler";
import { t, getLang, setLang, applyI18n } from "./i18n";
import type { Lang } from "./i18n";
import { escapeHtml, sanitizeColor } from "./utils";

export function setupHtmlUI(game: GameScene): void {
    const isMobileDev = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;

    // アカウント情報の再描画関数（ブロックスコープを超えて doLogin 等から呼ぶため関数スコープに配置）
    let refreshAccountStatus: (() => void) | null = null;

    // タブバーをドラッグしてデバイダー移動を開始した直後、タブ切替のクリックを抑止するフラグ
    let justDraggedFromTab = false;

    // --- i18n 言語セレクター ---
    const langSelect = document.getElementById("langSelect") as HTMLSelectElement | null;
    const settingsLangSelect = document.getElementById("settings-lang-select") as HTMLSelectElement | null;
    const onLangChangeCallbacks: (() => void)[] = [];
    const applyLang = (val: string) => {
        setLang(val as Lang);
        applyI18n();
        applyI18nMenus();
        if (langSelect && langSelect.value !== val) langSelect.value = val;
        if (settingsLangSelect && settingsLangSelect.value !== val) settingsLangSelect.value = val;
        for (const cb of onLangChangeCallbacks) cb();
    };
    if (langSelect) {
        langSelect.value = getLang();
        langSelect.addEventListener("change", () => applyLang(langSelect.value));
    }
    if (settingsLangSelect) {
        settingsLangSelect.value = getLang();
        settingsLangSelect.addEventListener("change", () => applyLang(settingsLangSelect.value));
    }

    // --- 設定パネル: ツールチップトグル（menu-tooltips と同期） ---
    {
        const settingsTooltipBtn = document.getElementById("settings-tooltip-toggle");
        const tooltipMenuBtn = document.getElementById("menu-tooltips");
        if (settingsTooltipBtn && tooltipMenuBtn) {
            const updateLabel = () => {
                const enabled = !!game.tooltipsEnabled;
                settingsTooltipBtn.textContent = enabled ? "ON" : "OFF";
            };
            updateLabel();
            settingsTooltipBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                tooltipMenuBtn.click();
                setTimeout(updateLabel, 0);
            });
            new MutationObserver(updateLabel).observe(tooltipMenuBtn, { childList: true, characterData: true, subtree: true });
            onLangChangeCallbacks.push(updateLabel);
        }
    }
    // --- 設定パネル: クッキー初期化（menu-cookie-reset を再利用） ---
    {
        const settingsCookieResetBtn = document.getElementById("settings-cookie-reset-btn");
        const cookieResetMenuBtn = document.getElementById("menu-cookie-reset");
        if (settingsCookieResetBtn && cookieResetMenuBtn) {
            settingsCookieResetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                cookieResetMenuBtn.click();
            });
        }
    }
    /** メニュー項目のプレフィックス付きテキストを翻訳 */
    const applyI18nMenus = () => {
        document.querySelectorAll<HTMLElement>("[data-i18n-prefix]").forEach(el => {
            const key = el.dataset.i18nPrefix as Parameters<typeof t>[0];
            const prefix = el.textContent?.slice(0, 2) ?? "　 ";
            el.textContent = prefix + t(key);
        });
    };
    applyI18n();
    applyI18nMenus();

    // スマホ: パネルのスクロール領域のタッチが canvas やデバイダーに伝播するのを防止
    // ヘッダーはデバイダードラッグに使うので除外
    if (isMobileDev) {
        const wrapIds = ["user-list-wrap", "chat-history-wrap", "server-settings-body",
                         "server-log-list", "ping-body", "ccu-body", "debug-content", "about-panel-body", "displayname-body",
                         "avatar-body", "room-list-body", "room-list-scroll", "settings-body"];
        for (const id of wrapIds) {
            const el = document.getElementById(id);
            if (!el) continue;
            for (const evt of ["pointerdown", "pointermove", "pointerup"] as const) {
                el.addEventListener(evt, (e) => e.stopPropagation());
            }
            el.addEventListener("touchmove", (e) => e.stopPropagation());
        }
    }

    // フラッシュガードの非表示状態をインラインスタイルに移してからCSS削除
    {
        const guard = document.getElementById("panel-flash-guard");
        if (guard) {
            const hiddenPanels = guard.textContent || "";
            const panelIds = ["server-settings-panel","server-log-panel","user-list-panel",
                               "chat-history-panel","debug-overlay","ping-panel"];
            let allHidden = true;
            for (const id of panelIds) {
                if (hiddenPanels.includes(id)) {
                    const el = document.getElementById(id);
                    if (el) el.style.display = "none";
                } else {
                    allHidden = false;
                }
            }
            if (isMobileDev) {
                const cvs = document.getElementById("renderCanvas");
                if (allHidden) {
                    if (matchMedia("(orientation:landscape)").matches) {
                        document.documentElement.style.setProperty("--ls-divider", "100%");
                        const div = document.getElementById("landscape-divider");
                        if (div) div.style.display = "none";
                    } else {
                        document.documentElement.style.setProperty("--pt-divider", "100vh");
                        const div = document.getElementById("portrait-divider");
                        if (div) div.style.display = "none";
                    }
                    document.body.classList.remove("sp-panel-visible");
                    if (cvs) cvs.style.height = "100vh";
                } else {
                    document.body.classList.add("sp-panel-visible");
                    if (cvs) cvs.style.height = "";
                }
            }
            guard.remove();
        }
    }

    // ===== クッキーヘルパー（デバイダー用） =====
    const divCkMax = `path=/;max-age=${60 * 60 * 24 * 365}`;
    const getDivCk = (k: string): string | null => {
        const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
        return m ? decodeURIComponent(m[1]) : null;
    };
    const setDivCk = (k: string, v: string) =>
        document.cookie = `${k}=${encodeURIComponent(v)};${divCkMax}`;

    // ===== ランドスケープ区切りコントロール =====
    {
        const divider = document.getElementById("landscape-divider");
        const chatContainer = document.getElementById("chat-container");
        const updatePanelBottom = () => {
            if (!chatContainer) return;
            const rect = chatContainer.getBoundingClientRect();
            const viewH = window.innerHeight;
            const bottomFromViewport = viewH - rect.bottom;
            document.documentElement.style.setProperty("--ls-panel-bottom", (rect.height + bottomFromViewport + 4) + "px");
        };
        const savedLs = getDivCk("lsDivider");
        if (savedLs) {
            document.documentElement.style.setProperty("--ls-divider", savedLs);
        }
        if (divider) {
            let dragging = false;
            let lsRafPending = false;
            divider.addEventListener("pointerdown", (e: PointerEvent) => {
                dragging = true;
                divider.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                const pct = Math.max(20, Math.min(80, (e.clientX / window.innerWidth) * 100));
                document.documentElement.style.setProperty("--ls-divider", pct + "%");
                // engine.resize() は重いので rAF で 1 フレーム 1 回に間引く。
                // resize 直後に scene.render() を同期呼び出ししてチラつきを防ぐ。
                if (!lsRafPending) {
                    lsRafPending = true;
                    requestAnimationFrame(() => {
                        lsRafPending = false;
                        game.engine.resize();
                        game.scene.render();
                        const reapply = (game as any).onChatOverlayReapply;
                        if (typeof reapply === "function") reapply();
                        for (const cb of game.onDividerMove) cb();
                    });
                }
            });
            document.addEventListener("pointerup", () => {
                if (dragging) {
                    dragging = false;
                    game.engine.resize();
                    game.scene.render();
                    const reapply = (game as any).onChatOverlayReapply;
                    if (typeof reapply === "function") reapply();
                    for (const cb of game.onDividerMove) cb();
                    const v = getComputedStyle(document.documentElement).getPropertyValue("--ls-divider").trim();
                    if (v) setDivCk("lsDivider", v);
                }
            });
        }
        if (chatContainer) {
            new ResizeObserver(updatePanelBottom).observe(chatContainer);
            window.addEventListener("orientationchange", () => setTimeout(updatePanelBottom, 200));
            updatePanelBottom();
        }
    }

    // ===== ポートレート水平デバイダー =====
    {
        const ptDivider = document.getElementById("portrait-divider");
        const chatContainer = document.getElementById("chat-container");
        const updatePtPanelBottom = () => {
            if (!chatContainer) return;
            const rect = chatContainer.getBoundingClientRect();
            const viewH = window.innerHeight;
            const bottomFromViewport = viewH - rect.bottom;
            document.documentElement.style.setProperty("--pt-panel-bottom", (rect.height + bottomFromViewport + 4) + "px");
        };
        const savedPt = getDivCk("ptDivider");
        if (savedPt) {
            // 保存値を30〜75%にクランプ
            const val = parseFloat(savedPt);
            const clamped = Math.max(30, Math.min(75, isNaN(val) ? 60 : val));
            document.documentElement.style.setProperty("--pt-divider", clamped + "vh");
        }
        {
            let dragging = false;
            let dragOffsetPx = 0; // タッチ位置とデバイダー位置の差分
            const startDrag = (e: PointerEvent, captureEl: HTMLElement) => {
                // 現在のデバイダー位置（px）を取得
                const vhPx = window.innerHeight;
                const curVal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--pt-divider")) || 60;
                const dividerPx = (curVal / 100) * vhPx;
                dragOffsetPx = e.clientY - dividerPx;
                dragging = true;
                captureEl.setPointerCapture(e.pointerId);
                e.preventDefault();
            };
            if (ptDivider) {
                ptDivider.addEventListener("pointerdown", (e: PointerEvent) => startDrag(e, ptDivider));
            }
            // スマホ: パネルヘッダーのドラッグでもデバイダーを移動（ポートレートのみ）
            // ただしヘッダー上端8px以内は境界線付近の誤操作防止のため反応させない。
            // 表示名・アバター等のポップオーバー系パネルは編集用のため対象外。
            if (isMobileDev) {
                const headerIds = ["user-list-header", "chat-history-header", "chat-settings-header",
                                   "server-settings-header", "server-log-header", "ping-header", "ccu-header", "bookmark-header", "room-list-header", "debug-title-bar", "about-panel-header",
                                   "avatar-header", "displayname-header", "settings-header"];
                // デバイダーがパネル上端に 2px しか被らないのでデッドゾーンは最小限
                const EDGE_DEAD_ZONE_PX = 2;
                for (const hid of headerIds) {
                    const hdr = document.getElementById(hid);
                    if (hdr) hdr.addEventListener("pointerdown", (e: PointerEvent) => {
                        // ランドスケープではヘッダードラッグ不要（ツールチップ優先）
                        if (window.matchMedia("(orientation: landscape)").matches) return;
                        const t = e.target as HTMLElement;
                        if (t.closest("[id$='-close']")) return; // ✕ボタンは除外
                        const rect = hdr.getBoundingClientRect();
                        if (e.clientY - rect.top < EDGE_DEAD_ZONE_PX) return; // 上端境界線付近は無視
                        startDrag(e, hdr);
                    });
                }
                // タブバーのドラッグでもデバイダーを移動させる。
                // 非ボタン領域: 即ドラッグ開始。タブボタン上: 縦方向に閾値超過で切替ではなくドラッグ。
                const tabBar = document.getElementById("panel-tab-bar");
                if (tabBar) {
                    const TAB_DRAG_THRESHOLD_PX = 8;
                    let pendingStart: { x: number; y: number; pointerId: number } | null = null;
                    tabBar.addEventListener("pointerdown", (e: PointerEvent) => {
                        if (window.matchMedia("(orientation: landscape)").matches) return;
                        const t = e.target as HTMLElement;
                        if (t.closest("#panel-tab-close")) return;
                        const rect = tabBar.getBoundingClientRect();
                        if (e.clientY - rect.top < EDGE_DEAD_ZONE_PX) return;
                        if (t.closest(".panel-tab")) {
                            pendingStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
                        } else {
                            startDrag(e, tabBar);
                        }
                    });
                    document.addEventListener("pointermove", (e: PointerEvent) => {
                        if (!pendingStart || e.pointerId !== pendingStart.pointerId) return;
                        const dy = e.clientY - pendingStart.y;
                        const dx = e.clientX - pendingStart.x;
                        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 3) {
                            // 横方向移動が優勢なら横スクロールとみなして中止
                            pendingStart = null;
                            return;
                        }
                        if (Math.abs(dy) >= TAB_DRAG_THRESHOLD_PX) {
                            pendingStart = null;
                            justDraggedFromTab = true;
                            setTimeout(() => { justDraggedFromTab = false; }, 120);
                            startDrag(e, tabBar);
                        }
                    });
                    document.addEventListener("pointerup", () => { pendingStart = null; });
                    document.addEventListener("pointercancel", () => { pendingStart = null; });
                }
            }
            let rafPending = false;
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                const vhPx = window.innerHeight;
                const pct = Math.max(30, Math.min(75, ((e.clientY - dragOffsetPx) / vhPx) * 100));
                document.documentElement.style.setProperty("--pt-divider", pct + "vh");
                // engine.resize() は重いので rAF で 1 フレーム 1 回に間引く。
                // resize 直後に scene.render() を同期呼び出ししないと
                // フレームバッファがクリアされた状態で次描画まで一瞬黒く光る（チラつき）。
                if (!rafPending) {
                    rafPending = true;
                    requestAnimationFrame(() => {
                        rafPending = false;
                        game.engine.resize();
                        game.scene.render();
                        const reapply = (game as any).onChatOverlayReapply;
                        if (typeof reapply === "function") reapply();
                    });
                }
            });
            document.addEventListener("pointerup", () => {
                if (dragging) {
                    dragging = false;
                    // ドラッグ終了時に最終リサイズを確実に実行
                    game.engine.resize();
                    game.scene.render();
                    const reapply = (game as any).onChatOverlayReapply;
                    if (typeof reapply === "function") reapply();
                    const v = getComputedStyle(document.documentElement).getPropertyValue("--pt-divider").trim();
                    if (v) setDivCk("ptDivider", v);
                }
            });
        }
        if (chatContainer) {
            new ResizeObserver(updatePtPanelBottom).observe(chatContainer);
            window.addEventListener("orientationchange", () => setTimeout(updatePtPanelBottom, 200));
            window.addEventListener("resize", updatePtPanelBottom);
            // sp-panel-visible クラス変更時にも再計算
            new MutationObserver(() => requestAnimationFrame(updatePtPanelBottom))
                .observe(document.body, { attributes: true, attributeFilter: ["class"] });
            updatePtPanelBottom();
            // DOMレイアウト確定後に再計算
            requestAnimationFrame(updatePtPanelBottom);
            setTimeout(updatePtPanelBottom, 500);
        }
    }

    const textarea = document.getElementById("chatInput") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;

    if (!textarea || !sendBtn) return;

    // チャット履歴の遅延フェッチ（addChatHistory 定義後に代入）
    const chatLoader: { fn: (() => void) | null } = { fn: null };

    const historyPanel = document.getElementById("chat-history-panel") as HTMLElement;
    const historyHeader = document.getElementById("chat-history-header") as HTMLElement;
    if (historyPanel && historyHeader) {

        const setCookie = (name: string, value: string) => {
            document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${60 * 60 * 24 * 365}`;
        };
        const savePanelState = () => {
            const rect = historyPanel.getBoundingClientRect();
            setCookie("chat-history-panel_l", String(Math.round(rect.left)));
            setCookie("chat-history-panel_t", String(Math.round(rect.top)));
            setCookie("chat-history-panel_w", String(Math.round(rect.width)));
            setCookie("chat-history-panel_h", String(Math.round(rect.height)));
        };

        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        historyHeader.addEventListener("pointerdown", (e: PointerEvent) => {
            if (isMobileDev) return;
            // Xボタン上のクリックはドラッグしない
            if ((e.target as HTMLElement).id === "chat-history-close") return;
            isDragging = true;
            const hRect = historyPanel.getBoundingClientRect();
            dragOffsetX = e.clientX - hRect.left;
            dragOffsetY = e.clientY - hRect.top;
            historyHeader.setPointerCapture(e.pointerId);
            e.preventDefault();
        });

        document.addEventListener("pointermove", (e: PointerEvent) => {
            if (!isDragging) return;
            const x = Math.max(0, e.clientX - dragOffsetX);
            const y = Math.max(0, e.clientY - dragOffsetY);
            historyPanel.style.left = x + "px";
            historyPanel.style.top  = y + "px";
        });

        document.addEventListener("pointerup", () => {
            if (isDragging) {
                isDragging = false;
                savePanelState();
            }
        });

        const resizeObserver = new ResizeObserver(() => {
            if (historyPanel.style.display === "none") return;
            savePanelState();
        });
        resizeObserver.observe(historyPanel);

        const histClose = document.getElementById("chat-history-close") as HTMLElement;
        if (histClose) {
            histClose.addEventListener("click", () => {
                savePanelState();  // 非表示前に位置・サイズを保存
                historyPanel.style.display = "none";
                setCookie("showChatHist", "0");
                const mb = document.getElementById("menu-chathistory");
                if (mb) mb.textContent = "　 " + t("menu.chathistory");
            });
        }

        // 表示/最小化解除時に末尾へスクロール（非表示中はスキップしていたため）
        const histList = document.getElementById("chat-history-list");
        if (histList) {
            let wasInactive = historyPanel.style.display === "none" || historyPanel.classList.contains("minimized");
            new MutationObserver(() => {
                const nowInactive = historyPanel.style.display === "none" || historyPanel.classList.contains("minimized");
                if (wasInactive && !nowInactive) {
                    requestAnimationFrame(() => { histList.scrollTop = histList.scrollHeight; });
                    chatLoader.fn?.();
                }
                wasInactive = nowInactive;
            }).observe(historyPanel, { attributes: true, attributeFilter: ["style", "class"] });
        }
    }

    // ===== ユーザーリスト ドラッグ & 最小化 =====
    {
        const ulPanel  = document.getElementById("user-list-panel") as HTMLElement;
        const ulHeader = document.getElementById("user-list-header") as HTMLElement;
        const ulClose  = document.getElementById("user-list-close") as HTMLElement;

        if (ulPanel && ulHeader) {
            if (!isMobileDev) {
                const gCkUl = (k: string): string | null => {
                    const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                    return m ? decodeURIComponent(m[1]) : null;
                };
                const sL = gCkUl("user-list-panel_l"), sT = gCkUl("user-list-panel_t");
                const sW = gCkUl("user-list-panel_w"), sH = gCkUl("user-list-panel_h");
                if (sL !== null) { ulPanel.style.left = sL + "px"; ulPanel.style.right = "auto"; }
                else { ulPanel.style.left = ulPanel.getBoundingClientRect().left + "px"; ulPanel.style.right = "auto"; }
                if (sT !== null) ulPanel.style.top = sT + "px";
                if (sW !== null) ulPanel.style.width = sW + "px";
                if (sH !== null) ulPanel.style.height = sH + "px";
            }

            const sCookieFn = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            let isDrag = false, offX = 0, offY = 0;
            ulHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "user-list-close") return;
                if ((e.target as HTMLElement).tagName === "SELECT") return;
                if (isMobileDev) return;
                isDrag = true;
                const uRect = ulPanel.getBoundingClientRect();
                offX = e.clientX - uRect.left;
                offY = e.clientY - uRect.top;
                ulHeader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!isDrag) return;
                ulPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                ulPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
            });
            document.addEventListener("pointerup", () => {
                if (!isDrag) return;
                isDrag = false;
                const r = ulPanel.getBoundingClientRect();
                sCookieFn("user-list-panel_l", String(Math.round(r.left)));
                sCookieFn("user-list-panel_t",  String(Math.round(r.top)));
            });

            const ulResizeObserver = new ResizeObserver(() => {
                if (ulPanel.classList.contains("minimized")) return;
                if (ulPanel.style.display === "none") return;
                const r = ulPanel.getBoundingClientRect();
                sCookieFn("user-list-panel_w",  String(Math.round(r.width)));
                sCookieFn("user-list-panel_h", String(Math.round(r.height)));
            });
            ulResizeObserver.observe(ulPanel);

            if (ulClose) {
                ulClose.addEventListener("click", () => {
                    // 非表示前に位置・サイズを保存
                    const r = ulPanel.getBoundingClientRect();
                    sCookieFn("user-list-panel_l", String(Math.round(r.left)));
                    sCookieFn("user-list-panel_t", String(Math.round(r.top)));
                    sCookieFn("user-list-panel_w", String(Math.round(r.width)));
                    sCookieFn("user-list-panel_h", String(Math.round(r.height)));
                    ulPanel.style.display = "none";
                    sCookieFn("showUserList", "0");
                    const mb = document.getElementById("menu-userlist");
                    if (mb) mb.textContent = "　 " + t("menu.userlist");
                });
            }
        }
    }

    // ===== サーバ設定パネル ドラッグ & 最小化 & クッキー復元 =====
    {
        const srvPanel  = document.getElementById("server-settings-panel") as HTMLElement;
        const srvHeader = document.getElementById("server-settings-header") as HTMLElement;
        const srvClose  = document.getElementById("server-settings-close") as HTMLElement;

        // サーバURL表示（同一オリジン: location.host）
        const srvDesc = srvPanel?.querySelector(".srv-desc") as HTMLElement | null;
        const updateSrvDesc = () => { if (srvDesc) srvDesc.textContent = t("server.info") + ": " + location.host; };
        updateSrvDesc();
        onLangChangeCallbacks.push(updateSrvDesc);

        if (srvPanel && srvHeader) {
            const sCk = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            const gCk = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };

            // Server Key 表示
            const srvKeyDisplay = document.getElementById("serverKeyDisplay") as HTMLElement | null;
            const activeServerKey = import.meta.env.VITE_SERVER_KEY || "defaultkey";
            if (srvKeyDisplay) srvKeyDisplay.textContent = activeServerKey;

            if (!isMobileDev) {
                const initRect = srvPanel.getBoundingClientRect();
                srvPanel.style.left  = initRect.left + "px";
                srvPanel.style.right = "auto";
            }
            if (!isMobileDev) {
                const savedL = gCk("srvLeft");
                const savedT = gCk("srvTop");
                if (savedL !== null) { srvPanel.style.left = savedL + "px"; srvPanel.style.right = "auto"; }
                if (savedT !== null)   srvPanel.style.top  = savedT + "px";
                if (!isMobileDev) game.clampToViewport(srvPanel);
            }

            let isDrag = false, offX = 0, offY = 0;
            srvHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "server-settings-close") return;
                if (isMobileDev) return;
                isDrag = true;
                offX = e.clientX - srvPanel.getBoundingClientRect().left;
                offY = e.clientY - srvPanel.getBoundingClientRect().top;
                srvHeader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!isDrag) return;
                srvPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                srvPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
            });
            document.addEventListener("pointerup", () => {
                if (!isDrag) return;
                isDrag = false;
                const r = srvPanel.getBoundingClientRect();
                sCk("srvLeft", String(Math.round(r.left)));
                sCk("srvTop",  String(Math.round(r.top)));
            });

            if (srvClose) {
                srvClose.addEventListener("click", () => {
                    srvPanel.style.display = "none";
                    sCk("showSrvSettings", "0");
                    const mb = document.getElementById("menu-serversettings");
                    if (mb) mb.textContent = "　 " + t("menu.serversettings");
                });
            }

            // ping / nakamaサーバ ボタン
            const pingResult = document.getElementById("srvPingResult");
            const srvPingBtn = document.getElementById("srvPingBtn");
            const srvNakamaPingBtn = document.getElementById("srvNakamaPingBtn");

            const pingLog = (msg: string) => {
                if (!pingResult) return;
                const now = new Date();
                const ts = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                const line = `${ts} ${msg}`;
                pingResult.textContent = pingResult.textContent ? pingResult.textContent + "\n" + line : line;
                pingResult.scrollTop = pingResult.scrollHeight;
            };

            if (srvPingBtn) {
                srvPingBtn.addEventListener("click", async () => {
                    const url = `${location.origin}/`;
                    pingLog(`${t("log.http_testing")} (${location.host})`);
                    const t0 = performance.now();
                    try {
                        await fetch(url, { method: "HEAD", cache: "no-store" });
                        const ms = Math.round(performance.now() - t0);
                        pingLog(`${t("log.http_success").replace("{ms}", String(ms))} (${location.host})`);
                    } catch (e) {
                        const ms = Math.round(performance.now() - t0);
                        pingLog(`HTTP: FAILED ${ms}ms (${location.host}) ${e instanceof Error ? e.message : String(e)}`);
                    }
                });
            }

            if (srvNakamaPingBtn) {
                srvNakamaPingBtn.addEventListener("click", async () => {
                    if (!game.nakama.selfSessionId) {
                        pingLog(`RPC: not logged in (${location.host})`);
                        return;
                    }
                    pingLog(`${t("log.rpc_testing")} (${location.host})`);
                    const ms = await game.nakama.measurePing();
                    if (ms !== null) {
                        pingLog(`${t("log.rpc_success").replace("{ms}", String(ms))} (${location.host})`);
                    } else {
                        pingLog(`RPC: FAILED (${location.host})`);
                    }
                });
            }

            // ─── アカウント情報セクション（doc/53 §8 最小実装） ───
            const savedEl  = document.getElementById("account-info-saved");
            const googleEl = document.getElementById("account-info-google");
            const deviceEl = document.getElementById("account-info-device");
            const googleRow = document.getElementById("account-info-google-row");
            const unlinkRow = document.getElementById("account-info-unlink-row");
            const detachRow = document.getElementById("account-info-detach-row");
            const deviceRow = document.getElementById("account-info-device-row");
            const linkRow  = document.getElementById("account-info-link-row");
            const linkBtn  = document.getElementById("googleLinkBtn") as HTMLButtonElement | null;
            const unlinkBtn = document.getElementById("googleUnlinkBtn") as HTMLButtonElement | null;
            const detachBtn = document.getElementById("deviceDetachBtn") as HTMLButtonElement | null;
            const refreshBtn = document.getElementById("accountRefreshBtn") as HTMLButtonElement | null;
            const linkResultEl = document.getElementById("googleLinkResult");

            const renderAccountStatus = async () => {
                if (!savedEl || !googleEl || !deviceEl) return;
                if (!game.nakama.selfSessionId) {
                    savedEl.textContent  = "未ログイン";
                    googleEl.textContent = "―";
                    deviceEl.textContent = "―";
                    return;
                }
                try {
                    const st = await game.nakama.getAccountStatus();
                    game.nakama.selfHasGoogle = st.hasGoogle;
                    game.nakama.selfIsAdmin = st.isAdmin;
                    // 自分のアバター名タグを再描画（アイコン付加）
                    {
                        const selfSid = game.nakama.selfSessionId;
                        const selfUname = (document.getElementById("loginName") as HTMLInputElement | null)?.value ?? "";
                        const lbl = resolveDisplayLabel(game.nakama.selfDisplayName, selfUname, selfSid ?? undefined);
                        game.updatePlayerNameTag(lbl.text, lbl.color, lbl.suffix);
                        if (selfSid) {
                            const me = userMap.get(selfSid);
                            if (me) { userMap.set(selfSid, { ...me, hasGoogle: st.hasGoogle, isAdmin: st.isAdmin }); scheduleRenderUserList(); }
                        }
                    }
                    // 状態行: 認証方式を表示
                    if (st.hasGoogle && st.isAdmin) {
                        savedEl.innerHTML = '✅Googleアカウント認証（<span style="color:#c00;font-weight:bold;">管理者</span>）';
                    } else {
                        savedEl.textContent = st.hasGoogle
                            ? "✅Googleアカウント認証"
                            : st.hasDevice ? "✅デバイス認証" : "⚠️ 仮アカウント（未保存）";
                    }
                    // Google認証済み: Googleアカウント行・解除行・デバイス行を表示、認証ボタン行を非表示
                    // 未リンク: 認証ボタン行のみ表示
                    const linked = st.hasGoogle;
                    if (googleRow) googleRow.style.display = linked ? "flex" : "none";
                    if (linked) {
                        googleEl.textContent = st.email ? `✅ ${st.email}` : "✅ リンク済み";
                    }
                    if (unlinkRow) unlinkRow.style.display = linked && st.hasDevice ? "" : "none";
                    if (detachRow) detachRow.style.display = linked && st.hasDevice ? "" : "none";
                    if (deviceRow) deviceRow.style.display = linked ? "" : "none";
                    if (linkRow) linkRow.style.display = linked ? "none" : "";
                    if (deviceEl && st.hasGoogle) {
                        const myDeviceId = game.nakama.getCurrentDeviceId();
                        const devs = st.devices;
                        const plat = st.devicePlatforms;
                        // デバイス一覧のサブリストをクリア（再描画時にゴミが残らないように）
                        const parent = deviceEl.parentElement;
                        const oldList = parent?.querySelector(".device-list");
                        if (oldList) oldList.remove();

                        if (devs.length === 0) {
                            deviceEl.textContent = st.hasDevice ? "1台" : "なし";
                        } else {
                            const platformIcon = (p: string) => {
                                switch (p) {
                                    case "Windows": return "🖥️";
                                    case "Mac":     return "💻";
                                    case "iPhone":  return "📱";
                                    case "iPad":    return "📱";
                                    case "Android": return "📱";
                                    default:        return "📱";
                                }
                            };
                            const short = (id: string) => id.length > 8 ? id.slice(0, 4) + "…" + id.slice(-4) : id;
                            const lines = devs.map(id => {
                                const p = plat[id] ?? "";
                                const icon = platformIcon(p);
                                const label = p ? `${icon} ${p}` : `📱 ${short(id)}`;
                                return id === myDeviceId ? `${label} ← このブラウザ` : label;
                            });
                            deviceEl.textContent = `${devs.length}台`;
                            if (parent) {
                                const listEl = document.createElement("div");
                                listEl.className = "device-list";
                                listEl.style.cssText = "color:#666;margin-top:2px;padding-left:12px;line-height:1.5;";
                                for (const line of lines) {
                                    const d = document.createElement("div");
                                    d.textContent = line;
                                    listEl.appendChild(d);
                                }
                                parent.appendChild(listEl);
                            }
                        }
                    }
                    // 表示名パネルのユーザID表示を更新（Google 認証済みなら email、未なら user_xxxxxx）
                    {
                        const dnUid = document.getElementById("dn-panel-userid");
                        if (dnUid) {
                            if (linked && st.email) {
                                dnUid.textContent = st.email;
                            } else {
                                const li = document.getElementById("loginName") as HTMLInputElement | null;
                                dnUid.textContent = li?.value ?? "-";
                            }
                        }
                    }
                    // サーバ側 Google OAuth 未設定 → ボタン無効化 + エラーコード表示
                    const oauthErr = game.nakama.googleOAuthErr;
                    if (linkBtn && oauthErr && oauthErr > 0) {
                        linkBtn.disabled = true;
                        linkBtn.style.opacity = "0.4";
                        linkBtn.style.cursor = "not-allowed";
                        if (linkResultEl) {
                            linkResultEl.textContent = `サーバ：設定エラー:${String(oauthErr).padStart(3, "0")}`;
                            linkResultEl.style.color = "#c00";
                        }
                    } else if (linkResultEl && !linked && oauthErr === 0) {
                        linkResultEl.textContent = "";
                    }
                } catch (e) {
                    console.warn("getAccountStatus failed:", e);
                    savedEl.textContent = "取得失敗";
                }
            };

            // 初回 & ログイン後に取得
            refreshAccountStatus = () => void renderAccountStatus();
            void renderAccountStatus();
            game.nakama.onMatchReconnect = ((prev) => () => { prev?.(); void renderAccountStatus(); })(game.nakama.onMatchReconnect);

            if (refreshBtn) {
                refreshBtn.addEventListener("click", async () => {
                    refreshBtn.disabled = true;
                    refreshBtn.style.opacity = "0.5";
                    refreshBtn.textContent = "⏳";
                    try {
                        await renderAccountStatus();
                    } finally {
                        refreshBtn.textContent = "↻";
                        refreshBtn.disabled = false;
                        refreshBtn.style.opacity = "";
                    }
                });
            }
            // メニューからサーバ設定パネルを開いたときにも最新化
            const srvMenuBtn = document.getElementById("menu-serversettings");
            if (srvMenuBtn) {
                srvMenuBtn.addEventListener("click", () => { void renderAccountStatus(); });
            }

            // window.tommieGoogleOAuth は public/js/google-oauth.js が defer で読み込む
            type OAuthApi = {
                getClientId: () => string | null;
                setClientId: (id: string) => void;
                startLink: (opts?: { captureState?: () => unknown }) => { popup: Window | null; promise: Promise<string> };
                resumeFromRedirect: () => { code: string; resumeState: unknown | null } | null;
            };
            const getOAuthApi = (): OAuthApi | null => {
                return (window as unknown as { tommieGoogleOAuth?: OAuthApi }).tommieGoogleOAuth ?? null;
            };

            const setLinkResult = (msg: string, isErr = false) => {
                if (!linkResultEl) return;
                linkResultEl.textContent = msg;
                linkResultEl.style.color = isErr ? "#c00" : "#666";
            };

            // 認可コードをサーバへ送って LinkGoogle 完了させる
            const completeLinkWithCode = async (code: string) => {
                setLinkResult("認可完了 → サーバ側でリンク処理中...");
                try {
                    const redirectUri = location.origin + "/oauth-callback.html";
                    const result = await game.nakama.linkGoogleByCode(code, redirectUri);
                    if (result.alreadyLinked && result.token) {
                        // 別ユーザーが既にこの Google アカウントをリンク済み
                        // → サーバ発行トークンでそのアカウントに切り替え
                        setLinkResult("既存アカウントに切り替え中...");
                        await game.nakama.switchToGoogleAccount(result.token);
                        // Google プロフィール名で表示名を更新（サーバ側で AccountUpdateId 済み）
                        if (result.displayName) {
                            game.nakama.selfDisplayName = result.displayName;
                            game.nakama.sendDisplayName(result.displayName).catch(e => console.warn("sendDisplayName:", e));
                            const dnInput = document.getElementById("displayNameInput") as HTMLInputElement | null;
                            if (dnInput) dnInput.value = result.displayName;
                        }
                        // loginName Cookie とログイン入力を切り替え先のユーザー名に更新
                        // （リロード後も同じアカウントに戻れるようにする）
                        const newUsername = game.nakama.getSession()?.username ?? "";
                        if (newUsername) {
                            setCookie("loginName", newUsername);
                            if (loginNameInput) loginNameInput.value = newUsername;
                            game.updatePlayerNameTag(newUsername);
                        }
                        setLinkResult("✅ Google 認証済みアカウントに切り替えました");
                        await renderAccountStatus();
                        return;
                    }
                    setLinkResult("✅ Google アカウントを紐付けました");
                    await renderAccountStatus();
                } catch (e) {
                    console.warn("linkGoogleByCode failed:", e);
                    const msg = e instanceof Error ? e.message
                        : (e && typeof e === "object" && "message" in e) ? String((e as { message: unknown }).message)
                        : JSON.stringify(e);
                    setLinkResult("リンク失敗: " + msg, true);
                }
            };

            if (linkBtn) {
                linkBtn.addEventListener("click", () => {
                    // ─── 重要 ───
                    // iOS Safari のポップアップブロッカーは「ユーザー操作直後の同期 window.open」しか許可しない。
                    // ここでは絶対に await を挟まず、startLink() を同期呼び出しすること。
                    if (!game.nakama.selfSessionId) {
                        setLinkResult("先にログインしてください", true);
                        return;
                    }
                    const api = getOAuthApi();
                    if (!api) { setLinkResult("OAuth スクリプト未読み込み", true); return; }
                    if (!api.getClientId()) {
                        setLinkResult("Google Client ID 未設定（index.html の <meta> または server の GOOGLE_CLIENT_ID）", true);
                        return;
                    }

                    setLinkResult("Google 認証画面を開いています...");

                    // リダイレクト方式フォールバックに渡す現在地スナップショット
                    const captureState = () => ({
                        worldId: game.currentWorldId,
                        x: game.playerBox.position.x,
                        z: game.playerBox.position.z,
                        ry: game.playerBox.rotation.y,
                    });

                    const { popup, promise } = api.startLink({ captureState });
                    if (!popup) {
                        // フォールバックが発火した（リダイレクト遷移中） → ここから先は実行されない
                        return;
                    }
                    promise.then(
                        (code) => { void completeLinkWithCode(code); },
                        (err) => {
                            console.warn("google-oauth promise rejected:", err);
                            setLinkResult("認証中断: " + (err instanceof Error ? err.message : String(err)), true);
                        }
                    );
                });
            }

            // ─── Google 紐付け解除ボタン ───
            if (unlinkBtn) {
                unlinkBtn.addEventListener("click", async () => {
                    if (!confirm("このアカウントから Google 連携を解除しますか？\n\n※ すべてのデバイスで Google 認証が無効になります\n※ デバイス認証は残るためログインは引き続き可能です")) return;
                    setLinkResult("紐付け解除中...");
                    try {
                        await game.nakama.unlinkGoogle();
                        setLinkResult("✅ Google 連携を解除しました");
                        await renderAccountStatus();
                    } catch (e) {
                        console.warn("unlinkGoogle failed:", e);
                        const msg = e instanceof Error ? e.message
                            : (e && typeof e === "object" && "message" in e) ? String((e as { message: unknown }).message)
                            : JSON.stringify(e);
                        setLinkResult("解除失敗: " + msg, true);
                        // 別デバイスで解除済みの場合があるので最新状態に更新
                        await renderAccountStatus();
                    }
                });
            }

            // ─── このデバイスを切り離すボタン ───
            if (detachBtn) {
                detachBtn.addEventListener("click", async () => {
                    if (!confirm(
                        "このデバイスのアカウント情報をリセットします。\n" +
                        "次回起動時に新しい匿名アカウントとして開始します。\n" +
                        "（他のデバイスには影響しません）\n\nよろしいですか？"
                    )) return;
                    try {
                        // サーバ側でこのデバイスIDをアカウントからアンリンク
                        await game.nakama.detachDevice();
                    } catch (e) {
                        console.warn("detachDevice failed:", e);
                        // サーバ側の切り離しに失敗してもクライアント側はリセットする
                    }
                    // loginName クッキーのみ削除（他の UI 設定は残す）
                    document.cookie = "loginName=; max-age=0; path=/";
                    location.reload();
                });
            }

            // ─── リダイレクト方式フォールバックからの復帰 ───
            // ページ初期化時に sessionStorage に code が残っていれば、復元して継続。
            // ログインが完了するまで待ってから RPC を発行する。
            const tryResume = async () => {
                const api = getOAuthApi();
                if (!api) return;
                const r = api.resumeFromRedirect();
                if (!r) return;
                console.log("oauth resume detected:", r);
                // ログイン完了を待つ
                for (let i = 0; i < 100; i++) {
                    if (game.nakama.selfSessionId) break;
                    await new Promise((res) => setTimeout(res, 100));
                }
                if (!game.nakama.selfSessionId) {
                    setLinkResult("ログイン完了待ちタイムアウト", true);
                    return;
                }
                // 元の部屋・位置に復元
                const rs = r.resumeState as { worldId?: number; x?: number; z?: number; ry?: number } | null;
                if (rs && typeof rs.worldId === "number") {
                    try {
                        game.moveBookmark("oauth_resume", { x: rs.x ?? 0, z: rs.z ?? 0 }, rs.worldId);
                        if (typeof rs.ry === "number") game.playerBox.rotation.y = rs.ry;
                    } catch (e) {
                        console.warn("oauth resume moveBookmark failed:", e);
                    }
                }
                await completeLinkWithCode(r.code);
            };
            void tryResume();
        }
    }
    // ===== チャット設定パネル ドラッグ & 閉じる =====
    {
        const csPanel  = document.getElementById("chat-settings-panel") as HTMLElement;
        const csHeader = document.getElementById("chat-settings-header") as HTMLElement;
        const csClose  = document.getElementById("chat-settings-close") as HTMLElement;

        if (csPanel && csHeader) {
            if (!isMobileDev) {
                let isDrag = false, offX = 0, offY = 0;
                csHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                    if ((e.target as HTMLElement).id === "chat-settings-close") return;
                    isDrag = true;
                    offX = e.clientX - csPanel.getBoundingClientRect().left;
                    offY = e.clientY - csPanel.getBoundingClientRect().top;
                    csHeader.setPointerCapture(e.pointerId);
                    e.preventDefault();
                });
                document.addEventListener("pointermove", (e: PointerEvent) => {
                    if (!isDrag) return;
                    csPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                    csPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
                    csPanel.style.right = "auto";
                });
                document.addEventListener("pointerup", () => {
                    if (!isDrag) return;
                    isDrag = false;
                });
            }

            if (csClose) {
                csClose.addEventListener("click", () => {
                    csPanel.style.display = "none";
                    const sCk = (k: string, v: string) =>
                        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
                    sCk("showChatSettings", "0");
                    const mb = document.getElementById("menu-chatsettings");
                    if (mb) mb.textContent = "　 " + t("menu.chatsettings");
                });
            }
        }
    }
    // ===== サーバ接続ログパネル ドラッグ & 最小化 =====
    {
        const slPanel  = document.getElementById("server-log-panel") as HTMLElement;
        const slHeader = document.getElementById("server-log-header") as HTMLElement;
        const slClose  = document.getElementById("server-log-close")  as HTMLElement;

        if (slPanel && slHeader) {
            const sCk = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            const gCk = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };

            if (!isMobileDev) {
                const initRect = slPanel.getBoundingClientRect();
                slPanel.style.left  = initRect.left + "px";
                slPanel.style.right = "auto";
            }
            if (!isMobileDev) {
                const savedL = gCk("slLeft");
                const savedT = gCk("slTop");
                const savedW = gCk("slWidth");
                const savedH = gCk("slHeight");
                if (savedL !== null) { slPanel.style.left = savedL + "px"; slPanel.style.right = "auto"; }
                if (savedT !== null)   slPanel.style.top   = savedT + "px";
                if (savedW !== null) slPanel.style.width  = savedW + "px";
                if (savedH !== null) slPanel.style.height = savedH + "px";
                if (!isMobileDev) game.clampToViewport(slPanel);
            }

            let isDrag = false, offX = 0, offY = 0;
            slHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "server-log-close") return;
                if (isMobileDev) return;
                isDrag = true;
                offX = e.clientX - slPanel.getBoundingClientRect().left;
                offY = e.clientY - slPanel.getBoundingClientRect().top;
                slHeader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!isDrag) return;
                slPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                slPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
            });
            document.addEventListener("pointerup", () => {
                if (!isDrag) return;
                isDrag = false;
                const r = slPanel.getBoundingClientRect();
                sCk("slLeft", String(Math.round(r.left)));
                sCk("slTop",  String(Math.round(r.top)));
            });
            const slResizeObserver = new ResizeObserver(() => {
                if (slPanel.classList.contains("minimized")) return;
                const r = slPanel.getBoundingClientRect();
                sCk("slWidth",  String(Math.round(r.width)));
                sCk("slHeight", String(Math.round(r.height)));
            });
            slResizeObserver.observe(slPanel);

            if (slClose) {
                slClose.addEventListener("click", () => {
                    slPanel.style.display = "none";
                    sCk("showSrvLog", "0");
                    const mb = document.getElementById("menu-serverlog");
                    if (mb) mb.textContent = "　 " + t("menu.serverlog");
                });
            }

            // 表示/最小化解除時に末尾へスクロール
            const slList = document.getElementById("server-log-list");
            if (slList) {
                let wasInactive = slPanel.style.display === "none" || slPanel.classList.contains("minimized");
                new MutationObserver(() => {
                    const nowInactive = slPanel.style.display === "none" || slPanel.classList.contains("minimized");
                    if (wasInactive && !nowInactive) {
                        requestAnimationFrame(() => { slList.scrollTop = slList.scrollHeight; });
                    }
                    wasInactive = nowInactive;
                }).observe(slPanel, { attributes: true, attributeFilter: ["style", "class"] });
            }
        }
    }
    // ===============================================

    // モバイル ポートレート / ランドスケープ / デスクトップ で別々にオーバレイ設定を保存
    const getOverlayMode = (): "ls" | "pt" | "dt" => {
        if (!matchMedia("(pointer: coarse) and (min-resolution: 2dppx)").matches) return "dt";
        return matchMedia("(orientation: landscape)").matches ? "ls" : "pt";
    };
    const ckKey = (base: string): string => {
        const m = getOverlayMode();
        return m === "dt" ? base : base + (m === "ls" ? "Ls" : "Pt");
    };
    // 起動時に chatOlMax クッキーを読んで初期値を決定（DebugOverlay 初期化より前に適用するため）
    const readChatOlMaxCookie = (): number => {
        const key = ckKey("chatOlMax");
        const re = new RegExp("(?:^|; )" + key + "=([^;]*)");
        const m = document.cookie.match(re);
        if (!m) return 5;
        const v = parseInt(decodeURIComponent(m[1]), 10);
        if (!Number.isFinite(v) || v < 0 || v > 20) return 5;
        return v;
    };
    let chatOverlayMax = readChatOlMaxCookie();
    const chatOverlay = document.getElementById("chat-overlay");
    // GameScene 経由で外部からアクセスできるようにする
    (game as any).chatOverlayMax = chatOverlayMax;
    /** テキスト1行の高さ（px） */
    // チャットオーバーレイのテキスト行高さ・パディングのキャッシュ
    let olTextLineHCache = 0;
    let olPaddingCache = -1; // paddingTop (CSSクラスで固定)
    const getOlTextLineH = (): number => {
        if (olTextLineHCache > 0) return olTextLineHCache;
        if (!chatOverlay) return 19.5;
        const fs = parseFloat(getComputedStyle(chatOverlay).fontSize) || 13;
        olTextLineHCache = fs * 1.5; // line-height: 1.5
        return olTextLineHCache;
    };
    const getOlPadding = (el: HTMLElement): number => {
        if (olPaddingCache >= 0) return olPaddingCache;
        const cs = getComputedStyle(el);
        olPaddingCache = parseFloat(cs.paddingTop || "0");
        return olPaddingCache;
    };
    /** 全メッセージをDOMに保持し、テキスト行数の合計がchatOverlayMaxに収まる分だけ表示
     *  枠を超えるメッセージは下の行だけ部分表示する
     *  レイアウトスラッシング回避: リセット(書込) → 行数計算(読取) → 表示制御(書込) の3フェーズ */
    const trimOlVisibility = () => {
        if (!chatOverlay) return;
        if (chatOverlayMax === 0) { chatOverlay.style.display = "none"; return; }
        chatOverlay.style.display = "";
        // ハンドル類は除外。.chat-ol-line のみ対象
        const children = Array.from(chatOverlay.querySelectorAll<HTMLElement>(".chat-ol-line"));
        // Phase 1: 全スタイルをリセット（バッチ書込）
        for (const el of children) {
            el.style.display = "";
            el.style.maxHeight = "";
            el.style.overflow = "";
            el.style.marginTop = "";
        }
        // Phase 2: 全要素の行数を一括計算（バッチ読取 — reflow 1回のみ）
        const lineH = getOlTextLineH();
        const linesCounts = new Array<number>(children.length);
        for (let i = 0; i < children.length; i++) {
            const el = children[i];
            const pt = getOlPadding(el);
            const contentH = el.offsetHeight - pt * 2;
            linesCounts[i] = Math.max(1, Math.ceil(contentH / lineH - 0.1));
        }
        // Phase 3: 末尾から積み上げて表示制御（バッチ書込）
        let totalLines = 0;
        for (let i = children.length - 1; i >= 0; i--) {
            const lines = linesCounts[i];
            if (totalLines + lines <= chatOverlayMax) {
                totalLines += lines;
            } else {
                const remainLines = chatOverlayMax - totalLines;
                if (remainLines > 0) {
                    const hideLines = lines - remainLines;
                    if (hideLines > 0) {
                        const pt = getOlPadding(children[i]);
                        children[i].style.marginTop = "-" + (hideLines * lineH + pt) + "px";
                        children[i].style.overflow = "hidden";
                    }
                } else {
                    children[i].style.display = "none";
                }
                for (let j = i - 1; j >= 0; j--) children[j].style.display = "none";
                break;
            }
        }
    };
    /** 最大行数分の縦スペースを確保（メッセージが少なくてもリサイズが視覚的に分かるように） */
    const applyOverlayMinHeight = () => {
        if (!chatOverlay) return;
        if (chatOverlayMax === 0) { chatOverlay.style.removeProperty("min-height"); return; }
        const lineH = getOlTextLineH();
        const h = Math.round(chatOverlayMax * lineH + 8); // 8px: padding 余裕
        chatOverlay.style.setProperty("min-height", h + "px", "important");
    };
    (game as any).setChatOverlayMax = (n: number) => {
        chatOverlayMax = n;
        (game as any).chatOverlayMax = n;
        olTextLineHCache = 0; // フォントサイズ変更に追随
        if (chatOverlay) chatOverlay.style.setProperty("--ol-line-h", getOlTextLineH() + "px");
        trimOlVisibility();
        applyOverlayMinHeight();
    };

    trimOlVisibility();
    if (chatOverlay) chatOverlay.style.setProperty("--ol-line-h", getOlTextLineH() + "px");
    applyOverlayMinHeight();

    // ===== オーバーレイチャット行タップ → コピーアイコン表示 =====
    if (chatOverlay) {
        chatOverlay.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            // コピーボタン自身のクリック
            const btn = target.closest(".chat-ol-copy-btn") as HTMLElement | null;
            if (btn) {
                e.stopPropagation();
                const line = btn.closest(".chat-ol-line") as HTMLElement | null;
                if (!line) return;
                const clone = line.cloneNode(true) as HTMLElement;
                clone.querySelectorAll(".chat-ol-copy-btn").forEach(b => b.remove());
                const text = (clone.textContent || "").replace(/\s+/g, " ").trim();
                const done = () => {
                    btn.textContent = "\u2705";
                    window.setTimeout(() => {
                        if (btn.parentElement) btn.remove();
                        line.classList.remove("copy-active");
                    }, 700);
                };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(done).catch(err => {
                        console.warn("chat overlay copy failed:", err);
                    });
                } else {
                    try {
                        const ta = document.createElement("textarea");
                        ta.value = text;
                        ta.style.position = "fixed";
                        ta.style.opacity = "0";
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand("copy");
                        ta.remove();
                        done();
                    } catch (err) {
                        console.warn("chat overlay copy fallback failed:", err);
                    }
                }
                return;
            }
            // 行タップ: コピーボタンをトグル
            const line = target.closest(".chat-ol-line") as HTMLElement | null;
            if (!line || !chatOverlay.contains(line)) return;
            const hadActive = line.classList.contains("copy-active");
            // 他のアクティブ行をクリア
            chatOverlay.querySelectorAll(".chat-ol-line.copy-active").forEach(l => {
                l.classList.remove("copy-active");
                l.querySelectorAll(".chat-ol-copy-btn").forEach(b => b.remove());
            });
            if (hadActive) return;
            line.classList.add("copy-active");
            const b = document.createElement("span");
            b.className = "chat-ol-copy-btn";
            b.textContent = "\u{1F4CB}";
            b.title = "コピー";
            b.setAttribute("role", "button");
            line.appendChild(b);
        });
    }

    // ===== チャットオーバーレイ: タップでリサイズ記号トグル + 四隅ドラッグで幅・行数変更 =====
    {
        const tapZone = document.getElementById("chat-overlay-resize");
        const hTR = document.getElementById("chat-overlay-resize-tr");
        const hBR = document.getElementById("chat-overlay-resize-br");
        if (chatOverlay && tapZone && hTR && hBR) {
            const OL_MAX_LIMIT = 20;
            const OL_WIDTH_MIN = 120;
            const TAP_THRESHOLD = 10;
            const setCk = (k: string, v: string) => {
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            };
            const getCk = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };
            const syncSelect = (v: number) => {
                const sel = document.getElementById("chatOlMaxSelect") as HTMLSelectElement | null;
                if (!sel) return;
                const opts = Array.from(sel.options).map(o => parseInt(o.value));
                if (opts.includes(v)) {
                    sel.value = String(v);
                } else {
                    const tmp = sel.querySelector('option[data-temp="1"]') as HTMLOptionElement | null;
                    if (tmp) { tmp.value = String(v); tmp.textContent = v + "行"; sel.value = String(v); }
                    else {
                        const o = document.createElement("option");
                        o.value = String(v); o.textContent = v + "行"; o.dataset.temp = "1";
                        sel.appendChild(o); sel.value = String(v);
                    }
                }
            };
            const getMaxWidth = (): number => {
                const cvs = document.getElementById("renderCanvas");
                const w = cvs ? cvs.getBoundingClientRect().width : window.innerWidth;
                return Math.max(OL_WIDTH_MIN, w - 16);
            };

            // 位置/サイズを canvas 領域内にクランプ
            const clampToCanvas = (left: number, top: number): { left: number; top: number } => {
                const cvs = document.getElementById("renderCanvas");
                const cr = cvs ? cvs.getBoundingClientRect() : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } as DOMRect;
                const w = chatOverlay.offsetWidth;
                const h = chatOverlay.offsetHeight;
                const L = Math.max(cr.left + 4, Math.min(cr.right - w - 4, left));
                const T = Math.max(cr.top + 4, Math.min(cr.bottom - h - 4, top));
                return { left: L, top: T };
            };
            // 位置を left + bottom で設定（リサイズで高さが上方向に伸びるように bottom 固定）
            const setOverlayPos = (left: number, top: number) => {
                const h = chatOverlay.offsetHeight;
                const bottom = Math.max(0, window.innerHeight - top - h);
                setOverlayPosByBottom(left, bottom);
            };
            // bottom アンカーで直接設定（高さ変化で位置がずれないため復元時はこちらを使う）
            const setOverlayPosByBottom = (left: number, bottom: number) => {
                chatOverlay.style.setProperty("left", left + "px", "important");
                chatOverlay.style.setProperty("bottom", bottom + "px", "important");
                chatOverlay.style.setProperty("top", "auto", "important");
                chatOverlay.style.setProperty("right", "auto", "important");
            };
            // ===== アンカー基準の垂直位置 =====
            // 位置はアンカー上端からの「ギャップ」で保存し、アンカーが動けば overlay も相対移動。
            // アンカー: 常に #chat-container（セリフ入力コントロール）上端を基準とする。
            // パネル位置は参照しない（パネルを動かしてもオーバーレイは追従しない）。
            const isElVisible = (el: HTMLElement): boolean => {
                if (el.style.display === "none") return false;
                const cs = getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden") return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };
            const isMobileLandscape = () =>
                matchMedia("(pointer: coarse) and (min-resolution: 2dppx) and (orientation: landscape)").matches;
            const getAnchorTopY = (): number => {
                // モバイルランドスケープ: 部屋名 (#coord-display) 上端をアンカー
                if (isMobileLandscape()) {
                    const cd = document.getElementById("coord-display");
                    if (cd && isElVisible(cd)) return cd.getBoundingClientRect().top;
                }
                // モバイルポートレート + パネル表示中: パネル上端（デバイダー位置）をアンカー
                if (document.body.classList.contains("sp-panel-visible")) {
                    const div = document.getElementById("portrait-divider");
                    if (div && isElVisible(div)) return div.getBoundingClientRect().top;
                }
                const chat = document.getElementById("chat-container");
                if (chat) return chat.getBoundingClientRect().top;
                return window.innerHeight - 60;
            };
            // モバイルランドスケープ: 幅をデバイダーに合わせて Canvas 領域内に収める
            const applyLandscapeWidth = () => {
                if (!isMobileLandscape()) return;
                const cvs = document.getElementById("renderCanvas");
                if (!cvs) return;
                const cr = cvs.getBoundingClientRect();
                const w = Math.max(80, Math.round(cr.width - 24));
                chatOverlay.style.setProperty("width", w + "px", "important");
                chatOverlay.style.setProperty("max-width", "none", "important");
                // 左端も Canvas 左端に揃える（ドラッグで横にずれていても戻す）
                chatOverlay.style.setProperty("left", Math.round(cr.left + 8) + "px", "important");
                chatOverlay.style.setProperty("right", "auto", "important");
            };
            // ギャップ値を取得（pointerY - overlayBottomY、正値=overlay がアンカーより上）
            const getSavedGap = (): number => {
                const g = getCk(ckKey("chatOlGap"));
                if (g !== null) {
                    const v = parseInt(g);
                    if (!isNaN(v)) return v;
                }
                // 旧形式: chatOlBottom から現在のアンカーでギャップを逆算して初回適用
                const b = getCk(ckKey("chatOlBottom"));
                if (b !== null) {
                    const bv = parseInt(b);
                    if (!isNaN(bv)) {
                        const overlayBottomY = window.innerHeight - bv;
                        return Math.round(getAnchorTopY() - overlayBottomY);
                    }
                }
                return 4; // デフォルト: アンカー直上 4px
            };
            // 位置/サイズを Canvas（アバター領域）内にクランプ
            // 戻り値: 適用された矩形（実際の left/width/bottom）
            const clampOverlayToCanvas = () => {
                const cvs = document.getElementById("renderCanvas");
                if (!cvs) return;
                const cr = cvs.getBoundingClientRect();
                const w = chatOverlay.offsetWidth;
                const h = chatOverlay.offsetHeight;
                // 幅: Canvas 幅を超えない
                const maxW = Math.max(OL_WIDTH_MIN, Math.round(cr.width - 16));
                if (w > maxW) {
                    chatOverlay.style.setProperty("width", maxW + "px", "important");
                    chatOverlay.style.setProperty("max-width", "none", "important");
                }
                const newW = Math.min(w, maxW);
                // 左端: Canvas 左端〜右端-幅 にクランプ
                const r = chatOverlay.getBoundingClientRect();
                const L = Math.max(cr.left + 4, Math.min(cr.right - newW - 4, r.left));
                if (Math.abs(L - r.left) > 0.5) {
                    chatOverlay.style.setProperty("left", Math.round(L) + "px", "important");
                    chatOverlay.style.setProperty("right", "auto", "important");
                }
                // 下端: Canvas 下端より下に出ない / 上端 + 高さ + 4 を下回らない
                const overlayBottomY = window.innerHeight - parseFloat(chatOverlay.style.bottom || "0");
                const minBottomY = cr.top + h + 4;
                const maxBottomY = cr.bottom - 4;
                const clampedBottomY = Math.max(minBottomY, Math.min(maxBottomY, overlayBottomY));
                if (Math.abs(clampedBottomY - overlayBottomY) > 0.5) {
                    chatOverlay.style.setProperty("bottom", Math.round(window.innerHeight - clampedBottomY) + "px", "important");
                    chatOverlay.style.setProperty("top", "auto", "important");
                }
            };
            // ギャップからインライン bottom を算出し適用
            const applyOverlayFromGap = (gap: number) => {
                const anchorTop = getAnchorTopY();
                const overlayBottomY = anchorTop - gap;
                const bottom = Math.max(0, window.innerHeight - overlayBottomY);
                chatOverlay.style.setProperty("bottom", Math.round(bottom) + "px", "important");
                chatOverlay.style.setProperty("top", "auto", "important");
            };
            const saveGapFromCurrent = () => {
                const r = chatOverlay.getBoundingClientRect();
                const overlayBottomY = r.bottom;
                const gap = Math.round(getAnchorTopY() - overlayBottomY);
                setCk(ckKey("chatOlGap"), String(gap));
            };
            const reapplyOverlayVertical = () => {
                applyLandscapeWidth();
                applyOverlayFromGap(getSavedGap());
                clampOverlayToCanvas();
            };
            // モード（ポートレート/ランドスケープ/デスクトップ）切替時に幅・行数・位置を再読込
            let lastOverlayMode = getOverlayMode();
            const reloadForMode = () => {
                const m = getOverlayMode();
                if (m === lastOverlayMode) return;
                lastOverlayMode = m;
                // 行数
                const sm = getCk(ckKey("chatOlMax"));
                if (sm !== null) {
                    const v = parseInt(sm);
                    if (Number.isFinite(v) && v >= 0 && v <= OL_MAX_LIMIT && v !== chatOverlayMax) {
                        chatOverlayMax = v;
                        (game as any).chatOverlayMax = v;
                        trimOlVisibility();
                        applyOverlayMinHeight();
                        syncSelect(v);
                    }
                }
                // 幅
                chatOverlay.style.removeProperty("width");
                chatOverlay.style.removeProperty("max-width");
                const sw = getCk(ckKey("chatOlWidth"));
                if (sw) {
                    const px = parseInt(sw);
                    if (px >= OL_WIDTH_MIN) {
                        chatOverlay.style.setProperty("width", Math.min(px, getMaxWidth()) + "px", "important");
                        chatOverlay.style.setProperty("max-width", "none", "important");
                    }
                }
                // 左端
                chatOverlay.style.removeProperty("left");
                const sl = getCk(ckKey("chatOlLeft"));
                if (sl !== null) {
                    chatOverlay.style.setProperty("left", parseInt(sl) + "px", "important");
                    chatOverlay.style.setProperty("right", "auto", "important");
                }
                requestAnimationFrame(reapplyOverlayVertical);
            };

            // 起動時: 幅クッキーを復元
            const savedW = getCk(ckKey("chatOlWidth"));
            if (savedW) {
                const px = parseInt(savedW);
                if (px >= OL_WIDTH_MIN) {
                    // モバイルCSSの width: 75% !important を上書きするため important で設定
                    chatOverlay.style.setProperty("width", Math.min(px, getMaxWidth()) + "px", "important");
                    chatOverlay.style.setProperty("max-width", "none", "important");
                }
            }
            // 起動時: 位置クッキーを復元（水平=絶対px, 垂直=アンカー相対ギャップ）
            const savedLeft = getCk(ckKey("chatOlLeft"));
            if (savedLeft !== null) {
                const cvs = document.getElementById("renderCanvas");
                const cr = cvs ? cvs.getBoundingClientRect() : { left: 0, right: window.innerWidth } as DOMRect;
                const w = chatOverlay.offsetWidth;
                const L = Math.max(cr.left + 4, Math.min(cr.right - w - 4, parseInt(savedLeft)));
                chatOverlay.style.setProperty("left", L + "px", "important");
                chatOverlay.style.setProperty("right", "auto", "important");
            }
            // 垂直: DOM 構築が落ち着いてからアンカー基準で適用
            requestAnimationFrame(() => reapplyOverlayVertical());
            setTimeout(() => reapplyOverlayVertical(), 300);

            // アンカー変動時に相対位置を再適用
            window.addEventListener("resize", () => {
                reloadForMode();
                requestAnimationFrame(reapplyOverlayVertical);
            });
            window.addEventListener("orientationchange", () => setTimeout(() => {
                reloadForMode();
                reapplyOverlayVertical();
            }, 200));
            // body class（sp-panel-visible）・各パネル表示・chat-container リサイズを監視
            new MutationObserver(() => requestAnimationFrame(reapplyOverlayVertical))
                .observe(document.body, { attributes: true, attributeFilter: ["class"] });
            const panelObsIds = ["user-list-panel", "chat-history-panel", "chat-settings-panel",
                "server-settings-panel", "server-log-panel", "ping-panel",
                "ccu-panel", "bookmark-panel", "room-list-panel", "othello-panel", "debug-overlay",
                "about-panel", "displayname-panel", "avatar-panel"];
            for (const id of panelObsIds) {
                const el = document.getElementById(id);
                if (!el) continue;
                new MutationObserver(() => requestAnimationFrame(reapplyOverlayVertical))
                    .observe(el, { attributes: true, attributeFilter: ["style", "class"] });
            }
            const chatCont = document.getElementById("chat-container");
            if (chatCont) {
                new ResizeObserver(() => requestAnimationFrame(reapplyOverlayVertical)).observe(chatCont);
            }
            // デバイダー移動でも再適用
            (game as any).onChatOverlayReapply = reapplyOverlayVertical;

            // --- タップゾーン: 短タップでハンドルをトグル／ドラッグで移動 ---
            // iOS Safari は pointer events と touch events を両方発火する場合があるので
            // 最終トグル時刻でガードして二重発火を防ぐ
            let lastToggleTs = 0;
            const tryToggle = () => {
                const now = performance.now();
                if (now - lastToggleTs < 300) return;
                lastToggleTs = now;
                chatOverlay.classList.toggle("handles-visible");
            };
            const DRAG_THRESHOLD = 10;
            let tapStartX = 0, tapStartY = 0, tapPointerId = -1;
            let tapDragging = false;
            let tapStartLeft = 0, tapStartTop = 0;
            // アクティブ状態（ハンドル表示中）のみドラッグ移動可
            const isActive = () => chatOverlay.classList.contains("handles-visible");
            tapZone.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                e.preventDefault();
                tapPointerId = e.pointerId;
                tapStartX = e.clientX; tapStartY = e.clientY;
                const r = chatOverlay.getBoundingClientRect();
                tapStartLeft = r.left; tapStartTop = r.top;
                tapDragging = false;
                try { tapZone.setPointerCapture(e.pointerId); } catch { /* noop */ }
            });
            tapZone.addEventListener("pointermove", (e) => {
                if (e.pointerId !== tapPointerId) return;
                if (!isActive()) return; // 非アクティブ時は移動しない
                const dx = e.clientX - tapStartX, dy = e.clientY - tapStartY;
                if (!tapDragging && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
                    tapDragging = true;
                }
                if (tapDragging) {
                    e.stopPropagation();
                    e.preventDefault();
                    const { left, top } = clampToCanvas(tapStartLeft + dx, tapStartTop + dy);
                    setOverlayPos(left, top);
                }
            });
            tapZone.addEventListener("pointerup", (e) => {
                e.stopPropagation();
                if (e.pointerId !== tapPointerId) return;
                tapPointerId = -1;
                if (tapDragging) {
                    const r = chatOverlay.getBoundingClientRect();
                    setCk(ckKey("chatOlLeft"), String(Math.round(r.left)));
                    saveGapFromCurrent();
                    tapDragging = false;
                    return;
                }
                const dx = e.clientX - tapStartX, dy = e.clientY - tapStartY;
                if (dx * dx + dy * dy < TAP_THRESHOLD * TAP_THRESHOLD) tryToggle();
            });
            tapZone.addEventListener("pointercancel", () => { tapPointerId = -1; tapDragging = false; });
            // iOS Safari 保険: touch events でも判定（pointer events が届かないケース対策）
            let touchStartX = 0, touchStartY = 0;
            let touchDragging = false;
            let touchStartLeft = 0, touchStartTop = 0;
            tapZone.addEventListener("touchstart", (e) => {
                e.stopPropagation();
                if (e.touches.length !== 1) return;
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                const r = chatOverlay.getBoundingClientRect();
                touchStartLeft = r.left; touchStartTop = r.top;
                touchDragging = false;
            }, { passive: true });
            tapZone.addEventListener("touchmove", (e) => {
                if (e.touches.length !== 1) return;
                if (!isActive()) return; // 非アクティブ時は移動しない
                const t = e.touches[0];
                const dx = t.clientX - touchStartX, dy = t.clientY - touchStartY;
                if (!touchDragging && dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
                    touchDragging = true;
                }
                if (touchDragging) {
                    e.stopPropagation();
                    e.preventDefault();
                    const { left, top } = clampToCanvas(touchStartLeft + dx, touchStartTop + dy);
                    setOverlayPos(left, top);
                }
            }, { passive: false });
            tapZone.addEventListener("touchend", (e) => {
                e.stopPropagation();
                if (e.changedTouches.length !== 1) return;
                if (touchDragging) {
                    const r = chatOverlay.getBoundingClientRect();
                    setCk(ckKey("chatOlLeft"), String(Math.round(r.left)));
                    saveGapFromCurrent();
                    touchDragging = false;
                    e.preventDefault();
                    return;
                }
                const t = e.changedTouches[0];
                const dx = t.clientX - touchStartX, dy = t.clientY - touchStartY;
                if (dx * dx + dy * dy < TAP_THRESHOLD * TAP_THRESHOLD) {
                    e.preventDefault();
                    tryToggle();
                }
            }, { passive: false });

            // --- 四隅ハンドル: ドラッグで幅・行数を変更 ---
            // isBottomHandle=true (BR): 下方向ドラッグ=拡大、top 固定で下方向に伸びる
            // isBottomHandle=false (TR): 上方向ドラッグ=拡大、bottom 固定で上方向に伸びる
            const attachResize = (el: HTMLElement, isBottomHandle: boolean) => {
                let dragging = false;
                let startX = 0, startY = 0;
                let startMax = 0, startW = 0;
                let activeId = -1;
                el.addEventListener("pointerdown", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    if (activeId >= 0 && e.pointerId !== activeId) return;
                    activeId = e.pointerId;
                    dragging = true;
                    startX = e.clientX; startY = e.clientY;
                    startMax = chatOverlayMax;
                    startW = chatOverlay.getBoundingClientRect().width;
                    // ドラッグ中は反対側を固定（ハンドルが指に追従するように）
                    const r = chatOverlay.getBoundingClientRect();
                    if (isBottomHandle) {
                        // BR: top 固定
                        chatOverlay.style.setProperty("top", r.top + "px", "important");
                        chatOverlay.style.setProperty("bottom", "auto", "important");
                    } else {
                        // TR: bottom 固定
                        chatOverlay.style.setProperty("bottom", (window.innerHeight - r.bottom) + "px", "important");
                        chatOverlay.style.setProperty("top", "auto", "important");
                    }
                    try { el.setPointerCapture(e.pointerId); } catch (err) { console.warn("setPointerCapture failed:", err); }
                });
                el.addEventListener("pointermove", (e) => {
                    if (!dragging) return;
                    e.stopPropagation();
                    e.preventDefault();
                    const lineH = getOlTextLineH();
                    if (lineH <= 0) return;
                    const deltaY = e.clientY - startY;
                    const deltaX = e.clientX - startX;
                    // BR: 下方向ドラッグで拡大 / TR: 上方向ドラッグで拡大
                    const deltaLines = isBottomHandle
                        ? Math.round(deltaY / lineH)
                        : -Math.round(deltaY / lineH);
                    const nextMax = Math.max(0, Math.min(OL_MAX_LIMIT, startMax + deltaLines));
                    if (nextMax !== chatOverlayMax) {
                        chatOverlayMax = nextMax;
                        (game as any).chatOverlayMax = nextMax;
                        trimOlVisibility();
                        applyOverlayMinHeight();
                    }
                    // 右へドラッグ = 幅増（モバイルCSSの !important を上書き）
                    const nextW = Math.max(OL_WIDTH_MIN, Math.min(getMaxWidth(), startW + deltaX));
                    chatOverlay.style.setProperty("width", Math.round(nextW) + "px", "important");
                    chatOverlay.style.setProperty("max-width", "none", "important");
                });
                const endDrag = (e: PointerEvent) => {
                    if (!dragging) return;
                    e.stopPropagation();
                    dragging = false;
                    activeId = -1;
                    // ドラッグ終了: left + bottom アンカーに統一し位置を保存
                    const r = chatOverlay.getBoundingClientRect();
                    setOverlayPos(r.left, r.top);
                    setCk(ckKey("chatOlLeft"), String(Math.round(r.left)));
                    saveGapFromCurrent();
                    if (chatOverlayMax !== startMax) {
                        setCk(ckKey("chatOlMax"), String(chatOverlayMax));
                        syncSelect(chatOverlayMax);
                        applyOverlayMinHeight();
                    }
                    const w = Math.round(chatOverlay.getBoundingClientRect().width);
                    if (Math.abs(w - Math.round(startW)) >= 1) setCk(ckKey("chatOlWidth"), String(w));
                };
                el.addEventListener("pointerup", endDrag);
                el.addEventListener("pointercancel", endDrag);
            };
            attachResize(hTR, false);
            attachResize(hBR, true);
        }
    }

    const addChatOverlay = (avatarName: string, text: string, timeStr: string, nameColor?: string, senderId?: string, prepend = false, deferTrim = false) => {
        if (!chatOverlay || !text || chatOverlayMax === 0) return;
        const isSystem = avatarName === "[system]";
        const line = document.createElement("div");
        line.className = "chat-ol-line";
        if (isSystem) {
            line.innerHTML =
                `<span class="chat-ol-time">${escapeHtml(timeStr)}</span>` +
                `${text}`;
        } else {
            const safeColor = sanitizeColor(nameColor ?? "");
            const colorStyle = safeColor ? ` style="color:${safeColor}"` : "";
            line.innerHTML =
                `<span class="chat-ol-time">${escapeHtml(timeStr)}</span>` +
                `<span class="chat-ol-name"${colorStyle}>${escapeHtml(avatarName)}:</span> ${escapeHtml(text)}`;
        }
        if (senderId) line.dataset.sender = senderId;
        if (prepend) {
            const firstLine = chatOverlay.querySelector(".chat-ol-line");
            chatOverlay.insertBefore(line, firstLine);
        } else {
            chatOverlay.appendChild(line);
        }
        if (!deferTrim) trimOlVisibility();
        // メモリ節約: 非表示要素が多すぎたら古い行を削除（ハンドル類は除外）
        const keepMax = Math.max(chatOverlayMax * 3, 20);
        const lines = chatOverlay.querySelectorAll(".chat-ol-line");
        for (let i = 0; i < lines.length - keepMax; i++) lines[i].remove();
    };

    /** 指定ユーザーの既存オーバーレイメッセージの名前色を一括更新 */
    const updateOverlayNameColor = (userId: string, newColor: string) => {
        if (!chatOverlay) return;
        for (const el of chatOverlay.querySelectorAll<HTMLElement>(".chat-ol-line")) {
            if (el.dataset.sender !== userId) continue;
            const nameEl = el.querySelector(".chat-ol-name") as HTMLElement | null;
            if (nameEl) nameEl.style.color = newColor;
        }
    };

    // 履歴フェッチの重複排除用（ts_userId）
    const seenChatKeys = new Set<string>();

    const addChatHistory = (avatarName: string, text: string, nameColor?: string, senderId?: string, serverTs = 0, prepend = false) => {
        const _end = prof("UIPanel.addChatHistory");
        if (!text) { _end(); return; }
        const list = document.getElementById("chat-history-list");
        if (!list) { _end(); return; }
        const panel = document.getElementById("chat-history-panel");
        const inactive = !panel || panel.style.display === "none" || panel.classList.contains("minimized");

        if (serverTs > 0 && senderId) seenChatKeys.add(`${serverTs}_${senderId}`);

        const now = serverTs > 0 ? new Date(serverTs) : new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const timeStr = `${hh}:${mm}`;

        const entry = document.createElement("div");
        entry.className = "chat-history-entry";
        const isSystem = avatarName === "[system]";
        const nameClass = isSystem ? "chat-history-system" : "chat-history-name";
        const safeColor = sanitizeColor(nameColor ?? "");
        const nameStyle = (!isSystem && safeColor) ? ` style="color:${safeColor}"` : "";
        entry.innerHTML =
            `<span class="chat-history-time">${escapeHtml(timeStr)}</span>` +
            `<span class="${nameClass}"${nameStyle}>${escapeHtml(avatarName)}</span>` +
            `<span class="chat-history-text">${isSystem ? text : escapeHtml(text)}</span>`;
        if (prepend) list.insertBefore(entry, list.firstChild);
        else list.appendChild(entry);
        // エントリ数上限（メモリ抑制 + 再スクロールコスト軽減）
        const MAX_CHAT_ENTRIES = 500;
        while (list.childElementCount > MAX_CHAT_ENTRIES) list.firstElementChild?.remove();
        if (prepend) {
            // 履歴フェッチ: scroll/吹き出しはスキップし、オーバーレイには先頭挿入（trim は呼び出し元で一括）
            addChatOverlay(avatarName, text, timeStr, nameColor, senderId, /*prepend=*/true, /*deferTrim=*/true);
        } else {
            // パネルが非表示/最小化中は強制レイアウトを引き起こす scrollIntoView をスキップ
            if (!inactive) entry.scrollIntoView({ block: "end", behavior: "instant" });
            // チャットオーバーレイにも追加
            addChatOverlay(avatarName, text, timeStr, nameColor, senderId);
        }

        _end();
    };

    const setCookie = (key: string, value: string) => {
        document.cookie = `${key}=${encodeURIComponent(value)};path=/;max-age=${60 * 60 * 24 * 365}`;
    };
    const getCookie = (key: string): string | null => {
        const match = document.cookie.match(new RegExp("(?:^|; )" + key + "=([^;]*)"));
        return match ? decodeURIComponent(match[1]) : null;
    };

    /** 表示名が空なら @username（@だけ色付き）、あればそのまま（白色）を返す */
    const resolveDisplayLabel = (displayName: string, username: string, sessionId?: string, flagsOverride?: { hasGoogle?: boolean; isAdmin?: boolean }): { text: string; color: string; suffix: string } => {
        const uidColorInput = document.getElementById("uidColorInput") as HTMLInputElement | null;
        const color = uidColorInput?.value ?? "#00bbfa";
        // 同一UUIDが複数セッションあればサフィックスを付与
        let suffix = "";
        if (sessionId) {
            const entry = userMap.get(sessionId);
            if (entry) {
                let count = 0;
                for (const e of userMap.values()) {
                    if (e.uuid === entry.uuid) count++;
                }
                if (count >= 2) suffix = "#" + sessionId.slice(0, 4);
            }
        }
        // 認証アイコン（管理者 👑 > Google ✅）。自分は NakamaService の self フラグを優先。
        // userMap に未登録でも profileCache / 呼び出し側オーバーライドがあれば使用（レース回避）。
        let hasGoogle = false;
        let isAdmin = false;
        if (flagsOverride && (flagsOverride.hasGoogle !== undefined || flagsOverride.isAdmin !== undefined)) {
            hasGoogle = flagsOverride.hasGoogle ?? false;
            isAdmin = flagsOverride.isAdmin ?? false;
        } else if (sessionId && sessionId === game.nakama.selfSessionId) {
            hasGoogle = game.nakama.selfHasGoogle;
            isAdmin = game.nakama.selfIsAdmin;
        } else if (sessionId) {
            const entry = userMap.get(sessionId);
            if (entry && (entry.hasGoogle !== undefined || entry.isAdmin !== undefined)) {
                hasGoogle = entry.hasGoogle ?? false;
                isAdmin = entry.isAdmin ?? false;
            } else {
                const pc = profileCache.get(sessionId);
                if (pc) { hasGoogle = pc.hasGoogle ?? false; isAdmin = pc.isAdmin ?? false; }
            }
        }
        if (isAdmin) suffix += " \u{1F451}";
        else if (hasGoogle) suffix += " \u2705";
        if (displayName) return { text: displayName, color: "white", suffix };
        return { text: "@" + username, color, suffix };
    };

    // ---- チャット履歴の遅延フェッチ（部屋ごと）----
    // オーバレイには常に最新ログを表示したいので、パネル表示状態に依存しない
    let loadedChatForWorld: number | null = null;
    chatLoader.fn = () => {
        const wid = game.currentWorldId;
        if (loadedChatForWorld === wid) return;
        if (!game.nakama.selfMatchId) return;
        loadedChatForWorld = wid;
        game.nakama.getRecentChat(wid).then((msgs) => {
            // サーバーからは古い順。新しい順に prepend すると最終的に古い→新しい順でリスト先頭に入る
            let added = 0;
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                const key = `${m.ts}_${m.userId}`;
                if (seenChatKeys.has(key)) continue;
                const entry = userMap.get(m.sessionId);
                // メッセージ自身の dn/hg/ad を優先（履歴描画時点で userMap に未到達でもアイコン・表示名が付く）
                const effDn = (m.displayName && m.displayName !== "") ? m.displayName : (entry?.displayName ?? "");
                const effUname = entry?.username ?? m.username;
                // 履歴メッセージのフラグを userMap / profileCache にも反映（以後のレース回避）
                if (m.sessionId && (m.isAdmin !== undefined || m.hasGoogle !== undefined)) {
                    const pc = profileCache.get(m.sessionId);
                    if (pc) { pc.hasGoogle = m.hasGoogle ?? pc.hasGoogle; pc.isAdmin = m.isAdmin ?? pc.isAdmin; }
                    if (entry) userMap.set(m.sessionId, { ...entry, hasGoogle: m.hasGoogle ?? entry.hasGoogle, isAdmin: m.isAdmin ?? entry.isAdmin });
                }
                const lbl = resolveDisplayLabel(effDn, effUname, m.sessionId, { hasGoogle: m.hasGoogle, isAdmin: m.isAdmin });
                const chatName = lbl.text + lbl.suffix;
                const chatNameColor = m.nameColor ?? entry?.nameColor;
                addChatHistory(chatName, m.text, chatNameColor, m.userId, m.ts, /*prepend=*/true);
                added++;
            }
            // バッチ挿入後に一括で表示トリム（layout thrashing 回避）
            if (added > 0) trimOlVisibility();
        }).catch((e) => {
            console.warn("getRecentChat:", e);
            loadedChatForWorld = null;
        });
    };

    // 部屋切替時は履歴をクリアし、パネル表示中なら再フェッチ
    game.onWorldChanged.push(() => {
        const list = document.getElementById("chat-history-list");
        if (list) while (list.firstChild) list.removeChild(list.firstChild);
        seenChatKeys.clear();
        loadedChatForWorld = null;
        chatLoader.fn?.();
    });

    const loginNameInput = document.getElementById("loginName") as HTMLInputElement;
    const loginBtn = document.getElementById("loginBtn") as HTMLButtonElement;

    /** ランダムユーザID生成（user_ + 6桁英数字 = 11文字） */
    const generateRandomUserId = (): string => {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        let id = "user_";
        for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
    };

    const manualLoginMode = new URLSearchParams(location.search).has("login");
    const savedLoginName = getCookie("loginName");
    if (savedLoginName && loginNameInput) {
        loginNameInput.value = savedLoginName;
        game.updatePlayerNameTag(savedLoginName);
    }

    const loginStatus = document.getElementById("loginStatus") as HTMLSpanElement;
    const userListBody = document.getElementById("user-list-body") as HTMLTableSectionElement;

    const formatTimestamp = (date: Date): string => {
        const now = new Date();
        const isToday = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
        if (isToday) {
            return "今日 " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        }
        return date.toLocaleString(undefined, {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
    };

    const userMap = new Map<string, { username: string; displayName: string; uuid: string; sessionId: string; loginTimestamp: number; loginTime: string; channel: "chat" | "match" | "chat+match"; nameColor?: string; hasGoogle?: boolean; isAdmin?: boolean }>();
    type UlSortKey = "username" | "displayName" | "uuid" | "sessionId" | "loginTime" | "loginTimestamp" | "channel";
    let ulSortKey: UlSortKey = "username";
    let ulSortAsc = true;
    const _ulCkMatch = document.cookie.match(/(?:^|; )ulFilter=([^;]*)/);
    let ulFilterMode: "room" | "all" = _ulCkMatch && decodeURIComponent(_ulCkMatch[1]) === "all" ? "all" : "room";
    const thUser  = document.getElementById("ul-th-user")  as HTMLTableCellElement;
    const thDname = document.getElementById("ul-th-dname") as HTMLTableCellElement;
    const thUuid  = document.getElementById("ul-th-uuid")  as HTMLTableCellElement;
    const thSid   = document.getElementById("ul-th-sid")   as HTMLTableCellElement;
    const thTime  = document.getElementById("ul-th-time")  as HTMLTableCellElement;
    const thRel   = document.getElementById("ul-th-rel")   as HTMLTableCellElement;
    const thMatchId = document.getElementById("ul-th-matchid") as HTMLTableCellElement;
    const ulFilterEl = document.getElementById("ul-filter");



    // デバウンス付きrenderUserList — 短期間の連続呼び出しをまとめる
    let _renderTimer: ReturnType<typeof setTimeout> | null = null;
    let _renderCount = 0;
    let _renderTotalMs = 0;
    let _renderMaxMs = 0;
    let _renderLastReport = performance.now();

    const cc = (name: string) => { if (game.profiling) game.callCounts[name] = (game.callCounts[name] ?? 0) + 1; };

    const scheduleRenderUserList = () => {
        cc("scheduleRenderUserList");
        // 同接数は右上バッジで常時表示するため、パネル非表示でも即時更新
        game.userListProfile.userCount = userMap.size;
        if (_renderTimer !== null) return;
        _renderTimer = setTimeout(() => { _renderTimer = null; renderUserList(); }, 1000);
    };

    const ulPanel = document.getElementById("user-list-panel");

    // 「すべて」モード用キャッシュ
    let _allPlayersCache: { sessionId: string; userId: string; username: string; displayName: string; loginTime: string; nameColor?: string; worldId: number; matchId: string }[] = [];

    const renderUserList = () => {
        cc("renderUserList");
        const _end = prof("UIPanel.renderUserList");
        if (!userListBody) { _end(); return; }
        // パネルが非表示ならスキップ（表示時に再レンダリングされる）
        if (ulPanel && ulPanel.style.display === "none") { _end(); return; }

        const _rt0 = performance.now();
        const myId = game.nakama.selfSessionId ?? "";
        const myMatchId = game.nakama.selfMatchId ?? "";

        // 「この部屋」: 自分の matchId でフィルタ / 「すべて」: 全員表示
        let source = _allPlayersCache;
        if (ulFilterMode === "room") {
            source = _allPlayersCache.filter(p => p.matchId === myMatchId);
            if (thMatchId) thMatchId.textContent = "MatchID";
        } else {
            if (thMatchId) thMatchId.textContent = "部屋";
        }

        const sorted = [...source].sort((a, b) => {
            if (ulSortKey === "username") return ulSortAsc ? a.username.localeCompare(b.username) : b.username.localeCompare(a.username);
            if (ulSortKey === "displayName") return ulSortAsc ? a.displayName.localeCompare(b.displayName) : b.displayName.localeCompare(a.displayName);
            return ulSortAsc ? a.username.localeCompare(b.username) : b.username.localeCompare(a.username);
        });

        const frag = document.createDocumentFragment();
        for (const p of sorted) {
            const tr = document.createElement("tr");
            const bold = p.sessionId === myId ? " class=\"ul-self\"" : "";
            const lbl = resolveDisplayLabel(p.displayName, p.username, p.sessionId);
            const fullName = lbl.suffix ? lbl.text + lbl.suffix : lbl.text;
            const eu = escapeHtml(p.username), ef = escapeHtml(fullName);
            const eUuid = escapeHtml(p.userId), eSid = escapeHtml(p.sessionId.slice(0, 8));
            const elt = escapeHtml(p.loginTime || "-");
            if (ulFilterMode === "room") {
                const matchShort = myMatchId ? myMatchId.slice(0, 8) : "-";
                const eMs = escapeHtml(matchShort), eMid = escapeHtml(myMatchId);
                tr.innerHTML = `<td${bold} title="${eu}">${eu}</td><td title="${ef}">${ef}</td><td class="uuid-cell" data-copy="${eUuid}" title="${eUuid}&#10;クリックでコピー">${escapeHtml(p.userId.slice(0, 8))}</td><td class="uuid-cell" data-copy="${eSid}" title="${eSid}&#10;クリックでコピー">${eSid}</td><td>-</td><td class="uuid-cell" data-copy="${eMid}" title="${eMid}&#10;クリックでコピー">${eMs}</td><td>-</td><td title="${elt}">${elt}</td>`;
            } else {
                const worldName = escapeHtml(resolveWorldName(p.worldId));
                tr.innerHTML = `<td${bold} title="${eu}">${eu}</td><td title="${ef}">${ef}</td><td class="uuid-cell" data-copy="${eUuid}" title="${eUuid}&#10;クリックでコピー">${escapeHtml(p.userId.slice(0, 8))}</td><td class="uuid-cell" data-copy="${eSid}" title="${eSid}&#10;クリックでコピー">${eSid}</td><td>-</td><td title="${worldName}">${worldName}</td><td>-</td><td title="${elt}">${elt}</td>`;
            }
            frag.appendChild(tr);
        }
        userListBody.innerHTML = "";
        userListBody.appendChild(frag);
        // プロファイル集計（1秒ごとにリセット）
        const _rt1 = performance.now();
        const elapsed = _rt1 - _rt0;
        _renderCount++;
        _renderTotalMs += elapsed;
        if (elapsed > _renderMaxMs) _renderMaxMs = elapsed;
        if (_rt1 - _renderLastReport >= 1000) {
            game.userListProfile = { calls: _renderCount, totalMs: _renderTotalMs, maxMs: _renderMaxMs, userCount: userMap.size };
            _renderCount = _renderTotalMs = _renderMaxMs = 0;
            _renderLastReport = _rt1;
        }
        _end();
    };

    // worldId → 部屋名のキャッシュ
    const worldNameCache = new Map<number, string>();
    const resolveWorldName = (worldId: number): string => {
        if (worldNameCache.has(worldId)) return worldNameCache.get(worldId)!;
        return `World ${worldId}`;
    };
    // ワールドリスト取得で名前キャッシュを更新
    const refreshWorldNames = () => {
        game.nakama.getWorldList().then(({ worlds }) => {
            for (const w of worlds) worldNameCache.set(w.id, w.name || `World ${w.id}`);
        }).catch(() => {});
    };

    const isUlPanelVisible = () => ulPanel && ulPanel.style.display !== "none";
    let _playerListMode: "count" | "full" | null = null; // 現在のサブスクライブモード

    /** full モードで購読開始（パネル表示時） */
    const subPlayerListFull = () => {
        if (_playerListMode === "full") return;
        _playerListMode = "full";
        refreshWorldNames();
        game.nakama.subscribePlayerList(true, "full");
    };
    /** count モードへダウングレード（パネル非表示時） */
    const subPlayerListCount = () => {
        if (_playerListMode === "count") return;
        _playerListMode = "count";
        game.nakama.subscribePlayerList(true, "count");
    };

    // サーバーからのプッシュ配信を受信（full: プレイヤーリスト）
    game.nakama.onPlayerListData = (players) => {
        _allPlayersCache = players;
        if (isUlPanelVisible()) renderUserList();
    };
    // サーバーからのプッシュ配信を受信（count: 部屋人数のみ）
    game.nakama.onPlayerListCount = (count) => {
        game.userListProfile.userCount = count;
    };

    // フィルタ切り替え
    if (ulFilterEl) {
        (ulFilterEl as HTMLSelectElement).value = ulFilterMode;
        ulFilterEl.addEventListener("change", () => {
            ulFilterMode = (ulFilterEl as HTMLSelectElement).value as "room" | "all";
            document.cookie = `ulFilter=${ulFilterMode};path=/;max-age=${60*60*24*365}`;
            renderUserList();
        });
    }

    // パネル表示時にレンダリングをトリガー（非表示中はスキップしているため）
    if (ulPanel) {
        let ulWasHidden = ulPanel.style.display === "none";
        new MutationObserver(() => {
            const isHidden = ulPanel.style.display === "none";
            if (ulWasHidden && !isHidden) {
                subPlayerListFull();
            } else if (!ulWasHidden && isHidden) {
                subPlayerListCount();
            }
            ulWasHidden = isHidden;
        }).observe(ulPanel, { attributes: true, attributeFilter: ["style"] });
    }

    // uuid-cell クリックをイベント委譲で処理（行ごとにリスナーを付けない）
    if (userListBody) {
        userListBody.addEventListener("click", (e) => {
            const td = (e.target as HTMLElement).closest(".uuid-cell") as HTMLElement | null;
            if (!td) return;
            const text = td.dataset.copy ?? td.textContent ?? "";
            navigator.clipboard.writeText(text).then(() => {
                const orig = td.textContent;
                td.textContent = "コピー済み";
                td.style.color = "#28a745";
                setTimeout(() => { td.textContent = orig; td.style.color = ""; }, 1000);
            });
        });
    }

    const setUlSort = (key: UlSortKey) => {
        if (ulSortKey === key) ulSortAsc = !ulSortAsc;
        else { ulSortKey = key; ulSortAsc = true; }
        renderUserList();
    };
    if (thUser)  thUser.addEventListener("click",  () => setUlSort("username"));
    if (thDname) thDname.addEventListener("click", () => setUlSort("displayName"));
    if (thUuid)  thUuid.addEventListener("click",  () => setUlSort("uuid"));
    if (thSid)   thSid.addEventListener("click",   () => setUlSort("sessionId"));
    if (thTime)  thTime.addEventListener("click",  () => setUlSort("loginTime"));
    if (thRel)   thRel.addEventListener("click",   () => setUlSort("loginTimestamp"));
    { const thCh = document.getElementById("ul-th-ch"); if (thCh) thCh.addEventListener("click", () => setUlSort("channel")); }

    // プレイヤーリストはサーバープッシュ(op=17)で更新されるため、定期ポーリングは不要

    // カラムリサイズハンドル
    {
        const table = document.getElementById("user-list") as HTMLTableElement;
        const ths = document.querySelectorAll<HTMLTableCellElement>("#user-list thead th");
        ths.forEach(th => {
            const handle = document.createElement("div");
            handle.className = "ul-resize";
            th.appendChild(handle);
            let startX = 0, startW = 0, startTableW = 0;
            const onMove = (e: PointerEvent) => {
                const delta = e.clientX - startX;
                const newW = Math.max(30, startW + delta);
                th.style.width = newW + "px";
                table.style.width = (startTableW + newW - startW) + "px";
            };
            const onUp = () => {
                document.removeEventListener("pointermove", onMove);
                document.removeEventListener("pointerup", onUp);
            };
            handle.addEventListener("pointerdown", (e) => {
                e.stopPropagation(); // ソートを発火させない
                e.preventDefault();
                startX = e.clientX;
                startW = th.offsetWidth;
                startTableW = table.offsetWidth;
                document.addEventListener("pointermove", onMove);
                document.addEventListener("pointerup", onUp);
            });
        });
    }

    // Nakama コールバック設定
    // セリフ自動消去: 15秒後にフェードアウト開始、約1秒で透明→消去
    const SPEECH_DISPLAY_MS = 15000;
    const SPEECH_FADE_DURATION = 1.0;  // フェード秒数
    const speechTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const speechFading = new Map<string, { clearFn: () => void; sid: string }>();

    const scheduleSpeechClear = (sessionId: string, clearFn: () => void) => {
        // 前のタイマー・フェードをキャンセル
        const prev = speechTimers.get(sessionId);
        if (prev !== undefined) clearTimeout(prev);
        speechFading.delete(sessionId);
        // alpha をリセット（新しいセリフ表示時）
        game.spriteAvatarSystem.setSpeechAlpha(sessionId, 1);

        speechTimers.set(sessionId, setTimeout(() => {
            speechTimers.delete(sessionId);
            // フェードアウト開始
            speechFading.set(sessionId, { clearFn, sid: sessionId });
        }, SPEECH_DISPLAY_MS));
    };

    // レンダーループでフェード処理（追加タイマー不要）
    game.scene.onAfterRenderObservable.add(() => {
        if (speechFading.size === 0) return;
        const dt = game.engine.getDeltaTime() / 1000;  // 秒
        const step = dt / SPEECH_FADE_DURATION;
        for (const [sid, fade] of speechFading) {
            const cur = game.spriteAvatarSystem.getSpeechAlpha(sid);
            const next = cur - step;
            if (next <= 0) {
                game.spriteAvatarSystem.setSpeechAlpha(sid, 0);
                fade.clearFn();
                speechFading.delete(sid);
            } else {
                game.spriteAvatarSystem.setSpeechAlpha(sid, next);
            }
        }
    });

    game.nakama.onChatMessage = (username, text, userId, senderSid, ts, hasGoogle, isAdmin, displayName, nameColor) => {
        // 認証フラグ・表示名を userMap / profileCache に反映（チャットが profileResponse より早く届く場合のレース回避）
        if (senderSid) {
            const pc = profileCache.get(senderSid);
            if (pc) {
                if (hasGoogle !== undefined) pc.hasGoogle = hasGoogle;
                if (isAdmin !== undefined) pc.isAdmin = isAdmin;
                if (displayName) pc.displayName = displayName;
            }
            const ue = userMap.get(senderSid);
            if (ue) {
                userMap.set(senderSid, {
                    ...ue,
                    hasGoogle: hasGoogle ?? ue.hasGoogle,
                    isAdmin: isAdmin ?? ue.isAdmin,
                    displayName: displayName || ue.displayName,
                    nameColor: nameColor || ue.nameColor,
                });
            }
        }
        // 表示名はメッセージ側を優先、なければ userMap
        const entry = senderSid ? userMap.get(senderSid) : undefined;
        const effDn = (displayName && displayName !== "") ? displayName : (entry?.displayName ?? "");
        const effUname = entry?.username ?? username;
        // resolveDisplayLabel に flags オーバーライドを渡す（userMap 未反映でもアイコンが出る）
        const lbl = resolveDisplayLabel(effDn, effUname, senderSid, { hasGoogle, isAdmin });
        const chatName = lbl.text + lbl.suffix;
        const chatNameColor = nameColor ?? entry?.nameColor;
        addChatHistory(chatName, text, chatNameColor, userId, ts);
        // 吹き出しは送信元セッションのアバターのみに表示
        if (senderSid === game.nakama.selfSessionId) {
            doUpdateSpeech(text);
            scheduleSpeechClear("__self__", () => doUpdateSpeech(""));
        } else if (senderSid) {
            game.remoteSpeeches.get(senderSid)?.(text);
            const remoteSpeech = game.remoteSpeeches.get(senderSid);
            if (remoteSpeech) {
                scheduleSpeechClear(senderSid, () => remoteSpeech(""));
            }
        }
    };
    // OP_INIT_POS受信後、サーバーAOI追跡が追いつくまでAOI_LEAVEを無視するガード
    const initPosGuard = new Map<string, number>(); // sessionId → timestamp

    game.nakama.onAvatarInitPos = (sessionId: string, x: number, z: number, _ry: number, loginTimeISO: string, displayName: string, textureUrl: string, charCol: number, charRow: number, nameColor?: string) => {
        console.log(`rcv onAvatarInitPos sid=${sessionId.slice(0, 8)} x=${(+x).toFixed(1)} z=${(+z).toFixed(1)} hasAvatar=${game.remoteAvatars.has(sessionId)}`);
        // userMap に存在しないセッション = 既にキック/退出済み → 無視（ゴースト防止）
        if (sessionId !== game.nakama.selfSessionId && !userMap.has(sessionId)) {
            console.log(`rcv onAvatarInitPos SKIP sid=${sessionId.slice(0, 8)} (not in userMap)`);
            return;
        }
        initPosGuard.set(sessionId, performance.now());
        const username = userMap.get(sessionId)?.username ?? sessionId.slice(0, 8);
        const sheetUrl = (textureUrl && textureUrl.includes("/s3/")) ? textureUrl : "/s3/avatars/001-pipo-nekonin008.png";
        if (game.spriteAvatarSystem.has(sessionId) || game.spriteAvatarSystem.isCreating(sessionId)) {
            if (game.spriteAvatarSystem.has(sessionId)) {
                game.spriteAvatarSystem.setPosition(sessionId, x, z);
                game.spriteAvatarSystem.setEnabled(sessionId, true);
            }
        } else {
            const initLbl = resolveDisplayLabel(displayName, username, sessionId);
            game.spriteAvatarSystem.createAvatar(sessionId, sheetUrl, charCol, charRow, x, z, initLbl.text).then(root => {
                game.remoteAvatars.set(sessionId, root as unknown as Mesh);
                game.remoteNameUpdaters.set(sessionId, game.spriteAvatarSystem.getNameUpdate(sessionId)!);
                const su = game.spriteAvatarSystem.getSpeechUpdate(sessionId);
                if (su) game.remoteSpeeches.set(sessionId, su);
                // 初期色を反映
                const upd = game.spriteAvatarSystem.getNameUpdate(sessionId);
                if (upd) upd(initLbl.text, initLbl.color, initLbl.suffix);
            }).catch(e => console.warn("UIPanel: createAvatar failed:", e));
        }
        game.remoteTargets.delete(sessionId);
        // OP_INIT_POS に含まれるログイン時刻・表示名を userMap に反映
        const existing = userMap.get(sessionId);
        if (existing) {
            const updates: Partial<typeof existing> = {};
            if (loginTimeISO) {
                const loginDate = new Date(loginTimeISO);
                updates.loginTime = formatTimestamp(loginDate);
                updates.loginTimestamp = loginDate.getTime();
            }
            updates.displayName = displayName;
            if (nameColor) updates.nameColor = nameColor;
            if (Object.keys(updates).length) {
                userMap.set(sessionId, { ...existing, ...updates });
                scheduleRenderUserList();
            }
            // 既存オーバーレイメッセージの名前色を更新
            if (nameColor && existing.uuid) updateOverlayNameColor(existing.uuid, nameColor);
        }
        // アバターのnameTagを表示名で更新
        {
            const lbl = resolveDisplayLabel(displayName, username, sessionId);
            const updater = game.remoteNameUpdaters.get(sessionId);
            if (updater) updater(lbl.text, lbl.color, lbl.suffix);
        }
    };
    game.nakama.onAvatarMoveTarget = (sessionId: string, x: number, z: number) => {
        if (game.remoteAvatars.has(sessionId)) game.remoteTargets.set(sessionId, { x, z });
    };
    game.nakama.onAvatarChange = (sessionId: string, textureUrl: string, charCol: number, charRow: number) => {
        console.log(`rcv avatarChange sid=${sessionId.slice(0, 8)} textureUrl=${textureUrl} cc=${charCol} cr=${charRow}`);
        if (sessionId === game.nakama.selfSessionId) return;
        const sheetUrl = (textureUrl && textureUrl.includes("/s3/")) ? textureUrl : "/s3/avatars/001-pipo-nekonin008.png";
        const cached = profileCache.get(sessionId);
        const dn = cached?.displayName ?? userMap.get(sessionId)?.displayName ?? "";
        const uname = userMap.get(sessionId)?.username ?? sessionId.slice(0, 8);
        const chgLbl = resolveDisplayLabel(dn, uname, sessionId);
        // 既存アバターの現在位置・回転を保持
        const oldRoot = game.remoteAvatars.get(sessionId);
        const px = oldRoot?.position.x ?? 0;
        const pz = oldRoot?.position.z ?? 0;
        const ry = oldRoot?.rotation.y ?? 0;
        game.spriteAvatarSystem.createAvatar(sessionId, sheetUrl, charCol, charRow, px, pz, chgLbl.text, undefined, ry).then(root => {
            game.remoteAvatars.set(sessionId, root as unknown as Mesh);
            game.remoteNameUpdaters.set(sessionId, game.spriteAvatarSystem.getNameUpdate(sessionId)!);
            const su = game.spriteAvatarSystem.getSpeechUpdate(sessionId);
            if (su) game.remoteSpeeches.set(sessionId, su);
            const upd = game.spriteAvatarSystem.getNameUpdate(sessionId);
            if (upd) upd(chgLbl.text, chgLbl.color, chgLbl.suffix);
        }).catch(e => console.warn("UIPanel: createAvatar failed:", e));
    };
    game.nakama.onAvatarJump = (sessionId: string) => {
        if (sessionId === game.nakama.selfSessionId) return;
        // アバター再作成中でも jump() 側で保留され、作成完了時に反映される
        game.spriteAvatarSystem.jump(sessionId);
    };
    // --- プロフィールキャッシュ & debounced matchデータ要求 ---
    const profileCache = new Map<string, { displayName: string; textureUrl: string; charCol: number; charRow: number; loginTime: string; hasGoogle?: boolean; isAdmin?: boolean }>();
    const pendingProfileSids = new Set<string>();
    let profileFetchTimer: ReturnType<typeof setTimeout> | null = null;
    const PROFILE_DEBOUNCE_MS = 50;
    function scheduleProfileFetch() {
        if (profileFetchTimer) return;
        profileFetchTimer = setTimeout(() => {
            profileFetchTimer = null;
            if (pendingProfileSids.size === 0) return;
            const sids = [...pendingProfileSids];
            pendingProfileSids.clear();
            game.nakama.sendProfileRequest(sids).catch((e) => console.warn("UIPanel:", e));
        }, PROFILE_DEBOUNCE_MS);
    }
    // サーバからのプロフィール応答を処理
    game.nakama.onProfileResponse = (profiles) => {
        console.log(`rcv profileResponse count=${profiles.length}`);
        for (const prof of profiles) {
            const sid = prof.sessionId;
            console.log(`  profile sid=${sid.slice(0, 8)} dn=${prof.displayName} tx=${prof.textureUrl?.slice(0, 20)} lt=${prof.loginTime}`);
            profileCache.set(sid, prof);
            // プレイヤーリスト更新
            const existing = userMap.get(sid);
            if (existing) {
                const updates: Record<string, unknown> = {};
                updates.displayName = prof.displayName ?? "";
                if (prof.nameColor) updates.nameColor = prof.nameColor;
                if (prof.loginTime) {
                    const d = new Date(prof.loginTime);
                    updates.loginTime = formatTimestamp(d);
                    updates.loginTimestamp = d.getTime();
                }
                updates.hasGoogle = prof.hasGoogle ?? false;
                updates.isAdmin = prof.isAdmin ?? false;
                if (Object.keys(updates).length > 0) {
                    userMap.set(sid, { ...existing, ...updates } as typeof existing);
                }
                // 既存オーバーレイメッセージの名前色を更新
                if (prof.nameColor && existing.uuid) updateOverlayNameColor(existing.uuid, prof.nameColor);
            }
            // アバター更新（自分以外）
            if (sid !== game.nakama.selfSessionId) {
                const uname = userMap.get(sid)?.username ?? sid.slice(0, 8);
                const plbl = resolveDisplayLabel(prof.displayName ?? "", uname, sid);
                const updater = game.remoteNameUpdaters.get(sid);
                if (updater) updater(plbl.text, plbl.color, plbl.suffix);
                // テクスチャURLが変わっていたらアバターを再作成
                const newSheetUrl = (prof.textureUrl && prof.textureUrl.includes("/s3/")) ? prof.textureUrl : "/s3/avatars/001-pipo-nekonin008.png";
                const cc = prof.charCol ?? 0;
                const cr = prof.charRow ?? 0;
                if (game.spriteAvatarSystem.has(sid)) {
                    // 現在のアバターのテクスチャと異なる場合のみ再作成
                    const oldAvatar = game.remoteAvatars.get(sid);
                    const oldPos = oldAvatar?.position ?? { x: 0, z: 0 };
                    const oldRy = oldAvatar?.rotation?.y ?? 0;
                    game.spriteAvatarSystem.createAvatar(sid, newSheetUrl, cc, cr, oldPos.x, oldPos.z, plbl.text, undefined, oldRy).then(root => {
                        game.remoteAvatars.set(sid, root as unknown as Mesh);
                        game.remoteNameUpdaters.set(sid, game.spriteAvatarSystem.getNameUpdate(sid)!);
                        const su = game.spriteAvatarSystem.getSpeechUpdate(sid);
                        if (su) game.remoteSpeeches.set(sid, su);
                        const upd2 = game.spriteAvatarSystem.getNameUpdate(sid);
                        if (upd2) upd2(plbl.text, plbl.color, plbl.suffix);
                    }).catch(e => console.warn("UIPanel: createAvatar failed:", e));
                }
            }
        }
        scheduleRenderUserList();
    };

    game.nakama.onAOIEnter = (sessionId: string, x: number, z: number, ry: number) => {
        console.log(`rcv AOI_ENTER sid=${sessionId.slice(0, 8)} x=${(+x).toFixed(1)} z=${(+z).toFixed(1)} ry=${(+ry).toFixed(2)}`);
        if (sessionId === game.nakama.selfSessionId) return;
        // userMap に存在しないセッション = 既にキック/退出済み → 無視（ゴースト防止）
        if (!userMap.has(sessionId)) {
            console.log(`rcv AOI_ENTER SKIP sid=${sessionId.slice(0, 8)} (not in userMap)`);
            return;
        }
        const cached = profileCache.get(sessionId);
        const username = userMap.get(sessionId)?.username ?? sessionId.slice(0, 8);
        const displayName = cached?.displayName ?? "";
        const aoiLbl = resolveDisplayLabel(displayName, username, sessionId);
        const sheetUrl = (cached?.textureUrl && cached.textureUrl.includes("/s3/")) ? cached.textureUrl : "/s3/avatars/001-pipo-nekonin008.png";
        if (game.spriteAvatarSystem.has(sessionId)) {
            game.spriteAvatarSystem.setPosition(sessionId, x, z);
            game.spriteAvatarSystem.setRotation(sessionId, ry);
            game.spriteAvatarSystem.setEnabled(sessionId, true);
        } else if (!game.spriteAvatarSystem.isCreating(sessionId)) {
            const cc = cached?.charCol ?? 0;
            const cr = cached?.charRow ?? 0;
            game.spriteAvatarSystem.createAvatar(sessionId, sheetUrl, cc, cr, x, z, aoiLbl.text, undefined, ry).then(root => {
                game.remoteAvatars.set(sessionId, root as unknown as Mesh);
                game.remoteNameUpdaters.set(sessionId, game.spriteAvatarSystem.getNameUpdate(sessionId)!);
                const su = game.spriteAvatarSystem.getSpeechUpdate(sessionId);
                if (su) game.remoteSpeeches.set(sessionId, su);
                const upd = game.spriteAvatarSystem.getNameUpdate(sessionId);
                if (upd) upd(aoiLbl.text, aoiLbl.color, aoiLbl.suffix);
                // 作成中にprofileResponseが到着しキャッシュが更新されていたら再作成
                const latest = profileCache.get(sessionId);
                const latestUrl = (latest?.textureUrl && latest.textureUrl.includes("/s3/")) ? latest.textureUrl : null;
                if (latestUrl && (latestUrl !== sheetUrl || (latest!.charCol ?? 0) !== cc || (latest!.charRow ?? 0) !== cr)) {
                    const lbl2 = resolveDisplayLabel(latest!.displayName ?? "", userMap.get(sessionId)?.username ?? sessionId.slice(0, 8), sessionId);
                    game.spriteAvatarSystem.createAvatar(sessionId, latestUrl, latest!.charCol ?? 0, latest!.charRow ?? 0, root.position.x, root.position.z, lbl2.text, undefined, root.rotation.y).then(root2 => {
                        game.remoteAvatars.set(sessionId, root2 as unknown as Mesh);
                        game.remoteNameUpdaters.set(sessionId, game.spriteAvatarSystem.getNameUpdate(sessionId)!);
                        const su2 = game.spriteAvatarSystem.getSpeechUpdate(sessionId);
                        if (su2) game.remoteSpeeches.set(sessionId, su2);
                        const upd2 = game.spriteAvatarSystem.getNameUpdate(sessionId);
                        if (upd2) upd2(lbl2.text, lbl2.color, lbl2.suffix);
                    }).catch(e => console.warn("UIPanel: createAvatar failed:", e));
                }
            }).catch(e => console.warn("UIPanel: createAvatar failed:", e));
        }
        game.remoteTargets.delete(sessionId);
        // キャッシュ未取得ならRPCで取得予約
        if (!profileCache.has(sessionId)) {
            pendingProfileSids.add(sessionId);
            scheduleProfileFetch();
        }
    };
    game.nakama.onDisplayName = (sessionId: string, displayName: string, nameColor?: string) => {
        console.log(`rcv onDisplayName sid=${sessionId.slice(0, 8)} displayName=${displayName} nc=${nameColor}`);
        // アバターのnameTag更新
        const username = userMap.get(sessionId)?.username ?? sessionId.slice(0, 8);
        const lbl = resolveDisplayLabel(displayName, username, sessionId);
        const updater = game.remoteNameUpdaters.get(sessionId);
        if (updater) updater(lbl.text, lbl.color, lbl.suffix);
        // ユーザリストの表示名・名前色更新
        let userId: string | undefined;
        for (const [sid, entry] of userMap) {
            if (entry.sessionId === sessionId) {
                userMap.set(sid, { ...entry, displayName, nameColor: nameColor || entry.nameColor });
                userId = entry.uuid;
                break;
            }
        }
        // 同一 UID の別セッション（別デバイス/別ブラウザ）からの変更は、自分自身にも反映する
        if (userId && userId === game.currentUserId && sessionId !== game.nakama.selfSessionId) {
            console.log(`rcv onDisplayName: adopting cross-session change displayName=${displayName}`);
            game.nakama.selfDisplayName = displayName;
            if (nameColor) game.nakama.selfNameColor = nameColor;
            const selfUsername = loginNameInput?.value ?? "";
            const selfLbl = resolveDisplayLabel(displayName, selfUsername, game.nakama.selfSessionId ?? undefined);
            game.updatePlayerNameTag(selfLbl.text, selfLbl.color, selfLbl.suffix);
            const dnInput = document.getElementById("displayNameInput") as HTMLInputElement | null;
            if (dnInput) dnInput.value = displayName;
            confirmedDisplayName = displayName;
            const mySid = game.nakama.selfSessionId;
            if (mySid) {
                const me = userMap.get(mySid);
                if (me) userMap.set(mySid, { ...me, displayName, nameColor: nameColor || me.nameColor });
            }
        }
        // 既存オーバーレイメッセージの名前色を一括更新
        if (nameColor && userId) updateOverlayNameColor(userId, nameColor);
        scheduleRenderUserList();
    };
    game.nakama.onAOILeave = (sessionId: string) => {
        console.log(`rcv AOI_LEAVE sid=${sessionId.slice(0, 8)}`);
        if (sessionId === game.nakama.selfSessionId) return;
        const av = game.remoteAvatars.get(sessionId);
        if (av) av.setEnabled(false);
        game.spriteAvatarSystem.setEnabled(sessionId, false);
        game.remoteTargets.delete(sessionId);
    };

    // --- アバター・オブジェクトプール ---
    const avatarPool: { av: import("@babylonjs/core").Mesh; nameUpdate: (n: string) => void; speechUpdate: (t: string) => void }[] = [];
    const MAX_POOL_SIZE = 32;

    /** 遅延生成 + プール再利用でリモートアバターを確保する */
    const removeRemoteAvatar = (sessionId: string) => {
        cc("removeRemoteAvatar");
        const _end = prof("UIPanel.removeRemoteAvatar");
        // スプライトアバターを破棄
        game.spriteAvatarSystem.dispose(sessionId);
        const av = game.remoteAvatars.get(sessionId);
        if (!av) { _end(); return; }
        const nameUpdate = game.remoteNameUpdaters.get(sessionId);
        const speechUpdate = game.remoteSpeeches.get(sessionId);
        game.remoteAvatars.delete(sessionId);
        game.remoteTargets.delete(sessionId);
        game.remoteSpeeches.delete(sessionId);
        game.remoteNameUpdaters.delete(sessionId);
        // プールに回収（上限超えたらdispose）
        if (nameUpdate && speechUpdate && avatarPool.length < MAX_POOL_SIZE) {
            av.setEnabled(false);
            avatarPool.push({ av, nameUpdate, speechUpdate });
        } else {
            av.dispose();
        }
        _end();
    };

    // 古いセッションのクリーンアップはサーバーの leave イベントに委任
    // （同一ユーザが複数ブラウザでログインするケースをサポート）

    // チャンネル情報を付与してuserMapに追加/更新
    /** 同一UUIDのセッション数が変わったら自分の表示名サフィックスを更新 */
    const refreshSelfSuffix = () => {
        const selfSid = game.nakama.selfSessionId;
        if (!selfSid) return;
        const selfEntry = userMap.get(selfSid);
        if (!selfEntry) return;
        const selfDn = game.nakama.selfDisplayName ?? "";
        const selfUsername = loginNameInput?.value ?? "";
        const lbl = resolveDisplayLabel(selfDn, selfUsername, selfSid);
        game.updatePlayerNameTag(lbl.text, lbl.color, lbl.suffix);
    };
    game.refreshSelfNameTag = refreshSelfSuffix;

    // マッチプレゼンス: ユーザー管理の唯一のソース（joinChat 廃止済み）
    game.nakama.onMatchPresenceJoin = (sessionId, userId, username) => {
        cc("onMatchPresenceJoin");
        const existing = userMap.get(sessionId);
        if (!existing) {
            userMap.set(sessionId, { username, displayName: "", uuid: userId, sessionId, loginTimestamp: Date.now(), loginTime: "…", channel: "match" });
        }
        // アバターが既に存在する場合、名前タグを更新
        if (sessionId !== game.nakama.selfSessionId && game.spriteAvatarSystem.has(sessionId)) {
            const dn = userMap.get(sessionId)?.displayName ?? "";
            const lbl = resolveDisplayLabel(dn, username, sessionId);
            const updater = game.spriteAvatarSystem.getNameUpdate(sessionId);
            if (updater) updater(lbl.text, lbl.color, lbl.suffix);
        }
        scheduleRenderUserList();
        refreshSelfSuffix();
    };
    game.nakama.onMatchPresenceLeave = (sessionId, _userId, _uname) => {
        cc("onMatchPresenceLeave");
        userMap.delete(sessionId);
        removeRemoteAvatar(sessionId);
        scheduleRenderUserList();
        refreshSelfSuffix();
    };
    // システムメッセージ: サーバーからのログイン/ログアウト通知
    game.nakama.onSystemMessage = (type, username, userId, sessionId, uidCount, serverNameColor, ts, msgDisplayName, hasGoogle, isAdmin) => {
        const existing = [...userMap.values()].find(e => e.uuid === userId);
        // 表示名はサーバメッセージを優先（userMap 未登録時もアイコン付きで表示）
        const displayName = (msgDisplayName && msgDisplayName !== "") ? msgDisplayName : (existing?.displayName ?? "");
        const nameText = displayName || ("@" + username);
        // 同一UIDのセッションが複数ある場合のみ #xxxx を付加
        const hashSuffix = (sessionId && uidCount >= 2) ? "#" + sessionId.slice(0, 4) : "";
        const icon = isAdmin ? " \u{1F451}" : (hasGoogle ? " \u2705" : "");
        const nameColor = serverNameColor || existing?.nameColor;
        const uidColorInput = document.getElementById("uidColorInput") as HTMLInputElement | null;
        const fallbackColor = uidColorInput?.value ?? "#00bbfa";
        const color = sanitizeColor(nameColor || (displayName ? "" : fallbackColor) || "");
        const colorStyle = color ? ` style="color:${color}"` : "";
        const nameHtml = `<span class="chat-ol-name"${colorStyle}>${escapeHtml(nameText)}${escapeHtml(hashSuffix)}${escapeHtml(icon)}</span>`;
        if (type === "join") {
            addChatHistory("[system]", t("system.user_joined").replace("{username}", nameHtml), undefined, userId, ts);
        } else if (type === "world_enter") {
            // ワールド切替中の自分自身の enter は抑制
            if (game.nakama.changingWorld) return;
            addChatHistory("[system]", t("system.user_world_enter").replace("{username}", nameHtml), undefined, userId, ts);
        } else if (type === "leave") {
            // ワールド切替中の自分自身の leave は抑制
            if (game.nakama.changingWorld) return;
            addChatHistory("[system]", t("system.user_left").replace("{username}", nameHtml), undefined, userId, ts);
        } else if (type === "world_move") {
            addChatHistory("[system]", t("system.user_world_move").replace("{username}", nameHtml), undefined, userId, ts);
        }
    };

    /** ログインUI行の表示/非表示 */
    const setLoginRowVisible = (visible: boolean) => {
        const loginRow = document.getElementById("login-row");
        if (loginRow) loginRow.style.display = visible ? "" : "none";
    };

    const setLoginMode = () => {
        if (loginBtn) {
            loginBtn.textContent = "ログイン";
            loginBtn.style.display = "";
            loginBtn.onclick = doLogin;
        }
        if (loginNameInput) {
            loginNameInput.disabled = false;
            loginNameInput.onkeydown = (e) => {
                if (e.key === "Enter") { e.preventDefault(); doLogin(); }
            };
        }
        { const slr = document.getElementById("settings-logout-row"); if (slr) slr.style.display = "none"; }
        { const mli = document.getElementById("menu-login"); if (mli) mli.style.display = "none"; }
        { const mav = document.getElementById("menu-avatar"); if (mav) mav.style.display = "none"; }
        { const mr = document.getElementById("menu-bookmarks"); if (mr) mr.style.display = "none"; }
        { const mr2 = document.getElementById("menu-rooms"); if (mr2) mr2.style.display = "none"; }
        { const fv = document.getElementById("app-footer-version"); if (fv) fv.style.display = ""; }
        setLoginRowVisible(true);
    };

    if (loginBtn) loginBtn.title = "tommieChatサーバへログインします。\nサーバURL: " + location.host;

    const isMobile = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
    if (loginStatus) {
        loginStatus.textContent = "";
    }

    // ===== サーバ接続ログ =====
    const serverUrl = location.host;
    const addServerLog = (label: string, detail = "", hint = "") => {
        const list = document.getElementById("server-log-list");
        if (!list) return;
        const panel = document.getElementById("server-log-panel");
        const inactive = !panel || panel.style.display === "none" || panel.classList.contains("minimized");
        const now = new Date();
        const ts = now.toLocaleString(undefined, {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            fractionalSecondDigits: 3,
        }) as string;
        const entry = document.createElement("div");
        entry.className = "server-log-entry";
        entry.textContent = hint
            ? `${ts} ${label} : ${hint} URL="${serverUrl}" ${detail}`.trimEnd()
            : `${ts} ${label} URL="${serverUrl}"` + (detail ? ` ${detail}` : "");
        list.appendChild(entry);
        // エントリ数上限
        const MAX_LOG_ENTRIES = 500;
        while (list.childElementCount > MAX_LOG_ENTRIES) list.firstElementChild?.remove();
        // 非表示中は scrollHeight 読み取りによる強制レイアウトをスキップ
        if (!inactive) list.scrollTop = list.scrollHeight;
    };
    // ===========================
    const NAKAMA_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@+\-]{5,127}$/;
    const doLogin = async () => {
        const _end = prof("UIPanel.doLogin");
        const name = loginNameInput?.value.trim();
        if (!name || name.length < 6) {
            if (loginStatus) {
                loginStatus.style.color = "#ff8800";
                loginStatus.textContent = isMobile ? "✗" : t("login.validation.short");
            }
            _end(); return;
        }
        if (!NAKAMA_ID_RE.test(name)) {
            if (loginStatus) {
                loginStatus.style.color = "#ff4444";
                loginStatus.textContent = isMobile ? "✗" : t("login.validation.chars");
            }
            _end(); return;
        }
        game.updatePlayerNameTag(name);
        setCookie("loginName", name);
        if (loginStatus) { loginStatus.style.color = ""; loginStatus.textContent = isMobile ? "…" : t("login.connecting"); }
        if (loginBtn)    loginBtn.disabled = true;
        try {
            await game.nakama.login(name);
            game.currentUserId = game.nakama.getSession()?.user_id ?? null;
            // 自分のdisplay_nameでアバター名を更新（joinWorldMatch前にawaitしてselfDisplayNameを確定）
            if (game.currentUserId) {
                const displayNameInput = document.getElementById("displayNameInput") as HTMLInputElement | null;
                try {
                    const names = await game.nakama.getDisplayNames([game.currentUserId]);
                    const entry = names.get(game.currentUserId!);
                    const dname = entry?.displayName ?? "";
                    {
                        const lbl = resolveDisplayLabel(dname, name, game.nakama.selfSessionId ?? undefined);
                        game.updatePlayerNameTag(lbl.text, lbl.color, lbl.suffix);
                        if (displayNameInput) displayNameInput.value = dname;
                        confirmedDisplayName = dname;
                        game.nakama.selfDisplayName = dname;
                        // プレイヤーリストの自分の表示名も更新
                        const sid = game.nakama.selfSessionId;
                        if (sid) {
                            const existing = userMap.get(sid);
                            if (existing) {
                                userMap.set(sid, { ...existing, displayName: dname });
                                scheduleRenderUserList();
                            }
                        }
                    }
                } catch (e) { console.warn("UIPanel.getDisplayNames:", e); }
            }
            await game.loadChunksFromDB(game.currentUserId ?? "anonymous");
            // 初期アバター選択: localStorage に保存済みでなければ、/s3/avatars/ 一覧の先頭を選ぶ
            if (!localStorage.getItem("spriteAvatarUrl")) {
                try {
                    const res = await fetch("/s3/avatars/");
                    const xml = await res.text();
                    const doc = new DOMParser().parseFromString(xml, "application/xml");
                    const keys = Array.from(doc.querySelectorAll("Contents > Key"))
                        .map(k => k.textContent ?? "")
                        .filter(n => n && /\.(png|jpg|jpeg)$/i.test(n))
                        .sort();
                    if (keys.length > 0) {
                        const url = "/s3/avatars/" + keys[0];
                        game.playerTextureUrl = url;
                        localStorage.setItem("spriteAvatarUrl", url);
                        const selfId = "__self__";
                        const p = game.playerBox.position;
                        await game.spriteAvatarSystem.createAvatar(
                            selfId, url, game.playerCharCol, game.playerCharRow,
                            p.x, p.z, "", undefined, game.playerBox.rotation.y,
                        );
                        game.spriteAvatarSystem.setPosition(selfId, p.x, p.z);
                        game.playerBox.getChildMeshes().forEach(m => m.isVisible = false);
                        game.refreshSelfNameTag?.();
                    }
                } catch (e) { console.warn("UIPanel.initialAvatar:", e); }
            }
            // joinMatch 1回で全て完結（メタデータに初期位置を含める）
            { const p = game.playerBox;
              // タブ固有キーで prevSid を管理（同一ブラウザの複数タブを区別）
              const tabId = sessionStorage.getItem("tabId") ?? (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
              sessionStorage.setItem("tabId", tabId);
              const prevSidKey = `prevSessionId_${tabId}`;
              const prevSid = localStorage.getItem(prevSidKey) ?? "";
              await game.nakama.joinWorldMatch({
                x: String(p.position.x), z: String(p.position.z), ry: String(p.rotation.y),
                tx: game.playerTextureUrl, dn: game.nakama.selfDisplayName ?? "",
                lt: new Date().toISOString(),
                cc: String(game.playerCharCol), cr: String(game.playerCharRow),
                nc: game.nakama.selfNameColor,
                prevSid,
            }); }
            // joinMatch 成功後に sessionId を保存（次回リロード時の prevSid 用）
            { const tid = sessionStorage.getItem("tabId") ?? "";
              if (game.nakama.selfSessionId && tid) {
                localStorage.setItem(`prevSessionId_${tid}`, game.nakama.selfSessionId);
            } }
            // 自分自身をプレイヤーリストに確実に登録
            {
                const sid = game.nakama.selfSessionId;
                const uid = game.currentUserId;
                if (sid && uid && !userMap.has(sid)) {
                    userMap.set(sid, { username: name, displayName: game.nakama.selfDisplayName ?? "", uuid: uid, sessionId: sid, loginTimestamp: Date.now(), loginTime: "…", channel: "match" });
                }
                scheduleRenderUserList();
            }
            // 自分のプロフィールをサーバから取得（loginTime等）
            {
                const sid = game.nakama.selfSessionId;
                if (sid) {
                    pendingProfileSids.add(sid);
                    scheduleProfileFetch();
                }
            }
            // matchId確定後にAOIを強制送信（selfMatchIdガードで未送信になったAOI_UPDATEを再実行）
            game.aoiManager.lastAOI = { minCX: -1, minCZ: -1, maxCX: -1, maxCZ: -1 };
            game.aoiManager.updateAOI();
            // プレイヤーリスト: ログイン後に購読開始（パネル表示中ならfull、非表示ならcount）
            if (isUlPanelVisible()) {
                subPlayerListFull();
            } else {
                subPlayerListCount();
            }

            // ブロック更新通知の受信
            game.nakama.onBlockUpdate = (gx, gz, blockId, r, g, b, a) => {
                console.log(`rcv onBlockUpdate gx=${gx} gz=${gz} blockId=${blockId} rgb=(${r},${g},${b})`);
                const CS = CHUNK_SIZE;
                const cx = Math.floor(gx / CS), cz = Math.floor(gz / CS);
                const lx = gx % CS, lz = gz % CS;
                const si = (lx * CS + lz) * 6;
                const key = `${cx}_${cz}`;
                let ch = game.chunks.get(key);
                if (!ch) { ch = { cells: new Uint8Array(CS * CS * 6), hash: 0n }; game.chunks.set(key, ch); }
                ch.cells[si]   = blockId & 0xFF;
                ch.cells[si+1] = (blockId >> 8) & 0xFF;
                ch.cells[si+2] = r; ch.cells[si+3] = g;
                ch.cells[si+4] = b; ch.cells[si+5] = a;
                ch.hash = fnv1a64(ch.cells);
                game.placeBlock(gx, gz, blockId, r, g, b, a);
            };

            // IndexedDB にあるチャンクのブロックをまず描画
            {
                const CS = CHUNK_SIZE;
                for (const [key, ch] of game.chunks) {
                    const parts = key.split("_");
                    const cx = parseInt(parts[0], 10), cz = parseInt(parts[1], 10);
                    const baseGX = cx * CS, baseGZ = cz * CS;
                    for (let lx = 0; lx < CS; lx++) {
                        for (let lz = 0; lz < CS; lz++) {
                            const si = (lx * CS + lz) * 6;
                            const blockId = ch.cells[si] | (ch.cells[si + 1] << 8);
                            if (blockId !== 0) game.placeBlock(baseGX + lx, baseGZ + lz, blockId, ch.cells[si + 2], ch.cells[si + 3], ch.cells[si + 4], ch.cells[si + 5]);
                        }
                    }
                }
                game.syncAOIChunks().catch((e) => console.warn("UIPanel:", e));
            }

            { const p = game.playerBox; game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y, game.playerTextureUrl, game.playerCharCol, game.playerCharRow).catch((e) => console.warn("UIPanel:", e)); }
            game.aoiManager.updateAOI();
            const srvInfo = await game.nakama.getServerInfo();
            game.connectionState = "connected";
            addServerLog(t("log.login_success"), srvInfo);
            // 部屋のチャット履歴を遅延フェッチ（パネル表示中のみ実行）
            chatLoader.fn?.();
            // getServerInfo で取得した Google Client ID をクライアント OAuth に設定
            {
                const cid = game.nakama.googleClientId;
                if (cid) {
                    const api = (window as unknown as { tommieGoogleOAuth?: { setClientId: (id: string) => void } }).tommieGoogleOAuth;
                    api?.setClientId(cid);
                }
            }
            // getServerInfo で googleOAuthErr が確定した後、ボタン状態を反映
            {
                const oauthErr = game.nakama.googleOAuthErr;
                const gBtn = document.getElementById("googleLinkBtn") as HTMLButtonElement | null;
                const gRes = document.getElementById("googleLinkResult");
                if (gBtn && oauthErr && oauthErr > 0) {
                    gBtn.disabled = true;
                    gBtn.style.opacity = "0.4";
                    gBtn.style.cursor = "not-allowed";
                    if (gRes) {
                        gRes.textContent = `サーバ：設定エラー:${String(oauthErr).padStart(3, "0")}`;
                        gRes.style.color = "#c00";
                    }
                }
            }
            // アカウント情報（Google リンク状態等）を最新化
            refreshAccountStatus?.();
            if (loginStatus) {
                loginStatus.style.color = "#00dd55";
                loginStatus.style.fontWeight = "bold";
                loginStatus.style.textShadow = "0 1px 2px rgba(0,0,0,0.4)";
                loginStatus.textContent = isMobile ? "✓" : t("login.success");
                setTimeout(() => { loginStatus.textContent = ""; loginStatus.style.fontWeight = ""; loginStatus.style.textShadow = ""; }, 3000);
            }
            if (loginBtn) {
                loginBtn.style.display = "none";
            }
            setLoginRowVisible(false);
            { const slr = document.getElementById("settings-logout-row"); if (slr) slr.style.display = ""; }
            { const mli = document.getElementById("menu-login"); if (mli) mli.style.display = ""; }
            { const mav = document.getElementById("menu-avatar"); if (mav) mav.style.display = ""; }
            { const mr = document.getElementById("menu-bookmarks"); if (mr) mr.style.display = ""; }
            { const mr2 = document.getElementById("menu-rooms"); if (mr2) mr2.style.display = ""; }
            if (loginNameInput) { loginNameInput.onkeydown = null; loginNameInput.disabled = true; }
            { const di = document.getElementById("displayNameInput") as HTMLInputElement | null; if (di) { di.disabled = false; di.placeholder = t("displayname.placeholder.enabled"); } }
            { const db = document.getElementById("displayNameBtn") as HTMLButtonElement | null; if (db) { db.disabled = true; } }
            // 表示名パネルにユーザIDを反映
            { const uid = document.getElementById("dn-panel-userid"); if (uid) uid.textContent = loginNameInput?.value ?? "-"; }
            // 表示名が未設定なら表示名設定パネルを自動表示
            if (!confirmedDisplayName) {
                const mli = document.getElementById("menu-login");
                const dnp = document.getElementById("displayname-panel");
                if (mli && dnp && dnp.style.display === "none") mli.click();
            }
            // WebSocket切断時の自動再接続コールバック
            game.nakama.onMatchDisconnect = () => {
                console.warn("UIPanel match disconnected, auto-reconnect in progress");
                game.connectionState = "retry";
                stopPing();
                // プレイヤーリストをクリア
                userMap.clear();
                scheduleRenderUserList();
                // リモートアバターを全破棄（再接続後 AOI_ENTER で再作成される）
                for (const sid of [...game.remoteAvatars.keys()]) removeRemoteAvatar(sid);
                // 吹き出しタイマーをクリア
                for (const t of speechTimers.values()) clearTimeout(t);
                speechTimers.clear();
                speechFading.clear();
                // initPosGuard をクリア
                initPosGuard.clear();
                addServerLog(t("log.match_disconnect"), t("log.match_disconnect.detail"));
            };
            // 再接続時にメタデータを提供
            game.nakama.getReconnectMeta = () => {
                const p = game.playerBox;
                const tid = sessionStorage.getItem("tabId") ?? "";
                return {
                    x: String(p.position.x), z: String(p.position.z), ry: String(p.rotation.y),
                    tx: game.playerTextureUrl, dn: game.nakama.selfDisplayName ?? "",
                    lt: new Date().toISOString(),
                    cc: String(game.playerCharCol), cr: String(game.playerCharRow),
                    nc: game.nakama.selfNameColor,
                    prevSid: tid ? (localStorage.getItem(`prevSessionId_${tid}`) ?? "") : "",
                };
            };
            game.nakama.onMatchReconnect = () => {
                console.log("UIPanel match reconnected");
                game.connectionState = "connected";
                addServerLog(t("log.match_reconnect"), t("log.match_reconnect.detail"));
                // 自分自身をプレイヤーリストに displayName 付きで再登録
                {
                    const sid = game.nakama.selfSessionId;
                    const uid = game.currentUserId;
                    if (sid && uid) {
                        const existing = userMap.get(sid);
                        if (existing) {
                            userMap.set(sid, { ...existing, displayName: game.nakama.selfDisplayName ?? "" });
                        }
                    }
                    scheduleRenderUserList();
                }
                // プレイヤーリスト購読を再確立（再接続で旧マッチのサブスクが失われるため）
                _playerListMode = null;
                if (isUlPanelVisible()) {
                    subPlayerListFull();
                } else {
                    subPlayerListCount();
                }
                // 自分のプロフィール（loginTime等）をサーバから再取得
                {
                    const sid = game.nakama.selfSessionId;
                    if (sid) {
                        pendingProfileSids.add(sid);
                        scheduleProfileFetch();
                    }
                }
                // 自分の位置・テクスチャを再送信（他プレイヤーに表示名・ログイン時刻を通知）
                { const p = game.playerBox; game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y, game.playerTextureUrl, game.playerCharCol, game.playerCharRow).catch((e) => console.warn("UIPanel:", e)); }
                game.aoiManager.lastAOI = { minCX: -1, minCZ: -1, maxCX: -1, maxCZ: -1 };
                game.aoiManager.updateAOI();
                // 切断中のブロック変更をハッシュ比較で同期
                game.syncAOIChunks().catch((e) => console.warn("UIPanel:", e));
                startPing();
                restartCcu();
            };
            startPing();
            const ccuPanel = document.getElementById("ccu-panel");
            if (ccuPanel && ccuPanel.style.display !== "none") startCcu();
        } catch (e) {
            let reason: string;
            if (e instanceof Error) {
                reason = e.message;
            } else if (e instanceof Response) {
                try {
                    const body = await e.json() as { message?: string; error?: string };
                    reason = body.message ?? body.error ?? `HTTP ${e.status} ${e.statusText}`;
                } catch {
                    reason = `HTTP ${e.status} ${e.statusText}`;
                }
            } else {
                reason = String(e);
            }
            if (reason === "Not Found") reason += ": " + t("error.not_found");
            const usedKey = import.meta.env.VITE_SERVER_KEY || "defaultkey";
            const hint = reason.includes("Failed to parse URL") ? t("error.bad_url")
                       : reason === "Failed to fetch"           ? t("error.fetch_failed")
                       : reason.includes("Username is already in use") ? t("error.username_conflict")
                       : reason.includes("too many logins") ? t("error.too_many_logins")
                       : /[Ss]erver key invalid|Invalid server key/.test(reason) ? `Server Key invalid. Used: ${usedKey}`
                       : "";
            addServerLog(t("log.login_failed"), reason, hint);
            if (loginStatus) {
                loginStatus.style.color = "#ff4444";
                loginStatus.textContent = isMobile ? "✗" : t("login.failed") + reason;
            }
            // 自動ログイン失敗時はログインUIを表示してリカバリ
            setLoginRowVisible(true);
        } finally {
            if (loginBtn) loginBtn.disabled = false;
            _end();
        }
    };

    // ===== 表示名設定 =====
    let confirmedDisplayName = "";
    {
        const displayNameInput = document.getElementById("displayNameInput") as HTMLInputElement | null;
        const displayNameBtn = document.getElementById("displayNameBtn") as HTMLButtonElement | null;
        const displayNameStatus = document.getElementById("displayNameStatus") as HTMLSpanElement | null;
        let dnStatusTimer: ReturnType<typeof setTimeout> | null = null;
        const showDnStatus = (text: string, color: string) => {
            if (!displayNameStatus) return;
            if (dnStatusTimer) clearTimeout(dnStatusTimer);
            displayNameStatus.style.color = color;
            displayNameStatus.style.fontWeight = "bold";
            displayNameStatus.style.textShadow = "0 1px 2px rgba(0,0,0,0.4)";
            displayNameStatus.textContent = text;
            dnStatusTimer = setTimeout(() => { displayNameStatus.textContent = ""; displayNameStatus.style.fontWeight = ""; displayNameStatus.style.textShadow = ""; dnStatusTimer = null; }, 3000);
        };
        if (displayNameInput && displayNameBtn) {
            displayNameInput.addEventListener("keydown", (e) => {
                if (displayNameInput.value.length >= 20 && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                    showDnStatus(t("displayname.maxlen"), "#ff4444");
                }
            });
            displayNameInput.addEventListener("input", () => {
                const val = displayNameInput.value.trim();
                if (val.length > 20) {
                    showDnStatus(t("displayname.maxlen"), "#ff4444");
                    displayNameBtn.disabled = true;
                    displayNameBtn.style.background = "";
                    return;
                }
                const changed = !displayNameInput.disabled && val !== confirmedDisplayName;
                displayNameBtn.disabled = !changed;
                displayNameBtn.style.background = changed ? "#28a745" : "";
            });
        }
        const doChangeDisplayName = async () => {
            const _end = prof("UIPanel.doChangeDisplayName");
            try {
            if (!displayNameInput) return;
            const name = displayNameInput.value.trim();
            if (/[\x00-\x1f\x7f]/.test(name)) {
                if (displayNameStatus) { displayNameStatus.style.color = "#ff4444"; displayNameStatus.textContent = t("displayname.control_char"); }
                return;
            }
            if (!game.nakama.getSession()) {
                if (displayNameStatus) { displayNameStatus.style.color = "#ff8800"; displayNameStatus.textContent = t("displayname.need_login"); }
                return;
            }
            try {
                await game.nakama.updateDisplayName(name);
                game.nakama.selfDisplayName = name;
                game.nakama.sendDisplayName(name).catch((e) => console.warn("UIPanel:", e));
                const selfUsername = loginNameInput?.value ?? "";
                const lbl = resolveDisplayLabel(name, selfUsername, game.nakama.selfSessionId ?? undefined);
                game.updatePlayerNameTag(lbl.text, lbl.color, lbl.suffix);
                // 自分のユーザリスト表示名も更新
                const mySid = game.nakama.selfSessionId;
                if (mySid) {
                    const me = userMap.get(mySid);
                    if (me) { userMap.set(mySid, { ...me, displayName: name }); scheduleRenderUserList(); }
                }
                confirmedDisplayName = name;
                if (displayNameBtn) { displayNameBtn.disabled = true; displayNameBtn.style.background = ""; }
                showDnStatus(t("displayname.success"), "#00dd55");
                addServerLog(t("log.displayname_change"), t("log.displayname_set").replace("{name}", name));
            } catch (err) {
                const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err) ? String((err as any).message) : String(err);
                if (displayNameStatus) { displayNameStatus.style.color = "#ff4444"; displayNameStatus.textContent = "✗ " + msg; }
                addServerLog(t("log.displayname_failed"), msg);
            }
            } finally { _end(); }
        };
        if (displayNameInput) {
            displayNameInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); doChangeDisplayName(); } };
        }
        if (displayNameBtn) {
            displayNameBtn.onclick = doChangeDisplayName;
        }
    }

    // ===== ping 計測 & グラフ =====
    const pingDisplay    = document.getElementById("ping-display");
    const PING_INTERVAL_MS  = 3000;
    const PING_SAMPLES      = 3;
    const PING_HISTORY_MAX  = 60;
    const pingSamples: number[] = [];
    const pingHistory: number[] = [];
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const drawPingGraph = () => {
        const _end = prof("UIPanel.drawPingGraph");
        try {
        const ppanel  = document.getElementById("ping-panel");
        const pheader = document.getElementById("ping-header");
        if (!ppanel || !pheader) return;
        // パネル非表示時は Canvas 描画をスキップ（RPC による死活監視は継続）
        if (ppanel.style.display === "none") return;
        const canvas = document.getElementById("ping-canvas") as HTMLCanvasElement | null;
        if (!canvas) return;
        // タブバー表示中はヘッダーが非表示なのでタブバー高さを使う
        const tabBar = ppanel.querySelector<HTMLElement>("#panel-tab-bar");
        const headerH = tabBar ? tabBar.offsetHeight : pheader.offsetHeight;
        canvas.style.top = headerH + "px";
        const w = ppanel.clientWidth, h = ppanel.clientHeight - headerH;
        if (w <= 0 || h <= 0) return;
        canvas.style.width  = w + "px";
        canvas.style.height = h + "px";
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const dark = document.body.classList.contains("theme-dark");
        const FONT_SIZE = dark ? 15 : 12;
        const FONT_MONO = '"Courier New", Courier, monospace';
        const FONT_STR  = `${FONT_SIZE}px ${FONT_MONO}`;
        const FONT_BOLD = `bold ${FONT_SIZE}px ${FONT_MONO}`;
        const AXIS_H = dark ? 26 : 16;
        const gh     = h - AXIS_H;
        ctx.clearRect(0, 0, w, h);

        const validPings = pingHistory.filter(v => v >= 0);
        const maxPing = Math.max(100, ...(validPings.length ? validPings : [0])) * 1.1;
        const toY = (ms: number) => gh - Math.min(ms / maxPing, 1) * gh;

        const gridMajor = dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.20)";
        const gridSub   = dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)";
        const labelCol  = dark ? "#eee" : "#000";

        ctx.lineWidth = 1;
        const subStep = 10;
        // 横グリッド描画 — Y軸ラベルを右揃え
        ctx.font = FONT_STR;
        const pingMajorLabels: { text: string; yp: number }[] = [];
        for (let ms = subStep; ms < maxPing; ms += subStep) {
            const yp = toY(ms);
            if (yp < 0) break;
            const isMajor = ms % 50 === 0;
            ctx.strokeStyle = isMajor ? gridMajor : gridSub;
            ctx.setLineDash(isMajor ? [4, 3] : [2, 5]);
            ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(w, yp); ctx.stroke();
            if (isMajor) pingMajorLabels.push({ text: `${ms}ms`, yp });
        }
        if (pingMajorLabels.length > 0) {
            ctx.fillStyle = labelCol;
            const maxLabelW = Math.max(...pingMajorLabels.map(l => ctx.measureText(l.text).width));
            for (const { text, yp } of pingMajorLabels) {
                const tw = ctx.measureText(text).width;
                ctx.fillText(text, 2 + maxLabelW - tw, yp - 2);
            }
        }
        ctx.setLineDash([]);

        const step    = w / (PING_HISTORY_MAX - 1);
        const offsetX = (PING_HISTORY_MAX - pingHistory.length) * step;
        const TICK_STEP = 10;
        for (let n = TICK_STEP; n < PING_HISTORY_MAX; n += TICK_STEP) {
            const xp = Math.round((PING_HISTORY_MAX - 1 - n) * step);
            if (xp < 0 || xp > w) continue;
            ctx.strokeStyle = dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)";
            ctx.setLineDash([2, 4]);
            ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, gh); ctx.stroke();
            ctx.setLineDash([]);
            const sec = n * Math.round(PING_INTERVAL_MS / 1000);
            const label = sec >= 60
                ? `-${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`
                : `-${sec}s`;
            ctx.fillStyle = labelCol;
            ctx.font = FONT_STR;
            const lw = ctx.measureText(label).width;
            ctx.fillText(label, Math.max(0, Math.min(xp - lw / 2, w - lw)), h - 2);
        }

        ctx.strokeStyle = gridMajor;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, gh); ctx.lineTo(w, gh); ctx.stroke();

        if (pingHistory.length === 0) return;

        const plotY = (v: number) => v < 0 ? gh : toY(v);

        const drawSegment = (start: number, end: number, isDisc: boolean) => {
            ctx.beginPath();
            for (let i = start; i <= end; i++) {
                const x = offsetX + i * step, y = plotY(pingHistory[i]);
                if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.lineTo(offsetX + end * step, gh);
            ctx.lineTo(offsetX + start * step, gh);
            ctx.closePath();
            ctx.fillStyle = isDisc ? "rgba(255,80,80,0.25)" : "rgba(80,200,80,0.18)";
            ctx.fill();

            ctx.beginPath();
            for (let i = start; i <= end; i++) {
                const x = offsetX + i * step, y = plotY(pingHistory[i]);
                if (i === start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = isDisc ? "rgba(255,80,80,0.85)" : "rgba(80,200,80,0.85)";
            ctx.lineWidth = 3;
            ctx.stroke();
        };

        let segStart = 0;
        let segDisc = pingHistory[0] < 0;
        for (let i = 1; i < pingHistory.length; i++) {
            const disc = pingHistory[i] < 0;
            if (disc !== segDisc) {
                drawSegment(segStart, i, segDisc);
                segStart = i;
                segDisc = disc;
            }
        }
        drawSegment(segStart, pingHistory.length - 1, segDisc);

        ctx.font = FONT_BOLD;
        const avgBg = dark ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.65)";
        const avgBoxH = FONT_SIZE + 4;
        if (pingDisconnected) {
            const label = t("ping.disconnected");
            const lw = ctx.measureText(label).width;
            ctx.fillStyle = avgBg;
            ctx.fillRect(w - lw - 8, 3, lw + 6, avgBoxH);
            ctx.fillStyle = "#ff4444";
            ctx.fillText(label, w - lw - 5, 3 + FONT_SIZE);
        } else if (pingSamples.length > 0) {
            const avg = Math.round(pingSamples.reduce((a, b) => a + b, 0) / pingSamples.length);
            const minP = Math.min(...validPings);
            const maxP = Math.max(...validPings);
            const rows = [
                { label: "avg", value: `${avg}ms` },
                { label: "min", value: `${minP}ms` },
                { label: "max", value: `${maxP}ms` },
            ];
            const lineH = FONT_SIZE + 2;
            const pad = 4;
            const labelW = Math.max(...rows.map(r => ctx.measureText(r.label).width));
            const valW = Math.max(...rows.map(r => ctx.measureText(r.value).width));
            const boxW = labelW + valW + pad * 3;
            const boxX = w - boxW - 4;
            const boxY = 3;
            ctx.fillStyle = dark ? "#eee" : "#000";
            for (let li = 0; li < 3; li++) {
                const y = boxY + pad + FONT_SIZE + li * lineH;
                ctx.fillText(rows[li].label, boxX + pad, y);
                const vw = ctx.measureText(rows[li].value).width;
                ctx.fillText(rows[li].value, boxX + boxW - pad - vw, y);
            }
        }
        } finally { _end(); }
    };

    let pingFailCount = 0;
    let pingDisconnected = false;
    const PING_FAIL_THRESHOLD = 3;

    // サーバ切断バナー
    let disconnectBanner: HTMLDivElement | null = null;
    const showDisconnectBanner = () => {
        if (disconnectBanner) return;
        disconnectBanner = document.createElement("div");
        disconnectBanner.id = "disconnect-banner";
        disconnectBanner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:10000;background:rgba(200,40,40,0.92);color:#fff;text-align:center;padding:10px 16px;font-size:15px;font-family:sans-serif;pointer-events:none;animation:fadeIn 0.3s ease;";
        disconnectBanner.textContent = t("connection.lost");
        document.body.appendChild(disconnectBanner);
    };
    const hideDisconnectBanner = () => {
        if (!disconnectBanner) return;
        disconnectBanner.remove();
        disconnectBanner = null;
    };

    const startPing = () => {
        if (pingTimer !== null) return;
        pingFailCount = 0;
        pingDisconnected = false;
        const tick = async () => {
            const ms = await game.nakama.measurePing();
            if (ms !== null) {
                pingFailCount = 0;
                if (pingDisconnected) {
                    pingDisconnected = false;
                    game.connectionState = "connected";
                    addServerLog(t("log.network_restored"));
                    hideDisconnectBanner();
                    if (loginStatus) {
                        loginStatus.style.color = "#00dd55";
                        loginStatus.textContent = isMobile ? "✓" : t("connection.restored");
                    }
                }
                pingSamples.push(ms);
                if (pingSamples.length > PING_SAMPLES) pingSamples.shift();
                pingHistory.push(ms);
                if (pingHistory.length > PING_HISTORY_MAX) pingHistory.shift();
                game.latestPingAvg = Math.round(pingSamples.reduce((a, b) => a + b, 0) / pingSamples.length);
                drawPingGraph();
            } else {
                pingFailCount++;
                pingHistory.push(-1);
                if (pingHistory.length > PING_HISTORY_MAX) pingHistory.shift();
                drawPingGraph();
                if (pingFailCount >= PING_FAIL_THRESHOLD && !pingDisconnected) {
                    pingDisconnected = true;
                    game.latestPingAvg = -1;
                    game.connectionState = "disconnected";
                    addServerLog(t("log.network_disconnect"), t("log.network_disconnect.detail"));
                    showDisconnectBanner();
                    if (loginStatus) {
                        loginStatus.style.color = "#ff4444";
                        loginStatus.textContent = isMobile ? "✗" : t("connection.disconnected");
                    }
                }
            }
        };
        tick();
        pingTimer = setInterval(tick, PING_INTERVAL_MS);
    };

    const stopPing = () => {
        if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
        pingSamples.length = 0;
        pingHistory.length = 0;
        game.latestPingAvg = null;
        drawPingGraph();
    };

    if (pingDisplay) {
        pingDisplay.style.cursor = "pointer";
        pingDisplay.addEventListener("click", () => {
            const btn = document.getElementById("menu-ping");
            if (btn) btn.click();
        });
    }

    // ===== Ping パネル ドラッグ & クローズ =====
    {
        const ppanel  = document.getElementById("ping-panel")  as HTMLElement;
        const pheader = document.getElementById("ping-header") as HTMLElement;
        const pclose  = document.getElementById("ping-close")  as HTMLElement;

        if (ppanel && pheader) {
            const sCkP = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            const gCkP = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };

            if (!isMobileDev) {
                const initRect = ppanel.getBoundingClientRect();
                ppanel.style.left  = initRect.left + "px";
                ppanel.style.right = "auto";
            }
            if (!isMobileDev) {
                const savedL = gCkP("pgLeft"), savedT = gCkP("pgTop");
                const savedW = gCkP("pgWidth"), savedH = gCkP("pgHeight");
                if (savedL !== null) { ppanel.style.left = savedL + "px"; ppanel.style.right = "auto"; }
                if (savedT !== null) ppanel.style.top    = savedT + "px";
                if (savedW !== null) ppanel.style.width  = savedW + "px";
                if (savedH !== null) ppanel.style.height = savedH + "px";
                if (!isMobileDev) game.clampToViewport(ppanel);
            }

            let isDragP = false, offXP = 0, offYP = 0;
            pheader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "ping-close") return;
                if (isMobileDev) return;
                isDragP = true;
                offXP = e.clientX - ppanel.getBoundingClientRect().left;
                offYP = e.clientY - ppanel.getBoundingClientRect().top;
                pheader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!isDragP) return;
                ppanel.style.left = Math.max(0, e.clientX - offXP) + "px";
                ppanel.style.top  = Math.max(0, e.clientY - offYP) + "px";
            });
            document.addEventListener("pointerup", () => {
                if (!isDragP) return;
                isDragP = false;
                const r = ppanel.getBoundingClientRect();
                sCkP("pgLeft", String(Math.round(r.left)));
                sCkP("pgTop",  String(Math.round(r.top)));
                drawPingGraph();
            });
            new ResizeObserver(() => {
                const r = ppanel.getBoundingClientRect();
                sCkP("pgWidth",  String(Math.round(r.width)));
                sCkP("pgHeight", String(Math.round(r.height)));
                drawPingGraph();
            }).observe(ppanel);
            const pingCanvas = document.getElementById("ping-canvas");
            if (pingCanvas) {
                new ResizeObserver(() => drawPingGraph()).observe(pingCanvas);
            }

            if (pclose) {
                pclose.addEventListener("click", () => {
                    ppanel.style.display = "none";
                    sCkP("showPing", "0");
                    const mb = document.getElementById("menu-ping");
                    if (mb) mb.textContent = "　 " + t("menu.ping");
                });
            }
        }
    }

    // ===== 同接数 (CCU) 計測 & グラフ =====
    // レンジ設定: { サンプル数, ポーリング間隔ms, 1サンプルあたりの秒数 }
    const CCU_RANGES: Record<string, { max: number; interval: number; secPerSample: number }> = {
        "1m":  { max: 60,    interval: 1000,  secPerSample: 1 },
        "5m":  { max: 300,   interval: 5000,  secPerSample: 1 },
        "1h":  { max: 60,    interval: 60000, secPerSample: 60 },
        "12h": { max: 720,   interval: 60000, secPerSample: 60 },
        "1d":  { max: 1440,  interval: 60000, secPerSample: 60 },
        "10d": { max: 14400, interval: 60000, secPerSample: 60 },
    };
    const CCU_DEFAULT_MAX  = 100;
    const ccuHistory: number[] = [];
    let ccuNow = 0;
    let ccuTimer: ReturnType<typeof setInterval> | null = null;
    let ccuRange = "5m";
    let ccuInitialized = false;

    const getCcuConfig = () => CCU_RANGES[ccuRange] || CCU_RANGES["5m"];

    const drawCcuGraph = () => {
        const _end = prof("UIPanel.drawCcuGraph");
        const canvas = document.getElementById("ccu-canvas") as HTMLCanvasElement | null;
        if (!canvas) { _end(); return; }
        const cpanel  = document.getElementById("ccu-panel");
        const cheader = document.getElementById("ccu-header");
        if (!cpanel || !cheader) return;
        const tabBar = cpanel.querySelector<HTMLElement>("#panel-tab-bar");
        const headerH = tabBar ? tabBar.offsetHeight : cheader.offsetHeight;
        canvas.style.top = headerH + "px";
        const w = cpanel.clientWidth, h = cpanel.clientHeight - headerH;
        if (w <= 0 || h <= 0) return;
        canvas.style.width  = w + "px";
        canvas.style.height = h + "px";
        const dpr = window.devicePixelRatio || 1;
        canvas.width  = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const cfg = getCcuConfig();
        const histMax = cfg.max;
        const dark = document.body.classList.contains("theme-dark");
        const FONT_SIZE = dark ? 15 : 12;
        const FONT_MONO = '"Courier New", Courier, monospace';
        const FONT_STR  = `${FONT_SIZE}px ${FONT_MONO}`;
        const FONT_BOLD = `bold ${FONT_SIZE}px ${FONT_MONO}`;
        const AXIS_H = dark ? 26 : 16;
        const gh     = h - AXIS_H;
        ctx.clearRect(0, 0, w, h);

        const validVals = ccuHistory.filter(v => v >= 0);
        const maxVal = Math.max(CCU_DEFAULT_MAX, ...(validVals.length ? validVals : [0])) * 1.1;
        const toY = (v: number) => gh - Math.min(v / maxVal, 1) * gh;

        const gridMajor = dark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.20)";
        const gridSub   = dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.08)";
        const labelCol  = dark ? "#eee" : "#000";

        // 横グリッド（人数）
        ctx.lineWidth = 1;
        const gridStep = maxVal <= 50 ? 5 : maxVal <= 200 ? 10 : maxVal <= 500 ? 50 : 100;
        const majorStep = gridStep * 5;
        // 横グリッド描画 — Y軸ラベルを右揃え
        ctx.font = FONT_STR;
        const ccuMajorLabels: { text: string; yp: number }[] = [];
        for (let v = gridStep; v < maxVal; v += gridStep) {
            const yp = toY(v);
            if (yp < 0) break;
            const isMajor = v % majorStep === 0;
            ctx.strokeStyle = isMajor ? gridMajor : gridSub;
            ctx.setLineDash(isMajor ? [4, 3] : [2, 5]);
            ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(w, yp); ctx.stroke();
            if (isMajor) ccuMajorLabels.push({ text: `${v}`, yp });
        }
        if (ccuMajorLabels.length > 0) {
            ctx.fillStyle = labelCol;
            const maxLabelW = Math.max(...ccuMajorLabels.map(l => ctx.measureText(l.text).width));
            for (const { text, yp } of ccuMajorLabels) {
                const tw = ctx.measureText(text).width;
                ctx.fillText(text, 2 + maxLabelW - tw, yp - 2);
            }
        }
        ctx.setLineDash([]);

        // 縦グリッド（時間軸）
        const step    = w / (histMax - 1);
        const offsetX = (histMax - ccuHistory.length) * step;
        // 時間ラベルの間隔を自動調整
        const totalSec = histMax * cfg.secPerSample;
        let tickStepSamples: number;
        if (totalSec <= 120) tickStepSamples = Math.ceil(10 / cfg.secPerSample);        // 10秒刻み
        else if (totalSec <= 600) tickStepSamples = Math.ceil(60 / cfg.secPerSample);    // 1分刻み
        else if (totalSec <= 7200) tickStepSamples = Math.ceil(600 / cfg.secPerSample);  // 10分刻み
        else if (totalSec <= 86400) tickStepSamples = Math.ceil(3600 / cfg.secPerSample);// 1時間刻み
        else tickStepSamples = Math.ceil(86400 / cfg.secPerSample);                      // 1日刻み

        const fmtTime = (sec: number): string => {
            if (sec < 60) return `-${sec}s`;
            if (sec < 3600) return `-${Math.floor(sec / 60)}m`;
            if (sec < 86400) return `-${Math.floor(sec / 3600)}h`;
            return `-${Math.floor(sec / 86400)}d`;
        };

        // ラベルが重ならないよう間引き倍率を計算
        ctx.font = FONT_STR;
        const sampleLabelW = ctx.measureText("-23h").width;
        const minLabelGap = sampleLabelW + 8; // ラベル幅 + 余白
        const tickPixels = tickStepSamples * step;
        const labelEvery = tickPixels > 0 ? Math.max(1, Math.ceil(minLabelGap / tickPixels)) : 1;

        let tickIdx = 0;
        for (let n = tickStepSamples; n < histMax; n += tickStepSamples) {
            tickIdx++;
            const xp = Math.round((histMax - 1 - n) * step);
            if (xp < 0 || xp > w) continue;
            const showLabel = tickIdx % labelEvery === 0;
            ctx.strokeStyle = dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)";
            ctx.setLineDash(showLabel ? [2, 4] : [1, 6]);
            ctx.beginPath(); ctx.moveTo(xp, 0); ctx.lineTo(xp, gh); ctx.stroke();
            ctx.setLineDash([]);
            if (showLabel) {
                const label = fmtTime(n * cfg.secPerSample);
                ctx.fillStyle = labelCol;
                ctx.font = FONT_STR;
                const lw = ctx.measureText(label).width;
                ctx.fillText(label, Math.max(0, Math.min(xp - lw / 2, w - lw)), h - 2);
            }
        }

        // ベースライン
        ctx.strokeStyle = gridMajor;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, gh); ctx.lineTo(w, gh); ctx.stroke();

        if (ccuHistory.length === 0) return;

        // エリア塗りつぶし + ライン描画 (-1の区間はスキップ)
        if (validVals.length > 0) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(0, 0, w, gh);
            ctx.clip();

            // 連続する有効データ区間(セグメント)を抽出
            const segments: { start: number; end: number }[] = [];
            let segStart = -1;
            for (let i = 0; i < ccuHistory.length; i++) {
                if (ccuHistory[i] >= 0) {
                    if (segStart < 0) segStart = i;
                } else {
                    if (segStart >= 0) { segments.push({ start: segStart, end: i - 1 }); segStart = -1; }
                }
            }
            if (segStart >= 0) segments.push({ start: segStart, end: ccuHistory.length - 1 });

            for (const seg of segments) {
                // エリア塗りつぶし
                ctx.beginPath();
                for (let i = seg.start; i <= seg.end; i++) {
                    const x = offsetX + i * step, y = toY(ccuHistory[i]);
                    if (i === seg.start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.lineTo(offsetX + seg.end * step, gh);
                ctx.lineTo(offsetX + seg.start * step, gh);
                ctx.closePath();
                ctx.fillStyle = "rgba(80,140,255,0.18)";
                ctx.fill();

                // ライン描画
                ctx.beginPath();
                for (let i = seg.start; i <= seg.end; i++) {
                    const x = offsetX + i * step, y = toY(ccuHistory[i]);
                    if (i === seg.start) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.strokeStyle = "rgba(80,140,255,0.85)";
                ctx.lineWidth = 3;
                ctx.stroke();
            }

            ctx.restore();
        }

        // 統計ボックス (now / avg / min / max) + ログイン状態
        const latest = ccuNow;
        const loggedIn = ccuInitialized && ccuHistory.length > 0;
        const hasData = validVals.length > 0;
        const minV = hasData ? Math.min(...validVals) : undefined;
        const maxV = hasData ? Math.max(...validVals) : undefined;
        const avgV = hasData ? Math.round(validVals.reduce((a, b) => a + b, 0) / validVals.length) : undefined;
        ctx.font = FONT_BOLD;
        const fmtVal = (v: number | undefined) => v !== undefined ? `${v}` : "";
        const rows = [
            { label: "now", value: fmtVal(loggedIn ? latest : undefined) },
            { label: "avg", value: fmtVal(avgV) },
            { label: "min", value: fmtVal(minV) },
            { label: "max", value: fmtVal(maxV) },
        ];
        const lineH = FONT_SIZE + 2;
        const pad = 4;
        const labelW = Math.max(...rows.map(r => ctx.measureText(r.label).width));
        const valW = Math.max(...rows.map(r => ctx.measureText(r.value || "  ").width));
        const boxW = labelW + valW + pad * 3;
        const boxX = w - boxW - 16;
        const boxY = 3;
        ctx.fillStyle = dark ? "#eee" : "#000";
        for (let li = 0; li < rows.length; li++) {
            const y = boxY + pad + FONT_SIZE + li * lineH;
            ctx.fillText(rows[li].label, boxX + pad, y);
            const vw = ctx.measureText(rows[li].value).width;
            ctx.fillText(rows[li].value, boxX + boxW - pad - vw, y);
        }
        _end();
    };

    const startCcu = () => {
        if (ccuTimer !== null) return;
        const cfg = getCcuConfig();
        const tick = async () => {
            const needHistory = !ccuInitialized;
            const result = await game.nakama.getPlayerCount(needHistory ? ccuRange : undefined);
            if (result === null) {
                ccuHistory.push(-1);
            } else if (needHistory) {
                ccuInitialized = true;
                ccuHistory.length = 0;
                for (const v of result.history) ccuHistory.push(v);
                if (ccuHistory.length === 0 || ccuHistory[ccuHistory.length - 1] !== result.count) {
                    ccuHistory.push(result.count);
                }
                ccuNow = result.count;
            } else {
                ccuHistory.push(result.count);
                ccuNow = result.count;
            }
            const maxLen = getCcuConfig().max;
            if (ccuHistory.length > maxLen) ccuHistory.splice(0, ccuHistory.length - maxLen);
            drawCcuGraph();
        };
        tick();
        ccuTimer = setInterval(tick, cfg.interval);
    };

    const stopCcu = () => {
        if (ccuTimer !== null) { clearInterval(ccuTimer); ccuTimer = null; }
        ccuHistory.length = 0;
        ccuNow = 0;
        ccuInitialized = false;
        drawCcuGraph();
    };

    const restartCcu = () => {
        stopCcu();
        const cpanel = document.getElementById("ccu-panel");
        if (cpanel && cpanel.style.display !== "none") startCcu();
    };

    // レンジ変更ハンドラ
    const ccuRangeSelect = document.getElementById("ccu-range") as HTMLSelectElement | null;
    if (ccuRangeSelect) {
        ccuRangeSelect.addEventListener("change", () => {
            ccuRange = ccuRangeSelect.value;
            restartCcu();
        });
    }

    // ===== CCU パネル ドラッグ & クローズ =====
    {
        const cpanel  = document.getElementById("ccu-panel")  as HTMLElement;
        const cheader = document.getElementById("ccu-header") as HTMLElement;
        const cclose  = document.getElementById("ccu-close")  as HTMLElement;

        if (cpanel && cheader) {
            const sCkC = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            const gCkC = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };

            if (!isMobileDev) {
                const initRect = cpanel.getBoundingClientRect();
                cpanel.style.left  = initRect.left + "px";
                cpanel.style.right = "auto";
            }
            if (!isMobileDev) {
                const savedL = gCkC("ccuLeft"), savedT = gCkC("ccuTop");
                const savedW = gCkC("ccuWidth"), savedH = gCkC("ccuHeight");
                if (savedL !== null) { cpanel.style.left = savedL + "px"; cpanel.style.right = "auto"; }
                if (savedT !== null) cpanel.style.top    = savedT + "px";
                if (savedW !== null) cpanel.style.width  = savedW + "px";
                if (savedH !== null) cpanel.style.height = savedH + "px";
                if (!isMobileDev) game.clampToViewport(cpanel);
            }

            let isDragC = false, offXC = 0, offYC = 0;
            cheader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "ccu-close") return;
                if ((e.target as HTMLElement).tagName === "SELECT") return;
                if (isMobileDev) return;
                isDragC = true;
                offXC = e.clientX - cpanel.getBoundingClientRect().left;
                offYC = e.clientY - cpanel.getBoundingClientRect().top;
                cheader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!isDragC) return;
                cpanel.style.left = Math.max(0, e.clientX - offXC) + "px";
                cpanel.style.top  = Math.max(0, e.clientY - offYC) + "px";
            });
            document.addEventListener("pointerup", () => {
                if (!isDragC) return;
                isDragC = false;
                const r = cpanel.getBoundingClientRect();
                sCkC("ccuLeft", String(Math.round(r.left)));
                sCkC("ccuTop",  String(Math.round(r.top)));
                drawCcuGraph();
            });

            new ResizeObserver(() => {
                const r = cpanel.getBoundingClientRect();
                sCkC("ccuWidth",  String(Math.round(r.width)));
                sCkC("ccuHeight", String(Math.round(r.height)));
                drawCcuGraph();
            }).observe(cpanel);
            const ccuCanvas = document.getElementById("ccu-canvas");
            if (ccuCanvas) {
                new ResizeObserver(() => drawCcuGraph()).observe(ccuCanvas);
            }

            if (cclose) {
                cclose.addEventListener("click", () => {
                    cpanel.style.display = "none";
                    sCkC("showCcu", "0");
                    const mb = document.getElementById("menu-ccu");
                    if (mb) mb.textContent = "　 " + t("menu.ccu");
                    stopCcu();
                });
            }

            // パネル表示時にCCU計測開始
            const ccuObserver = new MutationObserver(() => {
                if (cpanel.style.display !== "none") {
                    startCcu();
                } else {
                    stopCcu();
                }
            });
            ccuObserver.observe(cpanel, { attributes: true, attributeFilter: ["style"] });
        }
    }

    const doLogout = () => {
        stopPing();
        stopCcu();
        game.saveChunksToDB();
        game.nakama.logout();
        game.currentUserId = null;
        addServerLog(t("log.logout"));
        userMap.clear();
        scheduleRenderUserList();
        game.remoteAvatars.forEach(av => av.dispose());
        game.remoteAvatars.clear();
        if (loginStatus) { loginStatus.style.color = "#00dd55"; loginStatus.style.fontWeight = "bold"; loginStatus.style.textShadow = "0 1px 2px rgba(0,0,0,0.4)"; loginStatus.textContent = t("logout.done"); setTimeout(() => { loginStatus.textContent = ""; loginStatus.style.fontWeight = ""; loginStatus.style.textShadow = ""; }, 3000); }
        if (loginBtn) { loginBtn.style.background = "#28a74580"; loginBtn.style.display = ""; }
        { const di = document.getElementById("displayNameInput") as HTMLInputElement | null; if (di) { di.disabled = true; di.value = ""; di.placeholder = t("displayname.placeholder.disabled"); } }
        { const db = document.getElementById("displayNameBtn") as HTMLButtonElement | null; if (db) { db.disabled = true; } }
        confirmedDisplayName = "";
        { const ds = document.getElementById("displayNameStatus") as HTMLSpanElement | null; if (ds) ds.textContent = ""; }
        setLoginMode();
    };

    setLoginMode();

    // 自動ログイン: ?login パラメータがなければ自動ログインを実行
    if (!manualLoginMode) {
        // Cookie に保存されたユーザIDがあればそれを使用、なければランダム生成
        const autoName = savedLoginName || generateRandomUserId();
        if (loginNameInput) loginNameInput.value = autoName;
        setLoginRowVisible(false);  // ログイン行を非表示
        // 少し遅延させてDOMの初期化完了を待つ
        setTimeout(() => { doLogin(); }, 100);
    }

    // 表示名パネルにユーザIDを反映
    {
        const dnPanelUserId = document.getElementById("dn-panel-userid");
        if (dnPanelUserId && loginNameInput) {
            const updateDnPanelUserId = () => { dnPanelUserId.textContent = loginNameInput.value || "-"; };
            new MutationObserver(updateDnPanelUserId).observe(loginNameInput, { attributes: true, attributeFilter: ["value"] });
            loginNameInput.addEventListener("input", updateDnPanelUserId);
            updateDnPanelUserId();
        }
    }

    {
        const settingsLogoutBtn = document.getElementById("settings-logout-btn");
        const logoutPanel = document.getElementById("logout-panel");
        const logoutConfirm = document.getElementById("logout-confirm-btn");
        const logoutCancel = document.getElementById("logout-cancel-btn");
        const logoutClose = document.getElementById("logout-panel-close");
        const hideLogoutPanel = () => { if (logoutPanel) logoutPanel.style.display = "none"; };
        if (settingsLogoutBtn && logoutPanel) {
            settingsLogoutBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                logoutPanel.style.display = "block";
            });
        }
        if (logoutConfirm) logoutConfirm.addEventListener("click", () => { hideLogoutPanel(); doLogout(); });
        if (logoutCancel) logoutCancel.addEventListener("click", hideLogoutPanel);
        if (logoutClose) logoutClose.addEventListener("click", hideLogoutPanel);
    }

    {
        const aboutPanel = document.getElementById("about-panel");
        const aboutHeader = document.getElementById("about-panel-header");

        // コンテンツ初期化（言語切替時にも再呼び出し）
        const ver = (window as any).APP_VERSION || "";
        const commit = (window as any).APP_COMMIT_COUNTER || "";
        const date = (window as any).APP_DATE || "";
        const buildAboutContent = () => {
            const nameEl = document.getElementById("about-app-name");
            const verEl = document.getElementById("about-app-ver");
            const dateEl = document.getElementById("about-app-date");
            const creditsEl = document.getElementById("about-app-credits");
            if (nameEl) nameEl.innerHTML = '<img src="/favicon.png" style="width:18px;height:18px;vertical-align:middle;margin-right:4px;">tommieChat';
            if (verEl) verEl.textContent = "Ver. " + ver + (commit ? " #" + commit : "");
            if (dateEl) dateEl.textContent = t("about.date_label") + " " + date;
            if (creditsEl) creditsEl.innerHTML = "\u00A9 2026 tommie.jp"
                + '<hr style="border:none;border-top:1px solid rgba(0,0,0,0.15);margin:8px 0;">'
                + '<table style="border-collapse:collapse;font-size:inherit;line-height:1.6;">'
                + '<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">URL</td><td><a href="https://mmo.tommie.jp" target="_blank">https://mmo.tommie.jp</a></td></tr>'
                + '<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">X</td><td><a href="https://x.com/tommie_nico" target="_blank" rel="noopener" style="color:#1d9bf0;">@tommie_nico</a></td></tr>'
                + '<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">GitHub</td><td><a href="https://github.com/open-tommie/tommie-chat" target="_blank">open-tommie/tommie-chat</a></td></tr>'
                + `<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">${t("about.email_label")}</td><td><a href="mailto:open.tommie@gmail.com" style="color:#1d9bf0;">open.tommie@gmail.com</a></td></tr>`
                + '</table>'
                + '<hr style="border:none;border-top:1px solid rgba(0,0,0,0.15);margin:8px 0;">'
                + t("about.disclaimer") + '<br><br>'
                + 'This software is provided "AS IS" without warranty of any kind.<br>'
                + 'License: MIT'
                + '<hr style="border:none;border-top:1px solid rgba(0,0,0,0.15);margin:8px 0;">'
                + t("about.support");
            // 操作方法
            const opsPc = document.getElementById("about-ops-pc");
            const opsSp = document.getElementById("about-ops-sp");
            if (opsPc) opsPc.innerHTML =
                `<p style="margin:0;"><b>${t("about.move")}</b> ${t("about.pc.move")}</p>`
                + `<p style="margin:0;"><b>${t("about.camera_rotate")}</b> ${t("about.pc.camera_rotate")}</p>`
                + `<p style="margin:0;"><b>${t("about.camera_pan")}</b> ${t("about.pc.camera_pan")}</p>`
                + `<p style="margin:0;"><b>${t("about.zoom")}</b> ${t("about.pc.zoom")}</p>`
                + `<p style="margin:0;"><b>${t("about.send_msg")}</b> ${t("about.send_key")}</p>`
                + `<p style="margin:0;"><b>${t("about.newline")}</b> ${t("about.newline_key")}</p>`;
            if (opsSp) opsSp.innerHTML =
                `<p style="margin:0;"><b>${t("about.move")}</b> ${t("about.sp.move")}</p>`
                + `<p style="margin:0;"><b>${t("about.camera_rotate")}</b> ${t("about.sp.camera_rotate")}</p>`
                + `<p style="margin:0;"><b>${t("about.zoom")}</b> ${t("about.sp.zoom")}</p>`
                + `<p style="margin:0;"><b>${t("about.send_msg")}</b> ${t("about.send_key_sp")}</p>`
                + `<p style="margin:0;"><b>${t("about.newline")}</b> ${t("about.newline_key")}</p>`;
        };
        buildAboutContent();
        onLangChangeCallbacks.push(buildAboutContent);

        // 閉じるボタン
        const aboutClose = document.getElementById("about-panel-close");
        if (aboutClose && aboutPanel) {
            aboutClose.addEventListener("click", () => {
                aboutPanel.style.display = "none";
                setDivCk("showAbout", "0");
                const mb = document.getElementById("menu-about");
                if (mb) mb.textContent = "　 " + t("menu.about");
            });
        }

        // ドラッグ移動（PC のみ — スマホではヘッダードラッグはデバイダー移動に使う）
        if (aboutHeader && aboutPanel && !isMobileDev) {
            let dragging = false;
            let dx = 0, dy = 0;
            aboutHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "about-panel-close") return;
                dragging = true;
                dx = e.clientX - aboutPanel.getBoundingClientRect().left;
                dy = e.clientY - aboutPanel.getBoundingClientRect().top;
                aboutHeader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                aboutPanel.style.left = Math.max(0, e.clientX - dx) + "px";
                aboutPanel.style.top  = Math.max(0, e.clientY - dy) + "px";
            });
            document.addEventListener("pointerup", () => { dragging = false; });
        }
    }

    // 表示名パネル: 閉じるボタン & PCドラッグ
    {
        const dnPanel = document.getElementById("displayname-panel");
        const dnHeader = document.getElementById("displayname-header");
        const dnClose = document.getElementById("displayname-close");
        if (dnClose && dnPanel) {
            dnClose.addEventListener("click", () => {
                dnPanel.style.display = "none";
                const menuBtn = document.getElementById("menu-login");
                if (menuBtn) menuBtn.textContent = "　 " + t("menu.displayname");
            });
        }
        if (dnHeader && dnPanel && !isMobileDev) {
            let dragging = false;
            let dx = 0, dy = 0;
            dnHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "displayname-close") return;
                dragging = true;
                dx = e.clientX - dnPanel.getBoundingClientRect().left;
                dy = e.clientY - dnPanel.getBoundingClientRect().top;
                dnHeader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                dnPanel.style.left = Math.max(0, e.clientX - dx) + "px";
                dnPanel.style.top  = Math.max(0, e.clientY - dy) + "px";
            });
            document.addEventListener("pointerup", () => { dragging = false; });
        }
    }

    // アバター選択パネル: 閉じるボタン & PCドラッグ
    {
        const avPanel = document.getElementById("avatar-panel");
        const avHeader = document.getElementById("avatar-header");
        const avClose = document.getElementById("avatar-close");
        if (avClose && avPanel) {
            avClose.addEventListener("click", () => {
                avPanel.style.display = "none";
                const menuBtn = document.getElementById("menu-avatar");
                if (menuBtn) menuBtn.textContent = "　 " + t("menu.avatar");
            });
        }
        if (avHeader && avPanel && !isMobileDev) {
            let dragging = false;
            let dx = 0, dy = 0;
            avHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "avatar-close") return;
                dragging = true;
                dx = e.clientX - avPanel.getBoundingClientRect().left;
                dy = e.clientY - avPanel.getBoundingClientRect().top;
                avHeader.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                avPanel.style.left = Math.max(0, e.clientX - dx) + "px";
                avPanel.style.top  = Math.max(0, e.clientY - dy) + "px";
            });
            document.addEventListener("pointerup", () => { dragging = false; });
        }
    }

    // セリフ吹き出しトグル
    let lastSpeechText = "";
    let bubbleHidden = false;
    const doUpdateSpeech = (text: string) => {
        lastSpeechText = text;
        if (bubbleHidden && text) bubbleHidden = false;
        if (game.updatePlayerSpeech) game.updatePlayerSpeech(bubbleHidden ? "" : text);
    };

    const sendMessage = async () => {
        const trimEnabled = (document.getElementById("speechTrimBtn") as HTMLButtonElement | null)?.classList.contains("on") ?? true;
        const text = trimEnabled ? textarea.value.trim() : textarea.value;
        if (!text.trim()) {
            // 空白送信 → 吹き出しトグル（旧クリアボタン機能）
            if (lastSpeechText) {
                bubbleHidden = !bubbleHidden;
                if (game.updatePlayerSpeech) game.updatePlayerSpeech(bubbleHidden ? "" : lastSpeechText);
            }
            textarea.value = "";
            return;
        }
        doUpdateSpeech(text);
        textarea.value = "";
        if (game.nakama.getSession()) {
            try {
                await game.nakama.sendChatMessage(text);
            } catch (e) {
                const name = loginNameInput?.value.trim() || "tommie.jp";
                addChatHistory(name, text);
            }
        } else {
            const name = loginNameInput?.value.trim() || "tommie.jp";
            addChatHistory(name, text);
        }
    };

    // Speech Size 変更時に既存の吹き出しを即時再描画
    {
        const ssSel = document.getElementById("speechSizeSelect") as HTMLSelectElement | null;
        if (ssSel) {
            ssSel.addEventListener("change", () => {
                game.spriteAvatarSystem.refreshAllSpeeches();
                if (game.updatePlayerSpeech && lastSpeechText) {
                    game.updatePlayerSpeech(bubbleHidden ? "" : lastSpeechText);
                }
            });
        }
    }

    // UID Color 変更時に全アバターの名前タグを更新
    {
        const uidColorInput = document.getElementById("uidColorInput") as HTMLInputElement | null;
        if (uidColorInput) {
            uidColorInput.addEventListener("input", () => {
                // 自分のアバター
                const selfDn = game.nakama.selfDisplayName ?? "";
                const selfUsername = loginNameInput?.value ?? "";
                if (!selfDn) {
                    const lbl = resolveDisplayLabel("", selfUsername, game.nakama.selfSessionId ?? undefined);
                    game.updatePlayerNameTag(lbl.text, lbl.color, lbl.suffix);
                }
                // リモートアバター
                for (const [sid, entry] of userMap) {
                    if (sid === game.nakama.selfSessionId) continue;
                    const dn = entry.displayName ?? "";
                    if (!dn) {
                        const lbl = resolveDisplayLabel("", entry.username, sid);
                        const updater = game.remoteNameUpdaters.get(sid);
                        if (updater) updater(lbl.text, lbl.color, lbl.suffix);
                    }
                }
            });
        }
    }

    // ─── ブックマーク（テレポート先の選択） ───
    {
        const bookmarkPanel = document.getElementById("bookmark-panel") as HTMLElement | null;
        const bookmarkListEl = document.getElementById("bookmark-list") as HTMLElement | null;
        const bookmarkClose = document.getElementById("bookmark-close") as HTMLElement | null;

        if (bookmarkPanel && bookmarkListEl) {
            // 固定ブックマーク（クライアント側定義）
            const builtinBookmarks = [
                { id: "world_center", name: "ワールド（中心）", worldId: 0 },
                { id: "room_park",    name: "公園",           worldId: 0 },
                { id: "room_beach",   name: "ビーチ",         worldId: 0 },
                { id: "room_night",   name: "夜の街",         worldId: 0 },
            ];
            // ユーザー定義ブックマーク（サーバーから読み込み）
            let userBookmarks: { name: string; x: number; z: number; ry: number; worldId: number }[] = [];
            let bookmarksLoaded = false;

            const loadBookmarks = async () => {
                if (bookmarksLoaded) return;
                try {
                    userBookmarks = await game.nakama.getBookmarks();
                    bookmarksLoaded = true;
                } catch (e) { console.warn("getBookmarks failed:", e); }
            };
            const persistBookmarks = async () => {
                try { await game.nakama.saveBookmarks(userBookmarks); }
                catch (e) { console.warn("saveBookmarks failed:", e); }
            };

            // ── ブックマーク上部（ブックマーク + 現在地保存）を描画 ──
            const renderBookmarkSection = () => {
                bookmarkListEl.innerHTML = "";

                // 「もとに戻る」ボタン（スタックがあれば表示）
                if (game.canUndoMoveBookmark) {
                    const backBtn = document.createElement("button");
                    backBtn.style.fontWeight = "bold";
                    backBtn.textContent = "← もとに戻る";
                    backBtn.addEventListener("click", () => {
                        game.undoMoveBookmark();
                        renderBookmarkSection();
                    });
                    bookmarkListEl.appendChild(backBtn);
                }

                // 固定ブックマーク
                for (const r of builtinBookmarks) {
                    const isCurrent = game.currentBookmarkId === r.id && game.currentWorldId === r.worldId;
                    const btn = document.createElement("button");
                    if (isCurrent) btn.style.fontWeight = "bold";
                    btn.textContent = r.name + (isCurrent ? " ★" : "");
                    btn.addEventListener("click", () => {
                        if (isCurrent) return;
                        game.moveBookmark(r.id, undefined, r.worldId);
                        renderBookmarkSection();
                    });
                    bookmarkListEl.appendChild(btn);
                }

                // ユーザー定義ブックマーク
                for (let i = 0; i < userBookmarks.length; i++) {
                    const bm = userBookmarks[i];
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;gap:3px;align-items:stretch;";

                    const btn = document.createElement("button");
                    btn.style.cssText = "flex:1;";
                    const nameB = document.createElement("b");
                    nameB.textContent = `📌 ${bm.name}`;
                    const coordSpan = document.createElement("span");
                    coordSpan.style.cssText = "font-size:10px;opacity:0.6;margin-left:6px;";
                    const bmHalf = game.worldSizeOf(bm.worldId) / 2;
                    coordSpan.textContent = `(${Math.round(bm.x) + bmHalf}, ${Math.round(bm.z) + bmHalf}) w${bm.worldId}`;
                    btn.appendChild(nameB);
                    btn.appendChild(coordSpan);
                    btn.addEventListener("click", () => {
                        game.moveBookmark(`user_${i}`, { x: bm.x, z: bm.z }, bm.worldId);
                        game.playerBox.rotation.y = bm.ry;
                        renderBookmarkSection();
                    });

                    const delBtn = document.createElement("button");
                    delBtn.style.cssText = "padding:2px 6px;font-size:11px;opacity:0.5;";
                    delBtn.textContent = "✕";
                    delBtn.addEventListener("click", () => {
                        userBookmarks.splice(i, 1);
                        persistBookmarks();
                        renderBookmarkSection();
                    });

                    row.appendChild(btn);
                    row.appendChild(delBtn);
                    bookmarkListEl.appendChild(row);
                }

                // 「現在地を保存」ボタン
                const addBtn = document.createElement("button");
                addBtn.style.cssText = "margin-top:2px;font-weight:bold;";
                addBtn.textContent = "＋ 現在地を保存";
                addBtn.addEventListener("click", () => {
                    const p = game.playerBox.position;
                    const raw = prompt("ブックマーク名を入力（20文字以内）:");
                    if (!raw || !raw.trim()) return;
                    const name = raw.trim().slice(0, 20).replace(/[\x00-\x1f\x7f]/g, "");
                    if (!name) return;
                    userBookmarks.push({ name, x: p.x, z: p.z, ry: game.playerBox.rotation.y, worldId: game.currentWorldId });
                    persistBookmarks();
                    renderBookmarkSection();
                });
                bookmarkListEl.appendChild(addBtn);
            };

            // renderBookmarkList は互換性のため残す（ブックマーク全体を再描画）
            const renderBookmarkList = () => { renderBookmarkSection(); };

            // パネル表示時にブックマーク読み込み → リスト描画
            let lastDisplay = bookmarkPanel.style.display;
            new MutationObserver(() => {
                const now = bookmarkPanel.style.display;
                if (now !== lastDisplay) {
                    lastDisplay = now;
                    if (now !== "none") {
                        loadBookmarks().then(() => renderBookmarkList());
                    }
                }
            }).observe(bookmarkPanel, { attributes: true, attributeFilter: ["style"] });

            if (bookmarkClose) {
                bookmarkClose.addEventListener("click", () => {
                    bookmarkPanel.style.display = "none";
                    const setCookie = (k: string, v: string) =>
                        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
                    setCookie("showBookmarks", "0");
                    const mb = document.getElementById("menu-bookmarks");
                    if (mb) mb.textContent = "　 ブックマーク";
                });
            }

            // ドラッグ
            const bHeader = document.getElementById("bookmark-header");
            if (bHeader && !isMobileDev) {
                let isDrag = false, offX = 0, offY = 0;
                bHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                    if ((e.target as HTMLElement).id === "bookmark-close") return;
                    isDrag = true;
                    offX = e.clientX - bookmarkPanel.getBoundingClientRect().left;
                    offY = e.clientY - bookmarkPanel.getBoundingClientRect().top;
                    bHeader.setPointerCapture(e.pointerId);
                    e.preventDefault();
                });
                document.addEventListener("pointermove", (e: PointerEvent) => {
                    if (!isDrag) return;
                    bookmarkPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                    bookmarkPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
                });
                document.addEventListener("pointerup", () => {
                    if (!isDrag) return;
                    isDrag = false;
                    const r = bookmarkPanel.getBoundingClientRect();
                    const sCk = (k: string, v: string) =>
                        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
                    sCk("bookmark-panel_l", String(Math.round(r.left)));
                    sCk("bookmark-panel_t", String(Math.round(r.top)));
                });
                new ResizeObserver(() => {
                    const r = bookmarkPanel.getBoundingClientRect();
                    const sCk = (k: string, v: string) =>
                        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
                    sCk("bookmark-panel_w", String(Math.round(r.width)));
                    sCk("bookmark-panel_h", String(Math.round(r.height)));
                }).observe(bookmarkPanel);
            }
        }
    }

    // ─── 部屋一覧パネル ───
    {
        const roomPanel = document.getElementById("room-list-panel") as HTMLElement | null;
        const roomTbody = document.getElementById("room-list-tbody") as HTMLElement | null;
        const roomClose = document.getElementById("room-list-close") as HTMLElement | null;
        const roomCreateBtn = document.getElementById("room-create-btn") as HTMLElement | null;
        const roomScroll = document.getElementById("room-list-scroll") as HTMLElement | null;
        const roomTheadWrap = document.getElementById("room-list-thead-wrap") as HTMLElement | null;

        // 水平スクロール同期: body→thead
        if (roomScroll && roomTheadWrap) {
            roomScroll.addEventListener("scroll", () => {
                roomTheadWrap.scrollLeft = roomScroll.scrollLeft;
            });
        }

        if (roomPanel && roomTbody) {
            // ソート状態
            type RoomSortKey = "name" | "count" | "owner" | "uid" | "size";
            let roomSortKey: RoomSortKey = "count";
            let roomSortAsc = false;
            const setRoomSort = (key: RoomSortKey) => {
                if (roomSortKey === key) roomSortAsc = !roomSortAsc;
                else { roomSortKey = key; roomSortAsc = true; }
                lastWorldListJson = "";
                renderRoomList();
            };

            // ソートヘッダ
            const thName = document.getElementById("room-th-name");
            const thCount = document.getElementById("room-th-count");
            const thOwner = document.getElementById("room-th-owner");
            const thUid = document.getElementById("room-th-uid");
            const thSize = document.getElementById("room-th-size");
            if (thName) thName.addEventListener("click", () => setRoomSort("name"));
            if (thCount) thCount.addEventListener("click", () => setRoomSort("count"));
            if (thOwner) thOwner.addEventListener("click", () => setRoomSort("owner"));
            if (thUid) thUid.addEventListener("click", () => setRoomSort("uid"));
            if (thSize) thSize.addEventListener("click", () => setRoomSort("size"));

            // 部屋作成
            if (roomCreateBtn) {
                roomCreateBtn.addEventListener("click", async () => {
                    const name = prompt("部屋名を入力（30文字以内）:");
                    if (!name || !name.trim()) return;
                    const sizeStr = prompt("サイズ（チャンク数、2〜64）:", "8");
                    const size = Math.max(2, Math.min(64, parseInt(sizeStr || "8") || 8));
                    try {
                        await game.nakama.createRoom(name.trim(), size, size);
                        lastWorldListJson = "";
                        renderRoomList();
                    } catch (e) { console.warn("createRoom:", e); }
                });
            }

            // 差分更新
            let lastWorldListJson = "";
            const renderRoomList = () => {
                game.nakama.getWorldList().then(({ worlds: worldList, isAdmin }) => {
                    const myUid = game.currentUserId ?? "";
                    const canDelete = (w: typeof worldList[0]) =>
                        w.id !== 0 && w.playerCount === 0 && (isAdmin || w.ownerUid === myUid);

                    const json = JSON.stringify(worldList.map(w => `${w.id}:${w.name}:${w.playerCount}:${game.currentWorldId}:${canDelete(w)}`));
                    if (json === lastWorldListJson) return;
                    lastWorldListJson = json;

                    worldList.sort((a, b) => {
                        let cmp: number;
                        if (roomSortKey === "count") cmp = a.playerCount - b.playerCount;
                        else if (roomSortKey === "size") cmp = (a.chunkCountX * a.chunkCountZ) - (b.chunkCountX * b.chunkCountZ);
                        else if (roomSortKey === "owner") cmp = (a.ownerName || "").localeCompare(b.ownerName || "", "ja");
                        else if (roomSortKey === "uid") cmp = (a.ownerUid || "").localeCompare(b.ownerUid || "");
                        else cmp = (a.name || "").localeCompare(b.name || "", "ja");
                        if (cmp === 0 && roomSortKey !== "name") cmp = (b.name || "").localeCompare(a.name || "", "ja");
                        return roomSortAsc ? cmp : -cmp;
                    });

                    const arrow = roomSortAsc ? "▲" : "▼";
                    for (const [th, key] of [[thName, "name"], [thCount, "count"], [thOwner, "owner"], [thUid, "uid"], [thSize, "size"]] as const) {
                        if (th) th.dataset.sort = roomSortKey === key ? arrow : "";
                    }

                    const frag = document.createDocumentFragment();
                    for (const w of worldList) {
                        const tr = document.createElement("tr");
                        const isCurrent = game.currentWorldId === w.id;

                        const tdName = document.createElement("td");
                        tdName.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
                        if (isCurrent) tdName.style.fontWeight = "bold";
                        tdName.textContent = (isCurrent ? "⭐️" : "") + (w.name || `World ${w.id}`);
                        tr.appendChild(tdName);

                        const tdCount = document.createElement("td");
                        tdCount.style.cssText = "text-align:center;white-space:nowrap;";
                        tdCount.textContent = `${w.playerCount}`;
                        tr.appendChild(tdCount);

                        const tdOwnerName = document.createElement("td");
                        tdOwnerName.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
                        tdOwnerName.textContent = w.id === 0 ? "(system)" : (w.ownerName || "—");
                        tdOwnerName.title = w.id === 0 ? "system" : (w.ownerName || "");
                        tr.appendChild(tdOwnerName);

                        const tdOwnerUid = document.createElement("td");
                        tdOwnerUid.style.cssText = "white-space:nowrap;font-size:11px;overflow:hidden;text-overflow:ellipsis;";
                        tdOwnerUid.textContent = w.ownerUid ? w.ownerUid.substring(0, 8) : "—";
                        tdOwnerUid.title = w.ownerUid || "";
                        tr.appendChild(tdOwnerUid);

                        const tdSize = document.createElement("td");
                        tdSize.style.cssText = "text-align:center;white-space:nowrap;";
                        tdSize.textContent = `${w.chunkCountX * 16}x${w.chunkCountZ * 16}`;
                        tr.appendChild(tdSize);

                        const tdDel = document.createElement("td");
                        tdDel.style.cssText = "text-align:center;";
                        if (canDelete(w)) {
                            const delBtn = document.createElement("button");
                            delBtn.className = "ui-btn";
                            delBtn.style.cssText = "width:36px;height:24px;font-size:12px;background:#c04040;opacity:0.7;padding:0;display:flex;align-items:center;justify-content:center;";
                            delBtn.textContent = "✕";
                            delBtn.addEventListener("click", async (e) => {
                                e.stopPropagation();
                                if (!confirm(`「${w.name || `World ${w.id}`}」を削除しますか？`)) return;
                                try {
                                    await game.nakama.deleteRoom(w.id);
                                    lastWorldListJson = "";
                                    renderRoomList();
                                } catch (e) { console.warn("deleteRoom:", e); }
                            });
                            tdDel.appendChild(delBtn);
                        }
                        tr.appendChild(tdDel);

                        tr.addEventListener("click", () => {
                            if (isCurrent) return;
                            game.currentWorldName = w.name || `World ${w.id}`;
                            game.moveBookmark(`world_${w.id}`, { x: 0, z: 0 }, w.id);
                            lastWorldListJson = "";
                            renderRoomList();
                        });
                        frag.appendChild(tr);
                    }
                    roomTbody.innerHTML = "";
                    roomTbody.appendChild(frag);
                }).catch(e => console.warn("getWorldList:", e));
            };

            // tick方式ポーリング（約1秒おき、パネル表示中のみ）
            let roomTickCounter = 0;
            game.scene.onAfterRenderObservable.add(() => {
                if (roomPanel.style.display === "none") return;
                if (++roomTickCounter >= 60) {
                    roomTickCounter = 0;
                    renderRoomList();
                }
            });

            // パネル表示時に初回描画
            let lastRoomDisplay = roomPanel.style.display;
            new MutationObserver(() => {
                const now = roomPanel.style.display;
                if (now !== lastRoomDisplay) {
                    lastRoomDisplay = now;
                    if (now !== "none") {
                        roomTickCounter = 0;
                        lastWorldListJson = "";
                        renderRoomList();
                    }
                }
            }).observe(roomPanel, { attributes: true, attributeFilter: ["style"] });

            // 閉じるボタン
            if (roomClose) {
                roomClose.addEventListener("click", () => {
                    roomPanel.style.display = "none";
                    const sCk = (k: string, v: string) =>
                        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
                    sCk("showRooms", "0");
                    const mb = document.getElementById("menu-rooms");
                    if (mb) mb.textContent = "　 部屋一覧";
                });
            }

            // ドラッグ
            const rHeader = document.getElementById("room-list-header");
            if (rHeader && !isMobileDev) {
                let isDrag = false, offX = 0, offY = 0;
                rHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                    if ((e.target as HTMLElement).id === "room-list-close") return;
                    isDrag = true;
                    offX = e.clientX - roomPanel.getBoundingClientRect().left;
                    offY = e.clientY - roomPanel.getBoundingClientRect().top;
                    rHeader.setPointerCapture(e.pointerId);
                    e.preventDefault();
                });
                document.addEventListener("pointermove", (e: PointerEvent) => {
                    if (!isDrag) return;
                    roomPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                    roomPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
                });
                document.addEventListener("pointerup", () => {
                    if (!isDrag) return;
                    isDrag = false;
                    const r = roomPanel.getBoundingClientRect();
                    const sCk = (k: string, v: string) =>
                        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
                    sCk("room-list-panel_l", String(Math.round(r.left)));
                    sCk("room-list-panel_t", String(Math.round(r.top)));
                });
                new ResizeObserver(() => {
                    const r = roomPanel.getBoundingClientRect();
                    const sCk = (k: string, v: string) =>
                        document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
                    sCk("room-list-panel_w", String(Math.round(r.width)));
                    sCk("room-list-panel_h", String(Math.round(r.height)));
                }).observe(roomPanel);
            }
        }
    }

    // ===== オセロ サウンドエフェクト（Web Audio API） =====
    let othAudioCtx: AudioContext | null = null;
    const othelloPlaySound = (type: "place" | "flip" | "end") => {
        if (!othAudioCtx) {
            try { othAudioCtx = new AudioContext(); } catch { return; }
        }
        const ctx = othAudioCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        const now = ctx.currentTime;
        if (type === "place") {
            osc.type = "sine";
            osc.frequency.setValueAtTime(800, now);
            osc.frequency.exponentialRampToValueAtTime(400, now + 0.08);
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            osc.start(now);
            osc.stop(now + 0.1);
        } else if (type === "flip") {
            osc.type = "triangle";
            osc.frequency.setValueAtTime(600, now);
            osc.frequency.exponentialRampToValueAtTime(900, now + 0.06);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
            osc.start(now);
            osc.stop(now + 0.08);
        } else {
            // end: 3音のチャイム
            for (let i = 0; i < 3; i++) {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.connect(g);
                g.connect(ctx.destination);
                o.type = "sine";
                o.frequency.setValueAtTime([523, 659, 784][i], now + i * 0.15);
                g.gain.setValueAtTime(0.12, now + i * 0.15);
                g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.3);
                o.start(now + i * 0.15);
                o.stop(now + i * 0.15 + 0.3);
            }
            return;
        }
    };

    // ===== オセロパネル ドラッグ & クローズ & サーバ駆動ゲーム =====
    {
        const othPanel     = document.getElementById("othello-panel") as HTMLElement | null;
        const othHeader    = document.getElementById("othello-header") as HTMLElement | null;
        const othClose     = document.getElementById("othello-close") as HTMLElement | null;
        const othLobby     = document.getElementById("othello-lobby") as HTMLElement | null;
        const othGameView  = document.getElementById("othello-game") as HTMLElement | null;
        const othBoard     = document.getElementById("othello-board") as HTMLElement | null;
        const othBlack     = document.getElementById("othello-black-count") as HTMLElement | null;
        const othWhite     = document.getElementById("othello-white-count") as HTMLElement | null;
        const othStatus    = document.getElementById("othello-status") as HTMLElement | null;
        const othMyColor   = document.getElementById("othello-my-color") as HTMLElement | null;
        const othCreateBtn = document.getElementById("othello-create-btn") as HTMLButtonElement | null;
        const othGameList  = document.getElementById("othello-game-list") as HTMLElement | null;
        const othPassBtn   = document.getElementById("othello-pass-btn") as HTMLButtonElement | null;
        const othResignBtn = document.getElementById("othello-resign-btn") as HTMLButtonElement | null;
        const othBackBtn   = document.getElementById("othello-back-btn") as HTMLButtonElement | null;

        if (othPanel && othHeader && othBoard && othLobby && othGameView) {
            // --- サーバ駆動ゲーム状態 ---
            let currentGameId: string | null = null;
            let myColor: number = 0; // 1=黒, 2=白, 0=観戦
            let board: number[] = new Array(64).fill(0);
            let currentTurn = 0;
            let gameStatus = "";
            let lastMoveIdx = -1;
            let winner = 0;
            let subscribed = false;
            let prevBoard: number[] = new Array(64).fill(0);

            const myUid = () => game.nakama.getSession()?.user_id ?? "";

            // --- 8方向探索（ヒント表示用、クライアントのみ） ---
            const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
            const getLocalLegalMoves = (color: number): Set<number> => {
                const moves = new Set<number>();
                for (let r = 0; r < 8; r++) {
                    for (let c = 0; c < 8; c++) {
                        if (board[r * 8 + c] !== 0) continue;
                        const opp = color === 1 ? 2 : 1;
                        for (const [dr, dc] of DIRS) {
                            let nr = r + dr, nc = c + dc, count = 0;
                            while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr * 8 + nc] === opp) {
                                count++; nr += dr; nc += dc;
                            }
                            if (count > 0 && nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr * 8 + nc] === color) {
                                moves.add(r * 8 + c);
                                break;
                            }
                        }
                    }
                }
                return moves;
            };

            // --- 画面切り替え ---
            const showLobby = () => {
                othLobby.style.display = "";
                othGameView.style.display = "none";
                currentGameId = null;
                myColor = 0;
                prevBoard = new Array(64).fill(0);
                refreshGameList();
            };

            const showGame = () => {
                othLobby.style.display = "none";
                othGameView.style.display = "";
            };

            // --- ゲーム一覧取得 ---
            const refreshGameList = async () => {
                if (!othGameList) return;
                const uid = myUid();
                const res = await game.nakama.othelloList(game.currentWorldId);
                othGameList.innerHTML = "";
                for (const g of res.games) {
                    // 自分が参加中のゲームは自動的にそのゲーム画面へ
                    if (g.black === uid || g.white === uid) {
                        currentGameId = g.gameId;
                        myColor = g.black === uid ? 1 : 2;
                        // RPC で最新状態を取得して描画
                        const state = await game.nakama.othelloJoin(g.gameId);
                        if (state) applyState(state);
                        showGame();
                        return;
                    }
                    // 待機中のゲームを一覧に表示
                    if (g.status === "waiting") {
                        const item = document.createElement("div");
                        item.className = "othello-game-item";
                        const info = document.createElement("span");
                        info.textContent = `${escapeHtml(g.blackName || "???")} の対戦`;
                        const joinBtn = document.createElement("button");
                        joinBtn.textContent = "参加";
                        joinBtn.addEventListener("click", () => joinGame(g.gameId));
                        item.appendChild(info);
                        item.appendChild(joinBtn);
                        othGameList.appendChild(item);
                    }
                }
                if (othGameList.children.length === 0) {
                    const empty = document.createElement("div");
                    empty.style.cssText = "font-size:12px;color:#888;text-align:center;padding:8px;";
                    empty.textContent = "待機中の対戦はありません";
                    othGameList.appendChild(empty);
                }
            };

            // --- ゲーム作成 ---
            const createGame = async () => {
                const res = await game.nakama.othelloCreate(game.currentWorldId);
                if (!res) return;
                currentGameId = res.gameId;
                myColor = res.black === myUid() ? 1 : 2;
                applyState(res);
                showGame();
            };

            // --- ゲーム参加 ---
            const joinGame = async (gameId: string) => {
                const res = await game.nakama.othelloJoin(gameId);
                if (!res) return;
                currentGameId = res.gameId;
                myColor = res.black === myUid() ? 1 : (res.white === myUid() ? 2 : 0);
                applyState(res);
                showGame();
            };

            // --- サーバからの状態を適用 ---
            const applyState = (data: import("./NakamaService").OthelloUpdatePayload) => {
                if (data.gameId !== currentGameId) return;
                // 石の変化を検出してサウンド再生
                if (data.status === "playing" && data.lastMove >= 0) {
                    let flips = 0;
                    for (let i = 0; i < 64; i++) {
                        if (prevBoard[i] !== 0 && data.board[i] !== prevBoard[i]) flips++;
                    }
                    if (flips > 0) setTimeout(() => othelloPlaySound("flip"), 80);
                    othelloPlaySound("place");
                } else if (data.status === "finished" && gameStatus !== "finished") {
                    setTimeout(() => othelloPlaySound("end"), 200);
                }
                board = data.board;
                currentTurn = data.turn;
                gameStatus = data.status;
                lastMoveIdx = data.lastMove;
                winner = data.winner;
                if (othBlack) othBlack.textContent = String(data.blackCount);
                if (othWhite) othWhite.textContent = String(data.whiteCount);
                renderBoard();
            };

            // --- 盤面描画 ---
            const renderBoard = () => {
                const isMyTurn = gameStatus === "playing" && currentTurn === myColor;
                const legalMoves = isMyTurn ? getLocalLegalMoves(myColor) : new Set<number>();
                othBoard.innerHTML = "";
                for (let r = 0; r < 8; r++) {
                    for (let c = 0; c < 8; c++) {
                        const idx = r * 8 + c;
                        const cell = document.createElement("div");
                        cell.className = "othello-cell";
                        if (idx === lastMoveIdx) cell.classList.add("last-move");
                        if (board[idx] !== 0) {
                            const stone = document.createElement("div");
                            const colorCls = board[idx] === 1 ? "black" : "white";
                            const prev = prevBoard[idx];
                            if (prev === 0) {
                                // 新規配置
                                stone.className = "stone " + colorCls + " place";
                            } else if (prev !== 0 && prev !== board[idx]) {
                                // 裏返し
                                stone.className = "stone " + colorCls + " flip";
                            } else {
                                stone.className = "stone " + colorCls;
                            }
                            cell.appendChild(stone);
                        } else if (legalMoves.has(idx)) {
                            cell.classList.add("hint");
                        }
                        cell.addEventListener("click", () => onCellClick(r, c));
                        othBoard.appendChild(cell);
                    }
                }
                prevBoard = [...board];

                // ステータス表示
                if (othStatus) {
                    if (gameStatus === "finished") {
                        othStatus.className = "oth-result";
                        if (winner === 3) othStatus.textContent = "引き分け";
                        else if (winner === myColor) othStatus.textContent = "🎉 あなたの勝ち！";
                        else if (winner === 1) othStatus.textContent = "⚫ 黒の勝ち";
                        else if (winner === 2) othStatus.textContent = "⚪ 白の勝ち";
                    } else if (gameStatus === "waiting") {
                        othStatus.className = "";
                        othStatus.textContent = "対戦相手を待っています…";
                    } else {
                        othStatus.className = "";
                        const turnLabel = currentTurn === 1 ? "⚫ 黒の番" : "⚪ 白の番";
                        othStatus.textContent = isMyTurn ? turnLabel + "（あなた）" : turnLabel;
                    }
                }

                // 自分の色表示
                if (othMyColor) {
                    if (myColor === 1) othMyColor.textContent = "あなた: ⚫ 黒";
                    else if (myColor === 2) othMyColor.textContent = "あなた: ⚪ 白";
                    else othMyColor.textContent = "";
                }

                // パスボタン: 自分のターンかつ合法手なしでのみ有効
                if (othPassBtn) othPassBtn.disabled = !isMyTurn || legalMoves.size > 0;
                // 投了ボタン: ゲーム中かつ自分が参加者のときのみ有効
                if (othResignBtn) othResignBtn.disabled = gameStatus !== "playing" || myColor === 0;
                // 戻るボタン: 終局時のみ表示
                if (othBackBtn) othBackBtn.style.display = gameStatus === "finished" ? "" : "none";
            };

            // --- セルクリック（サーバに送信） ---
            const onCellClick = async (r: number, c: number) => {
                if (!currentGameId || gameStatus !== "playing" || currentTurn !== myColor) return;
                try {
                    await game.nakama.othelloMove(currentGameId, r, c);
                } catch (e) {
                    console.warn("othelloMove error:", e);
                }
            };

            // --- パスボタン（サーバにパスRPCは未実装のため、サーバ側自動パスに依存）---
            // サーバ側で合法手なし時に自動パスするため、クライアントのパスボタンは
            // 現時点では直接的な操作を行わない（UI上の表示のみ）

            // --- 投了ボタン ---
            if (othResignBtn) {
                othResignBtn.addEventListener("click", async () => {
                    if (!currentGameId || gameStatus !== "playing" || myColor === 0) return;
                    try {
                        await game.nakama.othelloResign(currentGameId);
                    } catch (e) {
                        console.warn("othelloResign error:", e);
                    }
                });
            }

            // --- 作成ボタン ---
            if (othCreateBtn) {
                othCreateBtn.addEventListener("click", () => { createGame().catch(e => console.warn("othelloCreate error:", e)); });
            }

            // --- 戻るボタン ---
            if (othBackBtn) {
                othBackBtn.addEventListener("click", () => showLobby());
            }

            // --- サーバからの更新通知ハンドラ ---
            game.nakama.onOthelloUpdate = (data) => {
                if (data.gameId !== currentGameId) {
                    // ロビー表示中なら一覧を更新
                    if (!currentGameId && othLobby.style.display !== "none") {
                        refreshGameList();
                    }
                    return;
                }
                applyState(data);
            };

            // --- 購読管理 ---
            const ensureSubscribe = async () => {
                if (!subscribed) {
                    await game.nakama.othelloSubscribe(true);
                    subscribed = true;
                }
            };
            const ensureUnsubscribe = async () => {
                if (subscribed) {
                    await game.nakama.othelloSubscribe(false);
                    subscribed = false;
                }
            };

            // パネル表示時に購読 + ロビー表示
            const panelObs = new MutationObserver(() => {
                if (othPanel.style.display !== "none") {
                    ensureSubscribe().catch(e => console.warn("othelloSubscribe error:", e));
                    if (!currentGameId) showLobby();
                } else {
                    ensureUnsubscribe().catch(e => console.warn("othelloUnsubscribe error:", e));
                }
            });
            panelObs.observe(othPanel, { attributes: true, attributeFilter: ["style"] });

            // --- クッキー復元 ---
            const sCk = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            if (!isMobileDev) {
                const gCk = (k: string): string | null => {
                    const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                    return m ? decodeURIComponent(m[1]) : null;
                };
                const sL = gCk("othello-panel_l"), sT = gCk("othello-panel_t");
                const sW = gCk("othello-panel_w"), sH = gCk("othello-panel_h");
                if (sL !== null) { othPanel.style.left = sL + "px"; othPanel.style.transform = "none"; }
                if (sT !== null) othPanel.style.top = sT + "px";
                if (sW !== null) othPanel.style.width = sW + "px";
                if (sH !== null) othPanel.style.height = sH + "px";
            }

            // --- ドラッグ ---
            if (!isMobileDev) {
                let isDrag = false, offX = 0, offY = 0;
                othHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                    if ((e.target as HTMLElement).id === "othello-close") return;
                    isDrag = true;
                    const rect = othPanel.getBoundingClientRect();
                    offX = e.clientX - rect.left;
                    offY = e.clientY - rect.top;
                    othHeader.setPointerCapture(e.pointerId);
                    e.preventDefault();
                });
                document.addEventListener("pointermove", (e: PointerEvent) => {
                    if (!isDrag) return;
                    othPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                    othPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
                    othPanel.style.transform = "none";
                });
                document.addEventListener("pointerup", () => {
                    if (!isDrag) return;
                    isDrag = false;
                    const r = othPanel.getBoundingClientRect();
                    sCk("othello-panel_l", String(Math.round(r.left)));
                    sCk("othello-panel_t", String(Math.round(r.top)));
                });
                new ResizeObserver(() => {
                    if (othPanel.style.display === "none") return;
                    const r = othPanel.getBoundingClientRect();
                    sCk("othello-panel_w", String(Math.round(r.width)));
                    sCk("othello-panel_h", String(Math.round(r.height)));
                }).observe(othPanel);
            }

            // --- 閉じる ---
            if (othClose) {
                othClose.addEventListener("click", () => {
                    const r = othPanel.getBoundingClientRect();
                    sCk("othello-panel_l", String(Math.round(r.left)));
                    sCk("othello-panel_t", String(Math.round(r.top)));
                    sCk("othello-panel_w", String(Math.round(r.width)));
                    sCk("othello-panel_h", String(Math.round(r.height)));
                    othPanel.style.display = "none";
                    sCk("showOthello", "0");
                    const mb = document.getElementById("menu-othello");
                    if (mb) mb.textContent = "　 " + t("menu.othello");
                });
            }
        }
    }

    // ワールド変更時に部屋名を非同期で取得
    game.onWorldChanged.push(() => {
        // 新マッチの presences に含まれない旧エントリを削除
        // （changeWorldMatch 完了後なので、新マッチの presences は既に userMap に登録済み）
        const currentPresences = new Set(game.nakama.currentPresenceIds ?? []);
        for (const sid of userMap.keys()) {
            if (!currentPresences.has(sid)) userMap.delete(sid);
        }
        game.nakama.getWorldList().then(({ worlds }) => {
            const w = worlds.find(w => w.id === game.currentWorldId);
            if (w) game.currentWorldName = w.name || `World ${w.id}`;
        }).catch(() => {});
        scheduleRenderUserList();
        // 新マッチに再 subscribe（パネル表示中ならfull、非表示ならcount）
        if (isUlPanelVisible()) {
            _playerListMode = null;
            subPlayerListFull();
        } else {
            _playerListMode = null;
            subPlayerListCount();
        }
    });

    sendBtn.onclick = () => { sendMessage(); };
    textarea.onkeydown = (e) => {
        // Enter: 送信、Shift+Enter: 改行（PC/スマホ共通）
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    // リサイズをマウス離し時に行単位へスナップ
    const lineH = 20;
    const borderH = 4;
    let lastH = textarea.offsetHeight;
    document.addEventListener("pointerup", () => {
        const h = textarea.offsetHeight;
        if (h === lastH) return;
        const lines = Math.max(1, Math.round((h - borderH) / lineH));
        const snapped = lines * lineH + borderH;
        textarea.style.height = snapped + "px";
        lastH = snapped;
    });

    // ===== モバイル・ポートレート専用パネルタブバー =====
    // 表示名設定 / サーバ接続ログ / ブックマーク を横スクロールタブで切替
    {
        const tabBar = document.getElementById("panel-tab-bar");
        const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".panel-tab"));
        const closeBtn = document.getElementById("panel-tab-close");
        if (tabBar && tabs.length > 0) {
            // タブラベルを「N.<訳語>」形式で描画（言語切替時にも呼ぶ）
            const renderTabLabels = () => {
                tabs.forEach((tab, i) => {
                    const key = tab.dataset.tabKey;
                    if (!key) return;
                    tab.textContent = `${i + 1}.${t(key as Parameters<typeof t>[0])}`;
                });
            };
            renderTabLabels();
            onLangChangeCallbacks.push(renderTabLabels);

            // タブクリック → 対応するメニューボタンの click を発火して既存トグルを再利用
            for (const tab of tabs) {
                tab.addEventListener("click", () => {
                    if (justDraggedFromTab) return; // 直前にドラッグでデバイダー移動した場合は抑止
                    const menuId = tab.dataset.menu;
                    if (!menuId) return;
                    const menuBtn = document.getElementById(menuId);
                    const target = document.getElementById(tab.dataset.target || "");
                    if (!menuBtn || !target) return;
                    // 既に表示中のタブを再タップした場合は閉じない（タブは切替専用）
                    if (target.style.display !== "none") return;
                    menuBtn.click();
                });
            }
            // ✕ボタン → アクティブなパネルを閉じる（＝そのメニューボタンを再クリック）
            if (closeBtn) {
                closeBtn.addEventListener("click", () => {
                    const activeTab = tabBar.querySelector<HTMLButtonElement>(".panel-tab.active");
                    if (!activeTab) return;
                    const menuBtn = document.getElementById(activeTab.dataset.menu || "");
                    menuBtn?.click();
                });
            }
            // パネル表示状態の監視 → タブバーの表示位置・アクティブ状態を同期
            const syncTabBar = () => {
                let activePanelId: string | null = null;
                for (const tab of tabs) {
                    const panelId = tab.dataset.target;
                    if (!panelId) continue;
                    const panel = document.getElementById(panelId);
                    if (panel && panel.style.display !== "none") {
                        activePanelId = panelId;
                        break;
                    }
                }
                if (activePanelId) {
                    const activePanel = document.getElementById(activePanelId);
                    const scrollEl = document.getElementById("panel-tabs-scroll");
                    const didMove = !!(activePanel && tabBar.parentElement !== activePanel);
                    if (activePanel && didMove) {
                        activePanel.insertBefore(tabBar, activePanel.firstChild);
                    }
                    for (const tab of tabs) {
                        tab.classList.toggle("active", tab.dataset.target === activePanelId);
                    }
                    document.body.classList.add("tab-panel-active");
                    // 直前に開いたパネルをハンバーガーの再表示用に記憶
                    const activeTabEl = tabBar.querySelector<HTMLButtonElement>(".panel-tab.active");
                    if (activeTabEl?.dataset.menu) {
                        document.body.dataset.tabLastMenu = activeTabEl.dataset.menu;
                    }
                    // モバイル（ポートレート／ランドスケープ）時のみ CSS に表示を委ね、それ以外（PC）は非表示
                    const isMobile = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
                    tabBar.style.display = isMobile ? "" : "none";
                    // アクティブタブを中央寄せ。パネル移動時はレイアウト確定前に scrollLeft を触るとクランプされて 0 に張り付くため、
                    // rAF 後に scrollLeft を直接セット（smooth だと 0 から target へアニメーションしてしまう）。
                    const centerActive = () => {
                        if (!scrollEl) return;
                        const activeTab = tabBar.querySelector<HTMLButtonElement>(".panel-tab.active");
                        if (!activeTab) return;
                        const tabRect = activeTab.getBoundingClientRect();
                        const scrollRect = scrollEl.getBoundingClientRect();
                        if (scrollRect.width === 0) return;
                        const targetLeft = scrollEl.scrollLeft + tabRect.left - scrollRect.left
                            - (scrollRect.width - tabRect.width) / 2;
                        scrollEl.scrollLeft = Math.max(0, targetLeft);
                    };
                    if (didMove) {
                        requestAnimationFrame(centerActive);
                    } else {
                        centerActive();
                    }
                } else {
                    document.body.classList.remove("tab-panel-active");
                    // パネル全閉じ時は全タブの active クラスをクリア
                    // （古い active 状態が残るとハンバーガーが「アクティブパネルあり」と誤判定する）
                    for (const tab of tabs) tab.classList.remove("active");
                    // タブバーを body 直下に戻して非表示
                    if (tabBar.parentElement !== document.body) {
                        document.body.appendChild(tabBar);
                    }
                    tabBar.style.display = "none";
                }
            };
            const observer = new MutationObserver(syncTabBar);
            for (const tab of tabs) {
                const panel = document.getElementById(tab.dataset.target || "");
                if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["style"] });
            }
            syncTabBar();
        }
    }
}
