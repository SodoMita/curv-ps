// Ad-hoc checks for solve-block memoisation: every program must produce different values when
// its (possibly indirect) inputs change, and identical values + a block cache hit when they do not.
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, resetSolveCache, Rec } from "../src/curv/interp";
import { buildAtlas } from "../src/gpu/atlas";
(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
const cases: [string, string, boolean][] = [ // [name, src, expectMemoisable]
  ["closure reads time", `let k = time; f x = x + k; in let L = solve { var a : num; a == f 10; }; in L.a`, true],
  ["nested closure", `let k = time; g y = y * 2; f x = g x + k; in (solve { var a : num; a == f 1; }).a`, true],
  ["local shadows outer", `let x = time; in (solve { var a : num; local x = x + 1; a == x; }).a`, true],
  ["record field", `let r = {v: time}; in (solve { var a : num; a == r.v; }).a`, true],
  ["let inside block", `(solve { var a : num; local q = let z = time; in z + 1; a == q; }).a`, true],
  ["for over list of time", `let xs = [time, 2]; in (solve { var a : num; for (x in xs) weak: a == x; }).a`, true],
  ["prelude combinator", `let b = box (0, 0, 100 + time, 50); in (solve { var c : box; pin 4 b c; }).c.w`, true],
  ["lambda arg", `let f = x -> x + time; in (solve { var a : num; a == f 1; }).a`, true],
  ["comprehension", `let n = 1 + floor time; in (solve { var a : num; a == count [for (i in 1..n) i]; }).a`, true],
  ["mouse", `(solve { var a : num; a == mouse.x; }).a`, true],
  ["viewport", `(solve { var a : num; a == viewport.w; }).a`, true],
  ["text_size of animated label", `let t = if (time < 1.5) "i" else "mmm"; in (solve { var a : num; a == (text_size t 12).[X]; }).a`, true],
  ["assign outer (impure)", `do local s = 0; local L = solve { var a : num; s := time; a == s; }; in L.a`, false],
  ["shape input", `let s = circle (10 + time); in (solve { var a : num; a == (bbox_box s).w; }).a`, true],
  ["custom shape input (unhashable)", `let s = make_shape { dist p = p.[X] - time; bbox = [[-1,-1,0],[1,1,0]]; is_2d = true }; in (solve { var a : num; a == s.bbox.[1].[X] + time; }).a`, false],
];
let fails = 0;
for (const [name, src, expectMemo] of cases) {
  resetSolveCache();
  const run = (t: number) => { const it = new Interp(atlas, { viewport: { x: -450, y: -300, w: 900 + t, h: 600 }, time: t, mouse: { x: 10 * t, y: 5, down: false } }); const r = it.run(src); return { v: r.value as number, tr: r.traces[0] }; };
  try {
    const a = run(1), a2 = run(1), b = run(2), b2 = run(2);
    const memo = a2.tr.cacheKind === "block";
    const ok = a.v === a2.v && b.v === b2.v && a.v !== b.v && memo === expectMemo;
    if (!ok) fails++;
    console.log(`${ok ? "OK " : "ERR"} ${name.padEnd(28)} t=1 → ${a.v} / ${a2.v}   t=2 → ${b.v} / ${b2.v}   memo=${memo}${memo !== expectMemo ? ` (expected ${expectMemo})` : ""}`);
  } catch (e: any) { fails++; console.log(`ERR ${name}: ${e.message}`); }
}
if (fails) process.exitCode = 1;
// a block evaluated twice per frame with different inputs must keep both results memoised
{
  resetSolveCache();
  const src = `let f w = (solve { var b : box; b.w == w; b.h == 10; b.x == 0; b.y == 0; }).b.w; in [f 10, f 20]`;
  const run = () => new Interp(atlas, { viewport: { x: 0, y: 0, w: 1, h: 1 }, time: 0, mouse: { x: 0, y: 0, down: false } }).run(src);
  const a = run(), b = run();
  const vals = (r: typeof a) => (r.value as number[]).join(",");
  const ok = vals(a) === "10,20" && vals(b) === "10,20" && b.traces.length === 2 && b.traces.every((t) => t.cacheKind === "block");
  if (!ok) fails++;
  console.log(`${ok ? "OK " : "ERR"} ${"two evaluations per frame".padEnd(28)} ${vals(b)} memo=${b.traces.map((t) => t.cacheKind ?? "none").join("/")}`);
}

// ---- call memo: pure user functions are memoised across frames once profiling says they are worth it.
// Each program is evaluated for several frames at t=1 (warm-up past the measuring phase), then at t=2.
// Values must be identical for identical inputs, differ when a (possibly indirect) input differs, and
// the number of solve traces must not change between a cold and a memoised frame.
console.log("\ncall memo");
const W = "count [for (i in 0..300) i]"; // makes a body expensive enough to be memoised
const ccases: [string, string, boolean, boolean][] = [ // [name, src, expectHits, expectTimeDependent]
  ["const arg", `let f x = (bbox_box (union [for (i in 0..12) circle (x + i) >> translate (i, 0)])).w + ${W}; in f 3 + f 3 + f 4`, true, false],
  ["reads time", `let f x = x + time + ${W}; in [for (i in 0..5) f i]`, true, true],
  ["reads time via closure arg", `let g = x -> x + time; f h = h 1 + ${W}; in [for (i in 0..5) f g]`, true, true],
  ["reads mouse via outer let", `let m = mouse.x; f x = x + m + ${W}; in [for (i in 0..5) f i]`, true, true],
  ["shape arg", `let f s = (bbox_box s).w + ${W}; in [for (i in 0..5) f (circle (10 + time))]`, true, true],
  ["assigns outer (impure)", `do local s = 0; local f x = do s := s + x + ${W}; in s; in [for (i in 0..5) f 1] >> map (x -> x + time)`, false, true],
  ["prints", `let f x = do print x; in x + ${W}; in [for (i in 0..5) f 1] >> map (x -> x + time)`, false, true],
  ["parametric inside", `let f x = parametric k :: slider[0,1] = 0.5; in x + k + ${W}; in [for (i in 0..5) f 1] >> map (x -> x + time)`, false, true],
  ["closure over later-mutated var", `let f h = h 1 + ${W}; in do local k = time; local g = x -> x + k; local a = f g; k := k + 100; local b = f g; in [a, b, f g]`, true, true],
  ["solve block inside", `let f w = (solve { var b : box; b.w == w + time; b.h == 10; b.x == 0; b.y == 0; }).b.w + ${W}; in [for (i in 0..5) f i]`, true, true],
  ["recursive", `let f n = if (n <= 1) n + ${W} else f (n - 1) + f (n - 2); in f 8 + time`, true, true],
];
for (const [name, src, expectHits, expectTimeDep] of ccases) {
  resetSolveCache();
  const run = (t: number) => new Interp(atlas, { viewport: { x: 0, y: 0, w: 900, h: 600 }, time: t, mouse: { x: 10 * t, y: 5, down: false } }).run(src);
  try {
    const show = (v: unknown) => JSON.stringify(v);
    const cold = run(1); let warm = cold;
    for (let i = 0; i < 6; i++) warm = run(1);
    const other = run(2), other2 = run(2);
    const same = show(cold.value) === show(warm.value) && show(other.value) === show(other2.value);
    const dep = show(cold.value) !== show(other.value);
    const hits = warm.callMemo.hits > 0;
    const traces = cold.traces.length === warm.traces.length && warm.traces.every((t) => t.cached);
    const ok = same && dep === expectTimeDep && hits === expectHits && traces;
    if (!ok) fails++;
    console.log(`${ok ? "OK " : "ERR"} ${name.padEnd(30)} hits=${warm.callMemo.hits}/${warm.callMemo.misses + warm.callMemo.hits}${hits !== expectHits ? ` (expected ${expectHits ? "hits" : "no hits"})` : ""}${same ? "" : " VALUES DIFFER FOR SAME INPUTS"}${dep === expectTimeDep ? "" : " time-dependence wrong"}${traces ? "" : " TRACES DIFFER"}  ${show(warm.value).slice(0, 40)}`);
  } catch (e: any) { fails++; console.log(`ERR ${name}: ${e.message}`); }
}
// node identity: a memoised shape-valued call returns the very same tree across frames (bbox / key memos hit)
{
  resetSolveCache();
  const src = `let f x = union [for (i in 0..12) circle (x + i) >> translate (i, 0)]; in f 3`;
  const run = () => new Interp(atlas, { viewport: { x: 0, y: 0, w: 1, h: 1 }, time: 0, mouse: { x: 0, y: 0, down: false } }).run(src);
  let a = run(); for (let i = 0; i < 6; i++) a = run();
  const b = run();
  const ok = a.shape === b.shape && a.shape !== null;
  if (!ok) fails++;
  console.log(`${ok ? "OK " : "ERR"} ${"node identity across frames".padEnd(30)} same=${a.shape === b.shape}`);
}

// ---- shared prelude: the prelude env is evaluated once per process and its vars map is shared read-only;
// user assignments to prelude names must be visible in that frame only, and prelude bodies must resolve
// builtins (time/mouse/viewport) of the frame evaluating them.
console.log("\nshared prelude");
const runS = (src: string, t = 1) => new Interp(atlas, { viewport: { x: -450, y: -300, w: 900 + t, h: 600 }, time: t, mouse: { x: 10 * t, y: 5, down: false } }).run(src);
{
  const a = runS(`do surface := "tampered"; in surface`); // same-frame visibility
  const b = runS(`surface`);                                // later programs see the original
  const ok = a.value === "tampered" && b.value === "#141a2a";
  if (!ok) fails++;
  console.log(`${ok ? "OK " : "ERR"} ${"prelude name mutation".padEnd(30)} ${JSON.stringify(a.value)} → ${JSON.stringify(b.value)}`);
}
{
  // prelude combinator called by two different programs / times keeps memoising and stays correct
  const src = `let b = box (0, 0, 100 + time, 50); in (solve { var c : box; pin 4 b c; }).c.w + viewport.w`;
  const a = runS(src, 1), a2 = runS(src, 1), b = runS(src, 2);
  const ok = a.value === a2.value && a2.value !== b.value && a2.traces[0].cacheKind === "block";
  if (!ok) fails++;
  console.log(`${ok ? "OK " : "ERR"} ${"combinator across programs".padEnd(30)} t=1 → ${a.value}/${a2.value}  t=2 → ${b.value}  memo=${a2.traces[0].cacheKind}`);
}
{
  // prelude functions stored in lists / called from lambdas resolve through the shared env on every frame
  const src = `union [for (i in 0..2) [card, panel, divider].[i] (box (10 + i*30, 0, 24, 12))]`;
  const a = runS(src, 1), b = runS(src, 1), c = runS(src, 2);
  const ok = a.shape !== null && b.shape !== null && c.shape !== null;
  if (!ok) fails++;
  console.log(`${ok ? "OK " : "ERR"} ${"prelude fns in lists/lambdas".padEnd(30)} shapes ok ×3`);
}
if (fails) process.exitCode = 1;
