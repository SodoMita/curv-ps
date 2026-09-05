import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, blockCacheStats, callMemoTable, resetSolveCache } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
(globalThis as any).document = { createElement: (t: string) => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
for (const id of ["dashboard", "chart", "split", "stacks", "toolbar"]) {
  const ex = EXAMPLES.find((e) => e.id === id)!;
  resetSolveCache();
  let te = 0, tg = 0, tp = 0, N = 30, cachedInfo = "", memoInfo = ""; let prev: ReturnType<typeof compileTree> | null = null;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const it = new Interp(atlas, { viewport: { x: -450, y: -300, w: 900, h: 600 }, time: i * 0.1, mouse: { x: 300, y: 200, down: false } });
    const r = it.run(ex.src);
    const t1 = performance.now();
    if (i === N - 1) cachedInfo = r.traces.map((t) => (t.cached ? `solve cached(${t.cacheKind})` : `solve ${t.engine}`)).join(", ") + (blockCacheStats.lastReason ? ` [not memoisable: ${blockCacheStats.lastReason}]` : "");
    if (i === N - 1) { const m = r.callMemo; memoInfo = `calls: ${m.hits} hit / ${m.misses} miss / ${m.measured} measured / ${m.skipped} skipped, hashing ${m.hashMs.toFixed(2)}ms`; }
    compileTree(r.shape!, atlas, "wgsl");
    const t2 = performance.now();
    prev = compileTree(r.shape!, atlas, "wgsl", prev); // fast path (structural key hit after the first frame)
    const t3 = performance.now();
    if (i >= 10) { te += t1 - t0; tg += t2 - t1; tp += t3 - t2; }
  }
  console.log(id, "eval", (te / 20).toFixed(2), "codegen", (tg / 20).toFixed(2), "params-only", (tp / 20).toFixed(2), prev!.reused ? "(reused)" : "(NOT reused)", cachedInfo, "|", memoInfo);
  if (process.argv.includes("-v")) for (const r of callMemoTable().filter((r) => r.calls > 0).sort((a, b) => b.avgMs * b.calls - a.avgMs * a.calls).slice(0, 12)) console.log("   ", r.mode.padEnd(7), r.name.padEnd(16), "calls", String(r.calls).padStart(5), "avg", (r.avgMs * 1000).toFixed(0).padStart(5), "µs", r.entries ? `entries ${r.entries}` : "", r.why ?? "");
}
