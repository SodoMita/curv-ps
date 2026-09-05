# Curv+solve — handoff (dev round 5)

Browser playground for **Curv** (2D F-Rep, compiled to WGSL / JS) extended with
`solve { }` constraint blocks solved by **psolve** (LP + convex QP, WebAssembly).

Live build: `npm run build` → single-file `dist/index.html`.
Headless checks (all use the JS backend, no browser needed):

| command | what it does |
|---|---|
| `npx tsx scripts/selftest.ts [id \| file.curv …]` | evaluates every example, compiles both backends, renders `/tmp/t/<id>.png` |
| `npx tsx scripts/paramcheck.ts` | **fast-path oracle**: params-only buffer must equal full codegen's, key must be stable *and the shader text identical* across time/viewport |
| `npx tsx scripts/prof.ts` | warm eval / codegen / params-only timings + whether each `solve` hit the cache |

All three were green at the end of this round (`paramcheck` exits 1 on any failure — check its exit code, not just its output).

## What changed in this round

1. **Solve memoisation** (`src/curv/interp.ts`, `src/psolve/constraints.ts`).
   `Problem.fingerprint()` serialises the numeric problem (every coefficient, relation, weight, objective).
   `Interp.solve` keeps a module-level `Map<line, {fp, res}>`; an unchanged block skips presolve + psolve
   (`SolveTrace.cached`, shown as a **cached** badge in the solver panel; `resetSolveCache()` exists for scripts).
   Constraint *construction* is still re-run every frame — see next steps.
2. **Constraint priorities inside combinators.** `Cons` carries an optional `weight`; the builtins
   `strength "weak"|"medium"|"strong"|"required" c`, `weight k c` (k × weak, or k × the existing tag) and `soft c`
   (= weak) tag a constraint value or any nested list of them. In `addValue` an explicit tag **wins over the
   statement's strength** (so `hstack_fit` can return `[hstack…, soft (same_w items)]` and be added by a plain
   statement). Trace labels reflect the effective strength (`weak ×4 line 23`).
   (`weak`/`strong`/… are statement keywords in the parser, hence the function is called `strength`.)
3. **Prelude combinators** (`src/curv/prelude.ts`): `text_size t s` builtin → `(w, h)`; `fit_text` / `hug_text
   pad s t b`; `hstack_fit gap pad s labels b items` (≥ label widths, equal widths only soft); `flow gap maxw b
   items sizes` — a **wrapping flow layout** written as a Curv `do` loop: line breaks are decided greedily from
   the numeric sizes, only positions become constraints, `b.h == total height`; `flow_text …` measures labels
   for you. New example **Toolbar & wrapping tags** (`toolbar`).
4. **Glyph atlas** (`src/gpu/atlas.ts`): character set is now ASCII + Latin-1 + `–—‘’“”•…€£→←↑↓↔×÷≤≥≠≈∞√°±✓✗★☆♥`
   (221 glyphs, 14 rows; `GLYPHS`, `atlas.index`), and **kerning**: `atlas.kern(a, b)` measures the pair on the
   retained canvas lazily (`measureText("AV") − adv(A) − adv(V)`), `penAdvance()` is used by `textMetrics`,
   glyph placement and `text_width`/`text_size`. Unknown characters render as a space.
5. **Adaptive resolution is a budget controller** (`src/App.tsx`): with GPU timestamps, each frame moves the render
   scale 35 % of the way towards `q·sqrt(GPU_BUDGET_MS / gpuMs)` (budget 8 ms, dead band 70–115 %, floor 0.3);
   without timestamps the old rAF-pacing heuristic remains.
6. **Bugs fixed**
   * `dynBase` wrote glyph / polygon blocks *inline*, so a label whose length changed shifted every later
     parameter index while the shader was reused (wrong values after animated labels). Blocks are now deferred:
     `Gen.dynBlock()` reserves a base slot, `Gen.finalParams()` appends all blocks after the scalars and patches
     the slots. **Always read the buffer through `finalParams()`**, never `g.params`. `paramcheck` now catches
     this (`codeSame`).
   * Lexer: `"..."` was listed after `".."` in `OPS`, so list spread `[...xs, y]` never lexed.
   * `min`/`max` on the CPU path passed `Math.max` to `reduce` directly → `Math.max(acc, x, index, array)` = `NaN`
     (`progress`, `flow`, anything using `max(a, b)` outside a shader was broken).
   * **psolve QP false INFEASIBLE**: a soft equality modelled as two rows + error variable became degenerate whenever
     its target coincided with an active hard bound. Soft *equalities* now go straight into the objective
     (`w·(lin)²` → Q, c; no rows, no variable); only soft inequalities keep an error variable (one-sided). Smaller
     QPs, and the toolbar example (which hit this) solves.

## Layout of the code

```
src/curv/parser.ts      lexer + parser (Curv syntax + solve/var/weak:/minimize statements)
src/curv/interp.ts      tree-walking interpreter, builtins, Cons values + strength tags, solve { } → psolve Problem
                        (fingerprint cache), compileTree (structural-key reuse) / collectParams
src/curv/subcurv.ts     SubCurv: compiles user dist/colour functions to shader code (inlining, loops)
src/curv/shapes.ts      SNode F-Rep tree, bboxOf (memoised), structKey, genShape (shape → straight-line code)
src/curv/prelude.ts     palette, box helpers, layout combinators (incl. flow / hstack_fit), UI components — in Curv
src/curv/examples.ts    example programs (group "solve" | "curv")
src/gpu/gen.ts          code generators: WGSL, JS, ParamsOnly; dynBlock/finalParams parameter layout
src/gpu/renderer.ts     WebGPU renderer (pipeline cache keyed by code, timestamp queries) + CPU fallback
src/gpu/atlas.ts        SDF glyph atlas (Canvas2D + EDT), GLYPHS charset, kerning
src/psolve/*.ts         Lin/Quad affine expressions, Cons, presolve, QP/LP assembly, bridge to psolve.wasm (b64 inline)
psolve-src/             C bridge + build instructions for the wasm (unmodified psolve cores)
src/App.tsx             UI: editor, preview (camera, pause, quality controller), solver + params panels
scripts/                selftest, paramcheck, prof (headless, tsx)
```

## Invariants to keep (things that will silently break otherwise)

* Any new `SNode` kind or new codegen branch on a *value* must be reflected in `structKey`; anything else that varies
  must go through `g.param(...)`. Run `scripts/paramcheck.ts` after touching `genShape` and check its exit code.
* `ParamsOnly` must invoke every callback (`if` then+else, `loop` body once) so parameter order matches.
* Variable-length parameter blocks must use `g.dynBlock` (via `dynBase`) and the buffer must be read with
  `finalParams()`; never bake `g.params.length` into code as a literal.
* Keep `OPS` in the lexer sorted longest-prefix-first for operators that share a prefix.
* Soft equalities must not be modelled as inequality pairs (psolve's active-set QP degenerates); keep them in the
  objective. If you add a new relation type, add it to `Problem.fingerprint()` too.
* `weak`, `medium`, `strong`, `required` are keywords — new strength-related builtins need other names.

## Known gaps / next steps

* Eval (~1–3 ms) still dominates the per-frame cost of animated programs: the interpreter rebuilds every `Lin`
  and every constraint each frame even when the solve is then served from the cache. Memoising a whole
  `solve { }` block by the values of its free variables (static free-variable analysis of the block + hashable
  inputs) would make cached frames eval-only; the `Problem.fingerprint()` cache is the safe fallback.
* `ParamsOnly` still walks the whole tree through the generic `Gen` interface (~0.8–2 ms). A dedicated
  `SNode` walker producing the same order (scalars first, dynamic blocks appended) would be faster.
* `flow` needs a *numeric* maximum width (wrapping is discrete); a solver-aware flow would need integer
  programming. `hstack_fit` gives all items the same font size / padding.
* Kerning is measured pairwise from the canvas font (Inter if installed, otherwise the fallback font), so text
  metrics can differ slightly between machines; the atlas has one weight, no ligatures, no combining marks.
* The quality controller targets GPU time only; CPU-side eval + params time is not budgeted.
* Only 2D shapes are supported (no 3D ray-marching).
