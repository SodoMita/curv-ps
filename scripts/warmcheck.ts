// Round-14 oracle for the psolve bridge upgrade (upstream main@05f9411, bridge ABI 3):
// warm starts (CURV_PS_PLAN P0.2), certified infeasibility (P0.1), wall-clock budgets (P0.3),
// and the failure-degradation rule (§6.2: never throw when a previous good layout exists).
//   npx tsx scripts/warmcheck.ts
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, resetSolveCache, collectParams } from "../src/curv/interp";
import { Problem, Lin, Quad } from "../src/psolve/constraints";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";

(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
let fails = 0;
const fail = (m: string) => { fails++; console.log("  FAIL " + m); };
const ok = (m: string) => console.log("  ok   " + m);

const solveExamples = EXAMPLES.filter((e) => e.group === "solve");
const runSrc = (src: string, vw: number, t: number, params?: Record<string, number | boolean | number[]>) =>
  new Interp(atlas, { viewport: { x: -vw / 2, y: -300, w: vw, h: 600 }, time: t, mouse: { x: 10, y: 5, down: false }, params }).run(src);

// ---------------------------------------------------------------- 1. drag equivalence
// Drag the viewport through 8 steps (fingerprints change every frame -> real solves, warm-started
// after frame 1), then solve the LAST frame's problems cold.  The layouts must agree: pixel-level
// identity is the acceptance bar of P0.2 (|Δ| far below a pixel, and each warm solve must be
// feasible, i.e. no hard-constraint violations).
console.log("[1] drag equivalence: warm sequence vs per-frame cold solves");
let warmAccepted = 0, warmIters = 0, coldIters = 0;
for (const ex of solveExamples) {
  resetSolveCache();
  const frames: { vw: number; res: ReturnType<typeof runSrc> }[] = [];
  [900, 848, 796, 760, 732, 716, 706, 700].forEach((vw, i) => frames.push({ vw, res: runSrc(ex.src, vw, 0.5 + i * 0.2) }));
  const warmT = frames[frames.length - 1].res.traces;
  const warmFrame = frames[frames.length - 1].res;
  frames.forEach((f) => f.res.traces.forEach((t) => { if (t.warm) { warmAccepted++; warmIters += t.iterations; } }));
  if (!warmFrame.shape) continue;
  const pWarm = collectParams(warmFrame.shape, atlas);
  resetSolveCache();
  const cold = runSrc(ex.src, 700, 0.5 + 7 * 0.2);
  cold.traces.forEach((t) => { if (!t.cached) coldIters += t.iterations; });
  const pCold = collectParams(cold.shape!, atlas);
  let maxd = 0, nd = 0;
  if (pWarm.length !== pCold.length) { fail(`${ex.id}: param length ${pWarm.length} != ${pCold.length}`); continue; }
  for (let i = 0; i < pWarm.length; i++) { const d = Math.abs(pWarm[i] - pCold[i]); if (d > 0) nd++; if (d > maxd) maxd = d; }
  const viol = warmT.reduce((s, t) => s + t.violations.length, 0) + frames.slice(0, -1).reduce((s, f) => s + f.res.traces.reduce((q, t) => q + t.violations.length, 0), 0);
  const bar = 1e-6; // way below a pixel; pure solve-path rounding
  if (maxd > bar) fail(`${ex.id}: warm/cold layout maxΔ=${maxd} over ${nd} floats (bar ${bar})`);
  else ok(`${ex.id.padEnd(12)} maxΔ=${maxd === 0 ? "0 (bitwise)" : maxd.toExponential(1) + ` (${nd}/${pWarm.length} floats)`}${viol ? ` violations=${viol}` : ""}`);
  if (viol > 0) fail(`${ex.id}: ${viol} hard-constraint violations in warm sequence`);
}
// speed: total iterations across all warm-accepted solves vs their cold counterparts is the
// deterministic proxy for the 23–35x wall-clock win of P0.2 (fewer Phase-I iterations)
console.log(`  warm starts accepted: ${warmAccepted}; iterations warm=${warmIters} vs cold=${coldIters} (${coldIters > 0 ? (warmIters / coldIters).toFixed(2) : "?"}x)`);

// -------------------------------------------------- 2. degradation / recovery across frames
console.log("[2] failure degradation: a failed frame reuses the last good layout, then recovers");
const brutal = `parametric
    Ctx :: slider[-1000,1000] = 200;
    Brk :: slider[0,1] = 0;
in
let
  L = solve {
    var x : num; var lo : num;
    x == Ctx; lo == x - 40;
    if (Brk > 0.5) (x >= Ctx + 10);   // required, and contradicts x == Ctx
  };
in union [ circle 18 >> translate (L.x, 0) >> colour (sRGB [0.8, 0.2, 0.3]), circle 6 >> translate (L.lo, 0) ]`;
resetSolveCache();
const dragIn = (ctx: number, brk: number) => ({ "Ctx": ctx, "Brk": brk });
const f1 = runSrc(brutal, 900, 1.0, dragIn(200, 0));
const v1 = f1.traces[0].values.map((v) => v.value).join(";");
if (!f1.traces[0].ok || f1.traces[0].degraded) fail(`frame1 not a clean solve: ${f1.traces[0].status}`);
// break it: same block astId, new fingerprint, infeasible by construction
const f2 = runSrc(brutal, 900, 1.1, dragIn(200, 1));
const t2 = f2.traces[0];
const v2 = t2.values.map((v) => v.value).join(";");
if (!t2.degraded) fail(`frame2 should degrade to the last good layout (got status ${t2.status}, ok=${t2.ok})`);
else if (v2 !== v1) fail(`frame2 values differ from frame1 (fallback must reuse the last good solve): ${v2} vs ${v1}`);
else ok(`degraded: verdict=${t2.degraded!.verdict}, values identical to last good, verdict status=${t2.status}${t2.conflicts?.length ? `, conflicts: ${t2.conflicts.map((c) => c.label).join(" / ")}` : ""}`);
if (t2.degraded && t2.degraded!.verdict === "INFEASIBLE_PROVEN" && !t2.degraded!.conflicts?.length) fail("proven infeasibility should come with Farkas conflict rows");
// recover: frame 3 re-solves (nothing failure-shaped was cached)
const f3 = runSrc(brutal, 900, 1.2, dragIn(210, 0));
if (!f3.traces[0].ok || f3.traces[0].degraded) fail("frame3 should recover with a fresh solve");
resetSolveCache();
const f3c = runSrc(brutal, 900, 1.2, dragIn(210, 0));
const pv = collectParams(f3.shape!, atlas), pc = collectParams(f3c.shape!, atlas);
let d3 = 0; for (let i = 0; i < pv.length; i++) d3 = Math.max(d3, Math.abs(pv[i] - pc[i]));
if (d3 > 0) fail(`frame3 polluted by the failed frame (maxΔ ${d3} vs clean cache)`);
else ok(`recovered: frame3 bitwise-identical to a clean-cache evaluation (no memo pollution)`);

// --------------------------------------------- 3. certified infeasibility on a FIRST frame
console.log("[3] first-frame failure throws with the certified verdict + conflict rows");
resetSolveCache();
let threw = "";
try { runSrc(brutal, 900, 2.0, dragIn(200, 1)); } catch (e: any) { threw = e.message ?? String(e); }
if (!/NO_FEASIBLE_START|INFEASIBLE_PROVEN/.test(threw)) fail(`error should carry the engine verdict, got: ${threw}`);
else ok(`threw: ${threw}`);

// ------------------------------------------------------------------ 4. budget = incumbent
console.log("[4] wall-clock budget: STOPPED hands back an approximate incumbent, never garbage");
{
  // a deliberately large-ish box stack (warm-started solvers answer in ~ms; a zero-ish budget must stop)
  const prob = new Problem();
  const N = 40;
  const xs: number[] = [];
  for (let i = 0; i < N; i++) xs.push(prob.newVar(`x${i}`));
  for (let i = 0; i + 1 < N; i++) prob.addConstraint({ lin: Lin.v(xs[i + 1]).sub(Lin.v(xs[i])).sub(Lin.const(2)), rel: ">", weight: Infinity, label: `g${i}` });
  prob.addConstraint({ lin: Lin.v(xs[0]).sub(Lin.const(10)), rel: "=", weight: Infinity, label: "anchor" });
  prob.addConstraint({ lin: Lin.v(xs[N - 1]).sub(Lin.const(1e4)), rel: "<", weight: 1, label: "soft far pull" });
  let obj = Lin.const(0);
  for (let i = 1; i < N; i++) obj = obj.add(Lin.v(xs[i]));
  prob.minimize(Quad.fromLin(obj)); // x0 pinned by the anchor, minimise the rest: chain tight at 10 + 2i (soft pull inactive)
  const stopped = prob.solve({ budgetMs: 1e-3 });
  if (stopped.status === 6) {
    if (!stopped.approximate) fail("STOPPED must be marked approximate");
    else ok(`STOPPED as designed: approximate incumbent, maxResid=${stopped.maxResid.toExponential(1)}, iterations=${stopped.iterations}`);
  } else ok(`solve beat the 1µs budget (${stopped.statusText}) — nothing to stop; assertion waived`);
  // budget ladder: a generous-enough budget must certify on THIS hardware, whatever the speed ratio
  let certified: ReturnType<Problem["solve"]> | null = null, usedB = 0;
  for (const B of [250, 1000, 5000]) { const r = prob.solve({ budgetMs: B }); if (r.certified) { certified = r; usedB = B; break; } }
  if (!certified) fail("no budget up to 5s produced a certified solve");
  else if (Math.abs(certified.values[xs[N - 1]] - (10 + 2 * (N - 1))) > 50) fail(`budgeted solve wrong answer: x${N - 1} = ${certified.values[xs[N - 1]]} (expected ≈${10 + 2 * (N - 1)})`);
  else ok(`${usedB}ms budget: certified OPTIMAL (${certified.warm ? "warm" : "cold"}), x${N - 1}=${certified.values[xs[N - 1]].toFixed(3)}`);
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nall warm/robustness checks passed");
if (fails) process.exitCode = 1;
