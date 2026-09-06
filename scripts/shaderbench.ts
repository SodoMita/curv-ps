// Shader variant benchmark: applies the SHADER_FLAGS ways (see src/gpu/gen.ts) one at a time to every
// example, and for each records
//   • ms of a full raster through the JS backend (the same code the CPU fallback renderer executes,
//     per-pixel branches included),
//   • generated WGSL bytes and the number of `if (` / `for (` (branches / loops the GPU sees).
// Usage: npx tsx scripts/shaderbench.ts [example …]
import { createCanvas } from "@napi-rs/canvas";
import { Interp, compileTree } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas, ATLAS_W, ATLAS_H } from "../src/gpu/atlas";
import { finiteBBox, bboxOf } from "../src/curv/shapes";
import { SHADER_FLAGS, makeJSRuntime, type ShaderFlags } from "../src/gpu/gen";
import { loadPsolve } from "../src/psolve/psolve";

(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();

const args = process.argv.slice(2);
const exs = args.length ? EXAMPLES.filter((e) => args.includes(e.id)) : EXAMPLES;
const base: ShaderFlags = { ...SHADER_FLAGS };
const ways: [string, Partial<ShaderFlags>][] = [
  ["baseline", {}],
  ["poly-select", { polySelect: true }],
  ["text-branchless", { textBranchless: true }],
  ["text-window", { textWindow: true }],
  ["if-flatten", { flattenIf: true }],
  ["unroll-8", { unrollMax: 8 }],
  ["cull-none", { cullWeight: Infinity }],
  ["cull-1", { cullWeight: 1 }],
  ["cull-8", { cullWeight: 8 }],
  ["cull-16", { cullWeight: 16 }],
];


function bench(ex: (typeof EXAMPLES)[number]): { way: string; ms: number; bytes: number; ifs: number; loops: number; params: number }[] {
  const inp = { viewport: { x: -450, y: -300, w: 900, h: 600 }, time: 0.4, mouse: { x: 0, y: 0, down: false } };
  const r = new Interp(atlas, inp).run(ex.src);
  if (!r.shape) return [];
  const bb = finiteBBox(bboxOf(r.shape!, atlas)) ?? [-10, -10, 10, 10];
  const cam = { cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, zoom: Math.min(128 / Math.max(bb[2] - bb[0], 1e-6), 128 / Math.max(bb[3] - bb[1], 1e-6)) };
  const out: ReturnType<typeof bench> = [];
  // probe once: the raster side is fixed per example so every way runs the exact same pixels
  const js0 = compileTree(r.shape!, atlas, "js");
  const R = makeJSRuntime((u: number, v: number) => {
    const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5))), y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
    return atlas.data[y * ATLAS_W + x] / 255;
  });
  const mk = (jsc: typeof js0) => {
    const body = `
      const zoom = cam.zoom;
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const p0 = [((i + 0.5) / scale - RW * 0.5) / zoom + cam.cx, -((j + 0.5) / scale - RH * 0.5) / zoom + cam.cy];
${jsc.code}
        const d = ${jsc.d}, col = ${jsc.c};
        const aa = Math.min(1, Math.max(0, 0.5 - d * zoom)) * col[3];
        const q = (j * W + i) * 4;
        px[q] = (bg[0] + (col[0] - bg[0]) * aa) * 255; px[q + 1] = (bg[1] + (col[1] - bg[1]) * aa) * 255; px[q + 2] = (bg[2] + (col[2] - bg[2]) * aa) * 255; px[q + 3] = 255;
      }`;
    return new Function("P", "R", "W", "H", "scale", "cam", "T", "bg", "px", "RW", "RH", body) as (P: Float32Array, R: unknown, W: number, H: number, scale: number, cam: object, T: number, bg: number[], px: Uint8ClampedArray, RW: number, RH: number) => void;
  };
  const bg = [0, 0, 0, 1];
  const pf = mk(js0); const probe = new Uint8ClampedArray(32 * 32 * 4);
  const pw = performance.now(); pf(js0.params, R, 32, 32, 1, cam, 0.4, bg, probe, 32, 32);
  const perPx = (performance.now() - pw) / 1024;
  const side = Math.max(24, Math.min(128, Math.round(Math.sqrt(Math.min(0.04 / Math.max(perPx, 0.00004), 1) * 128))));
  Object.assign(SHADER_FLAGS, base);
  // compile + warm every way, then time interleaved rounds, best frame-ms of any round
  // (first-run JIT effects would otherwise masquerade as differences between identical code)
  const pre: { name: string; wg: ReturnType<typeof compileTree>; js: typeof js0; f: ReturnType<typeof mk> }[] = [];
  for (const [name, wf] of ways) {
    Object.assign(SHADER_FLAGS, base, wf);
    const wg = compileTree(r.shape!, atlas, "wgsl");
    const js = compileTree(r.shape!, atlas, "js");
    const f = mk(js);
    const wm = Math.min(32, side); const warm = new Uint8ClampedArray(wm * wm * 4);
    f(js.params, R, wm, wm, 1, cam, 0.41, bg, warm, wm, wm);
    pre.push({ name, wg, js, f });
  }
  const px = new Uint8ClampedArray(side * side * 4);
  const best = new Map<string, number>();
  for (let round = 0; round < 4; round++) {
    for (const { name, js: jsc, f } of pre) {
      const t0 = performance.now();
      f(jsc.params, R, side, side, 1, cam, 0.42, bg, px, side, side);
      const msm = performance.now() - t0;
      const cur = best.get(name);
      if (cur === undefined || msm < cur) best.set(name, msm);
    }
  }
  for (const { name, wg, js: jsc } of pre)
    out.push({ way: name, ms: best.get(name)!, bytes: wg.code.length, ifs: (wg.code.match(/\bif \(/g) ?? []).length, loops: (wg.code.match(/\bfor \(/g) ?? []).length, params: jsc.params.length });
  Object.assign(SHADER_FLAGS, base);
  return out;
}

const totals = new Map<string, { ms: number; base: number; bytes: number; ifs: number; loops: number }>();
for (const ex of exs) {
  const rows = bench(ex);
  if (!rows.length) continue;
  const b = rows[0];
  console.log(`${ex.id} (baseline ${b.ms.toFixed(1)} ms, ${(b.bytes / 1024).toFixed(1)} kB WGSL, ${b.ifs} ifs, ${b.loops} loops, ${b.params} params)`);
  for (const r of rows) {
    console.log(`   ${r.way.padEnd(16)} ${r.ms.toFixed(1).padStart(7)} ms (${r.ms >= b.ms ? "+" : ""}${(((r.ms - b.ms) / b.ms) * 100).toFixed(0).padStart(4)}%)  ${(r.bytes / 1024).toFixed(1).padStart(6)} kB  ${String(r.ifs).padStart(3)} ifs ${String(r.loops).padStart(3)} loops`);
    if (exs.length > 1) {
      const t = totals.get(r.way) ?? { ms: 0, base: 0, bytes: 0, ifs: 0, loops: 0 };
      t.ms += r.ms; t.base += b.ms; t.bytes += r.bytes; t.ifs += r.ifs; t.loops += r.loops;
      totals.set(r.way, t);
    }
  }
}
if (totals.size) {
  console.log("\nTOTAL (sum over examples)");
  for (const [way, t] of totals) console.log(`   ${way.padEnd(16)} ${t.ms.toFixed(0).padStart(7)} ms (${t.ms >= t.base ? "+" : ""}${(((t.ms - t.base) / t.base) * 100).toFixed(0).padStart(4)}%)  ${(t.bytes / 1024).toFixed(0).padStart(6)} kB  ${String(t.ifs).padStart(4)} ifs ${String(t.loops).padStart(4)} loops`);
}
