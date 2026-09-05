# Curv+solve — handoff (dev round 7)

Browser playground for **Curv** (2D F-Rep, compiled to WGSL / JS) extended with
`solve { }` constraint blocks solved by **psolve** (LP + convex QP, WebAssembly).

Live build: `npm run build` → single-file `dist/index.html`.
Headless checks (all use the JS backend, no browser needed):

| command | what it does |
|---|---|
| `npx tsx scripts/selftest.ts [id \| file.curv …]` | evaluates every example, compiles both backends (`anim`/`anim(shader)` flags when the program reads time in the evaluator / only inside compiled shader code), renders `/tmp/t/<id>.png` |
| `npx tsx scripts/paramcheck.ts` | **fast-path oracle**: `walkParams` buffer == ParamsOnly buffer == full codegen's; key stable and shader text identical across time/viewport; **memoised evaluations produce the same buffer as cold ones** (`memo=` column) |
| `npx tsx scripts/memotest.ts` | solve-block **and call-memo** dependency tests (time/mouse/viewport through closures, shadowing, mutations, impure bodies, `print`/`parametric`, node identity …) |
| `npx tsx scripts/prof.ts [-v]` | warm eval / codegen / params-only timings, per-`solve` cache kind, call-memo hit/miss counters; `-v` prints the per-function memo decisions (calls, warm avg µs, LRU entries, skip reason) |

All four were green at the end of this round (`paramcheck` and `memotest` exit 1 on any failure — check the exit code).

## What changed in this round

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
                        solve { } → block memo → fingerprint cache (astId + LRU) → psolve Problem,
                        call memo (applyMemo/ValueHasher/CALL_* knobs, envEpoch, setVar, fnHashMemo),
                        compileTree (structural-key reuse) / collectParams / collectParamsFast
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
src/App.tsx             UI: editor, preview (camera, pause, CPU-aware quality controller, shader-time
                        re-render path), solver + params panels, memo hit counter in the status line
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

## Known gaps / next steps

* Eval of the *rest* of a cached frame (top-level `union`, builtin pipelines `s >> colour …`, record
  construction) still dominates: dashboard ≈ 0.5–1.5 ms (noisy sandbox).  Candidates: memoise
  `shapeFn`/`shapeRec` per node-identity, or a `run()` fast path that skips evaluation when
  `!usesTime && !usesMouse && !usesViewport && inputs equal && last value is a plain shape` — pure by
  construction (see the NOTE in `Interp.run`); it would collapse a static frame to the walk params.
* `CALL_MEMO_MIN_MS` is a fixed 25 µs — could adapt from measured hash cost.  Bodies whose cost sits
  just below the threshold (`vstack`/`hstack`/`grid` at 30–80 µs depending on load) are skipped even
  when called once per frame by example programs; raising `CALL_MEMO_SAMPLES` or profiling on node
  *warmup* frames could pick them up cheaply.
* The shader-only-time fast path keeps the previous quality scale; no settle-to-full-quality tick is
  scheduled per frame (it re-schedules only when `evaluate` ran).
* Solids-of-revolution style 3D shapes are rejected ('box [w,h,d]' error) — only 2D SDF.
* `flow` needs a *numeric* maximum width (wrapping is discrete); `hstack_fit` gives all items the same
  font size / padding.
* Kerning is measured pairwise from the canvas font, so metrics can differ slightly between machines; the
  atlas has one weight, no ligatures, no combining marks.
* The GPU budget is derived from the *previous* frame's CPU time; a sudden CPU spike is corrected one
  frame late.
