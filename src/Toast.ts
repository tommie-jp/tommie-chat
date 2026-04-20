/**
 * 吹き出しトースト通知
 *
 * 仕様: doc/20-仕様書.md ⭐️トースト（吹き出し）
 *   - 画面右下端（送信ボタンの少し上あたり）に表示
 *   - ソフトキーボード表示中も送信ボタンに追従（window.visualViewport）
 *   - 時間が経過すると消える：10秒（デフォルト）
 *   - タップで onTap コールバック（任意）
 *
 * 汎用コンポーネント: オセロ参加通知 / DM / いいね / フレンド申請 で共通使用予定
 */

export interface ToastOptions {
    text: string;
    durationMs?: number;
    onTap?: () => void;
}

const DEFAULT_DURATION_MS = 10000;
const BASE_BOTTOM_PX = 60; // 送信ボタンの少し上
const NOTIF_SOUND_URL = "/sounds/notification.mp3";
const NOTIF_SOUND_VOLUME = 0.5;

let container: HTMLDivElement | null = null;
let viewportListenerAttached = false;

// 通知音: 旧 iPad Safari は HTMLAudioElement の非 gesture 再生が不安定なので
// WebAudio の AudioBuffer にデコードしておき、必要時に BufferSourceNode で再生する。
let notifAudioCtx: AudioContext | null = null;
let notifBuffer: AudioBuffer | null = null;
let notifLoadPromise: Promise<void> | null = null;
// フォールバック（WebAudio 不可の環境）
let notifAudioEl: HTMLAudioElement | null = null;

function isNotifSoundEnabled(): boolean {
    const m = document.cookie.match(/(?:^|; )notifSound=([^;]*)/);
    const v = m ? decodeURIComponent(m[1]) : "on";
    return v !== "off";
}

function ensureNotifCtx(): AudioContext | null {
    if (notifAudioCtx) return notifAudioCtx;
    try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        notifAudioCtx = new Ctor();
    } catch (e) {
        console.warn("ensureNotifCtx failed:", e);
        notifAudioCtx = null;
    }
    return notifAudioCtx;
}

function loadNotifBuffer(): Promise<void> {
    if (notifLoadPromise) return notifLoadPromise;
    const ctx = ensureNotifCtx();
    if (!ctx) return Promise.resolve();
    notifLoadPromise = fetch(NOTIF_SOUND_URL)
        .then(r => r.arrayBuffer())
        .then(ab => ctx.decodeAudioData(ab))
        .then(buf => { notifBuffer = buf; })
        .catch(e => { console.warn("loadNotifBuffer failed:", e); notifLoadPromise = null; });
    return notifLoadPromise;
}

/** user gesture 内で呼び出して AudioContext を解禁 + mp3 をプリロード */
export function primeNotificationSound(): void {
    const ctx = ensureNotifCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") {
        ctx.resume().catch(e => console.warn("notifAudioCtx.resume failed:", e));
    }
    loadNotifBuffer();
    // HTMLAudio フォールバックも同じ gesture で解禁（WebAudio decode が失敗する環境用）
    if (!notifAudioEl) {
        try {
            notifAudioEl = new Audio(NOTIF_SOUND_URL);
            notifAudioEl.volume = NOTIF_SOUND_VOLUME;
            (notifAudioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
            notifAudioEl.preload = "auto";
            notifAudioEl.load();
        } catch (e) { console.warn("notifAudioEl init failed:", e); }
    }
    if (notifAudioEl) {
        const prev = notifAudioEl.volume;
        notifAudioEl.volume = 0;
        notifAudioEl.play().then(() => {
            notifAudioEl!.pause();
            notifAudioEl!.currentTime = 0;
            notifAudioEl!.volume = prev;
        }).catch(e => {
            if (notifAudioEl) notifAudioEl.volume = prev;
            // NotAllowedError は user gesture 前の期待される状態なので抑制する
            if ((e as Error)?.name === "NotAllowedError") return;
            console.warn("notifAudioEl prime failed:", e);
        });
    }
}

function playNotificationSound(): void {
    if (!isNotifSoundEnabled()) return;
    const ctx = notifAudioCtx;
    // WebAudio 経路（推奨）
    if (ctx && notifBuffer) {
        try {
            if (ctx.state === "suspended") ctx.resume().catch(() => {});
            const src = ctx.createBufferSource();
            const gain = ctx.createGain();
            gain.gain.value = NOTIF_SOUND_VOLUME;
            src.buffer = notifBuffer;
            src.connect(gain);
            gain.connect(ctx.destination);
            src.start(0);
            return;
        } catch (e) {
            console.warn("WebAudio notif play failed, fallback to Audio element:", e);
        }
    }
    // HTMLAudio フォールバック
    if (notifAudioEl) {
        try {
            notifAudioEl.currentTime = 0;
            notifAudioEl.play().catch(e => console.warn("notifAudioEl play failed:", e));
        } catch (e) {
            console.warn("notifAudioEl play exception:", e);
        }
    }
}

function ensureContainer(): HTMLDivElement {
    if (container) return container;
    const el = document.createElement("div");
    el.id = "toast-container";
    el.style.cssText = `
        position: fixed;
        right: 8px;
        bottom: ${BASE_BOTTOM_PX}px;
        z-index: 10000;
        display: flex;
        flex-direction: column-reverse;
        gap: 6px;
        pointer-events: none;
        max-width: min(380px, calc(100vw - 16px));
    `;
    document.body.appendChild(el);
    container = el;

    // visualViewport でソフトキーボード表示時に追従
    if (!viewportListenerAttached && window.visualViewport) {
        const updateBottom = () => {
            if (!container) return;
            const vv = window.visualViewport!;
            const kbOffset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            container.style.bottom = `${BASE_BOTTOM_PX + kbOffset}px`;
        };
        window.visualViewport.addEventListener("resize", updateBottom);
        window.visualViewport.addEventListener("scroll", updateBottom);
        viewportListenerAttached = true;
    }

    return el;
}

/**
 * 画面中央にダイアログを一定時間表示する。
 * - タップで即消し
 * - durationMs 経過で自動消失（デフォルト 5 秒）
 */
export function showCenterDialog(text: string, durationMs: number = 5000): void {
    const overlay = document.createElement("div");
    overlay.className = "center-dialog-overlay";

    const box = document.createElement("div");
    box.className = "center-dialog-box";
    box.textContent = text;

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        box.classList.remove("show");
        setTimeout(() => { overlay.remove(); }, 200);
    };
    overlay.addEventListener("click", dismiss);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => { box.classList.add("show"); });

    setTimeout(dismiss, durationMs);
}

export function showToast(opts: ToastOptions): void {
    const root = ensureContainer();
    const duration = opts.durationMs ?? DEFAULT_DURATION_MS;

    const el = document.createElement("div");
    el.className = "toast-bubble";
    el.style.cssText = `
        background: rgba(0, 118, 215, 0.92);
        color: #fff;
        padding: 10px 14px;
        border-radius: 14px;
        font-size: 14px;
        line-height: 1.4;
        box-shadow: 0 2px 8px rgba(0,0,0,0.35);
        pointer-events: auto;
        cursor: ${opts.onTap ? "pointer" : "default"};
        word-break: break-word;
        max-width: 100%;
        opacity: 0;
        transform: translateY(8px);
        transition: opacity 0.18s ease-out, transform 0.18s ease-out;
    `;
    el.textContent = opts.text;

    let dismissed = false;
    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        el.style.opacity = "0";
        el.style.transform = "translateY(8px)";
        setTimeout(() => { el.remove(); }, 200);
    };

    if (opts.onTap) {
        el.addEventListener("click", () => { opts.onTap?.(); dismiss(); });
    }

    root.appendChild(el);
    requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
    });

    playNotificationSound();

    setTimeout(dismiss, duration);
}
