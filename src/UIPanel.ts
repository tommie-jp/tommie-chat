import type { GameScene } from "./GameScene";
import { Color3, StandardMaterial } from "@babylonjs/core";
import { fnv1a64, CHUNK_SIZE } from "./WorldConstants";

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
        const getCookie = (name: string): string | null => {
            const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
            return match ? decodeURIComponent(match[1]) : null;
        };
        const savePanelState = () => {
            const rect = historyPanel.getBoundingClientRect();
            setCookie("chatHistLeft",   String(Math.round(rect.left)));
            setCookie("chatHistTop",    String(Math.round(rect.top)));
            setCookie("chatHistWidth",  String(Math.round(rect.width)));
            setCookie("chatHistHeight", String(Math.round(rect.height)));
        };

        const savedLeft   = getCookie("chatHistLeft");
        const savedTop    = getCookie("chatHistTop");
        const savedWidth  = getCookie("chatHistWidth");
        const savedHeight = getCookie("chatHistHeight");
        if (!isMobileDev) {
            if (savedLeft   !== null) historyPanel.style.left   = savedLeft   + "px";
            if (savedTop    !== null) historyPanel.style.top    = savedTop    + "px";
            if (savedWidth  !== null) historyPanel.style.width  = savedWidth  + "px";
            if (savedHeight !== null) historyPanel.style.height = savedHeight + "px";
            game.clampToViewport(historyPanel);
        }

        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        historyHeader.addEventListener("pointerdown", (e: PointerEvent) => {
            if (isMobileLandscape()) return;
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
            savePanelState();
        });
        resizeObserver.observe(historyPanel);

        const histClose = document.getElementById("chat-history-close") as HTMLElement;
        if (histClose) {
            histClose.addEventListener("click", () => {
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
            const gCookieFn = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };

            const savedL = gCookieFn("ulLeft");
            const savedT = gCookieFn("ulTop");
            const savedW = gCookieFn("ulWidth");
            const savedH = gCookieFn("ulHeight");
            if (!isMobileDev) {
                if (savedL !== null) { ulPanel.style.left = savedL + "px"; ulPanel.style.right = "auto"; }
                if (savedT !== null)   ulPanel.style.top  = savedT + "px";
                game.clampToViewport(ulPanel);
                if (savedW !== null) ulPanel.style.width  = savedW + "px";
                if (savedH !== null) ulPanel.style.height = savedH + "px";
            }

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
                sCookieFn("ulLeft", String(Math.round(r.left)));
                sCookieFn("ulTop",  String(Math.round(r.top)));
            });

            const ulResizeObserver = new ResizeObserver(() => {
                if (ulPanel.classList.contains("minimized")) return;
                const r = ulPanel.getBoundingClientRect();
                sCookieFn("ulWidth",  String(Math.round(r.width)));
                sCookieFn("ulHeight", String(Math.round(r.height)));
            });
            ulResizeObserver.observe(ulPanel);

            if (ulClose) {
                ulClose.addEventListener("click", () => {
                    ulPanel.style.display = "none";
                    sCookieFn("showUserList", "0");
                    const mb = document.getElementById("menu-userlist");
                    if (mb) mb.textContent = "　 ユーザリスト";
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
        if (!text) return;
        const list = document.getElementById("chat-history-list");
        if (!list) return;

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
    };

    const setCookie = (key: string, value: string) => {
        document.cookie = `${key}=${encodeURIComponent(value)};path=/;max-age=${60 * 60 * 24 * 365}`;
    };
    const getCookie = (key: string): string | null => {
        const match = document.cookie.match(new RegExp("(?:^|; )" + key + "=([^;]*)"));
        return match ? decodeURIComponent(match[1]) : null;
    };

    const loginNameInput = document.getElementById("loginName") as HTMLInputElement;
    const loginBtn = document.getElementById("loginBtn") as HTMLButtonElement;

    const savedLoginName = getCookie("loginName");
    if (savedLoginName && loginNameInput) {
        loginNameInput.value = savedLoginName;
        game.updatePlayerNameTag(savedLoginName);
    }

    const loginStatus = document.getElementById("loginStatus") as HTMLSpanElement;
    const userListBody = document.getElementById("user-list-body") as HTMLTableSectionElement;

    const formatTimestamp = (date: Date): string => {
        const off = -date.getTimezoneOffset();
        const sign = off >= 0 ? "+" : "-";
        const p2 = (n: number) => String(Math.abs(n)).padStart(2, "0");
        const tz = `${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
        return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}T`
             + `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}${tz}`;
    };

    const userMap = new Map<string, { username: string; uuid: string; sessionId: string; loginTimestamp: number; loginTime: string }>();
    type UlSortKey = "username" | "uuid" | "sessionId" | "loginTime" | "loginTimestamp";
    let ulSortKey: UlSortKey = "username";
    let ulSortAsc = true;
    const thUser = document.getElementById("ul-th-user") as HTMLTableCellElement;
    const thUuid = document.getElementById("ul-th-uuid") as HTMLTableCellElement;
    const thSid  = document.getElementById("ul-th-sid")  as HTMLTableCellElement;
    const thTime = document.getElementById("ul-th-time") as HTMLTableCellElement;
    const thRel  = document.getElementById("ul-th-rel")  as HTMLTableCellElement;

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

    const renderUserList = () => {
        if (!userListBody) return;
        userListBody.innerHTML = "";
        const entries = [...userMap.values()].sort((a, b) => {
            if (ulSortKey === "loginTimestamp")
                return ulSortAsc ? a.loginTimestamp - b.loginTimestamp : b.loginTimestamp - a.loginTimestamp;
            const va = a[ulSortKey as "username" | "uuid" | "sessionId" | "loginTime"] ?? "";
            const vb = b[ulSortKey as "username" | "uuid" | "sessionId" | "loginTime"] ?? "";
            return ulSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        });
        const arrow = ulSortAsc ? "▲" : "▼";
        if (thUser) thUser.dataset.sort = ulSortKey === "username"        ? arrow : "";
        if (thUuid) thUuid.dataset.sort = ulSortKey === "uuid"            ? arrow : "";
        if (thSid)  thSid.dataset.sort  = ulSortKey === "sessionId"       ? arrow : "";
        if (thTime) thTime.dataset.sort = ulSortKey === "loginTime"       ? arrow : "";
        if (thRel)  thRel.dataset.sort  = ulSortKey === "loginTimestamp"  ? arrow : "";
        const myId = game.nakama.selfSessionId ?? "";
        for (const { username, uuid, sessionId, loginTimestamp, loginTime } of entries) {
            const tr = document.createElement("tr");
            const bold = sessionId === myId ? " class=\"ul-self\"" : "";
            tr.innerHTML = `<td${bold}>${username}</td><td class="uuid-cell">${uuid}</td><td class="uuid-cell">${sessionId}</td><td>${relativeTime(loginTimestamp)}</td><td>${loginTime}</td>`;
            userListBody.appendChild(tr);
        }
    };

    const setUlSort = (key: UlSortKey) => {
        if (ulSortKey === key) ulSortAsc = !ulSortAsc;
        else { ulSortKey = key; ulSortAsc = true; }
        renderUserList();
    };
    if (thUser) thUser.addEventListener("click", () => setUlSort("username"));
    if (thUuid) thUuid.addEventListener("click", () => setUlSort("uuid"));
    if (thSid)  thSid.addEventListener("click",  () => setUlSort("sessionId"));
    if (thTime) thTime.addEventListener("click", () => setUlSort("loginTime"));
    if (thRel)  thRel.addEventListener("click",  () => setUlSort("loginTimestamp"));

    setInterval(renderUserList, 10000);

    const fetchAndSetLoginTime = async (sessionId: string, userId: string, _username: string) => {
        const isoStr = await game.nakama.getSessionLoginTime(userId, sessionId);
        const loginDate = isoStr ? new Date(isoStr) : new Date();
        const existing = userMap.get(sessionId);
        if (existing) {
            userMap.set(sessionId, { ...existing, loginTime: formatTimestamp(loginDate), loginTimestamp: loginDate.getTime() });
            renderUserList();
        }
    };

    // Nakama コールバック設定
    game.nakama.onChatMessage = (username, text, userId) => {
        addChatHistory(username, text);
        for (const [sid, user] of userMap) {
            if (user.uuid !== userId) continue;
            if (sid === game.nakama.selfSessionId) {
                doUpdateSpeech(text);
            } else {
                game.remoteSpeeches.get(sid)?.(text);
            }
        }
    };
    game.nakama.onAvatarInitPos = (sessionId: string, x: number, z: number, ry: number) => {
        console.log(`[onAvatarInitPos] sid=${sessionId} x=${x} z=${z} hasAvatar=${game.remoteAvatars.has(sessionId)}`);
        const av = game.remoteAvatars.get(sessionId);
        if (av) {
            av.position.x = x; av.position.z = z; av.rotation.y = ry;
            av.setEnabled(true);
        }
        game.remoteTargets.delete(sessionId);
    };
    game.nakama.onAvatarMoveTarget = (sessionId: string, x: number, z: number) => {
        if (game.remoteAvatars.has(sessionId)) game.remoteTargets.set(sessionId, { x, z });
    };
    game.nakama.onAvatarChange = (sessionId: string, textureUrl: string) => {
        console.log(`[avatarChange] sessionId=${sessionId} textureUrl=${textureUrl}`);
        const av = game.remoteAvatars.get(sessionId);
        if (av) game.avatarSystem.changeAvatarTexture(av, textureUrl);
    };
    game.nakama.onAOIEnter = (sessionId: string, x: number, z: number, ry: number, textureUrl: string) => {
        console.log(`[AOI_ENTER] sid=${sessionId} x=${x} z=${z} ry=${ry} tex=${textureUrl}`);
        if (sessionId === game.nakama.selfSessionId) return;
        const av = game.remoteAvatars.get(sessionId);
        if (av) {
            av.position.x = x; av.position.z = z; av.rotation.y = ry;
            av.setEnabled(true);
            game.remoteTargets.delete(sessionId);
            if (textureUrl) game.avatarSystem.changeAvatarTexture(av, textureUrl);
        }
    };
    game.nakama.onAOILeave = (sessionId: string) => {
        console.log(`[AOI_LEAVE] sid=${sessionId}`);
        if (sessionId === game.nakama.selfSessionId) return;
        const av = game.remoteAvatars.get(sessionId);
        if (av) av.setEnabled(false);
        game.remoteTargets.delete(sessionId);
    };

    const addRemoteAvatar = (sessionId: string, username: string) => {
        if (sessionId === game.nakama.selfSessionId) return;
        if (game.remoteAvatars.has(sessionId)) return;
        const x = (Math.random() - 0.5) * 14;
        const z = (Math.random() - 0.5) * 14;
        const avName = "remote_" + sessionId;
        const av = game.avatarSystem.createAvatar(avName, "/textures/pic1.ktx2", x, z, game.avatarDepth);
        const standBase = av.getChildMeshes().find(m => m.name === avName + "_standBase");
        if (standBase && standBase.material) {
            (standBase.material as StandardMaterial).diffuseColor = new Color3(0.4, 0.7, 1.0);
        }
        const nameTag = game.avatarSystem.createNameTag(av, username);
        try {
            const updater = game.avatarSystem.createSpeechBubble(nameTag.plane, "");
            game.remoteSpeeches.set(sessionId, updater);
        } catch (e) {
        }
        game.remoteAvatars.set(sessionId, av);
        av.setEnabled(false);
    };
    const removeRemoteAvatar = (sessionId: string) => {
        const av = game.remoteAvatars.get(sessionId);
        if (!av) return;
        av.dispose();
        game.remoteAvatars.delete(sessionId);
        game.remoteTargets.delete(sessionId);
        game.remoteSpeeches.delete(sessionId);
    };

    game.nakama.onPresenceJoin = (sessionId, userId, username) => {
        userMap.set(sessionId, { username, uuid: userId, sessionId, loginTimestamp: Date.now(), loginTime: "…" });
        renderUserList();
        fetchAndSetLoginTime(sessionId, userId, username);
        addRemoteAvatar(sessionId, username);
    };
    game.nakama.onPresenceNewJoin = (sessionId, userId, username) => {
        userMap.set(sessionId, { username, uuid: userId, sessionId, loginTimestamp: Date.now(), loginTime: "…" });
        renderUserList();
        fetchAndSetLoginTime(sessionId, userId, username);
        addChatHistory("[system]", `${username}がログインしました。`);
        addRemoteAvatar(sessionId, username);
        { const p = game.playerBox; game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y).catch(() => {}); }
        game.nakama.sendAvatarChange(game.playerTextureUrl).catch(() => {});
    };
    game.nakama.onPresenceLeave = (sessionId, _userId, uname) => {
        userMap.delete(sessionId);
        renderUserList();
        addChatHistory("[system]", `${uname}がログアウトしました。`);
        removeRemoteAvatar(sessionId);
    };

    const setLoginMode = () => {
        if (loginBtn) {
            loginBtn.textContent = "ログイン";
            loginBtn.onclick = doLogin;
        }
        if (loginNameInput) {
            loginNameInput.onkeydown = (e) => {
                if (e.key === "Enter") { e.preventDefault(); doLogin(); }
            };
        }
    };

    const srvUrlInput  = document.getElementById("serverUrl")  as HTMLInputElement;
    const srvPortInput = document.getElementById("serverPort") as HTMLInputElement;

    const updateLoginTooltip = () => {
        const url  = srvUrlInput?.value.trim()  || "127.0.0.1";
        const port = srvPortInput?.value.trim() || "7350";
        if (loginBtn) loginBtn.title =
            "tommieChatサーバへログインします。\nサーバURL: " + url + "\nポート番号: " + port;
    };
    srvUrlInput?.addEventListener("input",  updateLoginTooltip);
    srvPortInput?.addEventListener("input", updateLoginTooltip);
    updateLoginTooltip();

    const isMobile = matchMedia("(pointer:coarse) and (min-resolution:2dppx)").matches;
    if (loginStatus) {
        loginStatus.textContent = isMobile ? "" : "ログインして下さい！";
    }

    // ===== サーバ接続ログ =====
    const addServerLog = (host: string, port: string, label: string, detail = "", hint = "") => {
        const list = document.getElementById("server-log-list");
        if (!list) return;
        const now = new Date();
        const off = -now.getTimezoneOffset();
        const sign = off >= 0 ? "+" : "-";
        const p2 = (n: number) => String(Math.abs(n)).padStart(2, "0");
        const tz = `${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
        const ts = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}T`
                 + `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}.`
                 + `${String(now.getMilliseconds()).padStart(3, "0")}${tz}`;
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
        const name = loginNameInput?.value.trim();
        if (!name || name.length < 6) {
            if (loginStatus) {
                loginStatus.style.color = "#ff8800";
                loginStatus.textContent = isMobile ? "✗" : "名前(6文字以上)を入力して下さい";
            }
            return;
        }
        if (!NAKAMA_ID_RE.test(name)) {
            if (loginStatus) {
                loginStatus.style.color = "#ff4444";
                loginStatus.textContent = isMobile ? "✗" : "✗ 使えない文字が含まれています。使える文字: 英数字と . _ @ + -（6〜128文字）";
            }
            return;
        }
        const host = srvUrlInput?.value.trim()  || "127.0.0.1";
        const port = srvPortInput?.value.trim() || "7350";
        game.updatePlayerNameTag(name);
        setCookie("loginName", name);
        if (loginStatus) { loginStatus.style.color = ""; loginStatus.textContent = isMobile ? "…" : "接続中…"; }
        if (loginBtn)    loginBtn.disabled = true;
        try {
            await game.nakama.login(name, host, port);
            game.currentUserId = game.nakama.getSession()?.user_id ?? null;
            await game.loadChunksFromDB(game.currentUserId ?? "anonymous");
            await game.nakama.joinWorldMatch();

            // ブロック更新通知の受信
            game.nakama.onBlockUpdate = (gx, gz, blockId, r, g, b, a) => {
                console.log(`[onBlockUpdate] gx=${gx} gz=${gz} blockId=${blockId} rgb=(${r},${g},${b})`);
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

            { const p = game.playerBox; game.nakama.sendInitPos(p.position.x, p.position.z, p.rotation.y).catch(() => {}); }
            game.nakama.sendAvatarChange(game.playerTextureUrl).catch(() => {});
            game.aoiManager.updateAOI();
            const srvInfo = await game.nakama.getServerInfo();
            addServerLog(host, port, "ログイン成功", srvInfo);
            loggedInHost = host;
            loggedInPort = port;
            if (loginStatus) {
                loginStatus.style.color = "#00dd55";
                loginStatus.textContent = isMobile ? "✓" : "✓ログイン済み";
            }
            if (loginBtn) {
                loginBtn.textContent = "ログアウト";
                loginBtn.style.background = "#e0509099";
                loginBtn.onclick = doLogout;
            }
            if (loginNameInput) loginNameInput.onkeydown = null;
            startPing();
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
            const hint = reason.includes("Failed to parse URL") ? "URLの形式が違います。"
                       : reason === "Failed to fetch"           ? "サーバが稼働していないか、URL、ポート番号が間違っている可能性があります。"
                       : "";
            addServerLog(host, port, "ログイン失敗", reason, hint);
            if (loginStatus) {
                loginStatus.style.color = "#ff4444";
                loginStatus.textContent = isMobile ? "✗" : "✗ログイン失敗: " + reason;
            }
        } finally {
            if (loginBtn) loginBtn.disabled = false;
        }
    };

    // ===== ping 計測 & グラフ =====
    const pingDisplay    = document.getElementById("ping-display");
    const PING_INTERVAL_MS  = 3000;
    const PING_SAMPLES      = 3;
    const PING_HISTORY_MAX  = 60;
    const pingSamples: number[] = [];
    const pingHistory: number[] = [];
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    const drawPingGraph = () => {
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
        for (let ms = subStep; ms < maxPing; ms += subStep) {
            const yp = toY(ms);
            if (yp < 0) break;
            const isMajor = ms % 50 === 0;
            ctx.strokeStyle = isMajor ? gridMajor : gridSub;
            ctx.setLineDash(isMajor ? [4, 3] : [2, 5]);
            ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(w, yp); ctx.stroke();
            if (isMajor) {
                ctx.fillStyle = labelCol;
                ctx.font = FONT_STR;
                ctx.fillText(`${ms}ms`, 2, yp - 2);
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
            const boxH = lineH * 3 + pad * 2;
            const boxX = w - boxW - 4;
            const boxY = 3;
            ctx.fillStyle = avgBg;
            ctx.fillRect(boxX, boxY, boxW, boxH);
            ctx.fillStyle = dark ? "#eee" : "#000";
            for (let li = 0; li < 3; li++) {
                const y = boxY + pad + FONT_SIZE + li * lineH;
                ctx.fillText(rows[li].label, boxX + pad, y);
                const vw = ctx.measureText(rows[li].value).width;
                ctx.fillText(rows[li].value, boxX + boxW - pad - vw, y);
            }
        }
    };

    let pingFailCount = 0;
    let pingDisconnected = false;
    const PING_FAIL_THRESHOLD = 3;

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

    const doLogout = () => {
        const host = srvUrlInput?.value.trim()  || "127.0.0.1";
        const port = srvPortInput?.value.trim() || "7350";
        stopPing();
        game.saveChunksToDB();
        game.nakama.logout();
        game.currentUserId = null;
        addServerLog(host, port, "ログアウト");
        userMap.clear();
        renderUserList();
        game.remoteAvatars.forEach(av => av.dispose());
        game.remoteAvatars.clear();
        if (loginStatus) { loginStatus.style.color = "#00dd55"; loginStatus.textContent = isMobile ? "" : "ログインして下さい！"; }
        if (loginBtn) loginBtn.style.background = "#28a74580";
        setLoginMode();
    };

    setLoginMode();

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

    sendBtn.onclick = () => { sendMessage(); };
    textarea.onkeydown = (e) => {
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
