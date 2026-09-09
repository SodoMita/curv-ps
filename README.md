# Curv+solve

A browser playground for [Curv](https://github.com/curv3d/curv) shapes (F-Rep compiled to WGSL for WebGPU,
with a JS fallback) extended with `solve { … }` blocks: linear / convex-quadratic constraints solved by
[psolve](https://github.com/SodoMita/psolve) compiled to WebAssembly.  2D is the `z = 0` slice of a 3D
field, so the same program also renders as a raymarched solid (orbit camera) with the C++ `std.curv`
3D vocabulary: `sphere`, `box3`, `cone`, `capsule`, `torus`, `cylinder`, `gyroid`, `extrude`, `loft`,
`twist`, `bend`, `repeat_xyz`, `slice_xz`, `reflect_yz`, …

**Live: <https://sodomita.github.io/curv-ps/>** (the single-file `dist/index.html`, rebuilt on every push to main).

```curv
let
  L = solve {
    var side, main : box;  var cards : box[6];
    pin 16 viewport side;  side.w == 200;  main.left == side.right + 14;  main.right == viewport.right - 16;
    grid 14 3 main cards;          // a prelude combinator that returns constraints
    weight 4 (side.h == main.h);   // constraint values can carry their own priority
  };
in union [ card L.side, for (c in L.cards) card c ]
```

Highlights: the bottom **shader generation** panel switches the shader generator between `branched` (bbox-cull and
raymarch early-outs) and `branchless` (no `if`, no `break`, no short-circuit — both arms of every branch evaluated,
measured 3× slower in 2D and 10× in the 3D view) and exposes the other codegen options (cull weight, loop unrolling,
polygon/text/SubCurv variants), each with its measured cost — the panel folds to a vertical strip, as do the
parametric and solver-trace panels beside it; the **`WGSL` / `JS` view** shows the *whole* shader the backend compiles (uniforms, entry point
and the 3D raymarch loop), with the generated body one click away; shaders are reused across frames (only a parameter buffer is refilled by a memoised tree walk), a `solve`
block whose inputs (free variables, tracked through closures, shapes hashed by content) did not change is not
re-evaluated at all, unchanged numeric problems are additionally served from a fingerprint cache, pure user functions
that are expensive enough are memoised across frames the same way (profile-guided; impure bodies and functions that
read `parametric` or print are never memoised), programs that only use `time` inside compiled shader code animate by
re-rendering the same tree, layout combinators (`hstack`, `grid`, `flow`, `hstack_fit`, …) are plain Curv functions
that return constraint values, and text is an SDF atlas (ASCII + Latin-1 + symbols, kerned).

The solver is psolve's own wasm bridge (ABI 3, reproducibly built — see `psolve-src/PIN`): the previous frame's
solution is fed back as a **warm start** (pixel-identical layouts at a fraction of the time on drag frames), a solve
that fails degrades to the block's **last good layout** (amber, with the failure verdict) instead of erroring the
whole program, reported infeasibility is **Farkas-certified** with the conflicting constraints named, and every solve
runs inside a per-frame **wall-clock budget** that hands back an incumbent rather than hanging the UI.

* `npm install && npm run dev` — development server
* `npm run build` — single-file `dist/index.html`
* `npx tsx scripts/selftest.ts` — headless render of every example
* `npx tsx scripts/paramcheck.ts` — verifies the codegen fast paths and solve-block memoisation
* `npx tsx scripts/warmcheck.ts` — warm-start / certified-infeasibility / budget / degradation oracle for the solver bridge
* `npx tsx scripts/warmbench.ts [example …]` — cold vs warm-started solve timings (interleaved best-of-4)
* `npx tsx scripts/internbench.ts [example …]` — hash-consing A/B benchmark (round-15 study: inode stays off by default)
* `npx tsx scripts/exprbench.ts [example …]` — expression-memo A/B benchmark (round-16: pure list/comprehension memo sites)
* `npx tsx scripts/shaderbench.ts [example …]` — benchmarks the shader-generation variants (`SHADER_FLAGS`) per example: JS raster time, WGSL bytes, branch/loop counts
* `npx tsx scripts/memotest.ts` — dependency-tracking tests for solve-block and call memoisation
* `npx tsx scripts/threedcheck.ts` — 3D gate: solid-mode codegen on both backends, `bbox3`, `is_2d`/`is_3d`, and the CPU raymarcher's real pixels (slice/solid parity, animation)
* `npx tsx scripts/stdcheck.ts` — C++ `std.curv` parity: prelude values, 2D/3D boxes, and the generated field sampled on a grid (no non-finite distance, nothing inside the shape outside its box)
* `npx tsx scripts/branchbench.ts [id …]` — times the branching and the branchless shader builds against each other on the CPU fallback (`SHADER_FLAGS.branchless`, `noShortCircuit`, `cullSelect`, `branchless3D`) and counts the `if`/`break`/`&&` left in the WGSL
* `npx tsx scripts/wgslcheck.ts` — parses the **whole** WGSL shader (wrapper included) of every example and a list of codegen corner cases, in both view modes: the CPU fallback compiles JS, so a WGSL-only syntax error is invisible to every other gate
* `npx tsx scripts/pdiff.ts [--update]` — golden-frame gate: hashes every example's render (slice + solid) against `scripts/golden/pdiff.json` and counts non-finite distances; `--update` rewrites the goldens after an intended change
* `npx tsx scripts/flagcheck.ts [id …]` — invariance gate for the `gen:` menu: renders every example under every flag setting the menu can produce and checks the settings agree with each other (same pixels, same parameter buffer, code independent of the order the settings were compiled in)

See [HANDOFF.md](HANDOFF.md) for the architecture, invariants and the current state of development.
