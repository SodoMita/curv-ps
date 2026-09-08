// C++ std.curv parity checks for the shape vocabulary and the prelude surface (round 17).
//
//   npx tsx scripts/stdcheck.ts
//
// Three kinds of assertion, in ascending order of strength:
//   1. value checks   — `show` of a prelude expression equals the C++ result (transpose, sort, …)
//   2. bbox checks    — a shape's 2D/3D box is what std.curv says it is (the 2D camera fit, the
//                       3D camera fit and the culling tests all consume these)
//   3. field checks   — the *generated* distance field is sampled on a grid and
//                       (a) never non-finite, (b) never inside the shape outside its own bbox
//
// (3) is the one that would have caught round 17's repeat_xy / text-glyph NaNs and the
// cylinder / extrude / loft half-height mix-up: none of them throw, and "it renders" is not
// a test.  scripts/pdiff.ts covers the same ground at the pixel level; this script says *why*.
import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree, show, setSolveBudget } from "../src/curv/interp";
import { bboxOf, bbox3Of, type BBox3 } from "../src/curv/shapes";
import { buildAtlas } from "../src/gpu/atlas";
import { makeJSRuntime } from "../src/gpu/gen";
import { ATLAS_W, ATLAS_H } from "../src/gpu/atlas";

(globalThis as any).document = { createElement: (t: string) => { if (t !== "canvas") throw new Error(t); return createCanvas(1, 1) as any; } };
await loadPsolve();
setSolveBudget(0); // no wall-clock budget: a binding budget hands back a load-dependent incumbent
const atlas = buildAtlas();
const R = makeJSRuntime((u, v) => {
  const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5))), y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
  return atlas.data[y * ATLAS_W + x] / 255;
});

let fails = 0;
const ok = (name: string, good: boolean, extra = "") => { if (!good) fails++; console.log(`${good ? "OK " : "ERR"} ${name.padEnd(46)}${extra}`); };
const eq = (name: string, got: string, want: string) => ok(name, got === want, got === want ? "" : `got ${got} want ${want}`);

const mk = (w = 900, h = 600) => new Interp(atlas, { viewport: { x: -w / 2, y: -h / 2, w, h }, time: 0, mouse: { x: -1e6, y: -1e6, down: false }, params: {} });
const val = (src: string): string => { try { return show(mk().run(src).value); } catch (e: any) { return "ERR " + e.message; } };
const shape = (src: string) => { const r = mk().run(src); if (!r.shape) throw new Error("no shape"); return r.shape; };
const b2 = (src: string) => bboxOf(shape(src), atlas);
const b3 = (src: string): BBox3 | null => bbox3Of(shape(src), atlas);
const fmt = (b: unknown) => (b === null ? "inf" : (b as number[]).map((x) => (Number.isFinite(x) ? +x.toFixed(4) : x)).join(","));

// ---- 1. prelude values (C++ std.curv) ---------------------------------------------------------
console.log("prelude: lists / math / characters");
eq("transpose [[1,2],[3,4]]", val("str (transpose [[1,2],[3,4]])"), "\"[[1, 3], [2, 4]]\"");
eq("transpose of a 3×2", val("str (transpose [[1,2],[3,4],[5,6]])"), "\"[[1, 3, 5], [2, 4, 6]]\"");
eq("transpose [] ", val("str (transpose [])"), "\"[]\"");
eq("a.[[0,1]] is a list index (not a.[0,1])", val("str ([[1,2],[3,4]].[[0,1]])"), "\"[[1, 2], [3, 4]]\"");
eq("sort [3,1,2]", val("str (sort [3,1,2])"), "\"[1, 2, 3]\"");
eq("contains [[1,2,3], 2]", val("contains [[1,2,3], 2]"), "true");
eq("contains [[1,2], 5]", val("contains [[1,2], 5]"), "false");
eq("product [2,3,4]", val("product [2,3,4]"), "24");
eq("idmatrix 2", val("str (idmatrix 2)"), "\"[[1, 0], [0, 1]]\"");
eq("perp [3,4]", val("str (perp [3,4])"), "\"[-4, 3]\"");
eq("id 5", val("id 5"), "5");
eq("encode \"A\"", val("encode \"A\""), "65");
eq("decode 65", val("decode 65"), "\"A\"");
eq("MIN / MAX", val("str [MIN, MAX]"), "\"[0, 1]\"");
eq("RE / IM", val("str [RE, IM]"), "\"[0, 1]\"");
eq("X_axis / Y_axis / Z_axis", val("str [X_axis, Y_axis, Z_axis]"), "\"[[1, 0, 0], [0, 1, 0], [0, 0, 1]]\"");
eq("dol", val("dol"), "\"$\"");
eq("tab", val("tab"), "\"\\t\"");
eq("nl", val("nl"), "\"\\n\"");
eq("quot", val("quot"), "\"\\\"\"");
eq("phi", val("phi"), "1.618");
eq("rem [7,3]", val("rem [7,3]"), "1");
eq("merge [{a:1},{b:2}]", val("str (merge [{a:1},{b:2}])"), "\"{a: 1, b: 2}\"");
// NOTE: C++ std.curv has sec a = 1/sin a and csc a = 1/cos a — swapped on purpose, for parity
eq("sec 0 (C++: 1/sin → inf)", val("sec 0"), "Infinity");
eq("csc 0 (C++: 1/cos → 1)", val("csc 0"), "1");
eq("smooth_min [1,2,1]", val("smooth_min [1,2,1]"), "1");
eq("smooth_max [1,2,1]", val("smooth_max [1,2,1]"), "2");
eq("i_linear 2 [1,0,0,0]", val("i_linear 2 [1,0,0,0]"), "0.5");
eq("i_concentric 2 [1,0,0,0]", val("i_concentric 2 [1,0,0,0]"), "0.5");
eq("i_gyroid [0,0,0,0]", val("i_gyroid [0,0,0,0]"), "0.5");

console.log("\nprelude: C++-named colours (std.curv: sRGB.hue)");
eq("azure = sRGB.hue (7/12)", val("str azure"), val("str (sRGB.hue (7/12))"));
eq("indigo = sRGB.hue (3/4)", val("str indigo"), val("str (sRGB.hue (3/4))"));
eq("rose = sRGB.hue (11/12)", val("str rose"), val("str (sRGB.hue (11/12))"));
eq("chartreuse = sRGB.hue (1/4)", val("str chartreuse"), val("str (sRGB.hue (1/4))"));
eq("spring_green = sRGB.hue (5/12)", val("str spring_green"), val("str (sRGB.hue (5/12))"));

// ---- 2. shape records: is_2d / is_3d and the bbox the views consume ---------------------------
console.log("\nshape records");
eq("capsule is 3D (C++ capsule.is_3d)", val("let s = capsule {from:[0,0,0], to:[0,0,2], d:1} in str [s.is_2d, s.is_3d]"), "\"[false, true]\"");
eq("union [sphere, capsule] is 3D", val("let s = union [sphere 2, capsule {from:[0,0,0], to:[0,0,2], d:1}] in str [s.is_2d, s.is_3d]"), "\"[false, true]\"");
eq("stroke {from,to} stays 2D", val("let s = stroke {from:[0,0], to:[2,2], d:1} in str [s.is_2d, s.is_3d]"), "\"[true, false]\"");
eq("capsule bbox (r = d/2 around both centres)", val("let s = capsule {from:[0,0,0], to:[0,0,2], d:1} in str s.bbox"), "\"[[-0.5, -0.5, -0.5], [0.5, 0.5, 2.5]]\"");
eq("distance_field flags", val("let s = distance_field (sphere 4) in str [s.is_2d, s.is_3d]"), "\"[true, true]\"");
eq("show_dist over a 3D shape", val("let s = show_dist (sphere 4) in str [s.is_2d, s.is_3d]"), "\"[true, true]\"");
// C++ set_bbox forwards both flags: is_2d && is_3d is legal (nothing / everything / show_dist)
eq("set_bbox over everything", val("str ((set_bbox [[-5,-5],[5,5]] everything).bbox)"), "\"[[-5, -5, 0], [5, 5, 0]]\"");
eq("set_bbox over distance_field", val("str ((set_bbox [[-5,-5,-5],[5,5,5]] (distance_field (sphere 4))).bbox)"), "\"[[-5, -5, -5], [5, 5, 5]]\"");
eq("set_bbox over show_dist keeps is_3d", val("(set_bbox [[-5,-5,-5],[5,5,5]] (show_dist (sphere 4))).is_3d"), "true");
eq("make_shape {is_2d=true,is_3d=true}", val("(make_shape {dist p = mag p - 1; is_2d = true; is_3d = true}).is_3d"), "true");

console.log("\n2D boxes (camera fit + culling)");
eq("repeat_finite [4,0,0] [3,1,1] (circle 1)", fmt(b2("repeat_finite [4,0,0] [3,1,1] (circle 1)")), "-0.5,-0.5,8.5,0.5");
eq("box3 [2,4,6] slice is its xy footprint", fmt(b2("box3 [2,4,6]")), "-1,-2,1,2");
eq("slice_xz (box3 [2,4,6])", fmt(b2("slice_xz (box3 [2,4,6])")), "-1,-3,1,3");
eq("slice_yz (box3 [2,4,6])", fmt(b2("slice_yz (box3 [2,4,6])")), "-2,-3,2,3");
eq("bend {angle:tau,d:40} (rect 10)", fmt(b2("bend {angle: tau, d: 40} (rect 10)")), "-30,-30,30,30");
eq("box3 [1.1,1.1,5] >> rotate 90° about Y", fmt(b2("box3 [1.1,1.1,5] >> rotate {angle: 90*deg, axis: Y_axis}")), "-2.5,-0.55,2.5,0.55");
eq("reflect_x (circle 2 >> move [3,0])", fmt(b2("reflect_x (circle 2 >> move [3,0])")), "-4,-1,-2,1");
eq("polyline {d:1} is padded by d/2", fmt(b2("polyline {d: 1, v: [[0,0],[4,0],[4,3]]}")), "-0.5,-0.5,4.5,3.5");

console.log("\n3D boxes (camera fit + s.bbox)");
eq("cylinder {d:2,h:3} spans z ±1.5", fmt(b3("cylinder {d: 2, h: 3}")), "-1,-1,-1.5,1,1,1.5");
eq("extrude 3 (rect 2) spans z ±1.5", fmt(b3("extrude 3 (rect 2)")), "-1,-1,-1.5,1,1,1.5");
eq("extrude_mitred 3 (rect 2) spans z ±1.5", fmt(b3("extrude_mitred 3 (rect 2)")), "-1,-1,-1.5,1,1,1.5");
eq("loft 3 [circle 2, circle 4] spans z ±1.5", fmt(b3("loft 3 [circle 2, circle 4]")), "-2,-2,-1.5,2,2,1.5");
eq("cone {d:2,h:2} → r 1, z 0..2", fmt(b3("cone {d: 2, h: 2}")), "-1,-1,0,1,1,2");
eq("prism 6 2 3 (hex prism)", fmt(b3("prism 6 2 3")), "-1.1547,-1.1547,-1.5,1.1547,1.1547,1.5");
eq("bend {angle:tau,d:100} (rect [10,4])", fmt(b3("bend {angle: tau, d: 100} (rect [10,4])")), "-54,-54,0,54,54,0");
eq("repeat_finite [4,0,0] [3,1,1] (sphere 1)", fmt(b3("repeat_finite [4,0,0] [3,1,1] (sphere 1)")), "-0.5,-0.5,-0.5,8.5,0.5,0.5");
eq("box3 [2,4,6] >> rotate 90° about Y", fmt(b3("box3 [2,4,6] >> rotate {angle: 90*deg, axis: Y_axis}")), "-3,-2,-1,3,2,1");

// ---- 3. the generated field: non-finite distances, and geometry outside the box ---------------
console.log("\nfield sampling (3D: non-finite + inside-vs-bbox)");
const field3 = (src: string) => {
  const c = compileTree(shape(src), atlas, "js", null, undefined, "solid");
  const fn = new Function("P", "R", "zoom", "T", "q", `const p0 = q; ${c.code}; return ${c.d};`) as (P: Float32Array, R: unknown, zoom: number, T: number, q: number[]) => number;
  const P = Float32Array.from(c.params);
  return (x: number, y: number, z: number) => fn(P, R, 1, 0, [x, y, z]);
};
/** 2D (z = 0) field of a shape, through the interpreter's own CPU compiler. */
const field2 = (src: string) => { const f = mk().cpuCompile(shape(src)); return (x: number, y: number) => f.dist(x, y, 0); };

/** Every sampled point that is *inside* the shape must be inside its bbox3: a box that is too
 *  small silently clips the view (and used to be the case for extrude/loft/cylinder). */
const contains = (src: string, n = 13) => {
  const f = field3(src), b = b3(src);
  if (!b || !b.every(Number.isFinite)) return "no finite bbox3";
  const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
  const rx = (b[3] - b[0]) / 2, ry = (b[4] - b[1]) / 2, rz = (b[5] - b[2]) / 2;
  const diag = Math.hypot(rx, ry, rz) || 1;
  const tol = 0.02 * diag;                       // sampling slack
  let inside = 0, outside = 0, bad = 0, nan = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    const x = cx + (2 * rx * 1.6) * (i / (n - 1) - 0.5), y = cy + (2 * ry * 1.6) * (j / (n - 1) - 0.5), z = cz + (2 * rz * 1.6) * (k / (n - 1) - 0.5);
    const d = f(x, y, z);
    if (!Number.isFinite(d)) { nan++; continue; }
    if (d > -tol) continue;
    inside++;
    if (x < b[0] - tol || y < b[1] - tol || z < b[2] - tol || x > b[3] + tol || y > b[4] + tol || z > b[5] + tol) { outside++; if (bad === 0) bad = 1; }
  }
  return { inside, outside, nan };
};
for (const [name, src] of [
  ["sphere 4", "sphere 4"],
  ["box3 [2,4,6]", "box3 [2,4,6]"],
  ["cylinder {d:2,h:3}", "cylinder {d: 2, h: 3}"],
  ["extrude 3 (rect 2)", "extrude 3 (rect 2)"],
  ["extrude_mitred 3 (rect 2)", "extrude_mitred 3 (rect 2)"],
  ["loft 3 [circle 2, circle 4]", "loft 3 [circle 2, circle 4]"],
  ["cone {d:2,h:2}", "cone {d: 2, h: 2}"],
  ["cone {d:2,h:2,mode:\"mitred\"}", "cone {d: 2, h: 2, mode: \"mitred\"}"],
  ["capped_cone {h:2,bottom:3,top:1}", "capped_cone {h: 2, bottom: 3, top: 1}"],
  ["capsule {from,to,d}", "capsule {from: [0,0,0], to: [0,0,2], d: 1}"],
  ["torus {major:4,minor:1}", "torus {major: 4, minor: 1}"],
  ["rotate {angle,axis}", "sphere 2 >> move [3,0,0] >> rotate {angle: pi/2, axis: [0,0,1]}"],
  ["twist 0.3 (box3)", "box3 [1.1,1.1,5] >> twist 0.3"],
  ["bend {angle:tau,d:40} (rect 10)", "bend {angle: tau, d: 40} (rect 10)"],
  ["local_taper_xy", "box3 [2,2,6] >> local_taper_xy {range: [-3,3], scale: [[1,1],[0.4,0.4]]}"],
  ["repeat_finite [4,0,0] [3,1,1]", "repeat_finite [4,0,0] [3,1,1] (sphere 1)"],
  ["stretch3 [1,2,3] (sphere 2)", "sphere 2 >> stretch [1,2,3]"],
  ["reflect3 (sphere >> move)", "sphere 2 >> move [3,0,0] >> reflect [0,0,1]"],
] as [string, string][]) {
  try {
    const r = contains(src);
    const good = typeof r === "string" ? false : r.inside > 0 && r.outside === 0 && r.nan === 0;
    ok(`bbox3 covers the shape · ${name}`, good, typeof r === "string" ? r : `${r.inside} inside, ${r.outside} outside the box, ${r.nan} non-finite`);
  } catch (e: any) { ok(`bbox3 covers the shape · ${name}`, false, e.message); }
}

/** No pixel of a shape's field may be non-finite: one NaN lane poisons the whole frame. */
const finite3 = (src: string, n = 9) => {
  const f = field3(src); let nan = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
    const d = f(i - (n >> 1), j - (n >> 1), k - (n >> 1));
    if (!Number.isFinite(d)) nan++;
  }
  return nan;
};
for (const [name, src] of [
  ["repeat_x 3 (sphere 1.5)", "repeat_x 3 (sphere 1.5)"],
  ["repeat_y 3 (sphere 1.5)", "repeat_y 3 (sphere 1.5)"],
  ["repeat_xy [3,3] (sphere 1.5)", "repeat_xy [3,3] (sphere 1.5)"],
  ["repeat_xyz [3,3,3] (sphere 1)", "repeat_xyz [3,3,3] (sphere 1)"],
  ["repeat_xyz [3,3,0] (sphere 1)", "repeat_xyz [3,3,0] (sphere 1)"],
  ["repeat_xyz [0,0,3] (sphere 1)", "repeat_xyz [0,0,3] (sphere 1)"],
  ["repeat_finite [4,0,0] [3,1,1]", "repeat_finite [4,0,0] [3,1,1] (sphere 1)"],
  ["repeat_finite [0,3,0] [1,3,1]", "repeat_finite [0,3,0] [1,3,1] (sphere 1)"],
  ["repeat_mirror_xy (sphere 2)", "repeat_mirror_xy (sphere 2)"],
  ["repeat_radial 5 (sphere 2)", "repeat_radial 5 (sphere 2)"],
  ["gyroid", "gyroid"],
  ["swirl {strength:4,d:16}", "rect 4 >> swirl {strength: 4, d: 16}"],
] as [string, string][]) {
  try { const nan = finite3(src); ok(`field is finite · ${name}`, nan === 0, nan ? `${nan} non-finite samples` : ""); }
  catch (e: any) { ok(`field is finite · ${name}`, false, e.message); }
}
// the 2D text / polyline fields (CPU backend only — WGSL truncates a v3→v2 instead of NaN-ing)
for (const [name, src] of [["text \"Ag\" 2", "text \"Ag\" 2"], ["text \"Wg\" 40", "text \"Wg\" 40"]] as [string, string][]) {
  try {
    const f = field2(src); let nan = 0;
    for (let i = 0; i < 40; i++) for (let j = 0; j < 24; j++) { const d = f(i * 0.5 - 10, j * 0.5 - 6); if (!Number.isFinite(d)) nan++; }
    ok(`field is finite · ${name}`, nan === 0, nan ? `${nan} non-finite samples` : "");
  } catch (e: any) { ok(`field is finite · ${name}`, false, e.message); }
}

// ---- 4. `rotate {angle, axis}` turns the solid by +angle (C++ rot3 is a domain transform) -----
console.log("\nrotate {angle, axis}: handedness");
{
  const f = field3("sphere 2 >> move [3,0,0] >> rotate {angle: pi/2, axis: [0,0,1]}");
  const atY = f(0, 3, 0), atNegY = f(0, -3, 0);
  ok("+90° about Z moves +x onto +y", atY < 0 && atNegY > 0, `d(0,3,0)=${atY.toFixed(2)} d(0,-3,0)=${atNegY.toFixed(2)}`);
  const g = field3("sphere 2 >> move [3,0,0] >> rotate {angle: -pi/2, axis: [0,0,1]}");
  ok("-90° about Z moves +x onto -y", g(0, -3, 0) < 0 && g(0, 3, 0) > 0, `d(0,-3,0)=${g(0, -3, 0).toFixed(2)}`);
  const h = field3("sphere 2 >> move [0,0,3] >> rotate {angle: pi/2, axis: [1,0,0]}");
  ok("+90° about X moves +z onto -y (right-hand rule)", h(0, -3, 0) < 0, `d(0,-3,0)=${h(0, -3, 0).toFixed(2)}`);
}

// ---- 5. cone.exact is the Euclidean field (C++ cone.call = exact) -----------------------------
console.log("\ncone: exact vs mitred");
{
  const d = field3("cone {d: 2, h: 2}");          // apex (0,0,2), base radius 1
  const mitred = field3("cone {d: 2, h: 2, mode: \"mitred\"}");
  // (2,0,-1): outside the mantle, past the base ring — the mitred field under-reports the distance
  ok("exact ≥ mitred off the rim", d(2, 0, -1) > mitred(2, 0, -1) + 0.05, `exact ${d(2, 0, -1).toFixed(3)} vs mitred ${mitred(2, 0, -1).toFixed(3)}`);
  ok("exact is the Euclidean distance at the rim", Math.abs(d(2, 0, -1) - Math.SQRT2) < 0.02, `d=${d(2, 0, -1).toFixed(3)} want 1.414`);
  ok("apex distance is exact", Math.abs(d(0, 0, 4) - 2) < 0.02, `d(0,0,4)=${d(0, 0, 4).toFixed(3)} want 2`);
}

console.log(fails ? `\n${fails} FAILURES` : "\nall std.curv parity checks passed");
process.exit(fails ? 1 : 0);
