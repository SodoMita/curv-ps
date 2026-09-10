// Round-16 expression-memo benchmark: full-eval cost with the expression memo ON vs OFF,
// alternated in-process, best-of-K warm sequences (cross-process JIT swings >2x on this
// sandbox — the round-12/14 lesson).  The memo's value: per-frame hashing collapses from
// one hash per call/list item to one per expensive assembly site.
//   npx tsx scripts/exprbench.ts [example …]
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, resetSolveCache, setExprMemo } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
const want = process.argv.slice(2);
const TRIALS = 6, FRAMES = 8;
let tOn = 0, tOff = 0;
console.log("example        eval off → on (8 frames)");
for (const ex of EXAMPLES.filter((e) => !want.length || want.includes(e.id))) {
  const run = (t: number) => new Interp(atlas, { viewport: { x: -450, y: -300, w: 900, h: 600 }, time: t, mouse: { x: 12, y: 8, down: false } }).run(ex.src);
  const side = (on: boolean): number => {
    setExprMemo(on); resetSolveCache();
    let best = Infinity;
    for (let k = 0; k < TRIALS; k++) {
      const t0 = performance.now();
      for (let f = 0; f < FRAMES; f++) run(0.5 + f * 0.4);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };
  let on = Infinity, off = Infinity;
  for (let k = 0; k < 2; k++) { on = Math.min(on, side(true)); off = Math.min(off, side(false)); }
  tOn += on; tOff += off;
  console.log(`${ex.id.padEnd(14)} ${off.toFixed(2).padStart(6)} → ${on.toFixed(2).padStart(6)} ms  ${(off / Math.max(1e-9, on)).toFixed(2)}x`);
}
setExprMemo(true);
console.log(`TOTAL          ${tOff.toFixed(2).padStart(6)} → ${tOn.toFixed(2).padStart(6)} ms  ${(tOff / Math.max(1e-9, tOn)).toFixed(2)}x`);
