/**
 * 吹き出しトースト通知
 *
 * 仕様: doc/20-仕様書.md ⭐️トースト（吹き出し）
 *   - 画面右下端（送信ボタンの少し上あたり）に表示
 *   - ソフトキーボード表示中も送信ボタンに追従（window.visualViewport）
 *   - 時間が経過すると消える：５秒（デフォルト）
 *   - タップで onTap コールバック（任意）
 *
 * 汎用コンポーネント: オセロ参加通知 / DM / いいね / フレンド申請 で共通使用予定
 */

export interface ToastOptions {
    text: string;
    durationMs?: number;
    onTap?: () => void;
}

const DEFAULT_DURATION_MS = 5000;
const BASE_BOTTOM_PX = 60; // 送信ボタンの少し上

let container: HTMLDivElement | null = null;
let viewportListenerAttached = false;

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

    setTimeout(dismiss, duration);
}
