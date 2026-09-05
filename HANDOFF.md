# Curv+solve — handoff (dev round 6)

Browser playground for **Curv** (2D F-Rep, compiled to WGSL / JS) extended with
`solve { }` constraint blocks solved by **psolve** (LP + convex QP, WebAssembly).

Live build: `npm run build` → single-file `dist/index.html`.
Headless checks (all use the JS backend, no browser needed):

| command | what it does |
|---|---|
| `npx tsx scripts/selftest.ts [id \| file.curv …]` | evaluates every example, compiles both backends, renders `/tmp/t/<id>.png` |
| `npx tsx scripts/paramcheck.ts` | **fast-path oracle**: `walkParams` buffer == ParamsOnly buffer == full codegen's; key stable and shader text identical across time/viewport; **memoised evaluations produce the same buffer as cold ones** (`memo=` column) |
| `npx tsx scripts/memotest.ts` | solve-block memoisation dependency tests (indirect `time` through closures, shadowing, records, comprehensions, impure blocks …) |
| `npx tsx scripts/prof.ts` | warm eval / codegen / params-only timings + whether each `solve` was `cached(block)`, `cached(problem)` or solved |

All four were green at the end of this round (`paramcheck` and `memotest` exit 1 on any failure — check the exit code).

## What changed in this round

1. **Whole-block `solve { }` memoisation** (`src/curv/freevars.ts`, `Interp.solve`).
   `freeVarsOfBlock(stmts)` is a static free-variable analysis of the block (memoised on the AST node; mirrors
   `bindDefs` order: function defs visible everywhere, value defs only after their own definition, `local x = x + 1`
   reads the outer `x`, list comprehensions / lambdas / nested `let`/`do`/`solve` scoped). `Interp.blockKey` hashes
   `astId(stmts)` + the values of those names looked up in the enclosing env (`ValueHasher`): numbers, strings,
   booleans, null, lists, records, `Lin`/`Quad`/`Cons` by content; **builtins by `Fn.key`** (set by the `b()` helper in
   `builtins()`, incl. `sRGB.HSV` style fields); **closures by body identity + recursively the values of *their* free
   variables in their captured env** (so `f x = x + time` used inside a block correctly invalidates it). Shapes and
   anonymous host functions (partial applications such as `weight 4`) are unhashable → the block falls back to the
   round-5 fingerprint cache; a block that assigns to an outer variable (`pure: false`) is never memoised.
   A hit returns the previous result record (immutable), re-pushes the trace with `cacheKind: "block"` and re-applies
   the `usesTime/Mouse/Viewport` flags recorded at the original evaluation. The cache is keyed by `astId(stmts)` with a
   small LRU (8) per block, so `f 10; f 20` inside one frame keeps both results. `blockCacheStats.lastReason` says why the
   last block could not be memoised. Panel badge: **memoised** (block) vs **cached** (fingerprint).
   Effect (`prof.ts`, warm, ms): toolbar eval 2.1 → 0.6, stacks 0.9 → 0.4, dashboard 2.0 → 1.4 (the rest is shape
   construction outside the block).
2. **Dedicated parameter walk** (`walkParams` in `src/curv/shapes.ts`, used by `collectParamsFast` →
   `compileTree`'s reuse path). A direct `SNode` walk pushing numbers in exactly `genShape`'s `g.param` order, with
   the same cull-flag propagation and the same deferred-block layout as `Gen.finalParams()`. Returns null for trees with
   user shader functions (exactly the trees whose `structKey` is null). 3–5× cheaper than driving `ParamsOnly`
   (dashboard 1.1 → 0.27 ms, toolbar 1.7 → 0.48 ms). `ParamsOnly` + `collectParams` stay as the reference
   implementation and `paramcheck` compares all three.
3. **Text metrics memoised per node** (`textMetrics`, WeakMap) and glyph rows factored into `textGlyphs()` so bbox,
   codegen and the walk share one computation.
4. **Quality controller budgets CPU time too** (`src/App.tsx`): the GPU render-pass budget is
   `clamp(FRAME_BUDGET_MS(13) − cpuMs, 2.5, 8)` where `cpuMs` = eval + params/codegen of the last frame, so a
   program with an expensive CPU side gets a lower render scale instead of missing vsync.

## Layout of the code

```
src/curv/parser.ts      lexer + parser (Curv syntax + solve/var/weak:/minimize statements)
src/curv/freevars.ts    static free-variable analysis (blocks + closure bodies), astId
src/curv/interp.ts      tree-walking interpreter, builtins (Fn.key), Cons values + strength tags,
                        solve { } → block memo (ValueHasher) → fingerprint cache → psolve Problem,
                        compileTree (structural-key reuse) / collectParams (reference) / collectParamsFast
src/curv/subcurv.ts     SubCurv: compiles user dist/colour functions to shader code (inlining, loops)
src/curv/shapes.ts      SNode F-Rep tree, bboxOf (memoised), textMetrics/textGlyphs, structKey, genShape, walkParams
src/curv/prelude.ts     palette, box helpers, layout combinators (incl. flow / hstack_fit), UI components — in Curv
src/curv/examples.ts    example programs (group "solve" | "curv")
src/gpu/gen.ts          code generators: WGSL, JS, ParamsOnly; dynBlock/finalParams parameter layout
src/gpu/renderer.ts     WebGPU renderer (pipeline cache keyed by code, timestamp queries) + CPU fallback
src/gpu/atlas.ts        SDF glyph atlas (Canvas2D + EDT), GLYPHS charset, kerning
src/psolve/*.ts         Lin/Quad affine expressions, Cons, presolve, QP/LP assembly, bridge to psolve.wasm (b64 inline)
psolve-src/             C bridge + build instructions for the wasm (unmodified psolve cores)
src/App.tsx             UI: editor, preview (camera, pause, CPU-aware quality controller), solver + params panels
scripts/                selftest, paramcheck, memotest, prof (headless, tsx)
```

## Invariants to keep (things that will silently break otherwise)

* **`walkParams` must mirror `genShape` exactly**: every `g.param` / `dynBlock` needs a matching push in the same
  order, and `cull` must be propagated the same way (`kid(…, {cull:false})` ⇒ `walk(s, false)`; `colour`, `opacity`,
  `grad`, `reflect`, `xform`, the second `shadow` child inherit). Watch argument-evaluation order (`stretch` pushes
  `m` *before* its child and again after). Run `scripts/paramcheck.ts` after touching either and check its exit code.
* Any new `SNode` kind or new codegen branch on a *value* must be reflected in `structKey`; anything else that varies
  must go through `g.param(...)`.
* `ParamsOnly` must invoke every callback (`if` then+else, `loop` body once) so parameter order matches.
* Variable-length parameter blocks must use `g.dynBlock` (via `dynBase`) and the buffer must be read with
  `finalParams()`; never bake `g.params.length` into code as a literal.
* **Free-variable analysis must never under-approximate**: a name that *might* be read from the enclosing env must be
  reported free (extra names are harmless). New `Expr`/`Stmt` kinds need a case in `freevars.ts`; new binding
  constructs must follow the evaluator's binding order. Any new evaluator side effect reachable from inside a block
  (like `:=` on an outer variable) must set `pure = false`. Add a case to `scripts/memotest.ts`.
* **New builtins must be registered through `b(name, …)`** so they get an `Fn.key`; a builtin `Fn` without a key makes
  every block that mentions it unhashable (silent fallback to the fingerprint cache — `prof.ts` shows `cached(problem)`
  instead of `cached(block)`). Builtins that read mutable host state other than `time`/`mouse`/`viewport`/params
  would break memoisation — there are none today (`text_size` depends only on the constant atlas).
* The result record of a memoised block is shared between frames: records/lists must stay immutable in the evaluator.
* Keep `OPS` in the lexer sorted longest-prefix-first for operators that share a prefix.
* Soft equalities must not be modelled as inequality pairs (psolve's active-set QP degenerates); keep them in the
  objective. If you add a new relation type, add it to `Problem.fingerprint()` too.
* `weak`, `medium`, `strong`, `required` are keywords — new strength-related builtins need other names.

## Known gaps / next steps

* The block cache is keyed by `astId(stmts)` with an 8-entry LRU per block (a block evaluated several times per frame
  keeps all results); the older *fingerprint* cache is still keyed by source line (one slot per line), so a
  non-memoisable block evaluated twice per frame with different inputs re-solves every time.
* Shape values are unhashable, so a block reading `s.bbox` of a shape built outside it is only fingerprint-cached.
  A cheap content hash of an `SNode` (kind + numbers, memoised in a WeakMap like `bboxOf`) would close that gap.
* Eval of the *rest* of the program (prelude UI components, `bboxOf` for `at`/`fit_in`, record construction) now
  dominates cached frames (dashboard ≈ 1.4 ms). Candidates: memoise `box`/`makeBoxRec` records, avoid `shapeRec`
  allocation for `.bbox`, and a per-frame memo for pure prelude calls with hashable arguments (same `ValueHasher`).
* `structKey` is recomputed every frame (~0.3–0.5 ms on big trees) before the walk; it could be derived
  incrementally or memoised per subtree like `bboxOf`.
* `flow` needs a *numeric* maximum width (wrapping is discrete); `hstack_fit` gives all items the same font size /
  padding.
* Kerning is measured pairwise from the canvas font, so metrics can differ slightly between machines; the atlas has
  one weight, no ligatures, no combining marks.
* The GPU budget is derived from the *previous* frame's CPU time; a sudden CPU spike is corrected one frame late.
* Only 2D shapes are supported (no 3D ray-marching).
