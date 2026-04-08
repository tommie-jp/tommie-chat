/** HTML特殊文字をエスケープして XSS を防止する */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/** CSS色コードとして安全か検証する（不正な値は空文字を返す） */
export function sanitizeColor(c: string): string {
    return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "";
}
