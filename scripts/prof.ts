import { createCanvas } from "@napi-rs/canvas";
import { loadPsolve } from "../src/psolve/psolve";
import { Interp, compileTree } from "../src/curv/interp";
import { EXAMPLES } from "../src/curv/examples";
import { buildAtlas } from "../src/gpu/atlas";
(globalThis as any).document = { createElement: (t: string) => createCanvas(1, 1) as any };
await loadPsolve();
const atlas = buildAtlas();
for (const id of ["dashboard", "chart", "split"]) {
  const ex = EXAMPLES.find((e) => e.id === id)!;
  let te = 0, tg = 0, N = 30;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const it = new Interp(atlas, { viewport: { x: -450, y: -300, w: 900, h: 600 }, time: i * 0.1, mouse: { x: 300, y: 200, down: false } });
    const r = it.run(ex.src);
    const t1 = performance.now();
    compileTree(r.shape!, atlas, "wgsl");
    const t2 = performance.now();
    if (i >= 10) { te += t1 - t0; tg += t2 - t1; }
  }
  console.log(id, "eval", (te / 20).toFixed(2), "codegen", (tg / 20).toFixed(2));
}
