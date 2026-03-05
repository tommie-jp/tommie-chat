import { 
    Engine, 
    Scene, 
    Vector3, 
    Vector4,
    Color4,
    MeshBuilder, 
    HemisphericLight,
    DirectionalLight,
    ArcRotateCamera,     
    StandardMaterial, 
    Color3,
    Mesh,
    Texture,
    TransformNode,
    SceneInstrumentation,
    EngineInstrumentation,
    PointerEventTypes,
    VertexBuffer,
    VertexData,
    DefaultRenderingPipeline
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";
import { AdvancedDynamicTexture, TextBlock, Rectangle, Control } from "@babylonjs/gui"; 
import "@babylonjs/loaders";
import { NakamaService } from "./NakamaService";

export class GameScene {
    private engine: Engine;
    private scene: Scene;
    private camera!: ArcRotateCamera;
    private playerBox!: Mesh;

    private targetPosition: Vector3 | null = null;
    private readonly moveSpeed = 2.0; 
    
    private inputMap: { [key: string]: boolean } = {};
    
    private hoverMarker!: Mesh;
    private clickMarker!: Mesh;

    private updatePlayerSpeech!: (newText: string) => void;
    private updatePlayerNameTag!: (newName: string) => void;
    private nakama = new NakamaService();
    private renderingPipeline: DefaultRenderingPipeline | null = null;
    private camSpecLight!: DirectionalLight;

    // ==================== 自動移動用 ====================
    private time = 0;
    private isNpcChatOn = false;
    private npc001!: Mesh;
    private npc002!: Mesh;
    private npc003!: Mesh;                    
    private npc001BaseX = 0;
    private npc002BaseX = 1.5;
    private npc002BaseZ = 3;
    private npc003BaseX = 3;                  
    private npc003BaseZ = 3;                  
    // ===================================================

    constructor(canvas: HTMLCanvasElement) {
        this.engine = new Engine(canvas, false, { stencil: true });
        
        this.engine.setHardwareScalingLevel(1.0);

        this.scene = new Scene(this.engine);

        this.setupScene();
        this.createObjects();
        this.setMSAA(2);
        this.setupHtmlUI();

        this.handleResize();

        this.engine.runRenderLoop(() => {
            if (this.scene.activeCamera) {
                this.scene.render();
            }
        });

        const canvasResizeObserver = new ResizeObserver(() => {
            requestAnimationFrame(() => this.handleResize());
        });
        canvasResizeObserver.observe(canvas);
    }

    private setupScene(): void {
        this.camera = new ArcRotateCamera(
            "camera", 
            Math.PI / 2,     
            Math.PI / 2.5,    
            10.0,             
            new Vector3(0, 0.9, 0),
            this.scene
        );

        // βの可動範囲を 0(真上) ~ 80度 に限定
        this.camera.lowerBetaLimit = 0;
        this.camera.upperBetaLimit = 80 * Math.PI / 180;

        this.camera.attachControl(this.engine.getRenderingCanvas() as HTMLCanvasElement, true);

        this.camera.keysUp = [];
        this.camera.keysDown = [];
        this.camera.keysLeft = [];
        this.camera.keysRight = [];

        this.camera.lowerRadiusLimit = 2; 
        this.camera.upperRadiusLimit = 50;
        this.camera.fovMode = ArcRotateCamera.FOVMODE_VERTICAL_FIXED;
        this.camera.inertia = 0;
        
        this.camera.maxZ = 200;
        this.camera.fov = 60 * Math.PI / 180;

        const hemiLight = new HemisphericLight("hemiLight", new Vector3(0, 1, 0), this.scene);
        hemiLight.intensity = 0.8;
        hemiLight.groundColor = new Color3(0.9, 0.9, 0.9);
        hemiLight.specular = new Color3(0, 0, 0);

        const dirLightFront = new DirectionalLight("dirLightFront", new Vector3(-0.5, -1.0, 1.0), this.scene);
        dirLightFront.intensity = 0.7;
        dirLightFront.specular = new Color3(1.0, 1.0, 1.0);

        this.camSpecLight = new DirectionalLight("camSpecLight", new Vector3(0, -1, 0), this.scene);
        this.camSpecLight.diffuse = new Color3(0, 0, 0);
        this.camSpecLight.specular = new Color3(0.6, 0.6, 0.6);

        const skyColor = Color3.FromHexString("#a0d7f3");
        this.scene.clearColor = new Color4(skyColor.r, skyColor.g, skyColor.b, 1.0);
        this.scene.ambientColor = new Color3(0.65, 0.65, 0.75);

        this.scene.fogMode = Scene.FOGMODE_LINEAR;
        this.scene.fogColor = skyColor; 
        this.scene.fogStart = 30.0; 
        this.scene.fogEnd = this.camera.maxZ; 

    }

    private setupHtmlUI(): void {
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
            if (savedLeft   !== null) historyPanel.style.left   = savedLeft   + "px";
            if (savedTop    !== null) historyPanel.style.top    = savedTop    + "px";
            if (savedWidth  !== null) historyPanel.style.width  = savedWidth  + "px";
            if (savedHeight !== null) historyPanel.style.height = savedHeight + "px";

            let isDragging = false;
            let dragOffsetX = 0;
            let dragOffsetY = 0;

            historyHeader.addEventListener("mousedown", (e: MouseEvent) => {
                isDragging = true;
                dragOffsetX = e.clientX - historyPanel.getBoundingClientRect().left;
                dragOffsetY = e.clientY - historyPanel.getBoundingClientRect().top;
                e.preventDefault();
            });

            document.addEventListener("mousemove", (e: MouseEvent) => {
                if (!isDragging) return;
                const x = Math.max(0, e.clientX - dragOffsetX);
                const y = Math.max(0, e.clientY - dragOffsetY);
                historyPanel.style.left = x + "px";
                historyPanel.style.top  = y + "px";
            });

            document.addEventListener("mouseup", () => {
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
                const savedHistMin = getCookie("histMinimized");
                if (savedHistMin === "1") historyPanel.classList.add("minimized");

                histClose.addEventListener("click", () => {
                    const min = historyPanel.classList.toggle("minimized");
                    setCookie("histMinimized", min ? "1" : "0");
                });
            }
        }

        // ===== ユーザーリスト ドラッグ & 最小化 =====
        {
            const ulPanel  = document.getElementById("user-list-panel") as HTMLElement;
            const ulHeader = document.getElementById("user-list-header") as HTMLElement;
            const ulClose  = document.getElementById("user-list-close") as HTMLElement;

            if (ulPanel && ulHeader) {
                // right ベースの初期位置を left ベースに変換（ドラッグのため）
                const initRect = ulPanel.getBoundingClientRect();
                ulPanel.style.left  = initRect.left + "px";
                ulPanel.style.right = "auto";

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
                if (savedL !== null) { ulPanel.style.left = savedL + "px"; ulPanel.style.right = "auto"; }
                if (savedT !== null)   ulPanel.style.top  = savedT + "px";

                const savedMin = gCookieFn("ulMinimized");
                if (savedMin === "1") {
                    ulPanel.classList.add("minimized");
                } else {
                    if (savedW !== null) ulPanel.style.width  = savedW + "px";
                    if (savedH !== null) ulPanel.style.height = savedH + "px";
                }

                let isDrag = false, offX = 0, offY = 0;
                ulHeader.addEventListener("mousedown", (e: MouseEvent) => {
                    if ((e.target as HTMLElement).id === "user-list-close") return;
                    isDrag = true;
                    offX = e.clientX - ulPanel.getBoundingClientRect().left;
                    offY = e.clientY - ulPanel.getBoundingClientRect().top;
                    e.preventDefault();
                });
                document.addEventListener("mousemove", (e: MouseEvent) => {
                    if (!isDrag) return;
                    ulPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                    ulPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
                });
                document.addEventListener("mouseup", () => {
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
                        const min = ulPanel.classList.toggle("minimized");
                        sCookieFn("ulMinimized", min ? "1" : "0");
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

                // 入力値をクッキーから復元
                const savedUrl  = gCk("srvUrl");
                const savedPort = gCk("srvPort");
                if (savedUrl  && srvUrlInput)  srvUrlInput.value  = savedUrl;
                if (savedPort && srvPortInput) srvPortInput.value = savedPort;

                // 値が変わったらクッキーに保存
                srvUrlInput?.addEventListener("change",  () => sCk("srvUrl",  srvUrlInput.value.trim()));
                srvPortInput?.addEventListener("change", () => sCk("srvPort", srvPortInput.value.trim()));

                // 位置をクッキーから復元（right ベース → left ベースに変換）
                const initRect = srvPanel.getBoundingClientRect();
                srvPanel.style.left  = initRect.left + "px";
                srvPanel.style.right = "auto";
                const savedL = gCk("srvLeft");
                const savedT = gCk("srvTop");
                if (savedL !== null) { srvPanel.style.left = savedL + "px"; srvPanel.style.right = "auto"; }
                if (savedT !== null)   srvPanel.style.top  = savedT + "px";

                // 最小化状態を復元
                if (gCk("srvMinimized") === "1") srvPanel.classList.add("minimized");

                // ドラッグ
                let isDrag = false, offX = 0, offY = 0;
                srvHeader.addEventListener("mousedown", (e: MouseEvent) => {
                    if ((e.target as HTMLElement).id === "server-settings-close") return;
                    isDrag = true;
                    offX = e.clientX - srvPanel.getBoundingClientRect().left;
                    offY = e.clientY - srvPanel.getBoundingClientRect().top;
                    e.preventDefault();
                });
                document.addEventListener("mousemove", (e: MouseEvent) => {
                    if (!isDrag) return;
                    srvPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                    srvPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
                });
                document.addEventListener("mouseup", () => {
                    if (!isDrag) return;
                    isDrag = false;
                    const r = srvPanel.getBoundingClientRect();
                    sCk("srvLeft", String(Math.round(r.left)));
                    sCk("srvTop",  String(Math.round(r.top)));
                });

                if (srvClose) {
                    srvClose.addEventListener("click", () => {
                        const min = srvPanel.classList.toggle("minimized");
                        sCk("srvMinimized", min ? "1" : "0");
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

                const initRect = slPanel.getBoundingClientRect();
                slPanel.style.left  = initRect.left + "px";
                slPanel.style.right = "auto";
                const savedL = gCk("slLeft");
                const savedT = gCk("slTop");
                const savedW = gCk("slWidth");
                const savedH = gCk("slHeight");
                if (savedL !== null) { slPanel.style.left = savedL + "px"; slPanel.style.right = "auto"; }
                if (savedT !== null)   slPanel.style.top   = savedT + "px";
                const isMin = gCk("slMinimized") === "1";
                if (isMin) {
                    slPanel.classList.add("minimized");
                } else {
                    if (savedW !== null) slPanel.style.width  = savedW + "px";
                    if (savedH !== null) slPanel.style.height = savedH + "px";
                }

                let isDrag = false, offX = 0, offY = 0;
                slHeader.addEventListener("mousedown", (e: MouseEvent) => {
                    if ((e.target as HTMLElement).id === "server-log-close") return;
                    isDrag = true;
                    offX = e.clientX - slPanel.getBoundingClientRect().left;
                    offY = e.clientY - slPanel.getBoundingClientRect().top;
                    e.preventDefault();
                });
                document.addEventListener("mousemove", (e: MouseEvent) => {
                    if (!isDrag) return;
                    slPanel.style.left = Math.max(0, e.clientX - offX) + "px";
                    slPanel.style.top  = Math.max(0, e.clientY - offY) + "px";
                });
                document.addEventListener("mouseup", () => {
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
                        const min = slPanel.classList.toggle("minimized");
                        sCk("slMinimized", min ? "1" : "0");
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
            list.scrollTop = list.scrollHeight;
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

        // クッキーから復元
        const savedLoginName = getCookie("loginName");
        if (savedLoginName && loginNameInput) {
            loginNameInput.value = savedLoginName;
            this.updatePlayerNameTag(savedLoginName);
        }

        const loginStatus = document.getElementById("loginStatus") as HTMLSpanElement;
        const userListBody = document.getElementById("user-list-body") as HTMLTableSectionElement;

        // ユーザーリスト管理
        const formatTimestamp = (date: Date): string => {
            const off = -date.getTimezoneOffset();
            const sign = off >= 0 ? "+" : "-";
            const p2 = (n: number) => String(Math.abs(n)).padStart(2, "0");
            const tz = `${sign}${p2(Math.floor(Math.abs(off) / 60))}:${p2(Math.abs(off) % 60)}`;
            return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}T`
                 + `${p2(date.getHours())}:${p2(date.getMinutes())}:${p2(date.getSeconds())}${tz}`;
        };

        const userMap = new Map<string, { username: string; loginTime: string }>();
        let ulSortKey: "username" | "loginTime" = "username";
        let ulSortAsc = true;
        const thUser = document.getElementById("ul-th-user") as HTMLTableCellElement;
        const thTime = document.getElementById("ul-th-time") as HTMLTableCellElement;

        const renderUserList = () => {
            if (!userListBody) return;
            userListBody.innerHTML = "";
            const entries = [...userMap.values()].sort((a, b) => {
                const va = a[ulSortKey], vb = b[ulSortKey];
                return ulSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
            });
            for (const { username, loginTime } of entries) {
                const tr = document.createElement("tr");
                tr.innerHTML = `<td>${username}</td><td>${loginTime}</td>`;
                userListBody.appendChild(tr);
            }
            const arrow = ulSortAsc ? "▲" : "▼";
            if (thUser) thUser.dataset.sort = ulSortKey === "username" ? arrow : "";
            if (thTime) thTime.dataset.sort = ulSortKey === "loginTime" ? arrow : "";
        };

        if (thUser) thUser.addEventListener("click", () => {
            if (ulSortKey === "username") ulSortAsc = !ulSortAsc;
            else { ulSortKey = "username"; ulSortAsc = true; }
            renderUserList();
        });
        if (thTime) thTime.addEventListener("click", () => {
            if (ulSortKey === "loginTime") ulSortAsc = !ulSortAsc;
            else { ulSortKey = "loginTime"; ulSortAsc = true; }
            renderUserList();
        });
        const fetchAndSetLoginTime = async (userId: string, username: string) => {
            const isoStr = await this.nakama.getUserLoginTime(userId);
            const loginTime = formatTimestamp(isoStr ? new Date(isoStr) : new Date());
            userMap.set(userId, { username, loginTime });
            renderUserList();
        };

        // Nakama コールバック設定
        this.nakama.onChatMessage = (username, text) => {
            addChatHistory(username, text);
        };
        this.nakama.onPresenceJoin = (userId, username) => {
            userMap.set(userId, { username, loginTime: "…" });
            renderUserList();
            fetchAndSetLoginTime(userId, username);
        };
        this.nakama.onPresenceNewJoin = (userId, username) => {
            userMap.set(userId, { username, loginTime: "…" });
            renderUserList();
            fetchAndSetLoginTime(userId, username);
            addChatHistory("[system]", `${username}がログインしました。`);
        };
        this.nakama.onPresenceLeave = (userId, username) => {
            userMap.delete(userId);
            renderUserList();
            addChatHistory("[system]", `${username}がログアウトしました。`);
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
                : `${ts} ${label} URL=${host}:${port}` + (detail ? ` ${detail}` : "");
            list.appendChild(entry);
            list.scrollTop = list.scrollHeight;
        };
        // ===========================

        const NAKAMA_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@+\-]{5,127}$/;
        const doLogin = async () => {
            const name = loginNameInput?.value.trim();
            if (!name) return;
            if (!NAKAMA_ID_RE.test(name)) {
                if (loginStatus) {
                    loginStatus.style.color = "#ff4444";
                    loginStatus.textContent = "✘ 使えない文字が含まれています。使える文字: 英数字と . _ @ + -（6〜128文字）";
                }
                return;
            }
            const host = srvUrlInput?.value.trim()  || "127.0.0.1";
            const port = srvPortInput?.value.trim() || "7350";
            this.updatePlayerNameTag(name);
            setCookie("loginName", name);
            if (loginStatus) { loginStatus.style.color = ""; loginStatus.textContent = "接続中…"; }
            if (loginBtn)    loginBtn.disabled = true;
            try {
                await this.nakama.login(name, host, port);
                addServerLog(host, port, "ログイン成功");
                if (loginStatus) {
                    loginStatus.style.color = "#00dd55";
                    loginStatus.textContent = "✔ログイン済み";
                }
                if (loginBtn) {
                    loginBtn.textContent = "ログアウト";
                    loginBtn.style.background = "#e0509099";
                    loginBtn.onclick = doLogout;
                }
                if (loginNameInput) loginNameInput.onkeydown = null;
            } catch (e) {
                console.error("Nakama login failed:", e);
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
                    loginStatus.textContent = "✘ログイン失敗: " + reason;
                }
            } finally {
                if (loginBtn) loginBtn.disabled = false;
            }
        };

        const doLogout = () => {
            const host = srvUrlInput?.value.trim()  || "127.0.0.1";
            const port = srvPortInput?.value.trim() || "7350";
            this.nakama.logout();
            addServerLog(host, port, "ログアウト");
            userMap.clear();
            renderUserList();
            if (loginStatus) { loginStatus.style.color = "#00dd55"; loginStatus.textContent = "ログインして下さい！"; }
            if (loginBtn) loginBtn.style.background = "#28a74580";
            setLoginMode();
        };

        setLoginMode();

        const sendMessage = async () => {
            const text = textarea.value.trim();
            if (!text) return;
            this.updatePlayerSpeech(text);
            textarea.value = "";
            if (this.nakama.getSession()) {
                // ログイン済み: サーバー送信 → エコーで履歴反映
                try {
                    await this.nakama.sendChatMessage(text);
                } catch (e) {
                    console.error("sendChatMessage failed:", e);
                    // 送信失敗時はローカルで表示
                    const name = loginNameInput?.value.trim() || "tommie.jp";
                    addChatHistory(name, text);
                }
            } else {
                // 未ログイン: ローカルのみ
                const name = loginNameInput?.value.trim() || "tommie.jp";
                addChatHistory(name, text);
            }
        };

        clearBtn.onclick = () => {
            if (this.updatePlayerSpeech) this.updatePlayerSpeech(""); 
            textarea.value = "";
        };

        sendBtn.onclick = () => { sendMessage(); };
        textarea.onkeydown = (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        };
    }

    private createAvatar(name: string, textureUrl: string, x: number, z: number): Mesh {
        const width = 1.0;
        const height = 1.5;
        const depth = 0.05;    
        const layerCount = 5; 

        const vTrimStart = 0.02;
        const vTrimEnd = 0.98;

        const tex = new Texture(textureUrl, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
        tex.hasAlpha = true;

        const frontMat = new StandardMaterial(name + "_frontMat", this.scene);
        frontMat.diffuseTexture = tex;
        frontMat.useAlphaFromDiffuseTexture = true;
        frontMat.backFaceCulling = true; 
        frontMat.specularColor = new Color3(0.5, 0.5, 0.5); 
        frontMat.specularPower = 64; 
        frontMat.emissiveColor = new Color3(0.1, 0.1, 0.1); 

        const backMat = new StandardMaterial(name + "_backMat", this.scene);
        backMat.diffuseTexture = tex; 
        backMat.useAlphaFromDiffuseTexture = true;
        backMat.backFaceCulling = true;
        backMat.specularColor = new Color3(0.5, 0.5, 0.5); 
        backMat.specularPower = 64;
        backMat.emissiveColor = new Color3(0.1, 0.1, 0.1);

        const sideMat = new StandardMaterial(name + "_sideMat", this.scene);
        sideMat.diffuseTexture = tex; 
        sideMat.useAlphaFromDiffuseTexture = true;
        sideMat.diffuseColor = new Color3(0.5, 0.5, 0.5); 
        sideMat.specularColor = new Color3(0.8, 0.8, 0.8); 
        sideMat.emissiveColor = new Color3(0.15, 0.15, 0.15); 
        sideMat.backFaceCulling = false;

        const normalUVs = [0, vTrimEnd, 1, vTrimEnd, 1, vTrimStart, 0, vTrimStart];
        const invertedUVs = [1, vTrimEnd, 0, vTrimEnd, 0, vTrimStart, 1, vTrimStart];

        const applyCustomUVs = (mesh: Mesh, uvArray: number[]) => {
            mesh.setVerticesData(VertexBuffer.UVKind, uvArray);
        };

        const meshesToMerge: Mesh[] = [];

        const frontMesh = MeshBuilder.CreatePlane(name + "_front", { width, height, updatable: true }, this.scene);
        frontMesh.position.z = -depth / 2;
        frontMesh.material = frontMat;
        applyCustomUVs(frontMesh, normalUVs); 
        meshesToMerge.push(frontMesh);

        const backMesh = MeshBuilder.CreatePlane(name + "_back", { width, height, updatable: true }, this.scene);
        backMesh.position.z = depth / 2;
        backMesh.rotation.y = Math.PI; 
        backMesh.material = backMat;
        applyCustomUVs(backMesh, invertedUVs); 
        meshesToMerge.push(backMesh);

        const step = depth / (layerCount + 1);
        for (let i = 1; i <= layerCount; i++) {
            const layerMesh = MeshBuilder.CreatePlane(name + "_layer" + i, { width, height, updatable: true }, this.scene);
            layerMesh.position.z = -depth / 2 + step * i;
            layerMesh.material = sideMat;
            applyCustomUVs(layerMesh, normalUVs);
            meshesToMerge.push(layerMesh);
        }

        const mergedAvatar = Mesh.MergeMeshes(meshesToMerge, true, true, undefined, false, true) as Mesh;
        mergedAvatar.name = name;

        const avatarRoot = MeshBuilder.CreateBox(name + "_root", { size: 0.1 }, this.scene);
        avatarRoot.isVisible = false;
        avatarRoot.position.set(x, 0, z); 

        const baseThickness = 0.05;
        const groundOffset = 0.01; 

        mergedAvatar.parent = avatarRoot;
        mergedAvatar.position.set(0, height / 2 + baseThickness + groundOffset, 0);

        const standBase = new Mesh(name + "_standBase", this.scene);
        const y = baseThickness / 2;
        
        const p0 = new Vector3(0, y, -0.5);      
        const p1 = new Vector3(0.5, y, -0.1);    
        const p2 = new Vector3(0.5, y, 0.5);     
        const p3 = new Vector3(-0.5, y, 0.5);    
        const p4 = new Vector3(-0.5, y, -0.1);   
        
        const b0 = new Vector3(0, -y, -0.5);
        const b1 = new Vector3(0.5, -y, -0.1);
        const b2 = new Vector3(0.5, -y, 0.5);
        const b3 = new Vector3(-0.5, -y, 0.5);
        const b4 = new Vector3(-0.5, -y, -0.1);

        const positions: number[] = [];
        const indices: number[] = [];
        let idx = 0;

        const addFace = (v0: Vector3, v1: Vector3, v2: Vector3) => {
            positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
            indices.push(idx, idx+1, idx+2);
            idx += 3;
        };
        const addQuad = (v0: Vector3, v1: Vector3, v2: Vector3, v3: Vector3) => {
            addFace(v0, v1, v2);
            addFace(v0, v2, v3);
        };

        addFace(p0, p4, p3);
        addFace(p0, p3, p2);
        addFace(p0, p2, p1);
        
        addFace(b0, b1, b2);
        addFace(b0, b2, b3);
        addFace(b0, b3, b4);
        
        addQuad(p0, p1, b1, b0);
        addQuad(p1, p2, b2, b1);
        addQuad(p2, p3, b3, b2);
        addQuad(p3, p4, b4, b3);
        addQuad(p4, p0, b0, b4);

        const normals: number[] = [];
        VertexData.ComputeNormals(positions, indices, normals);

        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;
        vertexData.applyToMesh(standBase);

        standBase.parent = avatarRoot;
        standBase.position.set(0, y + groundOffset, 0); 

        const baseMat = new StandardMaterial(name + "_baseMat", this.scene);
        baseMat.diffuseColor = new Color3(0.4, 0.75, 0.95); 
        baseMat.alpha = 0.6; 
        baseMat.specularColor = new Color3(0.0, 0.0, 0.0); 
        baseMat.backFaceCulling = false; 
        baseMat.needDepthPrePass = true; 
        standBase.material = baseMat;

        return avatarRoot;
    }

    private createNameTag(targetMesh: Mesh, nameText: string): (newName: string) => void {
        const namePlane = MeshBuilder.CreatePlane("nameTag_" + targetMesh.name, { width: 1.5, height: 0.40 }, this.scene);
        namePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        namePlane.isPickable = false;

        namePlane.parent = targetMesh;
        namePlane.position = new Vector3(0, 1.75, 0);

        const adt = AdvancedDynamicTexture.CreateForMesh(namePlane, 1024, 128);

        const textBlock = new TextBlock();
        textBlock.text = nameText;
        textBlock.color = "white";
        textBlock.fontSize = "56px";
        textBlock.fontWeight = "bold";
        textBlock.outlineWidth = 6;
        textBlock.outlineColor = "black";

        adt.addControl(textBlock);

        return (newName: string) => { textBlock.text = newName; };
    }

    private createObjects(): void {
        const ground = MeshBuilder.CreateGround("ground", { width: 400, height: 400 }, this.scene);
        const gridMaterial = new GridMaterial("gridMaterial", this.scene);
        gridMaterial.mainColor = new Color3(0.85, 0.95, 0.85);
        gridMaterial.lineColor = new Color3(0.35, 0.55, 0.35);
        gridMaterial.gridRatio = 1.0;
        gridMaterial.opacity = 1.0;
        gridMaterial.freeze();
        ground.material = gridMaterial;
        ground.freezeWorldMatrix();

        this.hoverMarker = MeshBuilder.CreatePlane("hoverMarker", { size: 1.0 }, this.scene);
        this.hoverMarker.rotation.x = Math.PI / 2;
        this.hoverMarker.position.y = 0.01;
        const hoverMat = new StandardMaterial("hoverMat", this.scene);
        hoverMat.emissiveColor = new Color3(0.5, 1.0, 0.5); 
        hoverMat.alpha = 0.5; 
        hoverMat.disableLighting = true; 
        this.hoverMarker.material = hoverMat;
        this.hoverMarker.isPickable = false;

        this.clickMarker = MeshBuilder.CreatePlane("clickMarker", { size: 1.0 }, this.scene);
        this.clickMarker.rotation.x = Math.PI / 2;
        this.clickMarker.position.y = 0.01;
        const clickMat = new StandardMaterial("clickMat", this.scene);
        clickMat.emissiveColor = new Color3(0.0, 1.0, 0.0); 
        clickMat.alpha = 0.7;
        clickMat.disableLighting = true;
        this.clickMarker.material = clickMat;
        this.clickMarker.isVisible = false;
        this.clickMarker.isPickable = false;

        this.playerBox = this.createAvatar("tommie.jp", "/textures/pic1.ktx2", 0, 0);

        const playerStandBase = this.playerBox.getChildMeshes().find(m => m.name === "tommie.jp_standBase");
        if (playerStandBase && playerStandBase.material) {
            (playerStandBase.material as StandardMaterial).diffuseColor = new Color3(1.0, 0.4, 0.7);
        }

        const player2 = this.createAvatar("npc001", "/textures/pic2.ktx2", 0, 3);
        const player3 = this.createAvatar("npc002", "/textures/pic2.ktx2", 1.5, 3);
        const player4 = this.createAvatar("npc003", "/textures/pic2.ktx2", 3, 3);

        this.npc001 = player2;
        this.npc002 = player3;
        this.npc003 = player4;                    

        this.updatePlayerNameTag = this.createNameTag(this.playerBox, "tommie.jp✅️");
        this.createNameTag(player2, "npc001");
        this.createNameTag(player3, "npc002");
        this.createNameTag(player4, "npc003");

        this.createRoundedMinecraftClouds();
        this.createCoordinateLabels();
        
        this.updatePlayerSpeech = this.createSpeechBubble(this.playerBox, "こんにちは！");
        const updateNpc001Speech = this.createSpeechBubble(player2, "キタちゃん１です。");
        const updateNpc002Speech = this.createSpeechBubble(player3, "キターちゃん２です");
        const updateNpc003Speech = this.createSpeechBubble(player4, "キタちゃん３です");

        const getNpcMessage = (label: string) => {
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, "0");
            const mm = String(now.getMinutes()).padStart(2, "0");
            const ss = String(now.getSeconds()).padStart(2, "0");
            return `${label}時刻の分秒は${mm}:${ss}です！`;
        };
        const addChatHistoryGlobal = (avatarName: string, text: string) => {
            const list = document.getElementById("chat-history-list");
            if (!list) return;
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, "0");
            const mm = String(now.getMinutes()).padStart(2, "0");
            const ss = String(now.getSeconds()).padStart(2, "0");
            const entry = document.createElement("div");
            entry.className = "chat-history-entry";
            entry.innerHTML =
                `<span class="chat-history-time">${hh}:${mm}:${ss}</span>` +
                `<span class="chat-history-name">${avatarName}</span>` +
                `<span class="chat-history-text">${text}</span>`;
            list.appendChild(entry);
            list.scrollTop = list.scrollHeight;
        };

        let npcIntervals: ReturnType<typeof setInterval>[] = [];
        const startNpcIntervals = () => {
            npcIntervals.push(setInterval(() => {
                const msg = getNpcMessage("わーい。キタちゃん１です。");
                updateNpc001Speech(msg);
                if (this.isNpcChatOn) addChatHistoryGlobal("npc001", msg);
            }, 3000));
            npcIntervals.push(setInterval(() => {
                const msg = getNpcMessage("キタちゃん２です。❤");
                updateNpc002Speech(msg);
                if (this.isNpcChatOn) addChatHistoryGlobal("npc002", msg);
            }, 5000));
            npcIntervals.push(setInterval(() => {
                const msg = getNpcMessage("にゃにゃ。キタちゃん３です。🐕️");
                updateNpc003Speech(msg);
                if (this.isNpcChatOn) addChatHistoryGlobal("npc003", msg);
            }, 8000));
        };
        startNpcIntervals();

        this.createDebugOverlay();

        window.addEventListener("keydown", (e) => {
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA" || activeElement.tagName === "SELECT")) {
                return; 
            }

            const key = e.key.toLowerCase();
            this.inputMap[key] = true;
            
            if (["w", "a", "s", "d", "q", "e", "x", "escape", " ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
                this.targetPosition = null;
                if (this.clickMarker) this.clickMarker.isVisible = false;
            }
        });

        window.addEventListener("keyup", (e) => {
            const key = e.key.toLowerCase();
            this.inputMap[key] = false;
        });

        this.scene.onPointerObservable.add((pointerInfo) => {
            if (pointerInfo.type === PointerEventTypes.POINTERMOVE) {
                const pick = this.scene.pick(
                    this.scene.pointerX, 
                    this.scene.pointerY, 
                    (mesh) => mesh.name === "ground"
                );

                if (pick && pick.hit && pick.pickedPoint) {
                    this.hoverMarker.position.x = Math.floor(pick.pickedPoint.x) + 0.5;
                    this.hoverMarker.position.z = Math.floor(pick.pickedPoint.z) + 0.5;
                    this.hoverMarker.isVisible = true;
                } else {
                    this.hoverMarker.isVisible = false;
                }
            }

            if (pointerInfo.type === PointerEventTypes.POINTERTAP) {
                const pick = pointerInfo.pickInfo;
                if (pick && pick.hit && pick.pickedMesh && pick.pickedMesh.name === "ground" && pick.pickedPoint) {
                    const snappedX = Math.floor(pick.pickedPoint.x) + 0.5;
                    const snappedZ = Math.floor(pick.pickedPoint.z) + 0.5;

                    this.targetPosition = new Vector3(snappedX, 0, snappedZ);
                    this.clickMarker.position.x = snappedX;
                    this.clickMarker.position.z = snappedZ;
                    this.clickMarker.isVisible = true;
                }
            }
        });

        this.scene.onBeforeRenderObservable.add(() => {
            const deltaTime = this.engine.getDeltaTime() / 1000;
            this.time += deltaTime;

            const currentPos = this.playerBox.position;
            const moveDist = this.moveSpeed * deltaTime;

            let isKeyboardMoving = false;
            let moveDirection = new Vector3(0, 0, 0);

            const forward = this.camera.getDirection(Vector3.Forward());
            forward.y = 0; 
            forward.normalize();
            
            const right = this.camera.getDirection(Vector3.Right());
            right.y = 0;
            right.normalize();

            if (this.inputMap["w"] || this.inputMap["arrowup"]) moveDirection.addInPlace(forward); 
            if (this.inputMap["s"] || this.inputMap["arrowdown"]) moveDirection.subtractInPlace(forward); 
            if (this.inputMap["d"] || this.inputMap["e"] || this.inputMap["arrowright"]) moveDirection.addInPlace(right); 
            if (this.inputMap["a"] || this.inputMap["q"] || this.inputMap["arrowleft"]) moveDirection.subtractInPlace(right); 

            if (moveDirection.lengthSquared() > 0) {
                isKeyboardMoving = true;
                moveDirection.normalize();
                
                this.playerBox.position.addInPlace(moveDirection.scale(moveDist));
                
                const targetAngle = Math.atan2(moveDirection.x, moveDirection.z) + Math.PI;
                let diff = targetAngle - this.playerBox.rotation.y;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                this.playerBox.rotation.y += diff * Math.min(1.0, 15.0 * deltaTime);
            }

            if (!isKeyboardMoving && this.targetPosition) {
                const target = new Vector3(this.targetPosition.x, currentPos.y, this.targetPosition.z);
                const distance = Vector3.Distance(currentPos, target);

                if (distance > moveDist) {
                    const direction = target.subtract(currentPos).normalize();
                    this.playerBox.position.addInPlace(direction.scale(moveDist));

                    const targetAngle = Math.atan2(direction.x, direction.z) + Math.PI;
                    let diff = targetAngle - this.playerBox.rotation.y;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    this.playerBox.rotation.y += diff * Math.min(1.0, 15.0 * deltaTime);

                    const moveAngle = Math.atan2(direction.x, direction.z);
                    const destAlpha = -moveAngle - Math.PI / 2; 

                    let alphaDiff = destAlpha - this.camera.alpha;
                    while (alphaDiff < -Math.PI) alphaDiff += Math.PI * 2;
                    while (alphaDiff >  Math.PI) alphaDiff -= Math.PI * 2;
                    this.camera.alpha += alphaDiff * Math.min(1.0, 2.0 * deltaTime);
                } else {
                    this.playerBox.position.copyFrom(target);
                    this.targetPosition = null;
                    this.clickMarker.isVisible = false;
                }
            }

            this.npc001.position.x = this.npc001BaseX + 10 * Math.sin(this.time * 0.8);
            const velocityX = 10 * 0.8 * Math.cos(this.time * 0.8);
            if (Math.abs(velocityX) > 0.01) {
                const targetAngle1 = velocityX > 0 ? -Math.PI / 2 : Math.PI / 2;
                let diff1 = targetAngle1 - this.npc001.rotation.y;
                while (diff1 < -Math.PI) diff1 += Math.PI * 2;
                while (diff1 > Math.PI) diff1 -= Math.PI * 2;
                this.npc001.rotation.y += diff1 * 0.25;
            }

            const cycle = (this.time * 0.6) % 40;
            let targetX2 = this.npc002.position.x;
            let targetZ2 = this.npc002.position.z;
            if (cycle < 10) { targetX2 = this.npc002BaseX + cycle; targetZ2 = this.npc002BaseZ; }
            else if (cycle < 20) { targetX2 = this.npc002BaseX + 10; targetZ2 = this.npc002BaseZ + (cycle - 10); }
            else if (cycle < 30) { targetX2 = this.npc002BaseX + (30 - cycle); targetZ2 = this.npc002BaseZ + 10; }
            else { targetX2 = this.npc002BaseX; targetZ2 = this.npc002BaseZ + (40 - cycle); }
            const delta2 = new Vector3(targetX2 - this.npc002.position.x, 0, targetZ2 - this.npc002.position.z);
            this.npc002.position.x = targetX2;
            this.npc002.position.z = targetZ2;
            if (delta2.length() > 0.001) {
                const targetAngle2 = Math.atan2(delta2.x, delta2.z) + Math.PI;
                let diff2 = targetAngle2 - this.npc002.rotation.y;
                while (diff2 < -Math.PI) diff2 += Math.PI * 2;
                while (diff2 > Math.PI) diff2 -= Math.PI * 2;
                this.npc002.rotation.y += diff2 * 0.15;
            }

            const angle = this.time * 1.2;                    
            this.npc003.position.x = this.npc003BaseX + 5 * Math.cos(angle);
            this.npc003.position.z = this.npc003BaseZ + 5 * Math.sin(angle);
            const velocity3 = new Vector3(-5 * 1.2 * Math.sin(angle), 0, 5 * 1.2 * Math.cos(angle));
            if (velocity3.length() > 0.01) {
                const targetAngle3 = Math.atan2(velocity3.x, velocity3.z) + Math.PI;
                let diff3 = targetAngle3 - this.npc003.rotation.y;
                while (diff3 < -Math.PI) diff3 += Math.PI * 2;
                while (diff3 > Math.PI) diff3 -= Math.PI * 2;
                this.npc003.rotation.y += diff3 * 0.25;
            }

            this.camSpecLight.direction = this.camera.getDirection(Vector3.Forward());
        });

        if (this.camera && this.playerBox) {
            this.camera.setTarget(this.playerBox);
        }
    }

    private createSpeechBubble(targetMesh: Mesh, speechText: string): (newText: string) => void {
        const bubblePlane = MeshBuilder.CreatePlane("speechBubble_" + targetMesh.name, { width: 1.0, height: 0.20 }, this.scene);
        bubblePlane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        bubblePlane.isPickable = false;
        
        bubblePlane.parent = targetMesh;
        bubblePlane.position = new Vector3(0, 2.05, 0); 
        
        const adt = AdvancedDynamicTexture.CreateForMesh(bubblePlane, 1024, 128);

        const bg = new Rectangle();
        bg.width = "100%"; bg.height = "100%";
        bg.cornerRadius = 20;
        bg.background = "rgba(255, 255, 255, 0.85)";
        bg.thickness = 1;
        bg.color = "#333333";
        adt.addControl(bg);

        const textBlock = new TextBlock();
        textBlock.text = speechText;
        textBlock.fontSize = "48px";
        textBlock.color = "black";

        textBlock.textWrapping = true;
        textBlock.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        textBlock.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        textBlock.paddingLeft = "20px";
        textBlock.paddingRight = "20px";
        textBlock.paddingTop = "8px";
        textBlock.paddingBottom = "8px";

        bg.addControl(textBlock);
        
        return (newText: string) => {
            if (newText && newText.trim() !== "") {
                textBlock.text = newText;
                bubblePlane.isVisible = true;
            } else {
                textBlock.text = "";
                bubblePlane.isVisible = false;
            }
            adt.markAsDirty();
        };
    }

    private createRoundedMinecraftClouds(): void {
        const cloudMaterial = new StandardMaterial("roundedMinecraftCloudMat", this.scene);
        cloudMaterial.diffuseColor = new Color3(1, 1, 1);
        cloudMaterial.specularColor = new Color3(0, 0, 0); 
        cloudMaterial.emissiveColor = new Color3(0.6, 0.6, 0.6); 
        cloudMaterial.alpha = 0.6; 
        cloudMaterial.backFaceCulling = true;
        cloudMaterial.freeze(); 

        const spheresToMerge: Mesh[] = [];

        const cloudPatterns = [
            [ 
                [0,0], [1,0], [2,0],
                [-1,1], [0,1], [1,1], [2,1], [3,1],
                [0,2], [1,2], [2,2],
                [1,3]
            ],
            [ 
                [0,0], [1,0],
                [-1,1], [0,1], [1,1], [2,1],
                [-2,2], [-1,2], [0,2], [1,2], [2,2], [3,2],
                [0,3], [1,3], [2,3],
                [1,4]
            ],
            [ 
                [0,0], [1,0], [2,0], [3,0],
                [-1,1], [0,1], [1,1], [2,1], [3,1], [4,1],
                [0,2], [1,2], [2,2], [3,2],
                [1,3], [2,3]
            ]
        ];

        const blockSize = 6.0; 
        const areaSize = 400; 

        for (let i = 0; i < 25; i++) {
            const baseX = (Math.random() - 0.5) * areaSize;
            const baseY = 40 + (Math.random() - 0.5) * 5; 
            const baseZ = (Math.random() - 0.5) * areaSize;
            
            const pattern = cloudPatterns[Math.floor(Math.random() * cloudPatterns.length)];

            for (const [bx, bz] of pattern) {
                const sphere = MeshBuilder.CreateSphere(`cloud_${i}_${bx}_${bz}`, {
                    diameter: blockSize,
                    segments: 8
                }, this.scene);

                sphere.scaling.set(1.0, 0.5, 1.0);

                sphere.position.set(
                    baseX + bx * blockSize, 
                    baseY, 
                    baseZ + bz * blockSize
                );

                spheresToMerge.push(sphere);
            }
        }

        if (spheresToMerge.length > 0) {
            const mergedClouds = Mesh.MergeMeshes(spheresToMerge, true, true, undefined, false, true);
            if (mergedClouds) {
                mergedClouds.name = "roundedMinecraftClouds";
                mergedClouds.material = cloudMaterial;
                mergedClouds.isPickable = false;

                this.scene.onBeforeRenderObservable.add(() => {
                    const deltaTime = this.engine.getDeltaTime() / 1000;
                    mergedClouds.position.x += 2.0 * deltaTime; 
                    
                    if (mergedClouds.position.x > areaSize / 2) {
                         mergedClouds.position.x -= areaSize;
                    }
                });
            }
        }
    }

    private setMSAA(samples: number): void {
        if (samples <= 1) {
            if (this.renderingPipeline) {
                this.renderingPipeline.dispose();
                this.renderingPipeline = null;
            }
        } else {
            if (!this.renderingPipeline) {
                this.renderingPipeline = new DefaultRenderingPipeline("defaultPipeline", false, this.scene, [this.camera]);
            }
            this.renderingPipeline.samples = samples;
        }
    }

    private createCoordinateLabels(): void {
        const step = 10;
        const range = 50;
        for (let x = -range; x <= range; x += step) this.createSingleLabel(x, 0, "(" + x + ",0)");
        for (let z = -range; z <= range; z += step) if (z !== 0) this.createSingleLabel(0, z, "(0," + z + ")");
    }

    private createSingleLabel(x: number, z: number, labelText: string): void {
        const plane = MeshBuilder.CreatePlane("coordLabel_" + x + "_" + z, { width: 1.0, height: 1.0 }, this.scene);
        plane.rotation.x = Math.PI / 2;
        plane.position.set(x, 0.02, z);
        plane.isPickable = false;
        plane.freezeWorldMatrix();
        
        const texture = AdvancedDynamicTexture.CreateForMesh(plane, 256, 256, false);
        const bg = new Rectangle();
        bg.width = "100%"; bg.height = "100%";
        bg.background = "rgba(255,255,255,0.50)";
        bg.cornerRadius = 12;
        texture.addControl(bg);
        const text = new TextBlock();
        text.text = labelText; 
        text.color = "#FF0000"; 
        text.fontSize = "50px"; 
        bg.addControl(text);
    }

    private createDebugOverlay(): void {
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
            if (savedLeft  !== null) debugOverlay.style.left  = savedLeft  + "px";
            if (savedTop   !== null) debugOverlay.style.top   = savedTop   + "px";
            if (savedWidth !== null && savedMin !== "1") debugOverlay.style.width  = savedWidth + "px";
            if (savedHeight!== null && savedMin !== "1") debugOverlay.style.height = savedHeight + "px";
            if (savedMin === "1") debugOverlay.classList.add("minimized");

            let isDragging = false;
            let dragOX = 0, dragOY = 0;

            debugTitleBar.addEventListener("mousedown", (e: MouseEvent) => {
                if ((e.target as HTMLElement).tagName === "BUTTON") return;
                isDragging = true;
                const rect = debugOverlay.getBoundingClientRect();
                dragOX = e.clientX - rect.left;
                dragOY = e.clientY - rect.top;
                e.preventDefault();
            });
            document.addEventListener("mousemove", (e: MouseEvent) => {
                if (!isDragging) return;
                debugOverlay.style.left = Math.max(0, e.clientX - dragOX) + "px";
                debugOverlay.style.top  = Math.max(0, e.clientY - dragOY) + "px";
            });
            document.addEventListener("mouseup", () => {
                if (isDragging) { isDragging = false; saveDebugState(); }
            });

            let savedOverlayHeight = "";
            let savedOverlayWidth  = "";
            debugMinBtn.addEventListener("click", () => {
                if (isMaximized) {
                    savedOverlayWidth  = savedMaxWidth  || (savedWidth  !== null ? savedWidth  + "px" : "270px");
                    savedOverlayHeight = savedMaxHeight || (savedHeight !== null ? savedHeight + "px" : "");
                    isMaximized = false;
                } else {
                    savedOverlayWidth  = debugOverlay.style.width;
                    savedOverlayHeight = debugOverlay.style.height;
                }
                debugOverlay.style.height = ""; 
                debugOverlay.style.width  = ""; 
                debugOverlay.classList.add("minimized");
                saveDebugState();
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

            menuBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                menuPopup.classList.toggle("open");
            });

            document.addEventListener("click", () => {
                menuPopup.classList.remove("open");
            });

            cookieReset.addEventListener("click", () => {
                document.cookie.split(";").forEach(c => {
                    const name = c.trim().split("=")[0];
                    if (name) document.cookie = `${name}=;path=/;max-age=0`;
                });
                location.reload();
            });

            // パネル表示 ON/OFF トグル（クッキーで状態を保存・復元）
            const gCk = (k: string): string | null => {
                const m = document.cookie.match(new RegExp("(?:^|; )" + k + "=([^;]*)"));
                return m ? decodeURIComponent(m[1]) : null;
            };
            const sCk = (k: string, v: string) =>
                document.cookie = `${k}=${encodeURIComponent(v)};path=/;max-age=${60*60*24*365}`;

            const makeToggle = (btnId: string, targetId: string, label: string, cookieKey: string) => {
                const btn    = document.getElementById(btnId);
                const target = document.getElementById(targetId);
                if (!btn || !target) return;

                // 初期状態をクッキーから復元
                if (gCk(cookieKey) === "0") {
                    target.style.display = "none";
                    btn.textContent = "　 " + label;
                }

                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const visible = target.style.display !== "none";
                    target.style.display = visible ? "none" : "";
                    btn.textContent = (visible ? "　" : "✓") + " " + label;
                    sCk(cookieKey, visible ? "0" : "1");
                });
            };
            makeToggle("menu-serversettings", "server-settings-panel", "サーバ設定",    "showSrvSettings");
            makeToggle("menu-serverlog",      "server-log-panel",      "サーバ接続ログ", "showSrvLog");
            makeToggle("menu-userlist",       "user-list-panel",       "ユーザリスト",  "showUserList");
            makeToggle("menu-chathistory",    "chat-history-panel",    "チャット履歴",  "showChatHist");
            makeToggle("menu-debug",          "debug-overlay",         "デバッグツール", "showDebug");
        }

        const playerPosVal = document.getElementById("val-player-pos");
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

        const isWebGPU = (this.engine as any).isWebGPU || this.engine.name === "WebGPU";
        if (apiv) apiv.innerText = isWebGPU ? "WebGPU" : "WebGL2";

        if (scaleSelect) {
            scaleSelect.addEventListener("change", (e) => {
                const target = e.target as HTMLSelectElement;
                const newScale = parseFloat(target.value);
                this.engine.setHardwareScalingLevel(newScale);
            });
        }

        const aaSelect = document.getElementById("aaSelect") as HTMLSelectElement;
        if (aaSelect) {
            aaSelect.addEventListener("change", () => {
                this.setMSAA(parseInt(aaSelect.value));
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

        if (farClipInput && this.camera) {
            farClipInput.addEventListener("change", (e) => {
                const val = parseFloat((e.target as HTMLSelectElement).value);
                if (!isNaN(val) && val > 0) {
                    this.camera.maxZ = val;
                    this.scene.fogEnd = val;
                }
            });
        }

        if (fovSelect && fovInput && this.camera) {
            fovInput.addEventListener("input", (e) => {
                const val = parseFloat((e.target as HTMLInputElement).value);
                if (!isNaN(val) && val > 0) {
                    this.camera.fov = val * Math.PI / 180;
                    
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
                    this.camera.fov = val * Math.PI / 180;
                    fovInput.value = target.value; 
                }
            });
        }

        if (fogBtn) {
            let isFogEnabled = true;
            fogBtn.addEventListener("click", () => {
                isFogEnabled = !isFogEnabled;
                this.scene.fogMode = isFogEnabled ? Scene.FOGMODE_LINEAR : Scene.FOGMODE_NONE;
                fogBtn.innerText = isFogEnabled ? "On" : "Off";
                if (isFogEnabled) fogBtn.classList.remove("off");
                else fogBtn.classList.add("off");
            });
        }

        if (fogColorInput) {
            fogColorInput.addEventListener("input", (e) => {
                const val = (e.target as HTMLInputElement).value;
                const newColor = Color3.FromHexString(val);
                this.scene.fogColor = newColor;
                this.scene.clearColor = new Color4(newColor.r, newColor.g, newColor.b, 1.0);
            });
        }

        if (autoChatBtn) {
            const npcMessages = [
                "こんにちは！⭐️",
                "今日もいい天気だね。",
                "何か面白いことある？",
                "ここは好きな場所だよ。",
                "また会えたね！",
                "ちょっと疲れたな〜",
                "このあたりは静かでいいね。",
                "どこから来たの？",
                "冒険に出かけようよ！",
                "今日のランチは何だろう？",
            ];
            let autoChatTimer: ReturnType<typeof setTimeout> | null = null;
            let isAutoChatOn = false;
            const scheduleNext = () => {
                const delay = 3000 + Math.random() * 4000;
                autoChatTimer = setTimeout(async () => {
                    if (!isAutoChatOn) return;
                    const msg = npcMessages[Math.floor(Math.random() * npcMessages.length)];
                    try { await this.nakama.sendChatMessage(msg); } catch { /* ignore */ }
                    scheduleNext();
                }, delay);
            };
            autoChatBtn.addEventListener("click", () => {
                isAutoChatOn = !isAutoChatOn;
                autoChatBtn.textContent = isAutoChatOn ? "On" : "Off";
                if (isAutoChatOn) {
                    autoChatBtn.classList.remove("off");
                    scheduleNext();
                } else {
                    autoChatBtn.classList.add("off");
                    if (autoChatTimer !== null) { clearTimeout(autoChatTimer); autoChatTimer = null; }
                }
            });
        }

        if (npcAutoChatBtn) {
            npcAutoChatBtn.addEventListener("click", () => {
                this.isNpcChatOn = !this.isNpcChatOn;
                npcAutoChatBtn.textContent = this.isNpcChatOn ? "On" : "Off";
                if (this.isNpcChatOn) npcAutoChatBtn.classList.remove("off");
                else npcAutoChatBtn.classList.add("off");
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
                    this.scene.materials.forEach(mat => {
                        if (mat.name.endsWith("_frontMat") || mat.name.endsWith("_backMat")) {
                            (mat as StandardMaterial).specularColor = new Color3(clampedVal, clampedVal, clampedVal);
                        }
                    });
                }
            });
        }

        if (resetViewBtn && this.camera && this.playerBox) {
            resetViewBtn.addEventListener("click", () => {
                this.camera.alpha = Math.PI / 2 - this.playerBox.rotation.y;     
                this.camera.beta = Math.PI / 2.5;     
                this.camera.radius = 10.0;            
            });
        }

        // 【修正】Top View ボタン押下時のカメラアングルを α=90°, β=0° に固定
        if (topViewBtn && this.camera && this.playerBox) {
            topViewBtn.addEventListener("click", () => {
                this.camera.alpha = Math.PI / 2; // 90度
                this.camera.beta = 0;           // 0度 (真上)
                this.camera.radius = this.camera.upperRadiusLimit;
            });
        }

        if (defaultPosBtn && this.playerBox) {
            defaultPosBtn.addEventListener("click", () => {
                this.playerBox.position.set(0, 0, 0);
                this.playerBox.rotation.y = 0;
                this.targetPosition = null;

                this.camera.alpha = Math.PI / 2; 
                this.camera.beta = Math.PI / 4;  
                this.camera.radius = 10.0;       
            });
        }

        const sceneInstrumentation = new SceneInstrumentation(this.scene);
        sceneInstrumentation.captureFrameTime = true;
        
        const engineInstrumentation = new EngineInstrumentation(this.engine);
        engineInstrumentation.captureGPUFrameTime = true;

        let frameCount = 0;
        let lastTexRAM = "0.0 MB";
        let lastGeoRAM = "0.0 MB";

        this.scene.onAfterRenderObservable.add(() => {
            frameCount++;
            
            if (frameCount % 10 !== 0) return;

            if (fv) fv.innerText = this.engine.getFps().toFixed(0);
            
            if (sceneInstrumentation.frameTimeCounter && cv) {
                cv.innerText = sceneInstrumentation.frameTimeCounter.lastSecAverage.toFixed(2);
            }
            
            if (engineInstrumentation.gpuFrameTimeCounter && gv) {
                let gpuTime = engineInstrumentation.gpuFrameTimeCounter.lastSecAverage;
                
                if (gpuTime > 0) {
                    gv.innerText = gpuTime.toFixed(2);
                } else {
                    const currentFps = this.engine.getFps();
                    const frameTime = currentFps > 0 ? 1000 / currentFps : 0; 
                    const cpuTime = sceneInstrumentation.frameTimeCounter ? sceneInstrumentation.frameTimeCounter.lastSecAverage : 0;
                    
                    gpuTime = Math.max(0, frameTime - cpuTime);
                    gv.innerText = `~${gpuTime.toFixed(2)}`; 
                }
            }

            if (sceneInstrumentation.drawCallsCounter && dv) {
                dv.innerText = sceneInstrumentation.drawCallsCounter.current.toString();
            }
            
            const activeMeshes = this.scene.getActiveMeshes();
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
                this.scene.textures.forEach(texture => {
                    const size = texture.getSize();
                    if (size && size.width && size.height) {
                        const multiplier = texture.noMipmap ? 1.0 : 1.33;
                        textureMemoryBytes += size.width * size.height * 4 * multiplier;
                    }
                });
                lastTexRAM = (textureMemoryBytes / (1024 * 1024)).toFixed(1) + " MB";
                
                let geoMemoryBytes = 0;
                this.scene.meshes.forEach(m => {
                    geoMemoryBytes += m.getTotalVertices() * 32;
                    const indices = m.getIndices();
                    if (indices) geoMemoryBytes += indices.length * 4;
                });
                lastGeoRAM = (geoMemoryBytes / (1024 * 1024)).toFixed(1) + " MB";
            }
            if (tv) tv.innerText = lastTexRAM;
            if (geov) geov.innerText = lastGeoRAM;

            const activeIndices = this.scene.getActiveIndices();
            if (iv) iv.innerText = activeIndices.toString();
            if (pv) pv.innerText = Math.floor(activeIndices / 3).toString();

            const activeOcclusionQueries = this.scene.meshes.filter((m: any) => m.isOcclusionQueryInProgress).length;
            if (ov) ov.innerText = activeOcclusionQueries.toString();

            if (playerPosVal && this.playerBox) {
                const pos = this.playerBox.position;
                playerPosVal.innerText = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
            }

            if (camInfoVal && this.camera) {
                const a = (this.camera.alpha * 180 / Math.PI).toFixed(0);
                const b = (this.camera.beta * 180 / Math.PI).toFixed(0);
                const r = this.camera.radius.toFixed(1);
                camInfoVal.innerText = `α:${a}°, β:${b}°, r:${r}`;
            }
        });
    }

    private handleResize(): void {
        this.engine.resize(true);
    }
}