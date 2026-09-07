# Curv+solve

A browser playground for [Curv](https://github.com/curv3d/curv) 2D shapes (F-Rep compiled to WGSL for WebGPU,
with a JS fallback) extended with `solve { … }` blocks: linear / convex-quadratic constraints solved by
[psolve](https://github.com/SodoMita/psolve) compiled to WebAssembly.

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

Highlights: shaders are reused across frames (only a parameter buffer is refilled by a memoised tree walk), a `solve`
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

See [HANDOFF.md](HANDOFF.md) for the architecture, invariants and the current state of development.
