// Flag-invariance gate (round 21).
//
// The `gen:` menu lets the user flip any SHADER_FLAGS option at runtime.  Three things must hold
// for every setting a user can select:
//
//   (1) the flip really reaches codegen: the code a flag setting produces must not depend on which
//       setting was compiled before it.  The code LRU is keyed on the structural key, so a flag
//       that only changes *emission* (branchless, cullSelect, noShortCircuit, polySelect, …) is
//       invisible to that key — compile the same shape under two settings and the second compile
//       can be served the first one's text.  Running the settings in two orders and comparing is
//       what catches it: the text must be a pure function of (shape, target, mode, flags).
//   (2) the parameter buffer must not move: the memoised tree walk feeds it, so a flag may not
//       reorder or resize it.
//   (3) the rendered pixels must not change, in either view mode: an option may only cost time.
//
//   npx tsx scripts/flagcheck.ts [id ...]
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, collectParamsFast, setSolveBudget } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas, ATLAS_W, ATLAS_H } from "../src/gpu/atlas";
import { bboxOf, finiteBBox } from "../src/curv/shapes";
import { makeJSRuntime, SHADER_FLAGS } from "../src/gpu/gen";
import { createRenderer, type Camera3 } from "../src/gpu/renderer";

(globalThis as any).document = {
  createElement: (t: string) => { if (t !== "canvas") throw new Error(t); return createCanvas(1, 1) as any; },
};
await loadPsolve();
setSolveBudget(0); // no per-solve wall-clock budget (see pdiff.ts): one program must render twice identically
const atlas = buildAtlas();

// render configuration — small: this gate compares flag settings with each other, not with goldens
const W = 96, H = 64;            // slice
const W3 = 40, H3 = 28;          // solid (CPU raymarcher)
const VW = 900, VH = 600, TIME = 1.2;
const BG: [number, number, number] = [0.055, 0.075, 0.13];
const CAM3: Camera3 = { tx: 0, ty: 0, tz: 0, dist: 8, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };

const R = makeJSRuntime((u, v) => {
  const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5)));
  const y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
  return atlas.data[y * ATLAS_W + x] / 255;
});

const fnv = (b: Uint8ClampedArray | string): string => {
  let h = 0x811c9dc5;
  const n = typeof b === "string" ? b.length : b.length;
  for (let i = 0; i < n; i++) { h ^= typeof b === "string" ? b.charCodeAt(i) : b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
};

type Flags = Partial<typeof SHADER_FLAGS>;
// every setting the menu can produce: the shipped default, everything off, the master switch, each
// branch option on its own, and the two groups of "other codegen" rows
const COMBOS: { name: string; flags: Flags }[] = [
  { name: "shipped", flags: { polySelect: false, textBranchless: false, cullWeight: 4, flattenIf: false, unrollMax: 0, textWindow: false, branchless: false, noShortCircuit: true, cullSelect: false, branchless3D: false, sdfSteps: 128 } },
  { name: "all-off", flags: { polySelect: false, textBranchless: false, cullWeight: 4, flattenIf: false, unrollMax: 0, textWindow: false, branchless: false, noShortCircuit: false, cullSelect: false, branchless3D: false, sdfSteps: 128 } },
  { name: "branchless", flags: { polySelect: false, textBranchless: false, cullWeight: 4, flattenIf: false, unrollMax: 0, textWindow: false, branchless: true, noShortCircuit: true, cullSelect: false, branchless3D: false, sdfSteps: 128 } },
  { name: "cullSelect", flags: { polySelect: false, textBranchless: false, cullWeight: 4, flattenIf: false, unrollMax: 0, textWindow: false, branchless: false, noShortCircuit: true, cullSelect: true, branchless3D: false, sdfSteps: 128 } },
  { name: "branchless3D", flags: { polySelect: false, textBranchless: false, cullWeight: 4, flattenIf: false, unrollMax: 0, textWindow: false, branchless: false, noShortCircuit: true, cullSelect: false, branchless3D: true, sdfSteps: 128 } },
  { name: "selects", flags: { polySelect: true, textBranchless: true, cullWeight: 4, flattenIf: true, unrollMax: 0, textWindow: true, branchless: false, noShortCircuit: true, cullSelect: false, branchless3D: false, sdfSteps: 128 } },
  { name: "unroll8+cull1", flags: { polySelect: false, textBranchless: false, cullWeight: 1, flattenIf: false, unrollMax: 8, textWindow: false, branchless: false, noShortCircuit: true, cullSelect: false, branchless3D: false, sdfSteps: 128 } },
];
const setFlags = (f: Flags) => { Object.assign(SHADER_FLAGS, f); };
const BASE = COMBOS[0].flags;

interface Shot { hash: string; nan: number; lit: number }
function renderSlice(src: string): { shot: Shot; params: number[]; walk: number[]; code: string; key: string | null; reused: boolean } {
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
  // the App feeds the *walked* buffer every frame (codegen only runs when the tree changes), so the
  // render must use it too: a walk that disagrees with codegen has to show up here as pixels.
  const walk = collectParamsFast(r.shape, atlas, undefined, true);
  const fn = new Function("P", "R", "W", "H", "cam", "T", "bg", "px", body) as (...a: unknown[]) => number[];
  const cv = createCanvas(W, H); const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H);
  const [nan] = fn(walk, R, W, H, cam, TIME, BG, img.data);
  ctx.putImageData(img, 0, 0);
  return { shot: { hash: fnv(img.data), nan }, params: [...js.params], walk: [...walk], code: js.code, key: js.key, reused: !!js.reused };
}

const mkCanvas = (w: number, h: number) => {
  const c: any = createCanvas(w, h);
  Object.defineProperty(c, "clientWidth", { get: () => w });
  Object.defineProperty(c, "clientHeight", { get: () => h });
  return c;
};
let solidWalk: { code: number[]; walk: number[] } | null = null;
async function renderSolid(src: string): Promise<Shot> {
  const it = new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: TIME, mouse: { x: -1e6, y: -1e6, down: false }, params: {} });
  const r = it.run(src);
  if (!r.shape) throw new Error("no shape");
  const compiled = compileTree(r.shape, atlas, "js", null, undefined, "solid");
  const walkSolid = collectParamsFast(r.shape, atlas, undefined, false);
  solidWalk = { code: [...compiled.params], walk: [...walkSolid] };
  const prog = { ...compiled, params: walkSolid, solid: true as const };
  const canvas = mkCanvas(W3, H3);
  const renderer = await createRenderer(canvas as any, atlas, "cpu");
  await renderer.render(prog, { cx: 0, cy: 0, zoom: 1 }, BG, TIME, 1, CAM3);
  const img = canvas.getContext("2d").getImageData(0, 0, W3, H3).data;
  const nan = renderer.stats.nan;
  renderer.destroy();
  let lit = 0;
  for (let i = 0; i < W3 * H3; i++) {
    const q = i * 4;
    if (Math.abs(img[q] - BG[0] * 255) > 1.5 || Math.abs(img[q + 1] - BG[1] * 255) > 1.5 || Math.abs(img[q + 2] - BG[2] * 255) > 1.5) lit++;
  }
  return { hash: fnv(img), nan, lit };
}

const want = process.argv.slice(2).filter((a) => !a.startsWith("--"));
let fails = 0;
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

for (const ex of EXAMPLES) {
  if (want.length && !want.includes(ex.id)) continue;
  const notes: string[] = [], info: string[] = [];
  let basePx = "", baseSolid = "", baseParams: number[] = [];
  let keyed = false;   // does this shape have a structural key (i.e. can the code LRU cache it)?
  // ---- pass 0: the two view modes must not share a compiled program.  `structKey` used to be
  //      mode-blind, so a program compiled in 2D first was served its 2D shader in the 3D view
  //      (rings3d: 12.9% of the pixels differ) and the other way round.
  {
    setFlags(BASE);
    const run = (mode: "slice" | "solid") => {
      const r = new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: TIME, mouse: { x: 120, y: 60, down: false }, params: {} }).run(ex.src);
      return r.shape ? compileTree(r.shape, atlas, "wgsl", null, undefined, mode) : null;
    };
    const sl = run("slice"), so = run("solid");
    if (sl && so && sl.key !== null && (sl.reused || so.reused)) {
      fails++;
      notes.push(`view modes share a compiled program (slice reused=${!!sl.reused}, solid reused=${!!so.reused})`);
    }
  }
  // ---- pass 1, settings in menu order: pixels, parameters, and the code each setting produces
  const seen: Record<string, string> = {};
  for (const combo of COMBOS) {
    setFlags(combo.flags);
    try {
      const s = renderSlice(ex.src);
      if (!same(s.walk, s.params)) { fails++; notes.push(`${combo.name}: walked buffer ≠ codegen buffer (${s.walk.length} vs ${s.params.length})`); }
      if (combo === COMBOS[0]) { basePx = s.shot.hash; baseParams = s.params; keyed = s.key !== null; if (s.shot.nan) { fails++; notes.push(`shipped: non-finite distance ×${s.shot.nan}`); } continue; }
      if (s.params.length !== baseParams.length) info.push(`note: ${combo.name} buffer is ${s.params.length} params (shipped: ${baseParams.length}) — cull brackets carry bboxes, a size change is fine`);
      const wg = compileTree(new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: TIME, mouse: { x: 120, y: 60, down: false }, params: {} }).run(ex.src).shape!, atlas, "wgsl", null, undefined, "slice");
      seen[combo.name] = fnv(wg.code);
      if (s.shot.hash !== basePx) { fails++; notes.push(`${combo.name}: slice pixels differ ${s.shot.hash} vs ${basePx}`); }
      if (s.shot.nan) { fails++; notes.push(`${combo.name}: non-finite distance ×${s.shot.nan}`); }
    } catch (e: any) { fails++; notes.push(`${combo.name}: ${e.message}`); }
  }
  if (ex.group === "3d") {
    for (const combo of COMBOS) {
      setFlags(combo.flags);
      try {
        const s = await renderSolid(ex.src);
        if (combo === COMBOS[0]) { baseSolid = s.hash; if (s.nan) { fails++; notes.push(`shipped/solid: non-finite distance ×${s.nan}`); } continue; }
        if (solidWalk && !same(solidWalk.walk, solidWalk.code)) { fails++; notes.push(`${combo.name}/solid: walked buffer ≠ codegen buffer (${solidWalk.walk.length} vs ${solidWalk.code.length})`); }
        if (s.hash !== baseSolid) { fails++; notes.push(`${combo.name}: solid pixels differ ${s.hash} vs ${baseSolid}`); }
        if (s.nan) { fails++; notes.push(`${combo.name}/solid: non-finite distance ×${s.nan}`); }
      } catch (e: any) { fails++; notes.push(`${combo.name}/solid: ${e.message}`); }
    }
  }
  // ---- pass 2, settings in reverse order: the code must be identical to pass 1 for each setting,
  //      i.e. independent of which setting was compiled before it
  for (let i = COMBOS.length - 1; i >= 1; i--) {
    const combo = COMBOS[i];
    setFlags(combo.flags);
    try {
      const it = new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: TIME, mouse: { x: 120, y: 60, down: false }, params: {} });
      const r = it.run(ex.src);
      if (!r.shape) throw new Error("no shape");
      const wg = compileTree(r.shape, atlas, "wgsl", null, undefined, "slice");
      if (wg.reused && fnv(wg.code) !== seen[combo.name]) {
        fails++;
        notes.push(`${combo.name}: code depends on the previous setting — ${keyed ? "stale code-LRU hit (shader did not change)" : "reused text from an earlier compilation"}`);
      }
    } catch (e: any) { fails++; notes.push(`${combo.name}: ${e.message}`); }
  }
  setFlags(BASE);
  if (notes.length) console.log(`ERR ${ex.id.padEnd(14)}${keyed ? " (structural key: cacheable)" : ""}\n    ${notes.join("\n    ")}`);
  else console.log(`OK  ${ex.id.padEnd(14)} ${COMBOS.length - 1} settings: pixels + params unchanged, code order-independent`);
  for (const i of info) console.log(`    ${i}`);
}
setFlags(BASE);

// ---- the sdf-steps setting: a quality knob, not an invariance knob ------------------------
// Unlike every other option in the menu, the step count MAY change the solid view's pixels —
// trading grazing-surface fidelity for march time is its point.  What must still hold:
//   • the 2D slice view has no marcher, so its pixels cannot move with the count
//   • the parameter buffer and the generated body do not move (the flag is deliberately absent
//     from flagsKey — body/param caches stay valid across a change)
//   • hits are monotone in the count: the first N steps of an M-step march are the same march,
//     so lit(32) ≤ lit(64) ≤ lit(128) ≤ lit(256), and the NaN count likewise
console.log("\nsdf steps (3d group)");
for (const ex of EXAMPLES.filter((e) => e.group === "3d")) {
  if (want.length && !want.includes(ex.id)) continue;
  const save = { ...SHADER_FLAGS };
  const notes: string[] = [];
  try {
    setFlags(BASE);
    SHADER_FLAGS.sdfSteps = 128;
    const base = renderSlice(ex.src);
    let baseParams: number[] | null = null, baseCode = "";
    const lit: number[] = [], nan: number[] = [];
    for (const n of [32, 64, 128, 256]) {
      SHADER_FLAGS.sdfSteps = n;
      const sl = renderSlice(ex.src);
      if (sl.shot.hash !== base.shot.hash) notes.push(`steps=${n}: slice pixels differ — the 2D view has no marcher`);
      if (sl.shot.nan) notes.push(`steps=${n}: non-finite distance ×${sl.shot.nan} in the slice view`);
      const r2 = new Interp(atlas, { viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH }, time: TIME, mouse: { x: 120, y: 60, down: false }, params: {} }).run(ex.src);
      const js = compileTree(r2.shape!, atlas, "js", null, undefined, "slice");
      if (baseParams === null) { baseParams = [...js.params]; baseCode = js.code; }
      else {
        if (js.params.length !== baseParams.length || js.params.some((v, i) => v !== baseParams[i])) notes.push(`steps=${n}: parameter buffer moved`);
        if (js.code !== baseCode) notes.push(`steps=${n}: body code moved`);
      }
      const so = await renderSolid(ex.src);
      lit.push(so.lit); nan.push(so.nan);
    }
    for (let i = 1; i < lit.length; i++) {
      if (lit[i] < lit[i - 1]) notes.push(`lit pixels went down as steps went up (${lit.join(", ")}) — the first N steps of an M-step march are the same march`);
      if (nan[i] < nan[i - 1]) notes.push(`NaN count went down as steps went up (${nan.join(", ")})`);
    }
    if (notes.length) { fails++; console.log(`ERR ${ex.id.padEnd(14)}\n    ${notes.join("\n    ")}`); }
    else console.log(`OK  ${ex.id.padEnd(14)} 2d untouched · params/body fixed · lit ${lit.join(" ≤ ")}`);
  } catch (e: any) { fails++; console.log(`ERR ${ex.id.padEnd(14)} ${e.message}`); }
  finally { Object.assign(SHADER_FLAGS, save); }
}
setFlags(BASE);

console.log(fails ? `\n${fails} FLAG FAILURES` : `\nevery flag setting renders identically (${COMBOS.length} settings × ${EXAMPLES.length} examples)`);
if (fails) process.exitCode = 1;
