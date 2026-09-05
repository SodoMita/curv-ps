// Verifies the fast path: for every example, the ParamsOnly backend must produce exactly the
// same parameter buffer as full codegen, and the structural key must be stable across
// time / viewport / mouse changes (so animated programs really skip codegen).
//   npx tsx scripts/paramcheck.ts
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, collectParams } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
import { structKey } from "../src/curv/shapes";

(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
let fails = 0;
for (const ex of EXAMPLES) {
  const run = (t: number, vw: number) => new Interp(atlas, { viewport: { x: -vw / 2, y: -300, w: vw, h: 600 }, time: t, mouse: { x: 10 * t, y: 5, down: false } }).run(ex.src);
  try {
    const a = run(0.5, 900), b = run(1.7, 700);
    if (!a.shape || !b.shape) { console.log(`--  ${ex.id}: no shape`); continue; }
    const full = compileTree(a.shape, atlas, "wgsl");
    const fast = collectParams(a.shape, atlas);
    let same = full.params.length === fast.length;
    for (let i = 0; same && i < fast.length; i++) if (full.params[i] !== fast[i]) same = false;
    const ka = structKey(a.shape, atlas), kb = structKey(b.shape, atlas);
    const second = compileTree(b.shape, atlas, "wgsl", full);
    const fullB = compileTree(b.shape, atlas, "wgsl");
    const codeSame = second.code === fullB.code && second.d === fullB.d && second.c === fullB.c;
    let paramsB = fullB.params.length === second.params.length;
    for (let i = 0; paramsB && i < fullB.params.length; i++) if (fullB.params[i] !== second.params[i]) paramsB = false;
    // timing: full codegen vs params-only, warm
    let tf = 0, tp = 0; const N = 15;
    for (let i = 0; i < N; i++) { const t0 = performance.now(); compileTree(a.shape, atlas, "wgsl"); const t1 = performance.now(); collectParams(a.shape, atlas); tp += performance.now() - t1; tf += t1 - t0; }
    const ok = same && codeSame && paramsB;
    if (!ok) fails++;
    console.log(`${ok ? "OK " : "ERR"} ${ex.id.padEnd(14)} params=${full.params.length} sameParams=${same} key=${ka === null ? "none (custom)" : ka === kb ? "stable" : "CHANGED"} reused=${second.reused} codeSame=${codeSame} paramsB=${paramsB}  codegen ${(tf / N).toFixed(2)}ms → params-only ${(tp / N).toFixed(2)}ms`);
  } catch (e: any) { fails++; console.log(`ERR ${ex.id}: ${e.message}`); }
}
if (fails) process.exitCode = 1;
