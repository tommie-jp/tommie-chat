import { GameScene } from "./GameScene";

declare const APP_VERSION: string;
declare const APP_DATE: string;

// console.log / warn / error に時刻プレフィックスを付与
for (const method of ["log", "warn", "error"] as const) {
    const orig = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
        const now = new Date();
        const ts = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
        orig(ts, ...args);
    };
}

console.log(`tommieChat v${APP_VERSION} (${APP_DATE})`);

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
if (canvas) {
    const game = new GameScene(canvas);

    // ブラウザコンソールからプロファイル操作:
    //   profileStart()  — 計測開始（DevTools Timings に mark/measure 出力）
    //   profileStop()   — 計測停止
    //   profileDump()   — 収集済みデータのサマリをコンソール出力
    const w = window as unknown as Record<string, unknown>;
    w.profileStart = () => { game.profiling = true; game['_profileHistory'].length = 0; console.log('[Profile] started'); };
    w.profileStop = () => { game.profiling = false; console.log(`[Profile] stopped — ${game['_profileHistory'].length} frames captured`); };
    w.profileDump = () => {
        type PH = { playerMove: number; remoteAvatars: number; npc: number; total: number; avatarCount: number };
        const h = game['_profileHistory'] as PH[];
        if (h.length === 0) { console.log('[Profile] no data — run profileStart() first'); return; }
        const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
        const p95 = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]; };
        const max = (arr: number[]) => Math.max(...arr);
        const fields = ['playerMove', 'remoteAvatars', 'npc', 'total'] as const;
        const rows: { name: string; avg: string; p95: string; max: string }[] = fields.map(f => ({
            name: f,
            avg: avg(h.map(r => r[f])).toFixed(3) + 'ms',
            p95: p95(h.map(r => r[f])).toFixed(3) + 'ms',
            max: max(h.map(r => r[f])).toFixed(3) + 'ms',
        }));
        rows.push({ name: 'avatarCount', avg: avg(h.map(r => r.avatarCount)).toFixed(0), p95: '-', max: max(h.map(r => r.avatarCount)).toFixed(0) });
        console.log(`[Profile] ${h.length} frames`);
        console.table(rows);
        const md = game.nakama.matchDataProfile;
        console.log(`[Profile] onmatchdata: ${md.calls} calls/s, total=${md.totalMs.toFixed(1)}ms/s, max=${md.maxMs.toFixed(2)}ms`);
        const ul = game.userListProfile;
        console.log(`[Profile] userList: ${ul.calls} renders/s, total=${ul.totalMs.toFixed(1)}ms/s, max=${ul.maxMs.toFixed(2)}ms, users=${ul.userCount}`);
    };
} else {
    console.error("Canvas element 'renderCanvas' not found!");
}