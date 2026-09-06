# Curv+solve — handoff (dev round 13)

Browser playground for **Curv** (2D F-Rep, compiled to WGSL / JS) extended with
`solve { }` constraint blocks solved by **psolve** (LP + convex QP, WebAssembly).

Live build: `npm run build` → single-file `dist/index.html`.
Headless checks (all use the JS backend, no browser needed):

| command | what it does |
|---|---|
| `npx tsx scripts/selftest.ts [id \| file.curv …]` | evaluates every example, compiles both backends (`anim`/`anim(shader)` flags when the program reads time in the evaluator / only inside compiled shader code), renders `/tmp/t/<id>.png` |
| `npx tsx scripts/paramcheck.ts` | **fast-path oracle**: `walkParams` buffer == ParamsOnly buffer == full codegen's; key stable and shader text identical across time/viewport; **memoised evaluations produce the same buffer as cold ones** (`memo=` column); **`skip=safe`** when a program reads no time/mouse/viewport and its key *and* parameter buffer are identical for every input (the exact precondition of the App's static-frame skip) |
| `npx tsx scripts/memotest.ts` | solve-block **and call-memo** dependency tests (time/mouse/viewport through closures, shadowing, mutations, impure bodies, `print`/`parametric`, node identity …) |
| `npx tsx scripts/prof.ts [-v]` | warm eval / codegen / params-only timings, per-`solve` cache kind, call-memo hit/miss counters; `-v` prints the per-function memo decisions (calls, warm avg µs, LRU entries, skip reason) |

All four were green at the end of this round (`paramcheck` and `memotest` exit 1 on any failure — check the exit code).

## What changed in this round

1. **`textWindow` shader variant** (`SHADER_FLAGS.textWindow`, round-13 attempt at faster text): text
   nodes with more than 6 glyphs binary-search the glyph cell under the pixel (cells are sorted along
   the row; 6 branchless steps cover N ≤ 64), then evaluate only a 6-glyph window around the hit, with a
   guard falling back to the full loop when the AA pad exceeds half a cell (deep zoom-out).  Verified
   **pixel-identical to the baseline on toolbar (0/9216 differing pixels)** and buffer-identical on all
   examples.  Benchmark verdict, though (full 19-example matrix, JS raster): **+6 % total** — the
   search + guard costs ≈ saved glyph scans; the dominant per-pixel term is uniform loads / address
   arithmetic, not glyph count.  Off by default, kept for a future GPU-side benchmark (`shaderbench`).
2. Round-13 full matrix (sums over all 19 examples; baseline 509 ms total raster):

   | way | Δ time | WGSL |
   |---|---|---|
   | text-window | +6 % (stacks +94 %, buttons +48 %) | +18 % |
   | unroll-8 | +13 % | code +5 % |
   | text-branchless / if-flatten / poly-select | +2–3 % each | −30 % .. 0 |
   | **cull removed** | **+157 %** | branches −64 % |
   | cull weight 1 / 8 / 16 | +9 / +10 / +46 % | — |

## Round 12 recap (kept from the round-12 handoff — all still in force)

1. **GitHub Pages**: the single-file build is live at <https://sodomita.github.io/curv-ps/> — served from
   the `gh-pages` branch (repo root `index.html` = `dist/index.html`), rebuilt and force-pushed by
   `.github/workflows/pages.yml` on every push to main; repo homepage set via the API.
   Refresh the branch manually with `npm run build` + the same orphan-commit recipe if Actions is off.
2. **Shader-variant infrastructure and the branch-reduction study** (`SHADER_FLAGS` in `src/gpu/gen.ts`,
   benchmark `scripts/shaderbench.ts`).  Every variant preserves the parameter layout exactly (params
   verified equal with all flags on) and is fingerprinted into `structKey` (`flagsKey`) so caches never
   mix.  Measured per example on the JS backend (what the CPU renderer executes), with interleaved
   best-of-4 timing — first-run JIT effects otherwise masquerade as ±20 % between *identical* code:

   | way (vs baseline) | total over 19 examples | branches (`if`) | verdict |
   |---|---|---|---|
   | poly-select (`%`→conditional index, sign via `select`) | +0 % (±4 % on polygon) | 334→333 | off: branch is cheaper where it skips |
   | text-branchless (always sample + `select`) | +0 %, **stacks +69 %** | 334→217 | off: texture-call traffic beats divergence here |
   | if-flatten (dynamic `if` → `select`, tiny bodies) | +1 %, mandelbrot +18 % | 334→333 | off: computes both sides per pixel |
   | unroll static loops ≤ 8 | **+9 %** (smoke +51 %) | code +27 kB | off: JIT/code-size hurt |
   | **cull-none** (no bbox culling) | **+149 %** | 334→120 | — |
   | cull weight 1 / 8 / 16 (baseline 4) | +7 % / +9 % / +43 % | 576 / 290 / 199 | keep 4 |

   Takeaways kept as invariants: **bbox-cull branches are the single biggest shader win (2.5×)**;
   textbook "branchless is better on GPUs" is **false on this corpus** for scalar/texture-heavy paths —
   a skipped texture call and a skipped subtree beat `select`, and reducing per-pixel loop iterations
   does not pay when the dominant cost is uniform loads / address arithmetic.  `flattenIf`/`unrollMax`/
   `textWindow` remain available for future programs; re-run `shaderbench` before enabling anything by
   default (round 13 added the same lesson yet again: verify with pixel-equivalence probes, then measure).

## Round 11 recap (kept from the round-11 handoff — all still in force)

1. **Adaptive layout combinators** (`src/curv/prelude.ts`).  `flow_fit gap maxw maxh pad s labels b items`
   greedily wraps *measured* chips (like `flow_text`) after bisecting the largest font size ≤ s whose rows
   fit `maxw × maxh` (8 steps ≈ 1 %; font metrics via `text_size`; wraps are discrete so the decision is
   numeric, only positions are solved).  It returns `{ size, cells }`: `F.cells` adds the constraints and
   the caller exports `F.size` through a solved variable (`var fsz : num; fsz == F.size;`) to draw the
   chips at exactly the chosen size.  `fit_labels gap pad s maxw labels` returns the longest prefix (+1)
   of a toolbar row whose measured chips fit `maxw` — items that cannot fit are *dropped* instead of
   over-constraining the system.
2. **The examples never go infeasible anymore** (new `wrapfit` example; `toolbar`, `buttons`, `tooltip`
   updated): a solver-run grid over 140..900 × 320..700 succeeds everywhere.  This surfaced two rules
   worth keeping:
   * **psolve's active-set QP degenerates on tens of parallel softened inequalities around active
     bounds** (KKT_FAIL — empirically at widths where intrinsic minima went slack).  Adaptation belongs in
     the evaluator (bisection/truncation on numerics); keep the solver's soft constraints as plain
     quadratic pulls (`weak:`/`weight k: ==`), not soft inequalities that sit on their bound.
   * Conflicting slack pulls compromise in the ratio of their squared weights: body-hug `weight 4` vs
     space `weak` settles ≈ 15:1.  (And an unconstrained record width solves to 0 — `tagbox` needed
     `right == …` pinned, cosmetically.)
3. Reference rows for `fit_labels` / `flow_fit`; `buttons` and `tooltip` got bounded adaptive variants of
   their teaching constraints (list-driven rendering replaces hard-coded indices).

## Round 10/9/8/7 recaps (kept from earlier handoffs — all still in force)

1. **Shared static builtin environment** (`staticBuiltins`, per-atlas `WeakMap`).  All ~150 builtins that
   depend only on their arguments (math, lists, strings, colours, shape constructors/operators, text
   metrics via the atlas) now live in one read-only per-process env; the per-frame layer is just
   `time`/`mouse`/`viewport` (`parent` alias).  Definitions that turn user shader functions into custom
   nodes (`make_shape`, `make_texture`, `colour f`, `[ifield, cmap]`) dispatch through `activeInterp` so
   their results belong to the calling frame.  **Fixed per-run overhead: 125 µs → 5.6 µs.**
   Supporting mechanism: `Env.readonly` — the chain is
   `user child envs → dynamicEnv → sharedPrelude (ro) → staticBuiltins (ro)`; `owner()` skips readonly
   envs, and assigning to a name that only a *readonly* env holds creates a **same-frame shadow** binding
   in the statement's env (so `do surface := "tampered"` / `do sin := 3` still work, visibly, for that
   frame only — next frame sees the original).  No per-frame copies anywhere, and `envEpoch` no longer
   moves at all in normal frames, so `fnHashMemo` is warm process-wide.
2. **Shape accessors and `s.bbox` records memoised per `SNode`** (module weakmaps): `s.dist`/`s.colour`
   are one `Fn` per node across all frames and interps (hash keys stable), and they dispatch through
   `activeInterp` — this also fixed a latent bug where a call-memoised accessor evaluated distances at
   the *creation* frame's `time` instead of the current one.  `shapeRec` (`s.bbox`, `s.dist`, …) is one
   record per node.  Two new memotest cases (33 total).
3. Warm-frame effect (`prof.ts`, noisy sandbox but consistent): split eval 0.15 → 0.04 ms, dashboard
   1.3 → 0.9 ms, toolbar 0.7 → 0.8 ms with 27 memo hits; params-only on cached trees is 0.01–0.1 ms.

### Round 9 recap (kept from the round-9 handoff — all still in force)

1. **Shared prelude environment** (`Interp.run`).  The prelude (≈60 defs: palette, box helpers, layout
   combinators, UI components) is bind-time pure, so it is evaluated **once per process** into a shared
   `Env`; each run re-points `sharedPrelude.parent` at the fresh dynamic-builtin layer (which carries this
   frame's `time`/`mouse`/`viewport`), so names inside prelude bodies resolve against the current frame.
   Closures dispatch their bodies through a module-level `activeInterp` (set by `run`) instead of the
   instance that created them — prelude closures and call-memoised closures returned across frames now
   execute against the current frame's `inputs`/`traces`/memo bookkeeping.  Effects: stable prelude `Fn`
   identity keeps `fnHashMemo` (and thus block/call key hashing) warm across frames.  (Round 10 removed
   the per-run shallow copy: the env is marked readonly and assignments shadow instead — see above.)
2. **Codegen LRU by structural key** (`compileTree`).  A `key !== null` tree that was compiled before (cap
   32, per backend) reuses its `code`/`d`/`c`/`usesTime` and only walks for parameters — hopping back to a
   previous example no longer pays `genShape` (1–5 ms), matching the renderer's pipeline cache.
3. **memotest prelude section** (31 cases total): assignments to prelude names are visible in the frame
   that makes them and gone in the next; prelude combinators keep memoising across programs; prelude
   functions stored in lists/lambdas resolve on every frame.

### Round 8 recap (kept from the round-8 handoff — all still in force)

1. **App static-frame skip** (`src/App.tsx` `evaluate`).  After a successful evaluation, if the program read no
   `time`/`mouse`/`viewport` (`usesTime || CompiledTree.usesTime` covers the shader side too), its
   `{fp}` is cached where `fp = src + JSON(parametric values) + debug-flag`.  Any later dirty frame with the
   same fp (pan/zoom, resize, settle ticks — the camera and canvas size are render **uniforms**, not program
   inputs) re-renders `lastProg` directly: no interpreter, no `compileTree`, status line shows `· static` in
   green.  Consequences this forced: the **debug-boxes overlay stroke width is a constant 1.5 world units**
   (it used to be `1/zoom` — camera-dependent); camera **fitting runs inside the same evaluation** (`needFit`
   branch: responsive programs re-run the same `Interp` with the home viewport — `Interp.run` is now
   **idempotent** and wipes its per-instance state — instead of a second Interp whose results were silently
   dropped); the skip is only taken when `!needFit`.  Render calls funnel through a `paint(prog, q, updateCode)`
   helper shared by the evaluation path, the skip path and the shader-time path.
2. **Adaptive call-memo threshold.**  The decision at `CALL_MEMO_SAMPLES` now also measures the *warm* cost of
   keying this very call (hashes the closure + argument twice and times the second — the first primes
   `fnHashMemo` for the frame's fresh closure graph): memoise iff `avgWarmBody ≥ max(CALL_MEMO_MIN_MS (8 µs),
   2 × warmHash)`.  Known-unhashable calls are skipped outright.  This replaces the fixed 25 µs wall and
   picks up the 15–60 µs prelude helpers (`nav`, `panel`, `progress`, `avatar`, `button`): dashboard hits went
   8 → 24 per warm frame with hashing ≈ 0.12 ms; a 9 µs body hashed in ~7 µs is correctly skipped.
3. **`paramcheck` static-skip oracle** (`skip=safe` column) and Reference rows for the new behaviour.

### Round 7 recap (kept from the round-7 handoff — all still in force)

1. **Call memo for pure user functions** (`Interp.applyMemo`, used by `makeClosure`'s final application).
   Each function *body* is profiled for `CALL_MEMO_SAMPLES` (4) calls — the first call is
   excluded as cold — and memoised cross-evaluation only when its warm average is ≥ `CALL_MEMO_MIN_MS`
   (25 µs), so tiny helpers are never slowed down by hashing.  The key is `closure-hash + argument-hash`
   (the closure hash covers the values of its free variables, so `time`, outer data and any functions it
   calls are all dependencies).  Pure means: no `:=` to a captured variable, no `parametric` inside,
   and no `print` in its free names (side effects only).  A hit replays the call's **solve traces**
   (as `cacheKind: "block"`, `timeMs: 0`) and its **time/mouse/viewport flags** recorded during the
   original evaluation; results are immutable, so the same record/list/`SNode` tree is returned every
   frame — downstream `bboxOf`/`structKey`/`walkParams`/`nodeHash` memos then hit by identity.
   Per body: 32-entry LRU in `callCache`, global entry cap, `callStats` capped at 4096 bodies.
   `EvalResult.callMemo` (hits/misses/measured/skipped/hashMs) feeds `prof.ts` and a status-line
   counter; `callMemoTable()` (used by `prof -v`) shows per-body mode/calls/avg/why.
2. **`SNode` content hash** (`nodeHash` in `src/curv/shapes.ts`, WeakMap-memoised; 64-bit FNV-1a over
   kinds, numbers, strings, children).  Shape values are now hashable inputs for both the block memo and
   the call memo (round-6 gap closed).  `custom`/`colourfn` nodes (user shader functions, which can read
   the time uniform) return null → those blocks/calls are never memoised.
   `shapeFn` accessors (`s.dist`, `s.colour`) of plain trees get `key = "dist:<nodeHash>"` so functions
   receiving them stay hashable.
3. **Closure hashes memoised per `Fn` with an environment epoch** (`fnHashMemo`, valid only while
   `envEpoch` is the epoch it was computed in).  `envEpoch` bumps on every binding *overwrite* —
   `x := …`, or a name re-bound in the same env (all writes go through `setVar`: bindPat, execDo do `local`,
   `parametric`, solve env).  New bindings of previously-undefined names never wrongly invalidate (such a
   closure is not globably memoised at all), so per-frame per-call-site defs cost one hash at most.
4. **`structKey` memoised per subtree** (`skMemo[2]` keyed by node + cull flag) and **`walkParams`
   decomposed into memoised subtree segments** (`ParamSeg`: numbers + relative block-slot positions;
   `wpMemo[2]`; subtrees under ~24 numbers are walked inside their parent instead).  With the call memo
   returning identical subtrees across frames, dashboard `params-only` dropped to ~0.03–0.05 ms and the
   key walk is mostly memo hits; buffers verified equal by `paramcheck`.
5. **Problem fingerprint cache keyed by `astId(stmts)` with an 8-entry LRU** (was: source line, one
   slot) — same block body in several call sites no longer evicts itself (round-6 gap closed).
6. **Shader-side time detection**: `Gen.usesTime`, set by SubCurv when compiled user code reads the
   `t` of its `[x,y,z,t]` argument (the point is tagged `pt`; its 4th component `time`) or the `time`
   identifier; surfaced as `CompiledTree.usesTime`.  App: `usesTime || prog.usesTime` drives animation,
   pause and the budget controller, and when time is *only* used in the shader (`shaderTimeOnly`), the
   frame loop **re-renders the same program with the new time uniform without re-evaluating the tree** —
   liquid_paint and smoke now animate (they previously froze at t≈0).  `selftest` prints `anim(shader)`.

## Layout of the code

```
src/curv/parser.ts      lexer + parser (Curv syntax + solve/var/weak:/minimize statements)
src/curv/freevars.ts    static free-variable analysis (blocks + closure bodies), astId; FreeInfo.why
src/curv/interp.ts      tree-walking interpreter, shared static builtins + dynamic layer (Fn.key),
                        Cons values + strength tags, shared prelude env (Env.readonly + shadow-assign),
                        activeInterp dispatch, solve { } → block memo → fingerprint cache (astId + LRU) →
                        psolve Problem, call memo (applyMemo/ValueHasher/CALL_* knobs, envEpoch, setVar,
                        fnHashMemo), shapeRec/shapeFn per-node memos,
                        compileTree (structural-key reuse + codeLru) / collectParams / collectParamsFast
src/curv/subcurv.ts     SubCurv: compiles user dist/colour functions to shader code (inlining, loops);
                        tags the point argument, reports time reads (Gen.usesTime)
src/curv/shapes.ts      SNode F-Rep tree, bboxOf (memoised), textMetrics/textGlyphs, nodeHash (memoised),
                        weight (memoised), structKey (memoised per subtree), genShape, walkParams (segment-memoised)
src/curv/prelude.ts     palette, box helpers, layout combinators (incl. flow / hstack_fit), UI components — in Curv
src/curv/examples.ts    example programs (group "solve" | "curv")
src/gpu/gen.ts          code generators: WGSL, JS, ParamsOnly; dynBlock/finalParams; Gen.usesTime
src/gpu/renderer.ts     WebGPU renderer (pipeline cache keyed by code, timestamp queries) + CPU fallback
src/gpu/atlas.ts        SDF glyph atlas (Canvas2D + EDT), GLYPHS charset, kerning
src/psolve/*.ts         Lin/Quad affine expressions, Cons, presolve, QP/LP assembly, bridge to psolve.wasm (b64 inline)
psolve-src/             C bridge + build instructions for the wasm (unmodified psolve cores)
src/App.tsx             UI: editor, preview (camera, pause, CPU-aware quality controller, static-frame
                        skip cache, shader-time re-render path, single-eval camera fitting), solver +
                        params panels, memo hits + static badge in the status line
scripts/                selftest, paramcheck, memotest, prof (headless, tsx)
```

## Invariants to keep (things that will silently break otherwise)

* **`walkParams`/`walkSeg` must mirror `genShape` exactly**: every `g.param` / `dynBlock` needs a
  matching push in the same order, and `cull` must be propagated the same way (`kid(…, {cull:false})` ⇒
  `walk(s, false)`; `colour`, `opacity`, `grad`, `reflect`, `xform`, the second `shadow` child inherit).
  Watch argument-evaluation order (`stretch` pushes `m` *before* its child and again after).  The
  parameter layout must not depend on memo state: segments are `WeakMap`-memory, hits and misses must
  produce identical buffers.  Run `scripts/paramcheck.ts` after touching either and check its exit code.
* Any new `SNode` kind or new codegen branch on a *value* must be reflected in `structKey`/`structKeyMemo`,
  `nodeHash`, **and** `walkSeg`; anything else that varies must go through `g.param(...)`.
* `ParamsOnly` must invoke every callback (`if` then+else, `loop` body once) so parameter order matches.
* Variable-length parameter blocks must use `g.dynBlock` (via `dynBase`) and the buffer must be read with
  `finalParams()`; never bake `g.params.length` into code as a literal.  `ParamSeg.blocks.at` is a
  *slot index* into `nums` (the value written there is the final block offset).
* **Free-variable analysis must never under-approximate**: a name that *might* be read from the enclosing
  env must be reported free (extra names are harmless).  New `Expr`/`Stmt` kinds need a case in
  `freevars.ts`; new binding constructs must follow the evaluator's binding order.  Any new evaluator
  side effect reachable from inside a function/block must set `pure = false` (add a case to
  `scripts/memotest.ts`), also for the *call memo* — and any host state read (like `time`/`mouse`/
  `viewport`/`parametric` inputs today) must either be a free name or marked impure.
* **Every binding write goes through `setVar`** so `envEpoch` tracks overwrites: never `env.vars.set`
  directly in the evaluator (env construction inside builtins' `b()` records is fine, it's a fresh map).
* **New builtins must be registered through `b(name, …)`** so they get an `Fn.key`; a builtin `Fn` without
  a key makes every block/call that mentions it unhashable (silent fallback — `prof.ts -v` shows it).
  Builtins that read mutable host state other than `time`/`mouse`/`viewport`/params would break
  memoisation — there are none today (`text_size` depends only on the constant atlas).
* The results of memoised blocks/calls are shared between frames: records/lists/**SNodes** must stay
  immutable in the evaluator (including `WalkParams` segments — never mutate `seg.nums` after caching).
* `nodeHash` must cover *everything* the evaluator can observe about a plain node; `custom`/`colourfn`
  nodes (which read the time uniform) must stay unhashable, and host-state-free builtin `Fn`s are the
  only ones that may get a `.key`.
* Keep `OPS` in the lexer sorted longest-prefix-first for operators that share a prefix.
* Soft equalities must not be modelled as inequality pairs (psolve's active-set QP degenerates); keep them
  in the objective.  If you add a new relation type, add it to `Problem.fingerprint()` too.
* **Do not soften bounds in bulk with `strength`/`weight` tags inside combinators**: many parallel soft
  inequalities going in and out of satisfaction degenerate the active-set QP (KKT_FAIL).  Numeric
  adaptation (`flow_fit` bisection, `fit_labels` truncation) in the evaluator is the sane pattern; in the
  solver, prefer quadratic pulls toward equality.  Sweep a viewport grid (selftest renders one; grep the
  scripts for the 140..900 × 320..700 loop) when touching example structure.
* `weak`, `medium`, `strong`, `required` are keywords — new strength-related builtins need other names.
* The fast frame-loop path (`shaderTimeOnly`) may re-render without evaluating **only** when the program
  used no evaluator-side `time`: any `res.usesTime` means the tree itself changes per frame.
* The **static-frame skip** (App) is valid only because every program input is part of the fingerprint —
  src text, parametric values, debug flag — and because `time`/`mouse`/`viewport` reads are flagged
  (`res.usesTime || CompiledTree.usesTime` / `usesMouse` / `usesViewport` must stay exhaustive for ALL
  evaluator and SubCurv paths; missing flag = stale picture with no error).  The camera/canvas size must
  stay render-uniform-only: nothing in evaluation, the debug overlay or parameter generation may depend on
  it (that is why the overlay stroke width is a constant and fitting is one evaluation, not two).
* `Interp.run` must stay idempotent (App re-runs on the same instance for the fit retry): reset all
  per-instance state at the top.
* The **prelude must stay bind-time pure**: no `time`/`mouse`/`viewport`/`parametric` reads, no `solve`,
  no side effects in definitions (function *bodies* may call `text_size`; those are evaluated per call).
  The shared prelude vars map must **never** be written after the first bind (user assignments land in the
  per-run copy); don't add prelude defs for host-state-dependent values.
* New `Fn`-producing helpers must dispatch body evaluation through `activeInterp` (as `makeClosure` does)
  so shared / memoised closures execute against the current frame.
* **Shared envs are readonly**: never `setVar` into `staticBuiltins(...)` or `sharedPrelude` after
  creation.  New per-process values must be bind-time pure for their env (builtins: args + atlas only —
  anything reading `time`/`mouse`/`viewport` belongs in the small dynamic layer `Interp.builtins()`).
* Shape accessor `Fn`s are shared per node: they must never capture per-frame interp state (dispatch
  through `activeInterp`), and their CPU evaluation must be a pure function of (node, point, time).
* `owner()` skipping readonly envs is load-bearing for frame isolation: `x := y` where `y` is a builtin
  or prelude name must stay a same-frame shadow, not corruption of the shared env.
* `codeLru` entries must only ever depend on (backend, structural key): anything else baked into code
  (colours, atlas constants that can differ per document) would need to join the key.

## Known gaps / next steps

* Eval of the *rest* of an animated cached frame (user-tree construction, `union` literals) is nearly
  all that remains on warm frames (split 0.04 ms, dashboard ≈ 0.9 ms raw; static examples skip
  evaluation entirely).  Builtins (round 10) and the prelude (round 9) are shared per-process now; the
  per-frame cost is now dominated by the program's own tree allocation.
* The shader-only-time fast path keeps the quality scale while animating; settling to full resolution
  only happens on pause / interactions (a settle tick that schedules itself per frame was judged too
  finicky).
* Solids-of-revolution style 3D shapes are rejected ('box [w,h,d]' error) — only 2D SDF.
* `flow`/`flow_fit`/`fit_labels` need *numeric* budgets (wrapping is discrete); `hstack_fit` gives all
  items the same font size / padding.
* Kerning is measured pairwise from the canvas font, so metrics can differ slightly between machines; the
  atlas has one weight, no ligatures, no combining marks.
* The GPU budget is derived from the *previous* frame's CPU time; a sudden CPU spike is corrected one
  frame late.
