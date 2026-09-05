# Curv+solve — handoff (dev round 4)

Browser playground for **Curv** (2D F-Rep, compiled to WGSL / JS) extended with
`solve { }` constraint blocks solved by **psolve** (LP + convex QP, WebAssembly).

Live build: `npm run build` → single-file `dist/index.html`.
Headless checks (all use the JS backend, no browser needed):

| command | what it does |
|---|---|
| `npx tsx scripts/selftest.ts [id \| file.curv …]` | evaluates every example, compiles both backends, renders `/tmp/t/<id>.png` |
| `npx tsx scripts/paramcheck.ts` | **fast-path oracle**: params-only buffer must equal full codegen's, key must be stable across time/viewport |
| `npx tsx scripts/prof.ts` | warm eval / codegen / params-only timings |

## What changed in this round

1. **Codegen is skipped for animated / re-solved programs.**
   * `structKey(node)` (`src/curv/shapes.ts`) is a string describing the *shape* of the generated code: node
     kinds, tree layout, and the few numbers codegen branches on (`xform.sc == 1`, polygon vertex count,
     `repeat.kind`, text alignment, bbox-culling decision). User shader functions (`make_shape`, `colour f`) make the key
     `null` → full codegen as before.
   * `ParamsOnly` (`src/gpu/gen.ts`) is a third `Gen` backend that emits no text and only records the parameter
     buffer, walking exactly the same `genShape` path (callbacks of `if` / `loop` are invoked, `let` is identity).
   * `compileTree(node, atlas, target, prev)` returns `{…prev, params, reused: true}` when `prev.key` matches.
     `App.tsx` keeps the last result in `lastProg`. The status line shows `params N ms` instead of `codegen N ms`
     when the shader was reused.
   * The culling decision is a shared helper (`cullable`) so key and codegen cannot disagree;
     `bboxOf` / `weight` are memoised per node (WeakMap), which alone removed the O(n·depth) cost from codegen.
   * **Text is now a shader loop** (glyph count, cell origins and atlas UVs are parameters, 5 per glyph) and text /
     polygon parameter blocks start at a *parameterised* offset (`dynBase`). Consequences: label content and length
     never change the shader; text-heavy shaders are shorter; buffer length may differ between frames (fine — it
     is uploaded whole).
   * Numbers (dashboard, warm): eval 2.0 ms · full codegen 2.9 ms → structKey 0.5 ms + params 0.9 ms.
2. **Constraint values + layout combinators.**
   * A comparison whose operands contain solver variables now evaluates to a **`Cons` value** (or a list of them:
     chains, lists and box records broadcast) instead of throwing. Inside `solve { }`, every `cons` statement
     (`a == b;`, `weak: expr;`) and every expression statement whose value contains constraints adds them. So plain
     functions generate constraints:
     ```curv
     fit_col b items = [ vstack gap b items, same_h items ];
     L = solve { var cols : box[3]; hstack 12 body cols; weak: same_w cols; fit_col cols.[0] rows; };
     ```
   * Prelude combinators (`src/curv/prelude.ts`): `hstack vstack hsplit vsplit grid pin inside centre_in same_w same_h
     same_size align_left/right/top/bottom/cx/cy size_of min_size max_size aspect`. `box (x,y,w,h)` and `inset d box`
     accept solver expressions.
   * New example **Layout combinators** (`stacks`); the **Dashboard** card grid is now one line (`grid gap cols main cards;`)
     and produces the identical parameter buffer as the hand-written loop.
3. **WebGPU timestamp queries** (`src/gpu/renderer.ts`): if the adapter has `timestamp-query`, each render pass is
   timed (begin/end → resolve → single mappable readback, skipped while one is in flight). `stats.gpuMs` (lightly
   smoothed) drives the adaptive-quality controller in `App.tsx` (slow > 11 ms GPU or > 34 ms pacing; fast < 5 ms);
   without the feature the rAF-pacing heuristic from round 3 is used. Shown as `gpu N ms` in the status line.

## Layout of the code

```
src/curv/parser.ts      lexer + parser (Curv syntax + solve/var/weak:/minimize statements)
src/curv/interp.ts      tree-walking interpreter, builtins, Cons values, solve { } → psolve Problem,
                        compileTree (with structural-key reuse) / collectParams
src/curv/subcurv.ts     SubCurv: compiles user dist/colour functions to shader code (inlining, loops)
src/curv/shapes.ts      SNode F-Rep tree, bboxOf (memoised), structKey, genShape (shape → straight-line code)
src/curv/prelude.ts     palette, box helpers, layout combinators, UI components — written in Curv
src/curv/examples.ts    example programs (group "solve" | "curv")
src/gpu/gen.ts          code generators: WGSL, JS, ParamsOnly (parameter buffer only)
src/gpu/renderer.ts     WebGPU renderer (pipeline cache keyed by code, timestamp queries) + CPU fallback
src/gpu/atlas.ts        SDF glyph atlas (Canvas2D + EDT)
src/psolve/*.ts         Lin/Quad affine expressions, Cons, presolve, bridge to psolve.wasm (b64 inline)
psolve-src/             C bridge + build instructions for the wasm (unmodified psolve cores)
src/App.tsx             UI: editor, preview (camera, pause, quality), solver + params panels
scripts/                selftest, paramcheck, prof (headless, tsx)
```

## Invariants to keep (things that will silently break otherwise)

* Any new `SNode` kind or new codegen branch on a *value* must be reflected in `structKey`; anything else that varies
  must go through `g.param(...)`. Run `scripts/paramcheck.ts` after touching `genShape`.
* `ParamsOnly` must invoke every callback (`if` then+else, `loop` body once) so parameter order matches.
* Variable-length parameter blocks must use `dynBase` (never bake `g.params.length` into code as a literal).

## Known gaps / next steps

* `ParamsOnly` still walks the whole tree through the generic `Gen` interface (~0.9 ms for the dashboard). A
  dedicated `collectParams` walker over `SNode` — or caching `structKey` on the interpreter's shape values — could
  make the per-frame cost eval-only. Eval itself (~2 ms) now dominates; the interpreter re-runs the whole
  program every frame, so memoising `solve` results whose inputs did not change is the next big win.
* Adaptive quality thresholds are heuristic; with timestamps available a proper controller targeting a frame budget
  (e.g. 8 ms GPU) would be better than the multiplicative step.
* Combinators are minimal: no wrapping flow layout, no intrinsic-size (`text_width`) aware `hstack`, no
  priorities inside a combinator (all its constraints share the statement's strength).
* `text` uses a single Inter atlas at one weight; no kerning, ASCII only.
* Only 2D shapes are supported (no 3D ray-marching).
