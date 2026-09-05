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
  ["shape input", `let s = circle (10 + time); in (solve { var a : num; a == (bbox_box s).w; }).a`, false],
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
if (fails) process.exitCode = 1;
