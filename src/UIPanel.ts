import type { GameScene } from "./GameScene";
import { Mesh } from "@babylonjs/core";
import { fnv1a64, CHUNK_SIZE } from "./WorldConstants";
import { prof } from "./Profiler";
import { t, getLang, setLang, applyI18n } from "./i18n";
import type { Lang } from "./i18n";

export function setupHtmlUI(game: GameScene): void {
    const isMobileDev = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;

    // --- i18n 言語セレクター ---
    const langSelect = document.getElementById("langSelect") as HTMLSelectElement | null;
    const onLangChangeCallbacks: (() => void)[] = [];
    if (langSelect) {
        langSelect.value = getLang();
        langSelect.addEventListener("change", () => {
            setLang(langSelect.value as Lang);
            applyI18n();
            applyI18nMenus();
            for (const cb of onLangChangeCallbacks) cb();
        });
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
                         "server-log-list", "ping-body", "ccu-body", "debug-content", "about-panel-body", "displayname-body"];
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
            divider.addEventListener("pointerdown", (e: PointerEvent) => {
                dragging = true;
                divider.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                const pct = Math.max(20, Math.min(80, (e.clientX / window.innerWidth) * 100));
                document.documentElement.style.setProperty("--ls-divider", pct + "%");
                game.engine.resize();
                for (const cb of game.onDividerMove) cb();
            });
            document.addEventListener("pointerup", () => {
                if (dragging) {
                    dragging = false;
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
                const vhPx = document.body.getBoundingClientRect().height;
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
            if (isMobileDev) {
                const headerIds = ["user-list-header", "chat-history-header", "chat-settings-header",
                                   "server-settings-header", "server-log-header", "ping-header", "ccu-header", "bookmark-header", "room-list-header", "debug-title-bar", "about-panel-header"];
                for (const hid of headerIds) {
                    const hdr = document.getElementById(hid);
                    if (hdr) hdr.addEventListener("pointerdown", (e: PointerEvent) => {
                        // ランドスケープではヘッダードラッグ不要（ツールチップ優先）
                        if (window.matchMedia("(orientation: landscape)").matches) return;
                        const t = e.target as HTMLElement;
                        if (t.closest("[id$='-close']")) return; // ✕ボタンは除外
                        startDrag(e, hdr);
                    });
                }
            }
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                const vhPx = document.body.getBoundingClientRect().height;
                const pct = Math.max(30, Math.min(75, ((e.clientY - dragOffsetPx) / vhPx) * 100));
                document.documentElement.style.setProperty("--pt-divider", pct + "vh");
                game.engine.resize();
            });
            document.addEventListener("pointerup", () => {
                if (dragging) {
                    dragging = false;
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
            dragOffsetX = e.clientX - historyPanel.getBoundingClientRect().left;
            dragOffsetY = e.clientY - historyPanel.getBoundingClientRect().top;
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
    }

    // ===== ユーザーリスト ドラッグ & 最小化 =====
    {
        const ulPanel  = document.getElementById("user-list-panel") as HTMLElement;
        const ulHeader = document.getElementById("user-list-header") as HTMLElement;
        const ulClose  = document.getElementById("user-list-close") as HTMLElement;

        if (ulPanel && ulHeader) {
            if (!isMobileDev) {
                const initRect = ulPanel.getBoundingClientRect();
                ulPanel.style.left  = initRect.left + "px";
                ulPanel.style.right = "auto";
            }

            const sCookieFn = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            let isDrag = false, offX = 0, offY = 0;
            ulHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "user-list-close") return;
                if (isMobileDev) return;
                isDrag = true;
                offX = e.clientX - ulPanel.getBoundingClientRect().left;
                offY = e.clientY - ulPanel.getBoundingClientRect().top;
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
        }
    }
    // ===============================================

    let chatOverlayMax = 5;
    const chatOverlay = document.getElementById("chat-overlay");
    // GameScene 経由で外部からアクセスできるようにする
    (game as any).chatOverlayMax = chatOverlayMax;
    /** テキスト1行の高さ（px） */
    const getOlTextLineH = (): number => {
        if (!chatOverlay) return 19.5;
        const fs = parseFloat(getComputedStyle(chatOverlay).fontSize) || 13;
        return fs * 1.5; // line-height: 1.5
    };
    /** メッセージが占めるテキスト行数を計算（折り返し含む） */
    const getOlMsgLines = (el: HTMLElement): number => {
        const textLineH = getOlTextLineH();
        const cs = getComputedStyle(el);
        const contentH = el.offsetHeight - parseFloat(cs.paddingTop || "0") - parseFloat(cs.paddingBottom || "0");
        return Math.max(1, Math.ceil(contentH / textLineH - 0.1));
    };
    /** 全メッセージをDOMに保持し、テキスト行数の合計がchatOverlayMaxに収まる分だけ表示
     *  枠を超えるメッセージは下の行だけ部分表示する */
    const trimOlVisibility = () => {
        if (!chatOverlay) return;
        if (chatOverlayMax === 0) { chatOverlay.style.display = "none"; return; }
        chatOverlay.style.display = "";
        const children = Array.from(chatOverlay.children) as HTMLElement[];
        // まず全てリセット
        for (const el of children) {
            el.style.display = "";
            el.style.maxHeight = "";
            el.style.overflow = "";
            el.style.marginTop = "";
        }
        // 末尾（最新）からテキスト行数を積み上げ
        let totalLines = 0;
        for (let i = children.length - 1; i >= 0; i--) {
            const lines = getOlMsgLines(children[i]);
            if (totalLines + lines <= chatOverlayMax) {
                totalLines += lines;
            } else {
                // 残り行数分だけ部分表示
                const remainLines = chatOverlayMax - totalLines;
                if (remainLines > 0) {
                    const el = children[i];
                    const msgLines = getOlMsgLines(el);
                    const hideLines = msgLines - remainLines;
                    if (hideLines > 0) {
                        const cs = getComputedStyle(el);
                        const pt = parseFloat(cs.paddingTop || "0");
                        // 上部の行を隠す: paddingTop + 隠す行数分を負のmargin-topで押し上げ
                        el.style.marginTop = "-" + (hideLines * getOlTextLineH() + pt) + "px";
                        el.style.overflow = "hidden";
                    }
                } else {
                    children[i].style.display = "none";
                }
                // それ以前を全て非表示
                for (let j = i - 1; j >= 0; j--) children[j].style.display = "none";
                break;
            }
        }
    };
    (game as any).setChatOverlayMax = (n: number) => {
        chatOverlayMax = n;
        (game as any).chatOverlayMax = n;
        trimOlVisibility();
    };

    trimOlVisibility();

    const addChatOverlay = (avatarName: string, text: string, timeStr: string, nameColor?: string, senderId?: string) => {
        if (!chatOverlay || !text || chatOverlayMax === 0) return;
        const isSystem = avatarName === "[system]";
        const line = document.createElement("div");
        line.className = "chat-ol-line";
        if (isSystem) {
            line.innerHTML =
                `<span class="chat-ol-time">${timeStr}</span>` +
                `${text}`;
        } else {
            const colorStyle = nameColor ? ` style="color:${nameColor}"` : "";
            line.innerHTML =
                `<span class="chat-ol-time">${timeStr}</span>` +
                `<span class="chat-ol-name"${colorStyle}>${avatarName}:</span> ${text}`;
        }
        if (senderId) line.dataset.sender = senderId;
        chatOverlay.appendChild(line);
        trimOlVisibility();
        // メモリ節約: 非表示要素が多すぎたら古い行を削除
        const keepMax = Math.max(chatOverlayMax * 3, 20);
        while (chatOverlay.children.length > keepMax) {
            chatOverlay.removeChild(chatOverlay.firstChild!);
        }
    };

    /** 指定ユーザーの既存オーバーレイメッセージの名前色を一括更新 */
    const updateOverlayNameColor = (userId: string, newColor: string) => {
        if (!chatOverlay) return;
        for (const el of chatOverlay.children) {
            const line = el as HTMLElement;
            if (line.dataset.sender !== userId) continue;
            const nameEl = line.querySelector(".chat-ol-name") as HTMLElement | null;
            if (nameEl) nameEl.style.color = newColor;
        }
    };

    const addChatHistory = (avatarName: string, text: string, nameColor?: string, senderId?: string, serverTs = 0) => {
        const _end = prof("UIPanel.addChatHistory");
        if (!text) { _end(); return; }
        const list = document.getElementById("chat-history-list");
        if (!list) { _end(); return; }

        const now = serverTs > 0 ? new Date(serverTs) : new Date();
        const hh = String(now.getHours()).padStart(2, "0");
        const mm = String(now.getMinutes()).padStart(2, "0");
        const timeStr = `${hh}:${mm}`;

        const entry = document.createElement("div");
        entry.className = "chat-history-entry";
        const nameClass = avatarName === "[system]" ? "chat-history-system" : "chat-history-name";
        entry.innerHTML =
            `<span class="chat-history-time">${timeStr}</span>` +
            `<span class="${nameClass}">${avatarName}</span>` +
            `<span class="chat-history-text">${text}</span>`;
        list.appendChild(entry);
        entry.scrollIntoView({ block: "end", behavior: "instant" });

        // チャットオーバーレイにも追加
        addChatOverlay(avatarName, text, timeStr, nameColor, senderId);

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
    const resolveDisplayLabel = (displayName: string, username: string, sessionId?: string): { text: string; color: string; suffix: string } => {
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
        if (displayName) return { text: displayName, color: "white", suffix };
        return { text: "@" + username, color, suffix };
    };

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

    const userMap = new Map<string, { username: string; displayName: string; uuid: string; sessionId: string; loginTimestamp: number; loginTime: string; channel: "chat" | "match" | "chat+match"; nameColor?: string }>();
    type UlSortKey = "username" | "displayName" | "uuid" | "sessionId" | "loginTime" | "loginTimestamp" | "channel";
    let ulSortKey: UlSortKey = "username";
    let ulSortAsc = true;
    const thUser  = document.getElementById("ul-th-user")  as HTMLTableCellElement;
    const thDname = document.getElementById("ul-th-dname") as HTMLTableCellElement;
    const thUuid  = document.getElementById("ul-th-uuid")  as HTMLTableCellElement;
    const thSid   = document.getElementById("ul-th-sid")   as HTMLTableCellElement;
    const thTime  = document.getElementById("ul-th-time")  as HTMLTableCellElement;
    const thRel   = document.getElementById("ul-th-rel")   as HTMLTableCellElement;

    const relativeTime = (ts: number): string => {
        const secs = Math.floor((Date.now() - ts) / 1000);
        if (secs < 60) return `${secs}秒`;
        const mins = Math.floor(secs / 60);
        if (mins < 60) return `${mins}分`;
        const hours = Math.floor(mins / 60);
        const remMins = mins % 60;
        if (hours < 24) return remMins > 0 ? `${hours}時間${remMins}分` : `${hours}時間`;
        return `${Math.floor(hours / 24)}日`;
    };

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

    const renderUserList = () => {
        cc("renderUserList");
        const _end = prof("UIPanel.renderUserList");
        if (!userListBody) { _end(); return; }
        // パネルが非表示ならスキップ（表示時に再レンダリングされる）
        if (ulPanel && ulPanel.style.display === "none") { _end(); return; }
        const _rt0 = performance.now();
        const entries = [...userMap.values()].sort((a, b) => {
            if (ulSortKey === "loginTimestamp")
                return ulSortAsc ? a.loginTimestamp - b.loginTimestamp : b.loginTimestamp - a.loginTimestamp;
            const va = a[ulSortKey as "username" | "displayName" | "uuid" | "sessionId" | "loginTime" | "channel"] ?? "";
            const vb = b[ulSortKey as "username" | "displayName" | "uuid" | "sessionId" | "loginTime" | "channel"] ?? "";
            return ulSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        });
        const arrow = ulSortAsc ? "▲" : "▼";
        if (thUser)  thUser.dataset.sort  = ulSortKey === "username"        ? arrow : "";
        if (thDname) thDname.dataset.sort = ulSortKey === "displayName"   ? arrow : "";
        if (thUuid)  thUuid.dataset.sort  = ulSortKey === "uuid"          ? arrow : "";
        if (thSid)   thSid.dataset.sort   = ulSortKey === "sessionId"     ? arrow : "";
        if (thTime)  thTime.dataset.sort  = ulSortKey === "loginTime"     ? arrow : "";
        if (thRel)   thRel.dataset.sort   = ulSortKey === "loginTimestamp" ? arrow : "";
        const thCh = document.getElementById("ul-th-ch");
        if (thCh)    thCh.dataset.sort    = ulSortKey === "channel"        ? arrow : "";
        const myId = game.nakama.selfSessionId ?? "";
        const myMatchId  = game.nakama.selfMatchId  ?? "";
        const matchShort = myMatchId  ? myMatchId.slice(0, 8)  : "-";
        // DocumentFragment でまとめて構築し一度だけ DOM に挿入
        const frag = document.createDocumentFragment();
        for (const { username, displayName, uuid, sessionId, loginTimestamp, loginTime, channel } of entries) {
            const tr = document.createElement("tr");
            const bold = sessionId === myId ? " class=\"ul-self\"" : "";
            const rel = relativeTime(loginTimestamp);
            const lbl = resolveDisplayLabel(displayName, username, sessionId);
            const fullName = lbl.suffix ? lbl.text + lbl.suffix : lbl.text;
            tr.innerHTML = `<td${bold} title="${username}">${username}</td><td title="${fullName}">${fullName}</td><td class="uuid-cell" data-copy="${uuid}" title="${uuid}&#10;クリックでコピー">${uuid.slice(0, 8)}</td><td class="uuid-cell" data-copy="${sessionId.slice(0, 8)}" title="${sessionId.slice(0, 8)}&#10;クリックでコピー">${sessionId.slice(0, 8)}</td><td title="${channel}">${channel}</td><td class="uuid-cell" data-copy="${myMatchId}" title="${myMatchId}&#10;クリックでコピー">${matchShort}</td><td title="${rel}">${rel}</td><td title="${loginTime}">${loginTime}</td>`;
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

    // パネル表示時にレンダリングをトリガー（非表示中はスキップしているため）
    if (ulPanel) {
        let ulWasHidden = ulPanel.style.display === "none";
        new MutationObserver(() => {
            const isHidden = ulPanel.style.display === "none";
            if (ulWasHidden && !isHidden) renderUserList();
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

    // 約10秒おきにプレイヤーリストを更新（tick方式）
    let ulTickCounter = 0;
    game.scene.onAfterRenderObservable.add(() => {
        if (++ulTickCounter >= 600) { // ≈10秒（60FPS想定）
            ulTickCounter = 0;
            scheduleRenderUserList();
        }
    });

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

    game.nakama.onChatMessage = (username, text, userId, senderSid, ts) => {
        // 表示名を優先（なければ @ユーザID）— sessionId でサフィックス解決
        const entry = senderSid ? userMap.get(senderSid) : undefined;
        const chatName = entry
            ? resolveDisplayLabel(entry.displayName, entry.username, senderSid).text + resolveDisplayLabel(entry.displayName, entry.username, senderSid).suffix
            : username;
        const chatNameColor = entry?.nameColor;
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
        const sheetUrl = (textureUrl && textureUrl.includes("/s3/")) ? textureUrl : "/s3/avatars/pipo-nekonin008.png";
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
            });
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
        const sheetUrl = (textureUrl && textureUrl.includes("/s3/")) ? textureUrl : "/s3/avatars/pipo-nekonin008.png";
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
        });
    };
    // --- プロフィールキャッシュ & debounced matchデータ要求 ---
    const profileCache = new Map<string, { displayName: string; textureUrl: string; charCol: number; charRow: number; loginTime: string }>();
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
                const newSheetUrl = (prof.textureUrl && prof.textureUrl.includes("/s3/")) ? prof.textureUrl : "/s3/avatars/pipo-nekonin008.png";
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
                    });
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
        const sheetUrl = (cached?.textureUrl && cached.textureUrl.includes("/s3/")) ? cached.textureUrl : "/s3/avatars/pipo-nekonin008.png";
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
                    });
                }
            });
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
    game.nakama.onSystemMessage = (type, username, userId, sessionId, _uidCount, serverNameColor, ts) => {
        const existing = [...userMap.values()].find(e => e.uuid === userId);
        const displayName = existing?.displayName ?? "";
        const nameText = displayName || ("@" + username);
        const hashSuffix = sessionId ? "#" + sessionId.slice(0, 4) : "";
        const nameColor = serverNameColor || existing?.nameColor;
        const uidColorInput = document.getElementById("uidColorInput") as HTMLInputElement | null;
        const fallbackColor = uidColorInput?.value ?? "#00bbfa";
        const color = nameColor || (displayName ? "" : fallbackColor);
        const colorStyle = color ? ` style="color:${color}"` : "";
        const nameHtml = `<span class="chat-ol-name"${colorStyle}>${nameText}${hashSuffix}</span>`;
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
        { const ml = document.getElementById("menu-logout"); if (ml) ml.style.display = "none"; }
        { const mli = document.getElementById("menu-login"); if (mli) mli.style.display = "none"; }
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
        list.scrollTop = list.scrollHeight;
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
                    const dname = names.get(game.currentUserId!) ?? "";
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
            { const ml = document.getElementById("menu-logout"); if (ml) ml.style.display = ""; }
            { const mli = document.getElementById("menu-login"); if (mli) mli.style.display = ""; }
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
        const canvas = document.getElementById("ping-canvas") as HTMLCanvasElement | null;
        if (!canvas) return;
        const ppanel  = document.getElementById("ping-panel");
        const pheader = document.getElementById("ping-header");
        if (!ppanel || !pheader) return;
        const headerH = pheader.offsetHeight;
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
        const headerH = cheader.offsetHeight;
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
        const menuLogout = document.getElementById("menu-logout");
        const logoutPanel = document.getElementById("logout-panel");
        const logoutConfirm = document.getElementById("logout-confirm-btn");
        const logoutCancel = document.getElementById("logout-cancel-btn");
        const logoutClose = document.getElementById("logout-panel-close");
        const hideLogoutPanel = () => { if (logoutPanel) logoutPanel.style.display = "none"; };
        if (menuLogout && logoutPanel) {
            menuLogout.addEventListener("click", (e) => {
                e.stopPropagation();
                const cl = (game as any).closeMenu as ((btn?: HTMLElement) => void) | undefined;
                if (cl) cl(menuLogout); else document.getElementById("menu-popup")?.classList.remove("open");
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
        const date = (window as any).APP_DATE || "";
        const buildAboutContent = () => {
            const nameEl = document.getElementById("about-app-name");
            const verEl = document.getElementById("about-app-ver");
            const dateEl = document.getElementById("about-app-date");
            const creditsEl = document.getElementById("about-app-credits");
            if (nameEl) nameEl.innerHTML = '<img src="/favicon.png" style="width:18px;height:18px;vertical-align:middle;margin-right:4px;">tommieChat';
            if (verEl) verEl.textContent = "Ver. " + ver;
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
                { id: "sub_world",    name: "サブワールド",    worldId: 1 },
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

        if (roomPanel && roomTbody) {
            // ソート状態
            type RoomSortKey = "name" | "size" | "count";
            let roomSortKey: RoomSortKey = "name";
            let roomSortAsc = true;
            const setRoomSort = (key: RoomSortKey) => {
                if (roomSortKey === key) roomSortAsc = !roomSortAsc;
                else { roomSortKey = key; roomSortAsc = true; }
                lastWorldListJson = "";
                renderRoomList();
            };

            // ソートヘッダ
            const thName = document.getElementById("room-th-name");
            const thSize = document.getElementById("room-th-size");
            const thCount = document.getElementById("room-th-count");
            if (thName) thName.addEventListener("click", () => setRoomSort("name"));
            if (thSize) thSize.addEventListener("click", () => setRoomSort("size"));
            if (thCount) thCount.addEventListener("click", () => setRoomSort("count"));

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
                game.nakama.getWorldList().then(worldList => {
                    const json = JSON.stringify(worldList.map(w => `${w.id}:${w.name}:${w.playerCount}:${game.currentWorldId}`));
                    if (json === lastWorldListJson) return;
                    lastWorldListJson = json;

                    worldList.sort((a, b) => {
                        let cmp: number;
                        if (roomSortKey === "count") cmp = a.playerCount - b.playerCount;
                        else if (roomSortKey === "size") cmp = (a.chunkCountX * a.chunkCountZ) - (b.chunkCountX * b.chunkCountZ);
                        else cmp = (a.name || "").localeCompare(b.name || "", "ja");
                        return roomSortAsc ? cmp : -cmp;
                    });

                    const arrow = roomSortAsc ? "▲" : "▼";
                    if (thName) thName.dataset.sort = roomSortKey === "name" ? arrow : "";
                    if (thSize) thSize.dataset.sort = roomSortKey === "size" ? arrow : "";
                    if (thCount) thCount.dataset.sort = roomSortKey === "count" ? arrow : "";

                    const frag = document.createDocumentFragment();
                    for (const w of worldList) {
                        const tr = document.createElement("tr");
                        const isCurrent = game.currentWorldId === w.id;

                        const tdName = document.createElement("td");
                        tdName.style.cssText = "max-width:140px;";
                        if (isCurrent) tdName.style.fontWeight = "bold";
                        tdName.textContent = (w.name || `World ${w.id}`) + (isCurrent ? " ★" : "");
                        tr.appendChild(tdName);

                        const tdSize = document.createElement("td");
                        tdSize.style.cssText = "text-align:center;opacity:0.7;";
                        tdSize.textContent = `${w.chunkCountX * 16}x${w.chunkCountZ * 16}`;
                        tr.appendChild(tdSize);

                        const tdCount = document.createElement("td");
                        tdCount.style.cssText = "text-align:center;";
                        tdCount.textContent = `${w.playerCount}`;
                        tr.appendChild(tdCount);

                        const tdDel = document.createElement("td");
                        tdDel.style.cssText = "text-align:center;width:24px;";
                        if (w.id !== 0) {
                            const delBtn = document.createElement("button");
                            delBtn.style.cssText = "padding:0 4px;font-size:10px;opacity:0.4;line-height:1;";
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

    // ワールド変更時に部屋名を非同期で取得
    game.onWorldChanged.push(() => {
        game.nakama.getWorldList().then(worldList => {
            const w = worldList.find(w => w.id === game.currentWorldId);
            if (w) game.currentWorldName = w.name || `World ${w.id}`;
        }).catch(() => {});
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
}
