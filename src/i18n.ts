import { ja } from "./i18n/ja";
import { en } from "./i18n/en";

export type Lang = "ja" | "en";
export type MessageKey = keyof typeof ja;

const messages: Record<Lang, Record<MessageKey, string>> = { ja, en };

let currentLang: Lang = detectLang();

function detectLang(): Lang {
    const saved = localStorage.getItem("lang");
    if (saved === "ja" || saved === "en") return saved;
    return navigator.language.startsWith("ja") ? "ja" : "en";
}

/** 翻訳テキスト取得 */
export function t(key: MessageKey): string {
    return messages[currentLang][key] ?? messages.ja[key] ?? key;
}

/** 現在の言語を取得 */
export function getLang(): Lang { return currentLang; }

/** 言語を切り替え・保存 */
export function setLang(lang: Lang): void {
    currentLang = lang;
    localStorage.setItem("lang", lang);
}

/** HTML内の data-i18n 属性を持つ要素を一括翻訳 */
export function applyI18n(): void {
    document.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => {
        const key = el.dataset.i18n as MessageKey;
        if (key in messages[currentLang]) el.textContent = t(key);
    });
    document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach(el => {
        const key = el.dataset.i18nPlaceholder as MessageKey;
        if (key in messages[currentLang]) (el as HTMLInputElement | HTMLTextAreaElement).placeholder = t(key);
    });
}
