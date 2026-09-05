# Curv+solve — handoff (dev round 9)

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

1. **Shared prelude environment** (`Interp.run`).  The prelude (≈60 defs: palette, box helpers, layout
   combinators, UI components) is bind-time pure, so it is evaluated **once per process** into a shared
   `Env` whose vars map is read-only afterwards; each run re-points `sharedPrelude.parent` at the fresh
   builtins env (which carries this frame's `time`/`mouse`/`viewport`), so names inside prelude bodies
   resolve against the current frame.  The user program evaluates in a child of a **shallow copy** of the
   shared map, so assignments to prelude names (`surface := …`) stay frame-local.  Closures dispatch their
   bodies through a module-level `activeInterp` (set by `run`) instead of the instance that created them —
   prelude closures and call-memoised closures returned across frames now execute against the current
   frame's `inputs`/`traces`/memo bookkeeping.  Effects: ~35 % less fixed per-run overhead (156 → 125 µs
   for a trivial program: no 60-def `bindDefs` per frame), and stable prelude `Fn` identity keeps
   `fnHashMemo` (and thus block/call key hashing) warm across frames.
2. **Codegen LRU by structural key** (`compileTree`).  A `key !== null` tree that was compiled before (cap
   32, per backend) reuses its `code`/`d`/`c`/`usesTime` and only walks for parameters — hopping back to a
   previous example no longer pays `genShape` (1–5 ms), matching the renderer's pipeline cache.
3. **memotest prelude section** (31 cases total): assignments to prelude names are visible in the frame
   that makes them and gone in the next; prelude combinators keep memoising across programs; prelude
   functions stored in lists/lambdas resolve on every frame.

## Round 8 recap (kept from the round-8 handoff — all still in force)

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

## Round 7 recap (kept from the round-7 handoff — all still in force)

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
src/curv/interp.ts      tree-walking interpreter, builtins (Fn.key), Cons values + strength tags,
                        shared prelude env + activeInterp dispatch, solve { } → block memo →
                        fingerprint cache (astId + LRU) → psolve Problem,
                        call memo (applyMemo/ValueHasher/CALL_* knobs, envEpoch, setVar, fnHashMemo),
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
* `codeLru` entries must only ever depend on (backend, structural key): anything else baked into code
  (colours, atlas constants that can differ per document) would need to join the key.

## Known gaps / next steps

* Eval of the *rest* of an animated cached frame (top-level `union`, builtin pipelines `s >> colour …`,
  record construction) is all that remains on warm frames: dashboard ≈ 0.6–1.4 ms raw (noisy sandbox; in
  the App static examples skip evaluation entirely).  The prelude is shared per-process as of round 9;
  what's left is per-frame allocation of the *user* tree (records, `SNode`s) and `builtins()` (~100 fresh
  `Fn`s per run — could be shared the same way once a similar purity proof is made; `time`/`mouse`/
  `viewport` are *values* there, so the shared parts and the per-frame parts would have to be split).
* The shader-only-time fast path keeps the quality scale while animating; settling to full resolution
  only happens on pause / interactions (a settle tick that schedules itself per frame was judged too
  finicky).
* Solids-of-revolution style 3D shapes are rejected ('box [w,h,d]' error) — only 2D SDF.
* `flow` needs a *numeric* maximum width (wrapping is discrete); `hstack_fit` gives all items the same
  font size / padding.
* Kerning is measured pairwise from the canvas font, so metrics can differ slightly between machines; the
  atlas has one weight, no ligatures, no combining marks.
* The GPU budget is derived from the *previous* frame's CPU time; a sudden CPU spike is corrected one
  frame late.
