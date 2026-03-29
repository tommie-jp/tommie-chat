import type { GameScene } from "./GameScene";
import { Color3, Mesh, StandardMaterial } from "@babylonjs/core";
import { fnv1a64, CHUNK_SIZE } from "./WorldConstants";
import { prof } from "./Profiler";

export function setupHtmlUI(game: GameScene): void {
    const isMobileDev = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
    const isMobileLandscape = () => isMobileDev && matchMedia("(orientation:landscape)").matches;
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
            if (allHidden && isMobileDev) {
                if (matchMedia("(orientation:landscape)").matches) {
                    document.documentElement.style.setProperty("--ls-divider", "100%");
                    const div = document.getElementById("landscape-divider");
                    if (div) div.style.display = "none";
                } else {
                    document.documentElement.style.setProperty("--pt-divider", "100%");
                    const div = document.getElementById("portrait-divider");
                    if (div) div.style.display = "none";
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
            const h = chatContainer.getBoundingClientRect().height;
            const bottom = chatContainer.style.bottom ? parseInt(chatContainer.style.bottom) : 5;
            document.documentElement.style.setProperty("--ls-panel-bottom", (h + bottom) + "px");
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
            const h = chatContainer.getBoundingClientRect().height;
            const bottom = chatContainer.style.bottom ? parseInt(chatContainer.style.bottom) : 10;
            document.documentElement.style.setProperty("--pt-panel-bottom", (h + bottom) + "px");
        };
        const savedPt = getDivCk("ptDivider");
        if (savedPt) {
            document.documentElement.style.setProperty("--pt-divider", savedPt);
        }
        if (ptDivider) {
            let dragging = false;
            ptDivider.addEventListener("pointerdown", (e: PointerEvent) => {
                dragging = true;
                ptDivider.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            document.addEventListener("pointermove", (e: PointerEvent) => {
                if (!dragging) return;
                const pct = Math.max(30, Math.min(85, (e.clientY / window.innerHeight) * 100));
                document.documentElement.style.setProperty("--pt-divider", pct + "%");
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
            updatePtPanelBottom();
        }
    }

    const textarea = document.getElementById("chatInput") as HTMLTextAreaElement;
    const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
    const clearBtn = document.getElementById("clearBtn") as HTMLButtonElement;

    if (!textarea || !sendBtn || !clearBtn) return;

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
            if (isMobileLandscape()) return;
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
                if (mb) mb.textContent = "　 チャット履歴";
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
                if (isMobileLandscape()) return;
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
                    if (mb) mb.textContent = "　 プレイヤーリスト";
                });
            }
        }
    }

    // ===== サーバ設定パネル ドラッグ & 最小化 & クッキー復元 =====
    {
        const srvPanel  = document.getElementById("server-settings-panel") as HTMLElement;
        const srvHeader = document.getElementById("server-settings-header") as HTMLElement;
        const srvClose  = document.getElementById("server-settings-close") as HTMLElement;
        const srvUrlInput  = document.getElementById("serverUrl")  as HTMLInputElement;
        const srvPortInput = document.getElementById("serverPort") as HTMLInputElement;

        // 環境変数からデフォルト値を設定（本番ビルドでは mmo.tommie.jp:443）
        const defaultHost = import.meta.env.VITE_DEFAULT_HOST ?? "127.0.0.1";
        const defaultPort = import.meta.env.VITE_DEFAULT_PORT ?? "7350";
        if (srvUrlInput)  srvUrlInput.value  = defaultHost;
        if (srvPortInput) srvPortInput.value = defaultPort;

        // 本番ビルドではローカルデバッグ情報を非表示
        const srvDesc = srvPanel?.querySelector(".srv-desc") as HTMLElement | null;
        if (srvDesc && defaultHost !== "127.0.0.1") {
            srvDesc.textContent = "接続するtommieChatサーバの設定";
        }

        if (srvPanel && srvHeader) {
            const sCk = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;
            const gCk = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };

            const savedUrl  = gCk("srvUrl");
            const savedPort = gCk("srvPort");
            if (savedUrl  && srvUrlInput)  srvUrlInput.value  = savedUrl;
            if (savedPort && srvPortInput) srvPortInput.value = savedPort;

            // Server Key 表示
            const srvKeyDisplay = document.getElementById("serverKeyDisplay") as HTMLElement | null;
            const activeServerKey = import.meta.env.VITE_SERVER_KEY || "defaultkey";
            if (srvKeyDisplay) srvKeyDisplay.textContent = activeServerKey;

            srvUrlInput?.addEventListener("change",  () => sCk("srvUrl",  srvUrlInput.value.trim()));
            srvPortInput?.addEventListener("change", () => sCk("srvPort", srvPortInput.value.trim()));

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
                game.clampToViewport(srvPanel);
            }

            let isDrag = false, offX = 0, offY = 0;
            srvHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "server-settings-close") return;
                if (isMobileLandscape()) return;
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
                    if (mb) mb.textContent = "　 サーバ設定";
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
                    const host = srvUrlInput?.value.trim() || defaultHost;
                    const port = srvPortInput?.value.trim() || defaultPort;
                    const proto = port === "443" ? "https" : "http";
                    const url = `${proto}://${host}:${port}/`;
                    pingLog(`HTTP応答を実行中… (${host}:${port})`);
                    const t0 = performance.now();
                    try {
                        await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" });
                        const ms = Math.round(performance.now() - t0);
                        pingLog(`Nakamaサーバへ接続成功しました。 HTTP応答: ${ms}ms (${host}:${port})`);
                    } catch (e) {
                        const ms = Math.round(performance.now() - t0);
                        pingLog(`Nakamaサーバに接続できません HTTP応答: 失敗 ${ms}ms (${host}:${port}) ${e instanceof Error ? e.message : String(e)}`);
                    }
                });
            }

            if (srvNakamaPingBtn) {
                srvNakamaPingBtn.addEventListener("click", async () => {
                    const host = srvUrlInput?.value.trim() || defaultHost;
                    const port = srvPortInput?.value.trim() || defaultPort;
                    if (!game.nakama.selfSessionId) {
                        pingLog(`RPC応答: 未ログイン (${host}:${port})`);
                        return;
                    }
                    pingLog(`RPC応答を実行中… (${host}:${port})`);
                    const ms = await game.nakama.measurePing();
                    if (ms !== null) {
                        pingLog(`NakamaサーバへPing(RPC)が成功しました。 RPC応答: ${ms}ms (${host}:${port})`);
                    } else {
                        pingLog(`RPC応答: 失敗 (${host}:${port})`);
                    }
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
                game.clampToViewport(slPanel);
            }

            let isDrag = false, offX = 0, offY = 0;
            slHeader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "server-log-close") return;
                if (isMobileLandscape()) return;
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
                    if (mb) mb.textContent = "　 サーバ接続ログ";
                });
            }
        }
    }
    // ===============================================

    const addChatHistory = (avatarName: string, text: string) => {
        const _end = prof("UIPanel.addChatHistory");
        if (!text) { _end(); return; }
        const list = document.getElementById("chat-history-list");
        if (!list) { _end(); return; }

        const now = new Date();
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

    const userMap = new Map<string, { username: string; displayName: string; uuid: string; sessionId: string; loginTimestamp: number; loginTime: string; channel: "chat" | "match" | "chat+match" }>();
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
        const myChatId   = game.nakama.selfChannelId ?? "";
        const matchShort = myMatchId  ? myMatchId.slice(0, 8)  : "-";
        const chatShort  = myChatId   ? myChatId.slice(0, 8)   : "-";
        // DocumentFragment でまとめて構築し一度だけ DOM に挿入
        const frag = document.createDocumentFragment();
        for (const { username, displayName, uuid, sessionId, loginTimestamp, loginTime, channel } of entries) {
            const tr = document.createElement("tr");
            const bold = sessionId === myId ? " class=\"ul-self\"" : "";
            const rel = relativeTime(loginTimestamp);
            tr.innerHTML = `<td${bold} title="${username}">${username}</td><td title="${displayName}">${displayName}</td><td class="uuid-cell" data-copy="${uuid}" title="${uuid}&#10;クリックでコピー">${uuid.slice(0, 8)}</td><td class="uuid-cell" data-copy="${sessionId.slice(0, 8)}" title="${sessionId.slice(0, 8)}&#10;クリックでコピー">${sessionId.slice(0, 8)}</td><td title="${channel}">${channel}</td><td class="uuid-cell" data-copy="${myMatchId}" title="${myMatchId}&#10;クリックでコピー">${matchShort}</td><td class="uuid-cell" data-copy="${myChatId}" title="${myChatId}&#10;クリックでコピー">${chatShort}</td><td title="${rel}">${rel}</td><td title="${loginTime}">${loginTime}</td>`;
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

    setInterval(scheduleRenderUserList, 10000);


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

    game.nakama.onChatMessage = (username, text, userId) => {
        addChatHistory(username, text);
        for (const [sessionId, user] of userMap) {
            if (user.uuid !== userId) continue;
            if (sessionId === game.nakama.selfSessionId) {
                doUpdateSpeech(text);
                scheduleSpeechClear("__self__", () => doUpdateSpeech(""));
            } else {
                game.remoteSpeeches.get(sessionId)?.(text);
                const remoteSpeech = game.remoteSpeeches.get(sessionId);
                if (remoteSpeech) {
                    scheduleSpeechClear(sessionId, () => remoteSpeech(""));
                }
            }
        }
    };
    // OP_INIT_POS受信後、サーバーAOI追跡が追いつくまでAOI_LEAVEを無視するガード
    const initPosGuard = new Map<string, number>(); // sessionId → timestamp

    game.nakama.onAvatarInitPos = (sessionId: string, x: number, z: number, _ry: number, loginTimeISO: string, displayName: string, textureUrl: string, charCol: number, charRow: number) => {
        console.log(`rcv onAvatarInitPos sid=${sessionId.slice(0, 8)} x=${(+x).toFixed(1)} z=${(+z).toFixed(1)} hasAvatar=${game.remoteAvatars.has(sessionId)}`);
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
            if (Object.keys(updates).length) {
                userMap.set(sessionId, { ...existing, ...updates });
                scheduleRenderUserList();
            }
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
            game.nakama.sendProfileRequest(sids).catch(() => {});
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
                if (prof.loginTime) {
                    const d = new Date(prof.loginTime);
                    updates.loginTime = formatTimestamp(d);
                    updates.loginTimestamp = d.getTime();
                }
                if (Object.keys(updates).length > 0) {
                    userMap.set(sid, { ...existing, ...updates } as typeof existing);
                }
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
    game.nakama.onDisplayName = (sessionId: string, displayName: string) => {
        console.log(`rcv onDisplayName sid=${sessionId.slice(0, 8)} displayName=${displayName}`);
        // アバターのnameTag更新
        const username = userMap.get(sessionId)?.username ?? sessionId.slice(0, 8);
        const lbl = resolveDisplayLabel(displayName, username, sessionId);
        const updater = game.remoteNameUpdaters.get(sessionId);
        if (updater) updater(lbl.text, lbl.color, lbl.suffix);
        // ユーザリストの表示名更新
        for (const [sid, entry] of userMap) {
            if (entry.sessionId === sessionId) {
                userMap.set(sid, { ...entry, displayName });
                break;
            }
        }
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
    const ensureRemoteAvatar = (sessionId: string, username: string): import("@babylonjs/core").Mesh | null => {
        const _end = prof("UIPanel.ensureRemoteAvatar");
        if (sessionId === game.nakama.selfSessionId) { _end(); return null; }
        if (game.remoteAvatars.has(sessionId)) { _end(); return game.remoteAvatars.get(sessionId)!; }

        // プールから再利用
        const pooled = avatarPool.pop();
        if (pooled) {
            const av = pooled.av;
            game.remoteAvatars.set(sessionId, av);
            game.remoteNameUpdaters.set(sessionId, pooled.nameUpdate);
            game.remoteSpeeches.set(sessionId, pooled.speechUpdate);
            pooled.nameUpdate(username);
            pooled.speechUpdate("");
            av.setEnabled(false);
            _end();
            return av;
        }

        // 新規作成
        const avName = "remote_" + sessionId;
        const av = game.avatarSystem.createAvatar(avName, "/textures/pic1.ktx2", 0, 0, game.avatarDepth);
        const standBase = av.getChildMeshes().find(m => m.name === avName + "_standBase");
        if (standBase && standBase.material) {
            (standBase.material as StandardMaterial).diffuseColor = new Color3(0.4, 0.7, 1.0);
        }
        const nameTag = game.avatarSystem.createNameTag(av, username);
        game.remoteNameUpdaters.set(sessionId, nameTag.update);
        try {
            const updater = game.avatarSystem.createSpeechBubble(nameTag.plane, "");
            game.remoteSpeeches.set(sessionId, updater);
        } catch { /* ignore */ }
        game.remoteAvatars.set(sessionId, av);
        av.setEnabled(false);
        _end();
        return av;
    };

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
    const addChannelFlag = (sessionId: string, flag: "chat" | "match") => {
        const existing = userMap.get(sessionId);
        if (!existing) return;
        if (existing.channel === "chat+match") return;
        if (existing.channel !== flag) {
            userMap.set(sessionId, { ...existing, channel: "chat+match" });
        }
    };

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

    game.nakama.onPresenceJoin = (sessionId, userId, username) => {
        cc("onPresenceJoin");
        const existing = userMap.get(sessionId);
        const ch = existing ? (existing.channel === "match" ? "chat+match" : existing.channel) : "chat";
        userMap.set(sessionId, { username, displayName: existing?.displayName ?? "", uuid: userId, sessionId, loginTimestamp: existing?.loginTimestamp ?? 0, loginTime: existing?.loginTime ?? "…", channel: ch as "chat" | "match" | "chat+match" });
        scheduleRenderUserList();
        ensureRemoteAvatar(sessionId, username);
        refreshSelfSuffix();
    };
    game.nakama.onPresenceNewJoin = (sessionId, userId, username) => {
        cc("onPresenceNewJoin");
        const existing = userMap.get(sessionId);
        const ch = existing ? (existing.channel === "match" ? "chat+match" : existing.channel) : "chat";
        userMap.set(sessionId, { username, displayName: existing?.displayName ?? "", uuid: userId, sessionId, loginTimestamp: existing?.loginTimestamp ?? 0, loginTime: existing?.loginTime ?? "…", channel: ch as "chat" | "match" | "chat+match" });
        scheduleRenderUserList();
        addChatHistory("[system]", `${username}がログインしました。`);
        { const p = game.playerBox; game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y, game.playerTextureUrl, game.playerCharCol, game.playerCharRow).catch(() => {}); }
    };
    game.nakama.onPresenceLeave = (sessionId, _userId, uname) => {
        cc("onPresenceLeave");
        const existing = userMap.get(sessionId);
        if (existing) {
            if (existing.channel === "chat+match") {
                // chatだけ外す → matchのみに
                userMap.set(sessionId, { ...existing, channel: "match" });
            } else {
                userMap.delete(sessionId);
                addChatHistory("[system]", `${uname}がログアウトしました。`);
            }
        }
        scheduleRenderUserList();
        removeRemoteAvatar(sessionId);
        refreshSelfSuffix();
    };
    game.nakama.onMatchPresenceJoin = (sessionId, userId, username) => {
        cc("onMatchPresenceJoin");
        const existing = userMap.get(sessionId);
        if (existing) {
            addChannelFlag(sessionId, "match");
        } else {
            userMap.set(sessionId, { username, displayName: "", uuid: userId, sessionId, loginTimestamp: 0, loginTime: "…", channel: "match" });
        }
        // アバターが既に存在する場合、名前タグを更新（AOI_ENTER時にusername未取得だった場合のリカバリ）
        if (sessionId !== game.nakama.selfSessionId && game.spriteAvatarSystem.has(sessionId)) {
            const dn = userMap.get(sessionId)?.displayName ?? "";
            const lbl = resolveDisplayLabel(dn, username, sessionId);
            const updater = game.spriteAvatarSystem.getNameUpdate(sessionId);
            if (updater) updater(lbl.text, lbl.color, lbl.suffix);
        }
        scheduleRenderUserList();
        // 相手がマッチ参加した時点で自分のInitPosを送る（チャットチャンネル参加時はまだマッチ未参加で届かないため）
        if (sessionId !== game.nakama.selfSessionId) {
            const p = game.playerBox;
            game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y, game.playerTextureUrl, game.playerCharCol, game.playerCharRow).catch(() => {});
        }
    };
    game.nakama.onMatchPresenceLeave = (sessionId, _userId, _uname) => {
        cc("onMatchPresenceLeave");
        const existing = userMap.get(sessionId);
        if (existing) {
            if (existing.channel === "chat+match") {
                // matchだけ外す → chatのみに
                userMap.set(sessionId, { ...existing, channel: "chat" });
            } else if (existing.channel === "match") {
                userMap.delete(sessionId);
            }
        }
        removeRemoteAvatar(sessionId);
        scheduleRenderUserList();
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
        { const fv = document.getElementById("app-footer-version"); if (fv) fv.style.display = ""; }
        setLoginRowVisible(true);
    };

    const srvUrlInput  = document.getElementById("serverUrl")  as HTMLInputElement;
    const srvPortInput = document.getElementById("serverPort") as HTMLInputElement;

    const updateLoginTooltip = () => {
        const url  = srvUrlInput?.value.trim()  || (import.meta.env.VITE_DEFAULT_HOST ?? "127.0.0.1");
        const port = srvPortInput?.value.trim() || (import.meta.env.VITE_DEFAULT_PORT ?? "7350");
        if (loginBtn) loginBtn.title =
            "tommieChatサーバへログインします。\nサーバURL: " + url + "\nポート番号: " + port;
    };
    srvUrlInput?.addEventListener("input",  updateLoginTooltip);
    srvPortInput?.addEventListener("input", updateLoginTooltip);
    updateLoginTooltip();

    const isMobile = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
    if (loginStatus) {
        loginStatus.textContent = "";
    }

    // ===== サーバ接続ログ =====
    const addServerLog = (host: string, port: string, label: string, detail = "", hint = "") => {
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
            ? `${ts} ${label} : ${hint} URL="${host}:${port}" ${detail}`.trimEnd()
            : `${ts} ${label} URL="${host}:${port}"` + (detail ? ` ${detail}` : "");
        list.appendChild(entry);
        list.scrollTop = list.scrollHeight;
    };
    // ===========================

    let loggedInHost = "";
    let loggedInPort = "";
    const NAKAMA_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@+\-]{5,127}$/;
    const doLogin = async () => {
        const _end = prof("UIPanel.doLogin");
        const name = loginNameInput?.value.trim();
        if (!name || name.length < 6) {
            if (loginStatus) {
                loginStatus.style.color = "#ff8800";
                loginStatus.textContent = isMobile ? "✗" : "名前(6文字以上)を入力して下さい";
            }
            _end(); return;
        }
        if (!NAKAMA_ID_RE.test(name)) {
            if (loginStatus) {
                loginStatus.style.color = "#ff4444";
                loginStatus.textContent = isMobile ? "✗" : "✗ 使えない文字が含まれています。使える文字: 英数字と . _ @ + -（6〜128文字）";
            }
            _end(); return;
        }
        const host = srvUrlInput?.value.trim()  || (import.meta.env.VITE_DEFAULT_HOST ?? "127.0.0.1");
        const port = srvPortInput?.value.trim() || (import.meta.env.VITE_DEFAULT_PORT ?? "7350");
        const serverKey = import.meta.env.VITE_SERVER_KEY || undefined;
        game.updatePlayerNameTag(name);
        setCookie("loginName", name);
        if (loginStatus) { loginStatus.style.color = ""; loginStatus.textContent = isMobile ? "…" : "接続中…"; }
        if (loginBtn)    loginBtn.disabled = true;
        try {
            await game.nakama.login(name, host, port, serverKey);
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
                } catch (_) {}
            }
            await game.loadChunksFromDB(game.currentUserId ?? "anonymous");
            await game.nakama.joinWorldMatch();
            // 自分自身をプレイヤーリストに確実に登録（onPresenceJoinのタイミングで漏れる場合のフォールバック）
            {
                const sid = game.nakama.selfSessionId;
                const uid = game.currentUserId;
                if (sid && uid && !userMap.has(sid)) {
                    userMap.set(sid, { username: name, displayName: game.nakama.selfDisplayName ?? "", uuid: uid, sessionId: sid, loginTimestamp: Date.now(), loginTime: "…", channel: "chat+match" });
                } else if (sid && userMap.has(sid)) {
                    const existing = userMap.get(sid)!;
                    userMap.set(sid, { ...existing, channel: "chat+match" });
                }
                scheduleRenderUserList();
            }
            // matchId確定後にinitPosを送信（joinWorldMatch前のpresenceイベントではmatchId未設定のため送信されない）
            { const p = game.playerBox; await game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y, game.playerTextureUrl, game.playerCharCol, game.playerCharRow); }
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
                game.syncAOIChunks().catch(() => {});
            }

            { const p = game.playerBox; game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y, game.playerTextureUrl, game.playerCharCol, game.playerCharRow).catch(() => {}); }
            game.aoiManager.updateAOI();
            const srvInfo = await game.nakama.getServerInfo();
            addServerLog(host, port, "ログイン成功", srvInfo);
            loggedInHost = host;
            loggedInPort = port;
            if (loginStatus) {
                loginStatus.style.color = "#00dd55";
                loginStatus.style.fontWeight = "bold";
                loginStatus.style.textShadow = "0 1px 2px rgba(0,0,0,0.4)";
                loginStatus.textContent = isMobile ? "✓" : "✓ログイン成功しました";
                setTimeout(() => { loginStatus.textContent = ""; loginStatus.style.fontWeight = ""; loginStatus.style.textShadow = ""; }, 3000);
            }
            if (loginBtn) {
                loginBtn.style.display = "none";
            }
            setLoginRowVisible(false);
            { const ml = document.getElementById("menu-logout"); if (ml) ml.style.display = ""; }
            { const mli = document.getElementById("menu-login"); if (mli) mli.style.display = ""; }
            if (loginNameInput) { loginNameInput.onkeydown = null; loginNameInput.disabled = true; }
            { const di = document.getElementById("displayNameInput") as HTMLInputElement | null; if (di) di.disabled = false; }
            { const db = document.getElementById("displayNameBtn") as HTMLButtonElement | null; if (db) { db.disabled = true; db.style.display = "none"; } }
            // WebSocket切断時の自動再接続コールバック
            game.nakama.onMatchDisconnect = () => {
                console.warn("UIPanel match disconnected, auto-reconnect in progress");
                addServerLog(loggedInHost, loggedInPort, "マッチ切断", "WebSocket切断 — 自動再接続中…");
            };
            game.nakama.onMatchReconnect = () => {
                console.log("UIPanel match reconnected");
                addServerLog(loggedInHost, loggedInPort, "マッチ再接続", "WebSocket復帰");
                // 再接続後にInitPos・AOI・アバターを再送信
                const p = game.playerBox;
                game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y, game.playerTextureUrl, game.playerCharCol, game.playerCharRow).catch(() => {});
                game.aoiManager.lastAOI = { minCX: -1, minCZ: -1, maxCX: -1, maxCZ: -1 };
                game.aoiManager.updateAOI();
                // CCUグラフを再初期化（切断中の無効データをクリア）
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
            if (reason === "Not Found") reason += ": サーバに接続できません。サーバが動いていないか、URLかポート番号が間違っている可能性があります。";
            const usedKey = serverKey || import.meta.env.VITE_SERVER_KEY || "defaultkey";
            const hint = reason.includes("Failed to parse URL") ? "URLの形式が違います。"
                       : reason === "Failed to fetch"           ? "サーバが稼働していないか、URL、ポート番号が間違っている可能性があります。"
                       : reason.includes("Username is already in use") ? "Device auth error: username conflict. この名前は既に別の認証方式で使用されています。別の名前を試してください。"
                       : reason.includes("too many logins") ? "サーバが混雑しています。しばらく待ってから再接続してください。"
                       : /[Ss]erver key invalid|Invalid server key/.test(reason) ? `Server Keyが正しくありません。使用したKey: ${usedKey}`
                       : "";
            addServerLog(host, port, "ログイン失敗", reason, hint);
            if (loginStatus) {
                loginStatus.style.color = "#ff4444";
                loginStatus.textContent = isMobile ? "✗" : "✗ログイン失敗: " + reason;
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
                    showDnStatus("表示名は20文字以内です。", "#ff4444");
                }
            });
            displayNameInput.addEventListener("input", () => {
                const val = displayNameInput.value.trim();
                if (val.length > 20) {
                    showDnStatus("表示名は20文字以内です。", "#ff4444");
                    displayNameBtn.disabled = true;
                    displayNameBtn.style.display = "none";
                    displayNameBtn.style.background = "";
                    return;
                }
                const changed = !displayNameInput.disabled && val !== confirmedDisplayName;
                displayNameBtn.disabled = !changed;
                displayNameBtn.style.display = changed ? "" : "none";
                displayNameBtn.style.background = changed ? "#28a745" : "";
            });
        }
        const doChangeDisplayName = async () => {
            const _end = prof("UIPanel.doChangeDisplayName");
            try {
            if (!displayNameInput) return;
            const name = displayNameInput.value.trim();
            if (/[\x00-\x1f\x7f]/.test(name)) {
                if (displayNameStatus) { displayNameStatus.style.color = "#ff4444"; displayNameStatus.textContent = "✗ 制御文字は使えません"; }
                return;
            }
            if (!game.nakama.getSession()) {
                if (displayNameStatus) { displayNameStatus.style.color = "#ff8800"; displayNameStatus.textContent = "先にログインしてください"; }
                return;
            }
            try {
                await game.nakama.updateDisplayName(name);
                game.nakama.selfDisplayName = name;
                game.nakama.sendDisplayName(name).catch(() => {});
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
                if (displayNameBtn) { displayNameBtn.disabled = true; displayNameBtn.style.display = "none"; displayNameBtn.style.background = ""; }
                showDnStatus("✓ 表示名変更しました！", "#00dd55");
                addServerLog(loggedInHost || (import.meta.env.VITE_DEFAULT_HOST ?? "127.0.0.1"), loggedInPort || (import.meta.env.VITE_DEFAULT_PORT ?? "7350"), "表示名変更", `表示名を「${name}」に設定しました`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : (typeof err === "object" && err !== null && "message" in err) ? String((err as any).message) : String(err);
                if (displayNameStatus) { displayNameStatus.style.color = "#ff4444"; displayNameStatus.textContent = "✗ " + msg; }
                addServerLog(loggedInHost || (import.meta.env.VITE_DEFAULT_HOST ?? "127.0.0.1"), loggedInPort || (import.meta.env.VITE_DEFAULT_PORT ?? "7350"), "表示名変更失敗", msg);
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

        const dark = isMobileDev;
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
            const label = "回線切断中";
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
        disconnectBanner.textContent = "サーバに接続できません — 再接続を試みています…";
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
                    addServerLog(loggedInHost, loggedInPort, "回線復帰");
                    hideDisconnectBanner();
                    if (loginStatus) {
                        loginStatus.style.color = "#00dd55";
                        loginStatus.textContent = isMobile ? "✓" : "✓回線復帰";
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
                    addServerLog(loggedInHost, loggedInPort, "回線切断", "ネットワーク障害またはサーバ停止により切断されました");
                    showDisconnectBanner();
                    if (loginStatus) {
                        loginStatus.style.color = "#ff4444";
                        loginStatus.textContent = isMobile ? "✗" : "✗回線切断";
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
                game.clampToViewport(ppanel);
            }

            let isDragP = false, offXP = 0, offYP = 0;
            pheader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "ping-close") return;
                if (isMobileLandscape()) return;
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
                    if (mb) mb.textContent = "　 Ping グラフ";
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
        const dark = isMobileDev;
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
                game.clampToViewport(cpanel);
            }

            let isDragC = false, offXC = 0, offYC = 0;
            cheader.addEventListener("pointerdown", (e: PointerEvent) => {
                if ((e.target as HTMLElement).id === "ccu-close") return;
                if ((e.target as HTMLElement).tagName === "SELECT") return;
                if (isMobileLandscape()) return;
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
                    if (mb) mb.textContent = "　 同接グラフ";
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
        const host = srvUrlInput?.value.trim()  || (import.meta.env.VITE_DEFAULT_HOST ?? "127.0.0.1");
        const port = srvPortInput?.value.trim() || (import.meta.env.VITE_DEFAULT_PORT ?? "7350");
        stopPing();
        stopCcu();
        game.saveChunksToDB();
        game.nakama.logout();
        game.currentUserId = null;
        addServerLog(host, port, "ログアウト");
        userMap.clear();
        scheduleRenderUserList();
        game.remoteAvatars.forEach(av => av.dispose());
        game.remoteAvatars.clear();
        if (loginStatus) { loginStatus.style.color = "#00dd55"; loginStatus.style.fontWeight = "bold"; loginStatus.style.textShadow = "0 1px 2px rgba(0,0,0,0.4)"; loginStatus.textContent = "ログアウトしました"; setTimeout(() => { loginStatus.textContent = ""; loginStatus.style.fontWeight = ""; loginStatus.style.textShadow = ""; }, 3000); }
        if (loginBtn) { loginBtn.style.background = "#28a74580"; loginBtn.style.display = ""; }
        { const di = document.getElementById("displayNameInput") as HTMLInputElement | null; if (di) { di.disabled = true; di.value = ""; } }
        { const db = document.getElementById("displayNameBtn") as HTMLButtonElement | null; if (db) { db.disabled = true; db.style.display = "none"; } }
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

    // メニュー「ログイン画面」ボタン
    {
        const menuLogin = document.getElementById("menu-login");
        if (menuLogin) {
            menuLogin.addEventListener("click", (e) => {
                e.stopPropagation();
                setLoginRowVisible(true);
                document.getElementById("menu-popup")?.classList.remove("open");
            });
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

        // コンテンツ初期化
        const ver = (window as any).APP_VERSION || "";
        const date = (window as any).APP_DATE || "";
        const nameEl = document.getElementById("about-app-name");
        const verEl = document.getElementById("about-app-ver");
        const dateEl = document.getElementById("about-app-date");
        const creditsEl = document.getElementById("about-app-credits");
        if (nameEl) nameEl.innerHTML = '<img src="/favicon.png" style="width:18px;height:18px;vertical-align:middle;margin-right:4px;">tommieChat';
        if (verEl) verEl.textContent = "Ver. " + ver;
        if (dateEl) dateEl.textContent = "更新日 " + date;
        if (creditsEl) creditsEl.innerHTML = "\u00A9 2026 tommie.jp"
            + '<hr style="border:none;border-top:1px solid rgba(0,0,0,0.15);margin:8px 0;">'
            + '<table style="border-collapse:collapse;font-size:inherit;line-height:1.6;">'
            + '<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">URL</td><td><a href="https://mmo.tommie.jp" target="_blank">https://mmo.tommie.jp</a></td></tr>'
            + '<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">X</td><td><a href="https://x.com/tommie_nico" target="_blank" rel="noopener" style="color:#1d9bf0;">@tommie_nico</a></td></tr>'
            + '<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">GitHub</td><td><a href="https://github.com/open-tommie/tommie-chat" target="_blank">open-tommie/tommie-chat</a></td></tr>'
            + '<tr><td style="padding:1px 8px 1px 0;white-space:nowrap;vertical-align:top;">メール</td><td><a href="mailto:open.tommie@gmail.com" style="color:#1d9bf0;">open.tommie@gmail.com</a></td></tr>'
            + '</table>'
            + '<hr style="border:none;border-top:1px solid rgba(0,0,0,0.15);margin:8px 0;">'
            + '本ソフトウェアは現状のまま（AS IS）提供され、一切の保証はありません。<br>'
            + '本ソフトウェアの使用により生じたいかなる損害についても、作者は責任を負いません。<br><br>'
            + 'This software is provided "AS IS" without warranty of any kind.<br>'
            + 'License: MIT'
            + '<hr style="border:none;border-top:1px solid rgba(0,0,0,0.15);margin:8px 0;">'
            + 'このプロジェクトの開発を支援していただける方を募集しています。<br>'
            + 'We are looking for contributors to support the development of this project.<br>'
            + '☕ 開発支援（準備中）';

        // 閉じるボタン
        const aboutClose = document.getElementById("about-panel-close");
        if (aboutClose && aboutPanel) {
            aboutClose.addEventListener("click", () => {
                aboutPanel.style.display = "none";
                setDivCk("showAbout", "0");
                const mb = document.getElementById("menu-about");
                if (mb) mb.textContent = "　 tommieChatについて";
            });
        }

        // ドラッグ移動
        if (aboutHeader && aboutPanel) {
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

    const sendMessage = async () => {
        const trimEnabled = (document.getElementById("speechTrimBtn") as HTMLButtonElement | null)?.classList.contains("on") ?? true;
        const text = trimEnabled ? textarea.value.trim() : textarea.value;
        if (!text.trim()) return;
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

    // セリフ吹き出しトグル
    let lastSpeechText = "";
    let bubbleHidden = false;
    const spPc = clearBtn.querySelector(".btn-label-pc") as HTMLElement | null;
    const spSp = clearBtn.querySelector(".btn-label-sp") as HTMLElement | null;
    const updateClearBtnIcon = () => {
        const showing = !bubbleHidden && lastSpeechText !== "";
        if (spPc) spPc.textContent = showing ? "非表示" : "表示";
        if (spSp) spSp.textContent = showing ? "🚫" : "💬";
    };
    const doUpdateSpeech = (text: string) => {
        lastSpeechText = text;
        if (bubbleHidden && text) bubbleHidden = false;
        if (game.updatePlayerSpeech) game.updatePlayerSpeech(bubbleHidden ? "" : text);
        updateClearBtnIcon();
    };

    clearBtn.onclick = () => {
        if (lastSpeechText) {
            bubbleHidden = !bubbleHidden;
            if (game.updatePlayerSpeech) game.updatePlayerSpeech(bubbleHidden ? "" : lastSpeechText);
        } else {
            textarea.value = "";
        }
        updateClearBtnIcon();
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

    sendBtn.onclick = () => { sendMessage(); };
    textarea.onkeydown = (e) => {
        // スマホ: Enterは改行（送信ボタンで送信）、PC: Enterで送信、Shift+Enterで改行
        if (e.key === "Enter" && !isMobileDev && !e.shiftKey) {
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
