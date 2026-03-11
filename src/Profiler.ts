/** ブラウザサイド関数プロファイラ（サーバ側 prof() と同じパターン） */

interface FuncProfile {
    calls: number;
    totalUs: number;
    maxUs: number;
}

let enabled = false;
const data = new Map<string, FuncProfile>();

/** プロファイル ON/OFF */
export function profEnabled(): boolean { return enabled; }
export function profSetEnabled(on: boolean) { enabled = on; }

/** データリセット */
export function profReset() { data.clear(); }

/** 計測開始。返り値を関数末尾で呼ぶ。
 *  使い方: const _end = prof("funcName"); ... _end();
 *  OFF 時はほぼゼロコスト（空関数を返す） */
const noop = () => {};
export function prof(name: string): () => void {
    if (!enabled) return noop;
    const t0 = performance.now();
    return () => {
        const us = (performance.now() - t0) * 1000; // ms→μs
        let p = data.get(name);
        if (!p) { p = { calls: 0, totalUs: 0, maxUs: 0 }; data.set(name, p); }
        p.calls++;
        p.totalUs += us;
        if (us > p.maxUs) p.maxUs = us;
    };
}

/** 全関数のプロファイルデータ取得（totalMs 降順ソート済み） */
export function profDump(): { name: string; calls: number; totalMs: number; avgUs: number; maxUs: number }[] {
    const result: { name: string; calls: number; totalMs: number; avgUs: number; maxUs: number }[] = [];
    for (const [name, p] of data) {
        result.push({
            name,
            calls: p.calls,
            totalMs: p.totalUs / 1000,
            avgUs: p.calls > 0 ? p.totalUs / p.calls : 0,
            maxUs: p.maxUs,
        });
    }
    return result.sort((a, b) => b.totalMs - a.totalMs);
}
