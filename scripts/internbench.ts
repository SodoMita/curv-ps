// Round-15 hash-consing benchmark: warm-frame cost of evaluating examples with the inode
// table ON vs OFF, ALTERNATED IN-PROCESS (cross-process JIT swings ±2x on this sandbox —
// the round-12/14 lesson), best-of-K warm sequences per side.  Also reports the identity
// win the table exists for: codegen-key / params-walk time on trees rebuilt from scratch
// (call memo bypassed via a fresh Interp each frame, so only inode can share identity).
//   npx tsx scripts/internbench.ts [example …]
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, collectParamsFast, resetSolveCache } from "../src/curv/interp";
import { setInterning, internStats, resetInterning, structKey } from "../src/curv/shapes";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";

(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
const want = process.argv.slice(2);
const TRIALS = 6, FRAMES = 8;
interface Row { id: string; on: number; off: number; pipeOn: number; pipeOff: number; hitRatio: string }
const rows: Row[] = [];
for (const ex of EXAMPLES.filter((e) => !want.length || want.includes(e.id))) {
  const run = (t: number) => new Interp(atlas, { viewport: { x: -450, y: -300, w: 900, h: 600 }, time: t, mouse: { x: 12, y: 8, down: false } }).run(ex.src);
  // one warm sequence of FRAMES frames (varied time so animated programs rebuild for real);
  // returns eval ms + pipeline ms (structKey + params walk of the final frame)
  const seq = (): [number, number] => {
    let ms = 0;
    const t0 = performance.now();
    let last: ReturnType<typeof run> | null = null;
    for (let f = 0; f < FRAMES; f++) last = run(0.5 + f * 0.4);
    ms = performance.now() - t0;
    let pipe = 0;
    if (last?.shape) {
      const p0 = performance.now(); structKey(last.shape, atlas); collectParamsFast(last.shape, atlas); pipe = performance.now() - p0;
    }
    return [ms, pipe];
  };
  let hits = 0, stores = 0;
  const side = (on: boolean): [number, number] => {
    const hh = internStats.hits, ss = internStats.stores;
    setInterning(on); resetSolveCache(); if (!on) resetInterning(); // fair OFF: table must not flatter the other side
    let best: [number, number] = [Infinity, Infinity];
    for (let k = 0; k < TRIALS; k++) { const [e, p] = seq(); best = [Math.min(best[0], e), Math.min(best[1], p)]; }
    if (on) { hits += internStats.hits - hh; stores += internStats.stores - ss; }
    return best;
  };
  let on: [number, number] = [Infinity, Infinity], off: [number, number] = [Infinity, Infinity];
  for (let k = 0; k < 2; k++) { // interleave sides, best across interleavings
    const a = side(true), b = side(false);
    on = [Math.min(on[0], a[0]), Math.min(on[1], a[1])];
    off = [Math.min(off[0], b[0]), Math.min(off[1], b[1])];
  }
  rows.push({ id: ex.id, on: on[0], off: off[0], pipeOn: on[1], pipeOff: off[1], hitRatio: hits + stores === 0 ? "-" : `${hits}/${hits + stores}` });
}
setInterning(false); // leave the global in its production state
console.log("example        eval off → on (8 frames)   key+walk off → on    intern hits");
let tOn = 0, tOff = 0;
for (const r of rows) {
  tOn += r.on; tOff += r.off;
  const fmt = (v: number) => v < 0.005 ? "0" : v.toFixed(2);
  console.log(`${r.id.padEnd(14)} ${fmt(r.off).padStart(6)} → ${fmt(r.on).padStart(6)} ms  ${(r.off / Math.max(1e-9, r.on)).toFixed(2)}x   ${fmt(r.pipeOff).padStart(6)} → ${fmt(r.pipeOn).padStart(6)} ms  ${(r.pipeOff / Math.max(1e-9, r.pipeOn)).toFixed(1)}x   ${r.hitRatio}`);
}
console.log(`TOTAL          ${tOff.toFixed(2).padStart(6)} → ${tOn.toFixed(2).padStart(6)} ms  ${(tOff / Math.max(1e-9, tOn)).toFixed(2)}x`);
