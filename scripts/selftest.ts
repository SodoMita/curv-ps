// Headless check: evaluate every example, compile the shape tree for both
// backends and render it with the JS backend to /tmp/t/<id>.png.
//   npx tsx scripts/selftest.ts [id ...]
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
import { bboxOf, finiteBBox } from "../src/curv/shapes";
import { makeJSRuntime } from "../src/gpu/gen";
import { ATLAS_W, ATLAS_H } from "../src/gpu/atlas";

(globalThis as any).document = { createElement: (t: string) => { if (t !== "canvas") throw new Error(t); return createCanvas(1, 1) as any; } };
await loadPsolve();
const atlas = buildAtlas();
mkdirSync("/tmp/t", { recursive: true });
const W = 240, H = 160;
const R = makeJSRuntime((u, v) => { const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5))), y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5))); return atlas.data[y * ATLAS_W + x] / 255; });

const want = process.argv.slice(2);
const list = [...EXAMPLES.map((e) => ({ id: e.id, src: e.src }))];
for (const f of want) if (existsSync(f)) list.push({ id: f.replace(/.*\//, "").replace(/\.curv$/, ""), src: readFileSync(f, "utf8") });
let fails = 0;
for (const ex of list) {
  if (want.length && !want.includes(ex.id) && !want.some((w) => w.endsWith(ex.id + ".curv"))) continue;
  try {
    const t0 = performance.now();
    const VW = 900, VH = 600; // world-space viewport (centred on the origin, y up)
    const it = new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: 1.2, mouse: { x: 120, y: 60, down: false } });
    const r = it.run(ex.src);
    if (!r.shape) { console.log(`--  ${ex.id}: no shape (value ${String(r.value)})`); continue; }
    const t1 = performance.now();
    const js = compileTree(r.shape, atlas, "js"); const wg = compileTree(r.shape, atlas, "wgsl");
    const t2 = performance.now();
    const bb = finiteBBox(bboxOf(r.shape, atlas));
    const ui = r.usesViewport;
    const cam = ui ? { cx: 0, cy: 0, zoom: W / VW } : (() => { const b = bb ?? [-10, -10, 10, 10]; const z = 0.9 * Math.min(W / (b[2] - b[0]), H / (b[3] - b[1])); return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, zoom: z }; })();
    // the `d !== d` guard is the NaN check: a non-finite distance paints the pixel black and
    // would otherwise look like a legitimate empty frame (see scripts/pdiff.ts for the gate)
    const body = `const zoom=cam.zoom; let nan=0; for (let j=0;j<H;j++) for (let i=0;i<W;i++){ const p0=[((i+0.5)-W*0.5)/zoom+cam.cx, -((j+0.5)-H*0.5)/zoom+cam.cy, 0];\n${js.code}\nlet d=${js.d}; if (d!==d) { d=1e30; nan++; } const col=${js.c}; const aa=Math.min(1,Math.max(0,0.5-d*zoom))*col[3]; const q=(j*W+i)*4; px[q]=(bg[0]+(col[0]-bg[0])*aa)*255; px[q+1]=(bg[1]+(col[1]-bg[1])*aa)*255; px[q+2]=(bg[2]+(col[2]-bg[2])*aa)*255; px[q+3]=255; } return nan;`;
    const fn = new Function("P", "R", "W", "H", "cam", "T", "bg", "px", body) as (...a: unknown[]) => number;
    const cv = createCanvas(W, H); const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    const nan = fn(js.params, R, W, H, cam, 1.2, [0.055, 0.075, 0.13], img.data);
    ctx.putImageData(img, 0, 0);
    const t3 = performance.now();
    writeFileSync(`/tmp/t/${ex.id}.png`, cv.toBuffer("image/png"));
    console.log(`OK  ${ex.id.padEnd(14)} ${r.usesTime ? "anim " : wg.usesTime ? "anim(shader) " : ""}eval ${(t1 - t0).toFixed(1)}ms  codegen ${(t2 - t1).toFixed(1)}ms  cpu-render ${(t3 - t2).toFixed(0)}ms  params=${js.params.length} wgsl=${wg.code.length}b lines=${wg.code.split("\n").length} ${ui ? "ui" : "curv"} bbox=${bb ? bb.map((x) => x.toFixed(1)).join(",") : "inf"} ${r.params.length ? "sliders=" + r.params.map((p) => p.name).join(",") : ""}${nan ? `  *** ${nan} NON-FINITE PIXELS ***` : ""}`);
    if (nan) { fails++; console.log(`ERR ${ex.id}: ${nan} pixels with a non-finite distance`); }
    if (want.includes("--wgsl")) console.log(wg.code);
  } catch (e: any) { fails++; console.log(`ERR ${ex.id}: ${e.message} (line ${e.line})`); if (want.includes("--stack")) console.log(e.stack); }
}
if (fails) process.exitCode = 1;
