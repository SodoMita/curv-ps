// Warm-start benchmark (round 14): chained solves (warmCache live) vs per-frame cold solves of the
// SAME fingerprint sequence, interleaved best-of-K to suppress JIT noise (the round-12 lesson:
// first-run effects masquerade as multi-x differences between identical code).
//   npx tsx scripts/warmbench.ts [example …]
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, resetSolveCache } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
const want = process.argv.slice(2);
const WIDTHS = [900, 860, 820, 780, 740, 700]; // a 40px/frame resize-drag
const TRIALS = 4;
for (const ex of EXAMPLES.filter((e) => e.group === "solve" && (!want.length || want.includes(e.id)))) {
  const run = (vw: number, k: number) => new Interp(atlas, { viewport: { x: -vw / 2, y: -300, w: vw, h: 600 }, time: 0.5 + k * 0.2, mouse: { x: 10, y: 5, down: false } }).run(ex.src);
  const t = (fn: (k: number) => number) => {
    let best = Infinity;
    for (let r = 0; r < TRIALS; r++) best = Math.min(best, WIDTHS.reduce((s, w, k) => s + fn(k), 0));
    return best;
  };
  // chained: caches persist, warm starts from the previous frame
  let warm = 0, retry = 0;
  const chained = t((k) => {
    resetSolveCache();
    let ms = 0;
    for (let j = 0; j <= k; j++) { const r = run(WIDTHS[j], j); if (j === k) for (const tr of r.traces) if (!tr.cached) { ms += tr.timeMs; if (tr.warm) warm++; if (tr.warmRetry) retry++; } }
    return ms;
  });
  // cold: every frame from a cleared cache
  const cold = t((k) => {
    resetSolveCache();
    const r = run(WIDTHS[k], k);
    let ms = 0; for (const tr of r.traces) if (!tr.cached) ms += tr.timeMs;
    return ms;
  });
  const widths = WIDTHS.length;
  console.log(`${ex.id.padEnd(10)} cold ${(cold / widths).toFixed(3)}ms/frame → chained ${(chained / widths).toFixed(3)}ms/frame  (${(cold / Math.max(1e-9, chained)).toFixed(1)}x, warm accepted ${Math.round(warm / (TRIALS))}/${widths - 1}, cold retries ${Math.round(retry / TRIALS)})`);
}
