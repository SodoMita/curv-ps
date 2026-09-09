// WGSL syntax gate: parse the *whole* shader the GPU sees, for every example and a list of
// codegen corner cases, in both view modes.
//
// Why this exists: the JS (CPU fallback) target and the WGSL target are generated from the same
// straight-line body, but the two wrappers are written by hand, and JS accepts things WGSL does
// not.  Round 17 shipped exactly that — `if (dd > FAR) break;` in the 3D raymarch loop, which is
// a syntax error in WGSL (the body of an if must be a compound statement; naga reports
// "expected '{' for if statement").  The CPU fallback compiled it happily, so every headless gate
// stayed green while the 3D view failed in the browser with "error: shader: …".  Parsing the
// wrapped source catches the whole class: `scripts/pdiff.ts` renders on the CPU and would never
// have noticed.
//
// This is a *parser*, not a validator: it catches syntax, not type errors.  Semantic validation
// still needs a real WebGPU device, which headless Node does not have here (@kmamal/gpu / Dawn
// hangs with no adapter).
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree } from "../src/curv/interp";
import { buildAtlas } from "../src/gpu/atlas";
import { EXAMPLES } from "../src/curv/examples";
import { wrapWGSL } from "../src/gpu/renderer";
import { SHADER_FLAGS } from "../src/gpu/gen";
import { createCanvas } from "@napi-rs/canvas";

const { WgslReflect } = (await import("wgsl_reflect/wgsl_reflect.module.js")) as unknown as
  { WgslReflect: new (code: string) => unknown };

const CW = 96, CH = 64;
const mk = (w: number, h: number) => {
  const c: any = createCanvas(w, h);
  Object.defineProperty(c, "clientWidth", { get: () => w });
  Object.defineProperty(c, "clientHeight", { get: () => h });
  return c;
};
(globalThis as any).document = { createElement: () => mk(CW, CH) };

await loadPsolve();
const atlas = buildAtlas();
let fails = 0;
const interp = (w: number, h: number, t: number) =>
  new Interp(atlas, { viewport: { x: -w / 2, y: -h / 2, w, h }, time: t, mouse: { x: -1e6, y: -1e6, down: false }, params: {} });

// programs that reach codegen paths the examples do not all cover (kept in sync with stdcheck)
const EXTRA: string[] = [
  'text "Ag" 2',
  "repeat_xyz [3, 3, 0] (sphere 1)",
  "repeat_xy [2, 0] (sphere 1)",
  "repeat_finite [2, 2, 1] [3, 3, 1] (sphere 0.5)",
  "cone { d: 2, h: 3, mode: \"mitred\" }",
  "cone { d: 2, h: 3 }",
  "capsule { from: [0, 0, 0], to: [0, 0, 2], d: 1 }",
  "slice_xz (box3 [2, 4, 6])",
  "slice_yz (box3 [2, 4, 6])",
  "gyroid >> shell 0.2",
  "twist 0.5 (box3 [1, 1, 4])",
  "bend { angle: tau / 4 } (box3 [1, 4, 1])",
  "prism 6 2 3",
  "loft 3 [circle 2, rect [1, 1]]",
  "morph 0.5 [sphere 2, box3 [2, 2, 2]]",
  "smooth_union 0.5 [sphere 1, box3 [1, 1, 1]]",
  "intersection [sphere 2, box3 [1, 1, 1]]",
  "difference [sphere 2, sphere 1]",
  "torus { d: 4, r: 1 }",
  "rotate { angle: 40, axis: [0, 0, 1] } (box3 [1, 2, 3])",
  "show_dist (sphere 2)",
  "make_shape { dist: p -> mag p - 1, bbox: [[-1, -1, -1], [1, 1, 1]], is_3d: true }",
  "sphere (1 + 0.3 * sin time)",
];

const modes = ["slice", "solid"] as const;
type Mode = (typeof modes)[number];

/**
 * Branch census: `if (`/`}`else`/`break`/`continue` and short-circuit `&&`/`||` are divergent
 * control flow; `for (` is a uniform loop and is reported separately.  In the branchless build the
 * first four must all be zero — that is what "no branching" means, and it is asserted below.
 */
const census = (src: string) => {
  const code = src.replace(/\/\/[^\n]*/g, ""); // the wrapper's own comments mention if/break
  return {
  ifs: (code.match(/\bif\s*\(/g) ?? []).length,
  brks: (code.match(/\bbreak\b|\bcontinue\b/g) ?? []).length,
  logic: (code.match(/&&|\|\|/g) ?? []).length,
  loops: (code.match(/\bfor\s*\(/g) ?? []).length,
  };
};

const parse = (id: string, mode: Mode, code: string): boolean => {
  try {
    new WgslReflect(code);
    return true;
  } catch (e: any) {
    const msg = String(e?.message ?? e).split("\n")[0];
    const ln = Number((/Line: (\d+)/.exec(msg) ?? [])[1] ?? -1);
    const lines = code.split("\n");
    const where = ln > 0 ? ` → line ${ln}: ${(lines[ln - 1] ?? "").trim()}` : "";
    console.log(`ERR ${id} [${mode}] ${msg}${where}`);
    if (ln > 0) {
      for (let i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++)
        console.log(`      ${String(i + 1).padStart(4)}${i + 1 === ln ? " >" : "  "} ${lines[i]}`);
    }
    return false;
  }
};

const check = (id: string, src: string): void => {
  const sizes: string[] = [];
  let bad = false;
  for (const mode of modes) {
    // the 3D wrapper has two flavours (with and without control flow); validate both, and check
    // the branchless one really has no branches left
    for (const bl of [false, true]) {
      const save = { ...SHADER_FLAGS };
      Object.assign(SHADER_FLAGS, { branchless: bl, branchless3D: bl, noShortCircuit: bl, cullSelect: bl });
      try {
        const r = interp(900, 600, 0).run(src);
        if (!r.shape) { console.log(`ERR ${id} [${mode}] no shape`); bad = true; continue; }
        const c = compileTree(r.shape, atlas, "wgsl", null, undefined, mode);
        const code = wrapWGSL({ ...c, solid: mode === "solid" });
        if (!parse(id, mode, code)) { bad = true; continue; }
        const b = census(code);
        if (bl && (b.ifs || b.brks || b.logic)) {
          console.log(`ERR ${id} [${mode}] branchless build still branches: ${b.ifs} if / ${b.brks} break / ${b.logic} short-circuit`);
          bad = true; continue;
        }
        sizes.push(`${mode}${bl ? "(bl)" : ""} ${code.split("\n").length}L ${b.ifs}i/${b.brks}b/${b.logic}s/${b.loops}L`);
      } catch (e: any) { console.log(`ERR ${id} [${mode}] ${e.message}`); bad = true; }
      finally { Object.assign(SHADER_FLAGS, save); }
    }
  }
  if (bad) fails++;
  else console.log(`OK  ${id.padEnd(24)} ${sizes.join(" / ")}`);
};

console.log("examples");
for (const ex of EXAMPLES) check(ex.id, ex.src);
console.log("\ncodegen corner cases");
EXTRA.forEach((src, i) => check(`extra ${i}`, src));

// ---- 4. flipping a shader-gen option (the options menu) must really recompile --------------
// The menu mutates SHADER_FLAGS while the app is running; if a flag were missing from the structural
// key, `compileTree(prev)` would hand back the old shader and the option would appear to do nothing.
console.log("\noption changes invalidate the shader");
{
  const ex = EXAMPLES.find((e) => e.id === "packed")!;
  const r = interp(900, 600, 0).run(ex.src);
  const a = compileTree(r.shape!, atlas, "wgsl", null, undefined, "slice");
  const save = { ...SHADER_FLAGS };
  Object.assign(SHADER_FLAGS, { branchless: true });
  const b = compileTree(r.shape!, atlas, "wgsl", a, undefined, "slice");
  const ok1 = !b.reused && b.code !== a.code;
  console.log(`${ok1 ? "OK " : "ERR"} branchless flips the shader           ${a.code.length}B → ${b.code.length}B, reused=${b.reused}`);
  if (!ok1) fails++;
  Object.assign(SHADER_FLAGS, save);
  const c = compileTree(r.shape!, atlas, "wgsl", b, undefined, "slice");
  const ok2 = c.code === a.code;
  console.log(`${ok2 ? "OK " : "ERR"} flipping back restores the old text   ${ok2 ? "identical" : "DIFFERENT"}`);
  if (!ok2) fails++;
  // the parameter buffer must not move: the menu cannot be allowed to change the layout
  const same = a.params.length === b.params.length && a.params.every((v, i) => v === b.params[i]);
  console.log(`${same ? "OK " : "ERR"} parameter layout is unchanged        ${a.params.length} params`);
  if (!same) fails++;
}

// ---- 5. the hand-written 3D wrapper must agree with the CPU marcher's camera ----------------
// The wrapper is WGSL and every other gate runs the CPU path, so a divergence between the two is
// invisible to all 35 golden frames.  Round 21 shipped exactly that: `nd` was
// `(px - res * 0.5) * 2.0` where the CPU marcher has `((i + 0.5) - w * 0.5) / (w * 0.5)`, so every
// ray left the eye at ~90 degrees from the view axis and the 3D view was empty on the GPU while the
// CPU fallback looked perfect.  Parsing cannot catch it; this compares the two formulas' shape.
console.log("\nthe 3D wrapper's camera agrees with the CPU marcher");
{
  const ex = EXAMPLES.find((e) => e.id === "rings3d")!;
  for (const bl of [false, true]) {
    const save = { ...SHADER_FLAGS };
    Object.assign(SHADER_FLAGS, { branchless: bl, branchless3D: bl });
    const r = interp(900, 600, 0).run(ex.src);
    const c = compileTree(r.shape!, atlas, "wgsl", null, undefined, "solid");
    const code = wrapWGSL({ ...c, solid: true });
    const nd = code.split("\n").find((l) => l.includes("let nd =")) ?? "";
    // normalised device coords: divide by half the resolution, like the CPU marcher does
    const okNd = /\/ *\(u\.res \* 0\.5\)/.test(nd) && !/\* *2\.0/.test(nd);
    console.log(`${okNd ? "OK " : "ERR"} ${bl ? "branchless " : ""}ray dir uses normalised device coords${okNd ? "" : `  → ${nd.trim()}`}`);
    if (!okNd) fails++;
    // the far plane has to follow the camera: a viewport-sized program fits at ~1900 units out
    const far = code.split("\n").find((l) => l.includes("FAR =")) ?? "";
    const okFar = /max\(400\.0, *rad/.test(far);
    console.log(`${okFar ? "OK " : "ERR"} ${bl ? "branchless " : ""}far plane follows the camera distance${okFar ? "" : `  → ${far.trim()}`}`);
    if (!okFar) fails++;
    Object.assign(SHADER_FLAGS, save);
  }
}

// ---- 6. a 2D shape is a plate in the 3D view, and an ordinary 2D shape in the 2D view --------
// Same class of bug as §5, same reason: the WGSL body is compiled by the GPU and executed by
// nobody in this sandbox.  A 2D shape's distance ignores z, so in the 3D view it has to be
// intersected with a thin slab — and that slab must NOT appear in the slice shader, where it would
// fatten every shape by the plate's thickness.
console.log("\n2D shapes are plates in the 3D view (WGSL)");
{
  const r = interp(960, 600, 0).run("circle 2");
  const solid = compileTree(r.shape!, atlas, "wgsl", null, undefined, "solid").code;
  const slice = compileTree(r.shape!, atlas, "wgsl", null, undefined, "slice").code;
  const plate = /abs\(p0\.z\)/.test(solid) && /u\.cam3a\.w/.test(solid);
  console.log(`${plate ? "OK " : "ERR"} solid shader intersects the shape with a slab  ${solid.split("\n").filter((l) => l.includes("abs(p0.z)")).join(" ").trim()}`);
  if (!plate) fails++;
  const clean = !/abs\(p0\.z\)/.test(slice) && !/u\.cam3a\.w/.test(slice);
  console.log(`${clean ? "OK " : "ERR"} slice shader has no slab (2D view untouched)`);
  if (!clean) fails++;
  // a 3D shape keeps its depth: no slab is added to a sphere
  const s3 = compileTree(interp(960, 600, 0).run("sphere 2").shape!, atlas, "wgsl", null, undefined, "solid").code;
  const noPlate = !/abs\(p0\.z\)/.test(s3);
  console.log(`${noPlate ? "OK " : "ERR"} a 3D shape is not flattened`);
  if (!noPlate) fails++;
}

// ---- 7. the sdf-steps count is a comptime literal of the 3D wrapper, and the slab is 3D-only --
// `sdfSteps` is a codegen-time constant, not a uniform: the raymarch loop bound must appear in the
// generated WGSL as a literal that follows the flag, the wrapper text (and with it the pipeline
// cache key, which wraps this text) must change when the count changes, and neither may leak into
// the 2D slice view.  The empty-space slab test must be identical in the branched and branchless
// wrappers — flagcheck holds the two builds to identical pixels, so they must share the formulas.
console.log("\nsdf steps are a comptime constant of the 3D wrapper");
{
  const ex = EXAMPLES.find((e) => e.id === "rings3d")!;
  const r = interp(900, 600, 0).run(ex.src);
  const shape = r.shape!;
  const save = { ...SHADER_FLAGS };
  const loopLine = (code: string) => (code.split("\n").find((l) => /for \(var i = 0u;/.test(l)) ?? "").trim();
  try {
    const seen = new Map<number, string>();
    for (const n of [32, 128, 256]) {
      SHADER_FLAGS.sdfSteps = n;
      const c = compileTree(shape, atlas, "wgsl", null, undefined, "solid");
      const code = wrapWGSL({ ...c, solid: true });
      const line = loopLine(code);
      const ok = line === `for (var i = 0u; i < ${n}u; i = i + 1u) {`;
      console.log(`${ok ? "OK " : "ERR"} steps=${String(n).padStart(3)} baked as a loop-bound literal    ${ok ? "" : "→ " + line}`);
      if (!ok) fails++;
      seen.set(n, code);
      // the slice view has no raymarch loop at all: the same body compiled in slice mode must not
      // mention the count (the u32 loop is the wrapper's; body loops count in f32)
      const sl = wrapWGSL({ ...c, solid: false });
      if (/i < \d+u/.test(sl)) { console.log(`ERR steps=${n} leaked into the slice wrapper`); fails++; }
    }
    const okDiff = seen.get(32) !== seen.get(128) && seen.get(128) !== seen.get(256);
    console.log(`${okDiff ? "OK " : "ERR"} the wrapper text changes with the count      (so does the pipeline key, which hashes it)`);
    if (!okDiff) fails++;
    // the body — and with it the parameter buffer — must NOT change: the flag is deliberately
    // absent from flagsKey, the body caches stay valid across a steps change
    SHADER_FLAGS.sdfSteps = 32;
    const body32 = compileTree(shape, atlas, "wgsl", null, undefined, "solid");
    SHADER_FLAGS.sdfSteps = 256;
    const body256 = compileTree(shape, atlas, "wgsl", body32, undefined, "solid");
    const okBody = body256.reused && body256.code === body32.code;
    console.log(`${okBody ? "OK " : "ERR"} body and parameters are step-invariant     ${okBody ? "compileTree reuse holds" : "the body changed with the count"}`);
    if (!okBody) fails++;
    // the empty-space slab: identical formulas in both wrapper flavours, absent from the slice view
    const slabOf = (code: string) => code.split("\n").filter((l) => /let (pad|dinv|ta|tb|lo|hi|t0|t1) =/.test(l)).map((l) => l.trim()).join("\n");
    SHADER_FLAGS.sdfSteps = 128;
    Object.assign(SHADER_FLAGS, { branchless: false, branchless3D: false });
    const slabBr = slabOf(wrapWGSL({ ...compileTree(shape, atlas, "wgsl", null, undefined, "solid"), solid: true }));
    Object.assign(SHADER_FLAGS, { branchless: true, branchless3D: true });
    const slabBl = slabOf(wrapWGSL({ ...compileTree(shape, atlas, "wgsl", null, undefined, "solid"), solid: true }));
    const okSlab = slabBr !== "" && slabBr === slabBl;
    console.log(`${okSlab ? "OK " : "ERR"} branched and branchless share the slab test${okSlab ? "" : "  → the two wrappers compute the box bounds differently"}`);
    if (!okSlab) fails++;
    const sliceCode = wrapWGSL({ ...compileTree(shape, atlas, "wgsl", null, undefined, "slice"), solid: false });
    if (/let t0 = max\(0\.02/.test(sliceCode)) { console.log("ERR the slab test leaked into the slice wrapper"); fails++; }
    else console.log("OK  the slice wrapper has no slab test");
  } finally { Object.assign(SHADER_FLAGS, save); }
}

console.log(fails ? `\n${fails} shader(s) failed to parse` : "\nall shaders parse as WGSL");
process.exit(fails ? 1 : 0);
