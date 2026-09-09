// Branch-vs-branchless benchmark (round 18).
//
// `SHADER_FLAGS.branchless` (src/gpu/gen.ts) makes the generated shader emit no control flow at
// all: `if` becomes a masked assignment, `break` becomes a `live` flag, `&&`/`||` become `&`/`|`.
// Uniform `for` loops stay (a parameter-counted loop is not a divergent branch).  Both arms of
// every branch are then always computed, so the shader does strictly more arithmetic — on a GPU
// that trades ALU for warp coherence; on the CPU fallback it is mostly just ALU.
//
// This script times both builds on the *same* code path the app's CPU fallback uses
// (`createRenderer(canvas, atlas, "cpu", { fixedScale })`, so the adaptive resolution cannot
// move the pixel count between measurements), interleaved per example to cancel drift:
//
//   npx tsx scripts/branchbench.ts [example …]
//
// It reports, per example and per view mode, ms/frame (best of N), the size of the WGSL the GPU
// would get, and how many branches/breaks it still contains.
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree } from "../src/curv/interp";
import { buildAtlas } from "../src/gpu/atlas";
import { EXAMPLES } from "../src/curv/examples";
import { createRenderer, wrapWGSL, type Camera3 } from "../src/gpu/renderer";
import { SHADER_FLAGS } from "../src/gpu/gen";

const SLICE_W = 96, SLICE_H = 64;
const SOLID_W = 40, SOLID_H = 28;
const FRAMES = 2; // best-of, after one warm-up frame
const REPS = 1;   // raise for a quieter machine (round-robin A/B/A/B)
// the raymarch is ~1 ms/px on this backend, so the solid sweep runs on the 3D group plus two of
// the heaviest 2D trees (enough to show the effect; pass ids on the command line to widen it)
const SOLID_IDS = new Set(["packed", "dashboard", "toolbar", "mandelbrot"]);
const BG: [number, number, number] = [0.055, 0.075, 0.13];

const mk = (w: number, h: number) => {
  const c: any = createCanvas(w, h);
  Object.defineProperty(c, "clientWidth", { get: () => w });
  Object.defineProperty(c, "clientHeight", { get: () => h });
  return c;
};
(globalThis as any).document = { createElement: () => mk(SLICE_W, SLICE_H) };

await loadPsolve();
const atlas = buildAtlas();
(globalThis as any).document = { createElement: (kind: string) => (kind === "canvas" ? mk(1, 1) : {}) };

const args = process.argv.slice(2);
const exs = args.length ? EXAMPLES.filter((e) => args.includes(e.id)) : EXAMPLES;

/** `if (`, `} else`, `break`, `continue`, short-circuit `&&`/`||` — everything a GPU would have to
 *  diverge on.  `for (` is counted separately: a uniform loop is not a branch. */
const branches = (code: string) => ({
  ifs: (code.match(/\bif\s*\(/g) ?? []).length,
  brks: (code.match(/\bbreak\b|\bcontinue\b/g) ?? []).length,
  logic: (code.match(/&&|\|\|/g) ?? []).length,
  loops: (code.match(/\bfor\s*\(/g) ?? []).length,
});

type Row = { ms: number[]; bytes: number; ifs: number; brks: number; logic: number; loops: number };
const blank = (): Row => ({ ms: [], bytes: 0, ifs: 0, brks: 0, logic: 0, loops: 0 });

async function time(exId: string, src: string, mode: "slice" | "solid"): Promise<Row> {
  const r0 = new Interp(atlas, { viewport: { x: -450, y: -300, w: 900, h: 600 }, time: 1.2, mouse: { x: 0, y: 0, down: false }, params: {} }).run(src);
  if (!r0.shape) return blank();
  const prog = compileTree(r0.shape, atlas, "js", null, undefined, mode);
  const wg = compileTree(r0.shape, atlas, "wgsl", null, undefined, mode);
  const full = wrapWGSL({ ...wg, solid: mode === "solid" });
  const b = branches(full);
  const W = mode === "solid" ? SOLID_W : SLICE_W, H = mode === "solid" ? SOLID_H : SLICE_H;
  (globalThis as any).document = { createElement: (kind: string) => (kind === "canvas" ? mk(W, H) : {}) };
  const cv = mk(W, H);
  const r = await createRenderer(cv, atlas, "cpu", { fixedScale: 1 });
  const cam = { cx: 0, cy: 0, zoom: 24 };
  const cam3: Camera3 = { tx: 0, ty: 0, tz: 0, dist: 14, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };
  const row: Row = { ms: [], bytes: full.length, ...b };
  for (let i = 0; i <= FRAMES; i++) {
    const t0 = performance.now();
    await r.render({ ...prog, solid: mode === "solid" }, cam, BG, 1.2, 1, cam3);
    const dt = performance.now() - t0;
    if (i > 0) row.ms.push(dt); // first frame pays for the JS compile
  }
  r.destroy();
  return row;
}

const best = (ms: number[]) => (ms.length ? Math.min(...ms) : NaN);
const fmt = (v: number) => (Number.isFinite(v) ? v.toFixed(1).padStart(7) : "      -");

/** The four builds, in the order they are worth adopting. */
const WAYS: [string, Partial<typeof SHADER_FLAGS>][] = [
  ["branching (base)", { branchless: false, noShortCircuit: false, cullSelect: false, branchless3D: false }],
  ["no short-circuit", { branchless: false, noShortCircuit: true, cullSelect: false, branchless3D: false }],
  ["+ cull select", { branchless: false, noShortCircuit: true, cullSelect: true, branchless3D: false }],
  ["branchless body", { branchless: true, noShortCircuit: false, cullSelect: false, branchless3D: false }],
  ["branchless ray", { branchless: false, noShortCircuit: true, cullSelect: true, branchless3D: true }],
];
const setFlags = (f: Partial<typeof SHADER_FLAGS>) => Object.assign(SHADER_FLAGS, { branchless: false, noShortCircuit: false, cullSelect: false, branchless3D: false }, f);


/** Every way is measured REPS times, round-robin, and the fastest run of each wins: a way that
 *  happens to go first (or last) should not inherit the JIT's warm-up. */
const measure = async (id: string, src: string, mode: "slice" | "solid"): Promise<Row[]> => {
  const out: Row[] = WAYS.map(() => ({ ms: [], bytes: 0, ifs: 0, brks: 0, logic: 0, loops: 0 }));
  for (let rep = 0; rep < REPS; rep++) {
    for (let w = 0; w < WAYS.length; w++) {
      setFlags(WAYS[w][1]);
      const r = await time(id, src, mode);
      out[w] = { ...r, ms: [...out[w].ms, ...r.ms] };
    }
  }
  return out;
};

console.log(`branchless benchmark — best of ${FRAMES} frames after one warm-up, CPU fallback,`);
console.log(`slice ${SLICE_W}×${SLICE_H} · solid ${SOLID_W}×${SOLID_H} (raymarch), resolution pinned\n`);

const run = async (mode: "slice" | "solid") => {
  console.log(`${mode}: ms/frame (best of ${FRAMES})`);
  console.log("example        " + WAYS.map(([n]) => n.slice(0, 15).padStart(15)).join(""));
  const sums = WAYS.map(() => 0);
  const ratios = WAYS.map(() => [] as number[]);
  const branchCols: string[] = [];
  const list = mode === "solid" && args.length === 0 ? exs.filter((e) => e.group === "3d" || SOLID_IDS.has(e.id)) : exs;
  for (const ex of list) {
    const rows = await measure(ex.id, ex.src, mode);
    const ms = rows.map((r) => best(r.ms));
    console.log(ex.id.padEnd(14) + ms.map((v) => (Number.isFinite(v) ? v.toFixed(1) : "-").padStart(15)).join(""));
    ms.forEach((v, i) => { if (Number.isFinite(v)) { sums[i] += v; if (i > 0 && ms[0] > 0) ratios[i].push(v / ms[0]); } });
    branchCols.push(`${rows[0].ifs}/${rows[0].brks}/${rows[0].logic} → ${rows[rows.length - 1].ifs}/${rows[rows.length - 1].brks}/${rows[rows.length - 1].logic}`);
  }
  console.log("TOTAL".padEnd(14) + sums.map((v) => v.toFixed(0).padStart(15)).join(""));
  const geo = (xs: number[]) => (xs.length ? Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length) : NaN);
  console.log("slowdown".padEnd(14) + ratios.map((r) => (r.length ? `${geo(r).toFixed(2)}×` : "-").padStart(15)).join(""));
  console.log(`(if/break/|| branches: ${branchCols[0]} … ${branchCols[branchCols.length - 1]})\n`);
  return { sums, ratios };
};

await run("slice");
await run("solid");
setFlags({ branchless: false, noShortCircuit: false, cullSelect: false, branchless3D: false });
