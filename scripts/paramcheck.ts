// Verifies the fast path: for every example, the ParamsOnly backend must produce exactly the
// same parameter buffer as full codegen, and the structural key must be stable across
// time / viewport / mouse changes (so animated programs really skip codegen).
//   npx tsx scripts/paramcheck.ts
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, collectParams, collectParamsFast, resetSolveCache, blockCacheStats } from "../src/curv/interp";
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
    resetSolveCache();
    const a = run(0.5, 900), b = run(1.7, 700);
    if (!a.shape || !b.shape) { console.log(`--  ${ex.id}: no shape`); continue; }
    // solve-block memoisation oracle: a warm re-evaluation (block cache hit) and an evaluation after a
    // change of time / viewport must both produce exactly the buffer a cold evaluation produces
    const bWarm = run(1.7, 700), aWarm = run(0.5, 900);
    resetSolveCache(); const aCold = run(0.5, 900); resetSolveCache(); const bCold = run(1.7, 700);
    const eqP = (x: Float32Array, y: Float32Array) => x.length === y.length && x.every((v, i) => v === y[i]);
    const maxΔ = (x: Float32Array, y: Float32Array) => { let d = x.length === y.length ? 0 : Infinity; for (let i = 0; i < Math.min(x.length, y.length); i++) d = Math.max(d, Math.abs(x[i] - y[i])); return d; };
    // Memo REPLAY integrity stays a bitwise property (a replay rebuilds from the stored result):
    const replaySame = eqP(collectParams(b.shape, atlas), collectParams(bWarm.shape!, atlas)) && eqP(collectParams(a.shape, atlas), collectParams(aWarm.shape!, atlas));
    // Warm-start tolerance: a warm-started solve may round differently from a cold one (same optimum,
    // different solve path).  Compare memo/cold within 1e-6 — far below a pixel; replay stays bitwise.
    const warmΔ = Math.max(maxΔ(collectParams(b.shape, atlas), collectParams(bCold.shape!, atlas)), maxΔ(collectParams(aWarm.shape!, atlas), collectParams(aCold.shape!, atlas)));
    const memoSame = replaySame && warmΔ <= 1e-6;
    const memo = a.traces.length === 0 ? "n/a" : bWarm.traces.every((t) => t.cacheKind === "block") ? "block" : bWarm.traces.some((t) => t.cached) ? "problem" : `none${blockCacheStats.lastReason ? ` (${blockCacheStats.lastReason})` : ""}`;
    const full = compileTree(a.shape, atlas, "wgsl");
    const fast = collectParams(a.shape, atlas);
    let same = full.params.length === fast.length;
    for (let i = 0; same && i < fast.length; i++) if (full.params[i] !== fast[i]) same = false;
    const walk = collectParamsFast(a.shape, atlas); // dedicated tree walk must match the generic backend exactly
    let walkSame = walk.length === fast.length;
    for (let i = 0; walkSame && i < walk.length; i++) if (walk[i] !== fast[i]) walkSame = false;
    same = same && walkSame;
    const ka = structKey(a.shape, atlas), kb = structKey(b.shape, atlas);
    const second = compileTree(b.shape, atlas, "wgsl", full);
    const fullB = compileTree(b.shape, atlas, "wgsl");
    const codeSame = second.code === fullB.code && second.d === fullB.d && second.c === fullB.c;
    let paramsB = fullB.params.length === second.params.length;
    for (let i = 0; paramsB && i < fullB.params.length; i++) if (fullB.params[i] !== second.params[i]) paramsB = false;
    // timing: full codegen vs params-only, warm
    let tf = 0, tp = 0, tw = 0; const N = 15;
    for (let i = 0; i < N; i++) { const t0 = performance.now(); compileTree(a.shape, atlas, "wgsl"); const t1 = performance.now(); collectParams(a.shape, atlas); const t2 = performance.now(); collectParamsFast(a.shape, atlas); tw += performance.now() - t2; tp += t2 - t1; tf += t1 - t0; }
    const ok = same && codeSame && paramsB && memoSame;
    if (!ok) fails++;
    // App static-frame skip oracle: a program that read no time/mouse/viewport must produce the identical
    // key and parameter buffer for any time/mouse/viewport — exactly the inputs the App varies between frames.
    const isStatic = !a.usesTime && !a.usesMouse && !a.usesViewport && !b.usesTime && !b.usesMouse && !b.usesViewport;
    let staticOk = true;
    if (isStatic) { staticOk = ka === kb && eqP(collectParams(a.shape, atlas), collectParams(b.shape, atlas)); if (!staticOk) fails++; }
    console.log(`${ok && staticOk ? "OK " : "ERR"} ${ex.id.padEnd(14)} params=${full.params.length} sameParams=${same}${walkSame ? "" : " (WALK DIFFERS)"} key=${ka === null ? "none (custom)" : ka === kb ? "stable" : "CHANGED"} reused=${second.reused} codeSame=${codeSame} paramsB=${paramsB} memo=${memo}${memoSame ? (warmΔ > 0 ? ` (warmΔ=${warmΔ.toExponential(1)})` : "") : ` MISMATCH${replaySame ? "" : " REPLAY"} (warmΔ=${Number.isFinite(warmΔ) ? warmΔ.toExponential(1) : "len"})`} skip=${isStatic ? (staticOk ? "safe" : "NOT SAFE") : "-"}  codegen ${(tf / N).toFixed(2)}ms → params-only ${(tp / N).toFixed(2)}ms → walk ${(tw / N).toFixed(2)}ms`);
  } catch (e: any) { fails++; console.log(`ERR ${ex.id}: ${e.message}`); }
}
if (fails) process.exitCode = 1;
