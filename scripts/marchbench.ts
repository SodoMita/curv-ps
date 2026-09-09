// Marcher benchmark (round 23).
//
// The 3D solid view is a sphere-tracing raymarcher over the generated field — by far the most
// expensive thing the app renders.  Two knobs came out of this round, and this script measures
// both on the CPU fallback (the only backend that can count):
//
//   • the empty-space skip: the ray is intersected with the scene's (padded) bounding box before
//     the march.  A ray that misses the box cannot meet the surface, so it paints background with
//     zero field evaluations; a ray that meets it starts at the entry point and stops at the exit
//     instead of marching from the eye.  A/B in-process: the same program with its `bbox3`
//     stripped marches from the eye exactly as before the change.
//   • `SHADER_FLAGS.sdfSteps`: the raymarch loop bound, a compile-time constant baked into the
//     generated WGSL and the CPU marcher as a literal (`i < 128u`).  Hits are monotone in the
//     count — the first N steps of an M-step march are the same march — so the sweep trades
//     grazing-surface fidelity for time.
//
//   npx tsx scripts/marchbench.ts [example …]
//
// Reports ms/frame and SDF field evaluations per frame (the renderer's `stats.steps` counter,
// million counts), best of FRAMES after a warm-up, interleaved per example to cancel drift.
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, setSolveBudget } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
import { bbox3Of, finiteBBox3 } from "../src/curv/shapes";
import { createRenderer, wrapWGSL, type Camera3, type Compiled } from "../src/gpu/renderer";
import { SHADER_FLAGS } from "../src/gpu/gen";

const W = 48, H = 32;        // solid view, resolution pinned (the adaptive scale must not move pixels)
const FRAMES = 2;            // best-of, after one warm-up frame
const REPS = 1;              // round-robin A/B/A/B: a way that goes first must not inherit the JIT's warm-up
const BG: [number, number, number] = [0.055, 0.075, 0.13];
const VIEWPORT = { x: -450, y: -300, w: 900, h: 600 };
const TIME = 1.2;
// the heavy 2D trees (rendered as plates) join the 3D group; pass ids to widen it
const EXTRA_IDS = new Set(["packed", "dashboard", "toolbar"]);

const mk = (w: number, h: number) => {
  const c: any = createCanvas(w, h);
  Object.defineProperty(c, "clientWidth", { get: () => w });
  Object.defineProperty(c, "clientHeight", { get: () => h });
  return c;
};
(globalThis as any).document = { createElement: (kind: string) => (kind === "canvas" ? mk(1, 1) : {}) };
await loadPsolve();
setSolveBudget(0); // deterministic solves: a budget incumbent would depend on machine load
const atlas = buildAtlas();

const args = process.argv.slice(2);
const exs = args.length ? EXAMPLES.filter((e) => args.includes(e.id)) : EXAMPLES.filter((e) => e.group === "3d" || EXTRA_IDS.has(e.id));

/** The App's own 3D auto-fit: target = box centre, distance = extent / tan(fov/2) × 1.5 — the
 *  realistic viewing distance, and the one that puts a viewport-sized plate ~1900 units out. */
const fitCam3 = (bb3: number[] | null): Camera3 => {
  const b = bb3 ?? [-1, -1, -1, 1, 1, 1];
  const extent = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 1) / 2;
  return { tx: (b[0] + b[3]) / 2, ty: (b[1] + b[4]) / 2, tz: (b[2] + b[5]) / 2, dist: Math.max(0.5, (extent / Math.tan((38 * Math.PI) / 180 / 2)) * 1.5), yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };
};

type Way = { name: string; steps?: number; box: boolean; branchless?: boolean };
const WAYS: Way[] = [
  { name: "eye·128", steps: 128, box: false },          // the pre-round-23 marcher: from the eye, no skip
  { name: "skip·32", steps: 32, box: true },
  { name: "skip·64", steps: 64, box: true },
  { name: "skip·128", steps: 128, box: true },          // the shipped default
  { name: "skip·256", steps: 256, box: true },
  { name: "branchless·128", steps: 128, box: true, branchless: true },
];

interface Row { ms: number[]; steps: number[] }
const blank = (): Row => ({ ms: [], steps: [] });

async function time(ex: { id: string; src: string }, way: Way): Promise<Row> {
  const r0 = new Interp(atlas, { viewport: VIEWPORT, time: TIME, mouse: { x: 0, y: 0, down: false }, params: {} }).run(ex.src);
  if (!r0.shape) return blank();
  const compiled = compileTree(r0.shape, atlas, "js", null, undefined, "solid");
  const prog: Compiled = { ...compiled, solid: true, bbox3: way.box ? compiled.bbox3 : null };  // strip the box → march from the eye
  const cam3 = fitCam3(finiteBBox3(bbox3Of(r0.shape, atlas)));
  const cv = mk(W, H);
  const renderer = await createRenderer(cv as any, atlas, "cpu", { fixedScale: 1 });
  const prev = { ...SHADER_FLAGS };
  Object.assign(SHADER_FLAGS, { sdfSteps: way.steps ?? 128, branchless3D: !!way.branchless, branchless: false });
  const row: Row = blank();
  for (let i = 0; i <= FRAMES; i++) {
    const s0 = renderer.stats.steps;
    const t0 = performance.now();
    await renderer.render(prog, { cx: 0, cy: 0, zoom: 1 }, BG, TIME, 1, cam3);
    const dt = performance.now() - t0;
    if (i > 0) { row.ms.push(dt); row.steps.push(renderer.stats.steps - s0); } // first frame pays the JS compile
  }
  Object.assign(SHADER_FLAGS, prev);
  renderer.destroy();
  return row;
}

const best = (xs: number[]) => (xs.length ? Math.min(...xs) : NaN);
const fmtMs = (v: number) => (Number.isFinite(v) ? v.toFixed(0).padStart(7) : "      -");
const fmtK = (v: number) => (Number.isFinite(v) ? (v / 1e3).toFixed(0).padStart(7) : "      -");

const out: Row[][] = exs.map(() => WAYS.map(blank));
for (let rep = 0; rep < REPS; rep++) {
  for (let e = 0; e < exs.length; e++) {
    for (let w = 0; w < WAYS.length; w++) {
      const r = await time(exs[e], WAYS[w]);
      out[e][w] = { ms: [...out[e][w].ms, ...r.ms], steps: [...out[e][w].steps, ...r.steps] };
    }
  }
}

console.log(`marcher benchmark — best of ${FRAMES} frames after one warm-up, ${REPS} interleaved reps,`);
console.log(`solid view ${W}×${H} (CPU fallback, resolution pinned), camera at the App's auto-fit distance`);
console.log(`eye·N   = march from the eye, no box (the pre-round-23 marcher)   skip·N = bbox empty-space skip\n`);
console.log("ms/frame, then SDF evaluations per frame (thousands):\n");
console.log("example        " + WAYS.map((w) => w.name.padStart(12)).join(""));
for (let e = 0; e < exs.length; e++) {
  console.log(exs[e].id.padEnd(14) + out[e].map((r) => fmtMs(best(r.ms))).join(""));
  console.log("".padEnd(14) + out[e].map((r) => fmtK(best(r.steps))).join(""));
}
const sums = WAYS.map((_, w) => exs.reduce((s, _, e) => s + best(out[e][w].ms), 0));
const evals = WAYS.map((_, w) => exs.reduce((s, _, e) => s + best(out[e][w].steps), 0));
console.log("TOTAL".padEnd(14) + sums.map((v) => v.toFixed(0).padStart(12)).join(""));
console.log("TOTAL evals".padEnd(14) + evals.map((v) => (v / 1e6).toFixed(2).padStart(12)).join(""));
const base = 0, ship = 3;
if (sums[base] > 0) {
  console.log(`\nempty-space skip at 128 steps: ${(sums[base] / sums[ship]).toFixed(2)}× faster wall-clock, ${(evals[base] / Math.max(1, evals[ship])).toFixed(2)}× fewer field evaluations`);
  for (const w of [1, 2, 4]) if (sums[w] > 0) console.log(`steps ${WAYS[w].steps} vs 128 (skip on): ${(sums[ship] / sums[w]).toFixed(2)}× faster, ${(evals[ship] / Math.max(1, evals[w])).toFixed(2)}× fewer evaluations`);
  if (sums[5] > 0) console.log(`branchless raymarch vs branched (both 128, skip on): ${(sums[5] / sums[ship]).toFixed(2)}× slower`);
}
// the comptime half of the round: the step count is a literal in the generated WGSL loop, and the
// wrapper (therefore the pipeline key) changes with it — show it for one example
{
  const ex = exs.find((e) => e.group === "3d") ?? exs[0];
  const r = new Interp(atlas, { viewport: VIEWPORT, time: TIME, mouse: { x: 0, y: 0, down: false }, params: {} }).run(ex.src);
  if (r.shape) {
    const wg = compileTree(r.shape, atlas, "wgsl", null, undefined, "solid");
    console.log(`\ncomptime bound (WGSL of ${ex.id}, the loop the GPU compiles):`);
    for (const n of [32, 128, 256]) {
      const prev = SHADER_FLAGS.sdfSteps;
      SHADER_FLAGS.sdfSteps = n;
      const line = wrapWGSL({ ...wg, solid: true }).split("\n").find((l) => l.includes("for (var i"));
      console.log(`  sdfSteps=${String(n).padStart(3)} → ${line!.trim()}`);
      SHADER_FLAGS.sdfSteps = prev;
    }
  }
}
