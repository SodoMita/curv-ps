// Golden pixel-diff gate (round 17).
//
// Renders every example headlessly through the CPU backend at a fixed size, camera and time,
// hashes the framebuffer and compares it against scripts/golden/pdiff.json.  It also counts
// non-finite distances (a NaN distance paints the pixel pure black, so a whole frame of NaN
// still "renders" — that is exactly the failure this gate exists to catch).
//
//   npx tsx scripts/pdiff.ts            check (exit 1 on any mismatch)
//   npx tsx scripts/pdiff.ts --update   (re)write the golden hashes
//   npx tsx scripts/pdiff.ts [id ...]   only the named examples
//
// The camera is derived from the shape's bbox exactly as selftest.ts does, so a bbox change
// (which moves every pixel) shows up here too: that is deliberate — the 2D camera fit and the
// culling tests both consume bboxOf.
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, setSolveBudget } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
import { bboxOf, finiteBBox } from "../src/curv/shapes";
import { makeJSRuntime } from "../src/gpu/gen";
import { ATLAS_W, ATLAS_H } from "../src/gpu/atlas";
import { createRenderer, type Camera3 } from "../src/gpu/renderer";

(globalThis as any).document = { createElement: (t: string) => { if (t !== "canvas") throw new Error(t); return createCanvas(1, 1) as any; } };
await loadPsolve();
// no per-solve wall-clock budget: a binding budget hands back an incumbent that depends on how
// loaded the machine is, and then the same program hashes differently on two runs (the UI keeps
// its 16 ms budget — this is only the golden-frame gate).
setSolveBudget(0);
const atlas = buildAtlas();

// render configuration — a change here invalidates every hash (the file records it)
const W = 240, H = 160;          // slice mode
const W3 = 96, H3 = 64;          // solid mode (CPU raymarcher, much heavier)
const VW = 900, VH = 600;        // world-space viewport given to the program
const TIME = 1.2;
const BG: [number, number, number] = [0.055, 0.075, 0.13];
const CAM3: Camera3 = { tx: 0, ty: 0, tz: 0, dist: 8, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };
const CONFIG = { W, H, W3, H3, VW, VH, TIME, BG, CAM3 };
const GOLDEN = new URL("./golden/pdiff.json", import.meta.url).pathname;

const R = makeJSRuntime((u, v) => {
  const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5))), y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
  return atlas.data[y * ATLAS_W + x] / 255;
});

const fnv = (b: Uint8ClampedArray): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
};
interface Shot { hash: string; lit: number; nan: number }
interface Golden { config: typeof CONFIG; shots: Record<string, Shot> }

// ---- slice (2D) render: the whole framebuffer, one generated loop ----
function renderSlice(src: string): Shot {
  const it = new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: TIME, mouse: { x: 120, y: 60, down: false }, params: {} });
  const r = it.run(src);
  if (!r.shape) throw new Error("no shape");
  const js = compileTree(r.shape, atlas, "js", null, undefined, "slice");
  const bb = finiteBBox(bboxOf(r.shape, atlas));
  const cam = r.usesViewport
    ? { cx: 0, cy: 0, zoom: W / VW }
    : (() => { const b = bb ?? [-10, -10, 10, 10]; const z = 0.9 * Math.min(W / (b[2] - b[0]), H / (b[3] - b[1])); return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, zoom: z }; })();
  const body = `const zoom=cam.zoom; let nan=0, lit=0;
    for (let j=0;j<H;j++) for (let i=0;i<W;i++){
      const p0=[((i+0.5)-W*0.5)/zoom+cam.cx, -((j+0.5)-H*0.5)/zoom+cam.cy, 0];
${js.code}
      let d=${js.d}; if (d !== d) { d = 1e30; nan++; }
      const col=${js.c}; const aa=Math.min(1,Math.max(0,0.5-d*zoom))*col[3];
      const q=(j*W+i)*4;
      px[q]=(bg[0]+(col[0]-bg[0])*aa)*255; px[q+1]=(bg[1]+(col[1]-bg[1])*aa)*255; px[q+2]=(bg[2]+(col[2]-bg[2])*aa)*255; px[q+3]=255;
    }
    return [nan, lit];`;
  const fn = new Function("P", "R", "W", "H", "cam", "T", "bg", "px", body) as (...a: unknown[]) => number[];
  const cv = createCanvas(W, H); const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H);
  const [nan] = fn(js.params, R, W, H, cam, TIME, BG, img.data);
  ctx.putImageData(img, 0, 0);
  let lit = 0;
  for (let i = 0; i < W * H; i++) {
    const q = i * 4;
    if (Math.abs(img.data[q] - BG[0] * 255) > 1.5 || Math.abs(img.data[q + 1] - BG[1] * 255) > 1.5 || Math.abs(img.data[q + 2] - BG[2] * 255) > 1.5) lit++;
  }
  return { hash: fnv(img.data), lit, nan };
}

// ---- solid (3D) render: the app's own CPU raymarcher, fixed orbit camera ----
const mkCanvas = (w: number, h: number) => {
  const c: any = createCanvas(w, h);
  Object.defineProperty(c, "clientWidth", { get: () => w });
  Object.defineProperty(c, "clientHeight", { get: () => h });
  return c;
};
async function renderSolid(src: string): Promise<Shot> {
  const it = new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: TIME, mouse: { x: -1e6, y: -1e6, down: false }, params: {} });
  const r = it.run(src);
  if (!r.shape) throw new Error("no shape");
  const prog = { ...compileTree(r.shape, atlas, "js", null, undefined, "solid"), solid: true as const };
  const canvas = mkCanvas(W3, H3);
  const renderer = await createRenderer(canvas as any, atlas, "cpu");
  await renderer.render(prog, { cx: 0, cy: 0, zoom: 1 }, BG, TIME, 1, CAM3);
  const img = canvas.getContext("2d").getImageData(0, 0, W3, H3).data;
  renderer.destroy();
  let lit = 0;
  for (let i = 0; i < W3 * H3; i++) {
    const q = i * 4;
    if (Math.abs(img[q] - BG[0] * 255) > 1.5 || Math.abs(img[q + 1] - BG[1] * 255) > 1.5 || Math.abs(img[q + 2] - BG[2] * 255) > 1.5) lit++;
  }
  return { hash: fnv(img), lit, nan: renderer.stats.nan };
}

const args = process.argv.slice(2);
const update = args.includes("--update");
const want = args.filter((a) => !a.startsWith("--"));
const gold: Golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : { config: CONFIG, shots: {} };
if (JSON.stringify(gold.config) !== JSON.stringify(CONFIG)) {
  console.log(`--  render config changed (${GOLDEN})`);
  if (!update) console.log("   (every hash will differ; re-check and run --update)");
}
const shots: Record<string, Shot> = update ? {} : { ...gold.shots };
let fails = 0, missing = 0;
const one = async (id: string, src: string, solid: boolean) => {
  const key = solid ? id + "@solid" : id;
  try {
    const got = solid ? await renderSolid(src) : renderSlice(src);
    shots[key] = got;
    const prev = gold.shots[key];
    if (!prev) {
      missing++;
      console.log(`${update ? "NEW" : "ERR"} ${key.padEnd(18)} no golden  hash=${got.hash} lit=${got.lit} nan=${got.nan}`);
      if (!update) fails++;
      return;
    }
    const bad = prev.hash !== got.hash;
    if (bad) fails++;
    console.log(`${bad ? "ERR" : "OK "} ${key.padEnd(18)} hash=${got.hash}${bad ? " ≠ " + prev.hash : ""} lit=${got.lit}${prev.lit !== got.lit ? ` (was ${prev.lit})` : ""} nan=${got.nan}${got.nan ? "  ← NON-FINITE DISTANCE" : ""}`);
    if (got.nan) { fails++; console.log("    ^ NaN distances: at least one pixel's distance field is not a number"); }
  } catch (e: any) { fails++; console.log(`ERR ${key.padEnd(18)} ${e.message}`); }
};

for (const ex of EXAMPLES) {
  if (want.length && !want.includes(ex.id)) continue;
  await one(ex.id, ex.src, false);
  if (ex.group === "3d") await one(ex.id, ex.src, true);
}
if (update) {
  mkdirSync(new URL("./golden/", import.meta.url).pathname, { recursive: true });
  writeFileSync(GOLDEN, JSON.stringify({ config: CONFIG, shots }, null, 2) + "\n");
  console.log(`\nwrote ${Object.keys(shots).length} golden hashes → ${GOLDEN}`);
} else {
  console.log(fails ? `\n${fails} DIFFS` : `\nall ${Object.keys(shots).length} frames identical to the goldens`);
  if (missing && !update) console.log(`${missing} example(s) without a golden hash — run with --update once they look right`);
}
if (fails) process.exitCode = 1;
