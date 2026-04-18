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

/**
 * デフォルトアバターの URL（public/avatars/ 配下、dist/ に同梱配信）。
 * MinIO (/s3/) が落ちていてもフォールバックできるよう静的配信にする。
 * 詳細: doc/07-MinIO-アセットストレージ.md の「判断基準」節
 */
export const DEFAULT_AVATAR_URL = "/avatars/001-pipo-nekonin008.png";

/**
 * アバターテクスチャ URL として有効か判定する（受信値のバリデーション）。
 * サーバ側 sanitizeTextureUrl と同じ許可リスト（/avatars/ と /s3/avatars/）。
 */
export function isAvatarUrl(s: string | undefined | null): s is string {
    return typeof s === "string" && (s.startsWith("/avatars/") || s.startsWith("/s3/avatars/"));
}

/** 受信した textureUrl が不正ならデフォルトに差し替えて返す */
export function resolveAvatarUrl(s: string | undefined | null): string {
    return isAvatarUrl(s) ? s : DEFAULT_AVATAR_URL;
}

/**
 * デフォルトアバター一覧をフェッチする（/avatars/manifest.json、doStatic-set-avatars.sh が生成）。
 * 返り値は `/avatars/NNN-xxx.png` 形式の URL 配列（ファイル名昇順）。
 */
export async function fetchAvatarList(): Promise<string[]> {
    const res = await fetch("/avatars/manifest.json");
    if (!res.ok) throw new Error(`/avatars/manifest.json HTTP ${res.status}`);
    const json = await res.json() as { files?: string[] };
    const files = Array.isArray(json.files) ? json.files : [];
    return files
        .filter(n => typeof n === "string" && /\.(png|jpg|jpeg)$/i.test(n))
        .map(n => "/avatars/" + n);
}
