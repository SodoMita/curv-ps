// Headless 3D pipeline checks: every example evaluates, every 3D program compiles in solid mode
// (JS + WGSL codegen), bbox3 is sane, and the CPU raymarcher actually draws the shapes
// (centre hit / background outside / slice parity) using @napi-rs/canvas.
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, show } from "../src/curv/interp";
import { bbox3Of, marchBoxOf, bboxOf, flat2D, BB_PAD_K } from "../src/curv/shapes";
import { buildAtlas, ATLAS_W, ATLAS_H } from "../src/gpu/atlas";
import { makeJSRuntime } from "../src/gpu/gen";
import { createRenderer, jsStepFn, type Camera3 } from "../src/gpu/renderer";
import { EXAMPLES } from "../src/curv/examples";

const CW = 96, CH = 64;
const mkCanvas = () => {
  const c: any = createCanvas(CW, CH);
  Object.defineProperty(c, "clientWidth", { get: () => CW });
  Object.defineProperty(c, "clientHeight", { get: () => CH });
  return c;
};
(globalThis as any).document = { createElement: () => mkCanvas() as any };

await loadPsolve();
const atlas = buildAtlas();
let fails = 0;
const ok = (name: string, good: boolean, extra = "") => {
  if (!good) fails++;
  console.log(`${good ? "OK " : "ERR"} ${name.padEnd(34)}${extra}`);
};
const BG: [number, number, number] = [0.055, 0.075, 0.133]; // dark
const interp = (w: number, h: number, t: number) =>
  new Interp(atlas, { viewport: { x: -w / 2, y: -h / 2, w, h }, time: t, mouse: { x: -1e6, y: -1e6, down: false }, params: {} });
// 3D programs evaluate fine at the render size; 2D examples assume a desktop viewport
const run = (src: string, t = 0) => interp(CW, CH, t).run(src);
const run2D = (src: string, t = 0) => interp(960, 600, t).run(src);
const finiteBBox3 = (b: number[] | null): number[] | null => (b && b.length === 6 && b.every(Number.isFinite) ? b : null);

// ---- 1. every example evaluates (2D mode) ----
console.log("evaluate (2D mode)");
for (const ex of EXAMPLES) {
  try {
    const r = ex.group === "3d" ? run(ex.src) : run2D(ex.src);
    if (ex.group !== "3d" && r.shape === null) { ok(ex.id, false, "(no shape)"); continue; }
    ok(ex.id, true, ex.group === "3d" ? "[3d]" : "");
  } catch (e: any) { ok(ex.id, false, e.message); }
}

// ---- 2. 3D examples compile in solid mode, both targets ----
console.log("\ncompile solid (js + wgsl)");
for (const ex of EXAMPLES.filter((e) => e.group === "3d")) {
  try {
    const r = run(ex.src);
    const js = compileTree(r.shape!, atlas, "js", null, undefined, "solid");
    const wg = compileTree(r.shape!, atlas, "wgsl", null, undefined, "solid");
    ok(ex.id, js.code.length > 0 && wg.code.length > 0, `js ${js.code.split("\n").length}L / wgsl ${wg.code.split("\n").length}L / ${js.params.length} params`);
  } catch (e: any) { ok(ex.id, false, e.message); }
}

// ---- 3. bbox3 sanity ----
console.log("\nbbox3");
{
  const bb = (src: string) => bbox3Of(run(src).shape!, atlas);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const s = finiteBBox3(bb("sphere 4"));
  ok("sphere 4 → [-2,-2,-2,2,2,2]", s !== null && s.every((v, i) => near(v, [-2, -2, -2, 2, 2, 2][i])), JSON.stringify(s));
  const c = finiteBBox3(bb("cylinder {d: 2, h: 3}"));
  ok("cylinder {d:2,h:3} → z ±1.5", c !== null && near(c[2], -1.5) && near(c[5], 1.5), JSON.stringify(c));
  const b3 = finiteBBox3(bb("box3 [2, 4, 6]"));
  ok("box3 [2,4,6] → ±1/±2/±3", b3 !== null && b3.every((v, i) => near(v, [-1, -2, -3, 1, 2, 3][i])), JSON.stringify(b3));
  const u = finiteBBox3(bb("union [sphere 2 >> move [3, 0, 0], sphere 2]"));
  ok("union span x ∈ [-1, 4]", u !== null && near(u[0], -1) && near(u[3], 4), JSON.stringify(u));
}

// ---- 3b. shape record: is_2d / is_3d flags + dimensional bbox (C++ parity) ----
console.log("\nshape record");
{
  const val = (src: string): string => {
    try { return show(run(src).value); } catch (e: any) { return "ERR " + e.message; }
  };
  const eq = (name: string, src: string, want: string) => ok(name, val(src) === want, val(src));
  eq("circle 2 .is_2d → true", "circle 2 .is_2d", "true");
  eq("circle 2 .is_3d → false", "circle 2 .is_3d", "false");
  eq("sphere 4 .is_3d → true", "sphere 4 .is_3d", "true");
  eq("sphere 4 .bbox → 3D box", "sphere 4 .bbox", "[[-2, -2, -2], [2, 2, 2]]");
  eq("circle 2 .bbox → z=0 slab", "circle 2 .bbox", "[[-1, -1, 0], [1, 1, 0]]");
  eq("cylinder .bbox → z ±1.5", "let s = cylinder {d: 2, h: 3} in s.bbox", "[[-1, -1, -1.5], [1, 1, 1.5]]");
  eq("show_dist 3D child: is_2d true", "let s = show_dist (sphere 4) in s.is_2d", "true");
  eq("show_dist 3D child: is_3d true", "let s = show_dist (sphere 4) in s.is_3d", "true");
}

// ---- 3c. a 2D shape in the 3D view is a plate, not an infinite prism ----
// A 2D shape's distance ignores z, so text in the 3D view turned into a slab receding for ever.
// Every maximal 2D subtree is now intersected with a slab |z| <= FLAT_K * (camera distance), which
// is about one pixel on screen.  This is the oracle: a point inside the shape at z = 0 must be
// well outside it a little way up, and a 3D shape must keep its depth.
console.log("\n2D shapes are flat in the 3D view");
{
  const R = makeJSRuntime((u, v) => {
    const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5)));
    const y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
    return atlas.data[y * ATLAS_W + x] / 255;
  });
  // the CPU body takes the camera distance as RAD (the WGSL body reads the same from u.cam3a.w)
  const field = (src: string, w = 960, h = 600) => {
    const r = interp(w, h, 0).run(src);
    const c = compileTree(r.shape!, atlas, "js", null, undefined, "solid");
    const step = jsStepFn(c, R);   // the renderer's own step function, camera distance included
    return { d: (x: number, y: number, z: number, rad: number) => step(c.params, 0, [x, y, z], rad), flat: flat2D(r.shape!) };
  };
  {
    const rad = 10, h = rad * 0.001;                    // plate: ±0.01 thick
    const c = field("circle 2");
    ok("circle: solid in its plane", c.d(0, 0, 0, rad) < 0, `d=${c.d(0, 0, 0, rad).toFixed(3)}`);
    ok("circle: not a prism (z=10 outside)", c.d(0, 0, 10, rad) > 9, `d=${c.d(0, 0, 10, rad).toFixed(2)}`);
    ok("circle: the plate is thin (z=0.05 outside)", c.d(0, 0, 0.05, rad) > 0 && h < 0.05, `d=${c.d(0, 0, 0.05, rad).toFixed(4)}`);
    const s = field("sphere 2");            // `sphere d` has RADIUS d/2: the point z=1 is on the surface
    ok("sphere keeps its depth (z=0.5 inside)", s.d(0, 0, 0.5, rad) < 0, `d=${s.d(0, 0, 0.5, rad).toFixed(3)}`);
    ok("sphere: still a ball, not a plate (z=0.9 inside)", s.d(0, 0, 0.9, rad) < 0, `d=${s.d(0, 0, 0.9, rad).toFixed(3)}`);
    // extrude slices its child at z = 0: flattening that child would cap the height at the plate's
    const e = field("extrude 2 (circle 1)");   // h = 2 is the FULL height in Curv (half = 1)
    ok("extrude: inside at z=0.9", e.d(0, 0, 0.9, rad) < 0, `d=${e.d(0, 0, 0.9, rad).toFixed(3)}`);
    ok("extrude: outside at z=1.5", e.d(0, 0, 1.5, rad) > 0, `d=${e.d(0, 0, 1.5, rad).toFixed(3)}`);
  }
  // every 2D example: no point of the shape may extend above its own plane
  let checked = 0;
  for (const ex of EXAMPLES.filter((e) => e.group !== "3d")) {
    try {
      const f = field(ex.src);
      if (!f.flat) continue;
      const bb = bboxOf(run2D(ex.src).shape!, atlas);
      if (!bb || !bb.every(Number.isFinite)) continue;
      const rad = Math.max(1, 0.5 * Math.hypot(bb[2] - bb[0], bb[3] - bb[1])) * 3;
      let inside: [number, number] | null = null;
      for (let j = 1; j < 24 && !inside; j++) for (let i = 1; i < 24 && !inside; i++) {
        const x = bb[0] + ((bb[2] - bb[0]) * i) / 24, y = bb[1] + ((bb[3] - bb[1]) * j) / 24;
        if (f.d(x, y, 0, rad) < -0.05) inside = [x, y];
      }
      if (!inside) continue;
      checked++;
      const up = f.d(inside[0], inside[1], rad * 0.5, rad);
      ok(`flat ${ex.id}`, up > 0, `d(z=${(rad * 0.5).toFixed(0)})=${up.toFixed(2)}`);
    } catch (e: any) { ok(`flat ${ex.id}`, false, e.message); }
  }
  ok("≥5 examples checked for flatness", checked >= 5, `${checked} checked`);
}

// ---- 4. CPU raymarcher: real pixels ----
console.log("\ncpu raymarch render");
const canvas = mkCanvas();
const renderer = await createRenderer(canvas as any, atlas, "cpu");
const cam3: Camera3 = { tx: 0, ty: 0, tz: 0, dist: 8, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };
const pixels = () => canvas.getContext("2d").getImageData(0, 0, CW, CH).data as Uint8ClampedArray;
const at = (px: Uint8ClampedArray, x: number, y: number) => {
  const q = (y * CW + x) * 4;
  return [px[q], px[q + 1], px[q + 2]];
};
const isBg = (c: number[]) => c.every((v, i) => Math.abs(v - BG[i] * 255) < 1.5);
const render3 = async (src: string, t = 0, c3: Camera3 = cam3) => {
  const r = run(src, t);
  const prog = { ...compileTree(r.shape!, atlas, "js", null, undefined, "solid"), solid: true };
  await renderer.render(prog, { cx: 0, cy: 0, zoom: 1 }, BG, t, 1, c3);
  return pixels();
};
{
  const ball = `sphere 4 >> colour (sRGB[0.9, 0.3, 0.3])`;
  try {
    const px = await render3(ball);
    const centre = at(px, CW >> 1, CH >> 1);
    const corner = at(px, 4, 4);
    ok("ball: centre lit", !isBg(centre), `rgb(${centre.join(",")})`);
    ok("ball: corner background", isBg(corner), `rgb(${corner.join(",")})`);
    // lit ≠ flat colour: shading varies across the disc
    let varied = 0;
    for (let i = 0; i < 200; i++) if (!isBg(at(px, 20 + (i % 56), 16 + (i % 32)))) varied++;
    ok("ball: ≥100 lit pixels", varied > 100, `${varied} px`);
  } catch (e: any) { ok("ball", false, e.message); }
  try {
    // slice parity: the same ball compiled in slice mode draws a filled disc in 2D
    const r = run(ball);
    const prog = { ...compileTree(r.shape!, atlas, "js", null, undefined, "slice"), solid: false };
    await renderer.render(prog, { cx: 0, cy: 0, zoom: 10 }, BG, 0, 1);
    const px = pixels();
    const centre = at(px, CW >> 1, CH >> 1);
    const far = at(px, CW - 8, 8);
    ok("ball slice: centre drawn", !isBg(centre), `rgb(${centre.join(",")})`);
    ok("ball slice: far corner bg", isBg(far), `rgb(${far.join(",")})`);
  } catch (e: any) { ok("ball slice", false, e.message); }
}
// per-example camera overrides; the gyroid's ball clip (r = 15) swallows the home camera,
// so pull back to see its silhouette
const camFor: Record<string, Partial<Camera3>> = { gyroid3d: { dist: 50 } };
// the show_gradient z = 0 diagnostic sheet legitimately covers the whole view
const fullFrame = new Set(["grad3d"]);
for (const ex of EXAMPLES.filter((e) => e.group === "3d" && !["ball3d", "pulse3d"].includes(e.id))) {
  try {
    const px = await render3(ex.src, 0, { ...cam3, ...camFor[ex.id] });
    let lit = 0;
    for (let i = 0; i < CW * CH; i++) if (!isBg(at(px, i % CW, (i / CW) | 0))) lit++;
    const frac = lit / (CW * CH);
    ok(`render ${ex.id}`, lit > 20 && (fullFrame.has(ex.id) || frac < 0.9), `${lit} px (${(frac * 100).toFixed(1)}%)`);
  } catch (e: any) { ok(`render ${ex.id}`, false, e.message); }
}
// animated: two different times give different frames, both render
try {
  const pulse = EXAMPLES.find((e) => e.id === "pulse3d")!.src;
  const a = await render3(pulse, 0.5);
  const b = await render3(pulse, 4.0);
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2) diff++;
  ok("pulse: t=0.5 vs t=4 differ", diff > 50, `${diff} px differ`);
} catch (e: any) { ok("pulse anim", false, e.message); }

// ---- 5. the marcher's empty-space skip is sound and pixel-preserving -----------------------
// The solid view intersects each ray with the scene's bounding box (padded by BB_PAD_K·rad, see
// renderer.ts) before marching: a ray that misses the box paints background without one field
// evaluation, a ray that meets it starts at the entry.  Two oracles:
//   (a) soundness — the field cannot register a hit outside the padded box (d ≥ the 0.001 hit
//       epsilon there), so the skipped segments contain no surface.  The pad exists because a
//       flattened 2D shape is a slab ±FLAT_K·rad thick while its own box has zero z extent.
//   (b) parity — the same program rendered with the box and without it (the renderer then marches
//       from the eye, the pre-round-23 path) agrees pixel-for-pixel up to floating-point path
//       differences: grazing rays may flip at a silhouette, but materially the frames are the same.
console.log("\nempty-space skip");
{
  const R = makeJSRuntime((u, v) => {
    const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5)));
    const y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
    return atlas.data[y * ATLAS_W + x] / 255;
  });
  const field = (src: string) => {
    const r = interp(960, 600, 0).run(src);
    const c = compileTree(r.shape!, atlas, "js", null, undefined, "solid");
    const step = jsStepFn(c, R);
    return (x: number, y: number, z: number, rad: number) => step(c.params, 0, [x, y, z], rad);
  };
  let sound = 0;
  for (const ex of EXAMPLES) {
    try {
      const r = ex.group === "3d" ? run(ex.src) : run2D(ex.src);
      if (!r.shape) continue;
      const bb = marchBoxOf(r.shape, atlas);
      if (!bb) { if (ex.group === "3d" && ex.id !== "grad3d") ok(`box: ${ex.id}`, false, "3d example without a finite box"); continue; }
      const rad = ex.group === "3d" ? (camFor[ex.id]?.dist ?? 8) : 100;
      const pad = Math.max(0.01, BB_PAD_K * rad);
      const cx = (bb[0] + bb[3]) / 2, cy = (bb[1] + bb[4]) / 2, cz = (bb[2] + bb[5]) / 2;
      const ex3 = (bb[3] - bb[0]) / 2 || 1, ey3 = (bb[4] - bb[1]) / 2 || 1, ez3 = (bb[5] - bb[2]) / 2 || 1;
      const d = field(ex.src);
      // shell of sample points strictly outside the padded box: face centres, edge midpoints,
      // corners — and, right above/below the centre, the plate-thickness case the pad exists for
      const pts: [number, number, number][] = [];
      for (const k of [1.2, 2.5]) {
        pts.push([cx + (ex3 + k * pad), cy, cz], [cx - (ex3 + k * pad), cy, cz], [cx, cy + (ey3 + k * pad), cz], [cx, cy - (ey3 + k * pad), cz], [cx, cy, cz + (ez3 + k * pad)], [cx, cy, cz - (ez3 + k * pad)]);
        pts.push([cx + (ex3 + k * pad), cy + (ey3 + k * pad), cz + (ez3 + k * pad)], [cx - (ex3 + k * pad), cy - (ey3 + k * pad), cz - (ez3 + k * pad)]);
        pts.push([cx, cy, cz + (ez3 + k * pad) + 0.5 * pad], [cx, cy, cz - (ez3 + k * pad) - 0.5 * pad]); // just past the pad, inside the footprint
      }
      let worst = Infinity, at = "";
      for (const [x, y, z] of pts) { const v = d(x, y, z, rad); if (v < worst) { worst = v; at = `(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`; } }
      ok(`box bounds the field: ${ex.id}`, worst >= 0.001, `min d=${worst.toFixed(4)} at ${at}`);
      if (worst >= 0.001) sound++;
    } catch (e: any) { ok(`box bounds the field: ${ex.id}`, false, e.message); }
  }
  ok("≥10 examples with a derived box", sound >= 10, `${sound} checked`);
  // a custom shape's *declared* bbox must never drive the skip, however honest it looks: the field
  // may be inside everywhere (mandelbrot is `everything.dist`, liquid_paint says `dist = -inf`)
  for (const id of ["mandelbrot", "liquid_paint", "log_spiral"]) {
    const ex = EXAMPLES.find((e) => e.id === id)!;
    const r = run2D(ex.src);
    ok(`custom shape never skips: ${id}`, r.shape !== null && marchBoxOf(r.shape!, atlas) === null, r.shape ? "declared bbox → march from the eye" : "(no shape)");
  }

  // (b) parity, resolution pinned: the same program with its box and without it
  const pinned = await createRenderer(mkCanvas() as any, atlas, "cpu", { fixedScale: 1 });
  const renderBox = async (src: string, box: boolean, c3: Camera3) => {
    const r = run(src);
    const compiled = compileTree(r.shape!, atlas, "js", null, undefined, "solid");
    await pinned.render({ ...compiled, solid: true, bbox3: box ? compiled.bbox3 : null }, { cx: 0, cy: 0, zoom: 1 }, BG, 0, 1, c3);
    return pixels();
  };
  let parity = 0;
  for (const ex of EXAMPLES.filter((e) => e.group === "3d")) {
    try {
      const c3: Camera3 = { ...cam3, ...(camFor[ex.id] ?? {}) };
      const a = await renderBox(ex.src, true, c3);
      const b = await renderBox(ex.src, false, c3);
      let diff = 0, maxd = 0;
      for (let i = 0; i < a.length; i += 4) {
        const dd = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (dd > 2) diff++;
        maxd = Math.max(maxd, dd);
      }
      const frac = diff / (CW * CH);
      ok(`skip parity: ${ex.id}`, frac <= 0.01, `${(frac * 100).toFixed(2)}% of pixels differ (max Δ${maxd.toFixed(0)}/255)`);
      if (frac <= 0.01) parity++;
    } catch (e: any) { ok(`skip parity: ${ex.id}`, false, e.message); }
  }
  ok("every 3d example passes parity", parity === 8, `${parity}/8`);
  pinned.destroy();
}

renderer.destroy();
console.log(fails ? `\n${fails} FAILURES` : "\nall 3d checks passed");
process.exit(fails ? 1 : 0);
