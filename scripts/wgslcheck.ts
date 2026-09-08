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
    try {
      const r = interp(900, 600, 0).run(src);
      if (!r.shape) { console.log(`ERR ${id} [${mode}] no shape`); bad = true; continue; }
      const c = compileTree(r.shape, atlas, "wgsl", null, undefined, mode);
      const code = wrapWGSL({ ...c, solid: mode === "solid" });
      if (!parse(id, mode, code)) { bad = true; continue; }
      sizes.push(`${mode} ${code.split("\n").length}L`);
    } catch (e: any) { console.log(`ERR ${id} [${mode}] ${e.message}`); bad = true; }
  }
  if (bad) fails++;
  else console.log(`OK  ${id.padEnd(24)} ${sizes.join(" / ")}`);
};

console.log("examples");
for (const ex of EXAMPLES) check(ex.id, ex.src);
console.log("\ncodegen corner cases");
EXTRA.forEach((src, i) => check(`extra ${i}`, src));

console.log(fails ? `\n${fails} shader(s) failed to parse` : "\nall shaders parse as WGSL");
process.exit(fails ? 1 : 0);
