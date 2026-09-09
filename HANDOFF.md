# Curv+solve — handoff (dev round 21)

Browser playground for **Curv** (2D F-Rep, compiled to WGSL / JS) extended with
`solve { }` constraint blocks solved by **psolve** (LP + convex QP, WebAssembly).

Live build: `npm run build` → single-file `dist/index.html`.
Headless checks (all use the JS backend, no browser needed):

| command | what it does |
|---|---|
| `npx tsx scripts/selftest.ts [id \| file.curv …]` | evaluates every example, compiles both backends (`anim`/`anim(shader)` flags when the program reads time in the evaluator / only inside compiled shader code), renders `/tmp/t/<id>.png` |
| `npx tsx scripts/paramcheck.ts` | **fast-path oracle**: `walkParams` buffer == ParamsOnly buffer == full codegen's; key stable and shader text identical across time/viewport; **memo replays are bitwise-identical and memo-vs-cold buffers agree within `warmΔ ≤ 1e-6`** (`memo=` column; the Δ is solve-path rounding from accepted warm starts, replay itself stays bitwise); **`skip=safe`** when a program reads no time/mouse/viewport and its key *and* parameter buffer are identical for every input |
| `npx tsx scripts/memotest.ts` | solve-block **and call-memo** dependency tests (time/mouse/viewport through closures, shadowing, mutations, impure bodies, `print`/`parametric`, node identity …) |
| `npx tsx scripts/threedcheck.ts` | **round-17 3D gate**: every example evaluates; the 3D group compiles in solid mode on both backends; `bbox3` sanity; `is_2d`/`is_3d` + dimensional `bbox` of the shape record; the CPU raymarcher really draws (centre lit / background outside / slice parity / animation divergence) |
| `npx tsx scripts/stdcheck.ts` | **C++ `std.curv` parity**: prelude values (`transpose`, `sort`, `contains`, colours …), 2D/3D boxes against the C++ formulas, and — the load-bearing part — the *generated* field sampled on a grid: no non-finite distance anywhere, and no point inside the shape outside its own `bbox3` |
| `npx tsx scripts/branchbench.ts [id …]` | **round-19 branch-vs-branchless benchmark**: times five builds (`branching`, `noShortCircuit`, `+cullSelect`, `branchless` bodies, `branchless` raymarch) on the CPU fallback at a pinned resolution, interleaved, and counts the `if`/`break`/`&&` that remain in the WGSL |
| `npx tsx scripts/wgslcheck.ts` | **round-18 WGSL gate**: parses the **whole** shader the GPU sees (`wrapWGSL`, wrapper included) for every example *and* a list of codegen corner cases, in **both** view modes (50 shaders).  Needed because the JS/CPU target accepts things WGSL does not: `if (dd > FAR) break;` in the 3D raymarch loop shipped green through every gate and failed only in the browser |
| `npx tsx scripts/pdiff.ts [--update] [id …]` | **golden pixel gate**: renders every example headlessly (slice mode at 240×160 + solid mode at 96×64 for the 3D group), hashes the framebuffer and compares with `scripts/golden/pdiff.json`; counts non-finite distances per frame. `--update` (re)writes the goldens after an intended change |
| `npx tsx scripts/flagcheck.ts [id …]` | **round-21 invariance gate for the `gen:` menu**: every example × every flag setting the menu can produce — pixels and parameter buffer identical to the shipped default in **both** view modes, the walked buffer equal to the codegen buffer, each setting's code independent of which setting was compiled before it, and the two view modes never sharing a compiled program |
| `npx tsx scripts/warmcheck.ts` | **round-14 bridge oracle**: warm→cold drag equivalence (plan P0.2 acceptance: pixel-identity), failure degradation/recovery with **no memo pollution**, first-frame certified-infeasible error message, wall-clock **budget → STOPPED + approximate incumbent (never garbage)**, budget ladder certifies |
| `npx tsx scripts/warmbench.ts [example …]` | cold-vs-chained solve timing, interleaved best-of-4 per width (round-12 noise lesson), warm-accept / cold-retry counters |
| `npx tsx scripts/internbench.ts [example …]` | round-15 hash-consing A/B (inode ON/OFF, alternated in-process, best-of-6): full-eval cost vs fresh-tree key+param-walk cost, hit counters |
| `npx tsx scripts/exprbench.ts [example …]` | round-16 expression-memo A/B (alternated in-process, best-of-6): full-eval cost with the list-site memo ON vs OFF |
| `npx tsx scripts/prof.ts [-v]` | warm eval / codegen / params-only timings, per-`solve` cache kind, call-memo hit/miss counters; `-v` prints the per-site memo decisions (function bodies and «list» expression sites) |

All twelve check scripts were green at the end of this round (`paramcheck` / `memotest` / `warmcheck` / `threedcheck` / `wgslcheck` / `stdcheck` / `pdiff` exit 1 on any failure — check the exit code).  `pdiff` and `stdcheck` run with `setSolveBudget(0)`: the UI's 16 ms per-solve budget can hand back an incumbent that depends on machine load, which would make a golden frame flaky.

## What changed in this round (21) — two cache keys that forgot an input of codegen

Round 20 put every `SHADER_FLAGS` option behind a menu, which makes one question load-bearing for
every cache that is keyed on the shape tree: *is this entry valid under the flags and the view mode
of the request?*  `scripts/flagcheck.ts` asks it for all 27 examples × 7 settings.  Two answers were
no:

* **`structKey` was mode-blind.**  It mixes `cullable()`'s answer per child — and `cullable` is false
  for every child when `cull` is false, so any tree *without* a cullable child hashed identically in
  the two view modes.  Slice unions blend with coverage AA and carry cull brackets; solid unions take
  the exact min and the raymarcher owns early-out, so the two are not the same shader — yet the code
  LRU (and the `prev` fast path in `compileTree`) served the 2D one to the 3D view, and the other way
  round.  Every 3D example was exposed: once a program had been compiled in 2D, its 3D view ran the
  2D shader — 12.9% of the pixels differ on `rings3d`, 3.9% on `loft3d`.  The key now carries the
  mode (`|1|` / `|0|`).
* **`walkParams`' memo was flag-blind.**  Its slots were keyed on `cull` alone, but `cullable()` reads
  `SHADER_FLAGS.cullWeight`, and a cull bracket pushes its bbox as four parameters.  After moving the
  cull-weight slider the tree walk kept handing out the buffer built under the old threshold — 615
  numbers to a shader compiled for 635 — and the walk is exactly what feeds the GPU every frame.
  Slots are now keyed on `flagsKey()`, like the struct-key slots already were.

Both are the same class: a cache keyed on "the shape" that forgot one input of codegen.  The gate
compiles each setting twice in two different orders (a setting's text must not depend on which
setting ran before it), compares every setting's pixels and parameter buffer against the shipped
default in both view modes, checks the walked buffer against the codegen buffer, and asserts the two
view modes never share a compiled program.

Two golden frames changed (`rings3d@solid`, `loft3d@solid`): the 3D goldens had been recorded with
the 2D shader.  `scripts/pdiff.ts --update` also no longer drops the goldens it did not re-render
when it is given a list of example ids — it did, once, in this round.

## Round 19 recap — branchless shaders: built, measured, and mostly *not* shipped

The round-18 bug (a brace-less `if` in the hand-written WGSL wrapper) invited the obvious cure:
generate **no branching at all**.  `Gen` can now lower control flow instead of emitting it:

* `assign` under a condition → `x = select(x, v, cond)` (WGSL) / `x = (cond ? v : x)` (JS);
* `if`/`else` → **both** arms emitted, each guarded by the condition (or its negation) — no control
  flow, and assignments compose, so nesting works without any special case;
* `break` → a per-loop `live` flag cleared *at the break site* (clearing it only at the end of the
  iteration lets one more body run — that bug cost an afternoon and showed up as a wrong Mandelbrot);
* `&&`/`||` → non-short-circuiting `&`/`|`, which WGSL also defines for `bool`;
* loops stay: a `for` whose trip count is a parameter is uniform, not divergent.

Four flags (`src/gpu/gen.ts`): `branchless` (master: masked `if`s/`break`s *and* the 3D raymarch),
`noShortCircuit`, `cullSelect` (only the bbox-cull bracket), `branchless3D` (only the raymarch).
All are in `flagsKey()`, so cached code is never confused across them.

**Result: zero `if`, `else`, `break`, `continue` and zero short-circuit operators** in the
branchless build — every example and every corner case, in both view modes — and `wgslcheck`
now *asserts* that (it parses both flavours and fails if the branchless one still branches).
`pdiff` is 35/35 identical with **either** build, as are `threedcheck` and `stdcheck`: the two
builds are the same program, only the price differs.

### Measured (`scripts/branchbench.ts`, CPU fallback, best-of-N, resolution pinned)

| build | 2D slice | 3D solid (3D group) |
|---|---|---|
| branching (round-18 default) | 1.00× | 1.00× |
| `noShortCircuit` (`&&`→`&`) | **1.00×** | **1.02×** |
| `+cullSelect` | 2.79× | 1.01× |
| `branchless` (bodies + raymarch) | **3.05×** | **9.72×** |

Worst cases, all from removing a branch that was *doing work*: a text-heavy 2D tree rendered in the
3D view (`buttons` 19.3×, `split` 17.9×, `dashboard` 17.7× — the glyph loop samples the atlas for
every glyph of every label at every pixel once `if (inside cell)` is gone), and the raymarch
(9.7× — every ray now runs all 128 steps and is shaded even when it hits nothing).

**Why it cannot be cheap:** two of the branches are load-bearing optimisations, not artefacts.
The bbox-cull branch *skips a whole subtree* for pixels outside its box, and the raymarch's
early-out *stops marching*.  A branchless build must evaluate both sides, so it is ≥ the branching
build in ALU work by construction; what it buys is warp coherence, which here is worth far less
than the work it costs.

**Shipped:** `noShortCircuit: true` (measured free, and it removes every `&&`/`||` from the
generated code — on a GPU that is a real branch removed for one AND).  `branchless`, `cullSelect`
and `branchless3D` stay off: implemented, documented, benchable with one flag, and shown above.
`polygon` is the one example that got *faster* branchless (0.72×, `polySelect` replaces a `%`),
which is a nudge towards measuring `polySelect` on its own.

**In the UI:** the preview toolbar has a `gen: branched | branchless` menu (`src/components/GenOptions.tsx`)
that exposes every `SHADER_FLAGS` option, each with its measured cost in the tooltip, plus a live branch
census of the last compiled shader (`N lines · i if · b break · s && || · L loops`).  Flipping an option
mutates `SHADER_FLAGS` and clears `lastProg`/`staticCache`; three `wgslcheck` checks keep that honest:
switching to `branchless` must produce different code (not a reused shader), switching back must restore
the old text, and the **parameter layout must not move** (292 params either way) — the menu cannot be
allowed to invalidate the memoised tree walk.

Caveat, stated plainly: **these are CPU-fallback numbers.**  Headless Node here has no WebGPU
device (`@kmamal/gpu`/Dawn hangs with no adapter), so the GPU side of the trade is unmeasured —
the ALU increase is the same, the coherence win is not, and the browser preview is the only oracle.

## Round 18 recap (kept from the round-18 handoff — all still in force)

### The 3D view never compiled on a GPU, and the gate that would have said so

**The bug.**  `wrapWGSL3D`'s raymarch loop contained `if (dd > FAR) break;` and `if (tt > FAR) break;`.
In WGSL the body of an `if` must be a *compound* statement, so both are syntax errors — naga reports
`expected '{' for if statement`.  Every 3D shader (and every 2D example switched to the 3D view)
failed to compile, and the app surfaced it as `error: shader: expected '{' for if statement (line 61)`.

**Why nothing caught it.**  The WGSL and JS backends share the generated *body*, but the two wrappers
are hand-written — and the JS target happily accepts a brace-less `if`.  Headless scripts use the CPU
renderer, so `selftest`, `threedcheck` and `pdiff` all ran the JS wrapper; the WGSL wrapper was never
parsed, compiled or executed once.  The line number in the message was also a lie: it subtracted a
constant 20 meant to skip the preamble, which points at an arbitrary line of the body for an error
that lives in the wrapper.

**The fixes.**
* `if (dd > FAR) { break; }` / `if (tt > FAR) { break; }` (both backends' wrappers reviewed; the 2D
  one has no bare statements).
* The shader error now says which view and which line *of the generated shader*
  (`… (solid WGSL line 123)`) instead of pretending to be a line of the program.
* **The status bar has a `copy` button** whenever there is an error: it copies the message, the
  example id, the view mode (2D slice / 3D solid), the backend (`webgpu` + adapter, or the CPU
  fallback) and the program — everything a bug report needs.  `navigator.clipboard` first, a hidden
  `textarea` + `execCommand` fallback for non-secure contexts.
* **`scripts/wgslcheck.ts`** (new gate, in CI): parses every example plus 23 hand-picked codegen
  corner cases (`text`, `repeat_xyz [3,3,0]`, `cone {mode:"mitred"}`, `capsule`, `slice_xz`, `gyroid`,
  `twist`, `bend`, `loft`, `morph`, `make_shape`, …) in **both** view modes with `wgsl_reflect`
  (devDependency).  It parses the output of `wrapWGSL` — the wrapper is where the hand-written WGSL
  lives — so `wrapWGSL` is now exported for that reason.  Verified as a real oracle: reintroducing
  the missing brace makes it fail with the offending line and three lines of context.
  It is a *parser*, not a validator: syntax, not types.  Real semantic validation needs a WebGPU
  device, and headless Node has none here (`@kmamal/gpu`/Dawn hangs with no adapter).

**Lesson for the next round:** any hand-written shader text is code that only one backend runs.  The
CPU fallback is a *fallback*, not a second implementation — a gate that never touches WGSL cannot
protect the WebGPU path.  `tsconfig.json` also type-checks only `src` and `vite.config.ts`, so the
gate scripts themselves are unchecked (they run through `tsx`, which strips types).

## Round 17 recap (kept from the round-17 handoff — all still in force)

### 3D: solid raymarch view + the C++ 3D vocabulary (PR #3), then the review fixes

**The 2D language is now a `z = 0` slice of a 3D field.**  `genShape` compiles one body for a `vec3`
point; the 2D view evaluates it on the plane, the 3D view raymarches it.  One code path, two compile
modes (`mode: "slice" | "solid"`), per-mode pipeline caches, and `fp` (the App's static-frame skip
fingerprint) carries the view mode so a mode switch cannot reuse a stale frame.  On top of that,
PR #3 added ~50 C++ `std.curv` symbols (`sphere`/`box3`/`cone`/`capsule`/`torus`/`cylinder`/`gyroid`,
`extrude`/`extrude_mitred`/`loft`/`twist`/`bend`/`taper`/`shear`/`repeat_xyz`/`repeat_finite`,
`slice_xy/xz/yz`, `reflect_x…yz`, `set_bbox`, `distance_field`, implicit fields, matrix helpers) and
nine `SNode` kinds.

Then the review of that PR — and the fixes, which are this round's substance:

1. **`repeat_xy` painted the whole frame NaN** (the `vec2 → vec3` migration): the spacing was built as
   `vec3(a, b, 0)` and `mod(z, 0)` is NaN, which poisons `length()`/min() for every pixel.  Repeats are
   now per-lane (`repeat_x/y/xy/xyz`), and a lane with **spacing 0 is not repeated** instead of
   dividing by zero (C++ would NaN there; `repeat_xyz [3,3,0]` is a legitimate 2D repeat).
2. **Every text glyph was NaN on the JS backend**: `clamp(lp/qs, 0, 1)` clamped a `v3` and `mix(v2, v2, v3)`
   reconciled the mismatch with `R.bc`, which is *scalar → vector* only.  `Gen.bcast` now **throws** on a
   vector → vector broadcast (WGSL used to truncate it silently), and the clamp takes `swz(lp, [0, 1])`.
3. **`cylinder` was twice as tall as C++** and `extrude`/`loft`'s `bbox3` was half the truth: `extrude`
   stores the *half* height (`let h = d/2`) but `cylinder` passed the full one, while `bbox3Of` read it
   as full.  Both are `±n.h` now, which also fixes the 3D camera fit (it frames `bbox3Of`).
4. **`rotate {angle, axis}` turned the solid the wrong way**: C++ `rot3` is the *domain* transform
   `R(−angle)`, so the shape rotates by `+angle`.  The matrix is now `rot3`'s, and `bbox3Of("xform3")`
   maps the child box through its **transpose** (the image of a domain transform is `M⁻¹·box`).
5. **`make_shape` rejected `is_2d && is_3d`**, which C++ allows (`nothing`, `everything`, `show_dist`,
   `show_gradient`) and the new `set_bbox` forwards verbatim.  Dropped; a `make_shape` that declares
   the flags now reports exactly those flags (previously they were re-derived from the bbox), and a
   2-point bbox on a 3D shape means a `z = 0` slab.
6. **`transpose` returned a matrix of matrices**: `a.[[j, i]]` indexes *by the list* `[j, i]`; C++'s
   `a.[j, i]` is a two-index lookup — `a.[j].[i]` here.
7. **Bounding boxes that mis-frame the shape** (`S1`): `repeat_finite` (2D and 3D: the span was folded
   into the *min*), `bend` (now C++ `±(height + ry)`, was `1.6·max(w,h)`), `box3`'s 2D footprint
   (`±(hx, hy)`, not `±max(hx, hz)`), `slice_xz`/`slice_yz` (inverted y-range ⇒ "empty"), and
   `xform3`'s 2D box — which now really cuts the child's 3D box with the `z = 0` plane (corners on the
   plane + edge crossings) instead of projecting the 2D box through the xy block.  `capsule` also
   reports `is_3d` (it shares the `seg` node with `stroke`; the z coordinates tell them apart) and its
   radius is `d/2` again — the node's `th` is a diameter, so `th: d/2` halved it once more.
8. **`cone` is C++'s Euclidean field** (`cone.call = exact`, MERCURY/hg_sdf apex + base-ring
   corrections); `mode: "mitred"` keeps the cheaper mitred cone, like `cylinder`.
9. **Two new gates** so this class of bug cannot pass again: `scripts/stdcheck.ts` (values, boxes, and
   field sampling — finite distances and "nothing inside the shape may lie outside its box") and
   `scripts/pdiff.ts` (golden frame hashes, `nan` counted per frame).  The CPU raster loops and
   `march3` now **count non-finite distances** (`renderer.stats.nan`) and treat them as background
   instead of painting black holes.  `selftest` fails an example that produces any.
10. Parity nits: `chartreuse`/`spring_green` are `sRGB.hue` (as in `std.curv`, not `web_colour.curv`);
    `sec`/`csc` keep C++'s *swapped* definitions with a comment saying so; `polyline`'s comment now
    admits it is the closed `polygon` field (C++ `polyline` is an open stroke) and its bbox is padded
    by `d/2`; `bend`'s unused `g.param(n.ry)` is documented as lockstep with `walkSeg`.

Net effect, measured with `pdiff` against `main`: **18 of the 19 pre-existing 2D examples are
bit-identical again** (before the fixes, 12 differed — ten of them because every glyph was NaN);
`peppermint` differs on purpose (the C++ skimage `swirl`).

## Round 16 recap (kept from the round-16 handoff — all still in force)

### expression-level memo (the round-15 gap, shipped) + a merged editor PR

**Merge against the PR-edited origin** (parallel "round 15" line, PR #1: editor syntax highlighting +
brace-pair matching — `src/components/highlight.ts` permissive Curv tokenizer used purely for spans,
`Editor.tsx` overlay highlight + bracket matching, `index.css` theme).  Clean fast-forward; suites
green on the merged tree.  This round's own work was the round-15-designated next step:

1. **Expression memo for pure list literals / comprehensions** (`applyExprMemo`, interp.ts; analysis
   `freeVarsOfExpr`, freevars.ts).  The round-15 study showed the warm-frame residual is *evaluator*
   assembly work, not solvable by hashing trees cheaper — this memo is the mechanism at the right
   grain: a `[nav vp, panel "x" rows, for (c in cards) card c]` site whose free variables hash
   identically replays as ONE hit (identical immutable array returned), instead of re-hashing every
   item's call memo every frame.  Same profile-guided election as the call memo (memo iff warm body
   ≥ max(8 µs, 2 × warm-hash)), same flags/trace replay (`time`/`mouse`/`viewport` through closures
   are covered by hashing the *values* of free names — a closure's captured inputs hash with it),
   LRU per site (`EXPR_LRU` 8) inside the global cap.  `memoWorthyList` gates constant/tiny lists
   (colour vectors, point pairs — cheaper to evaluate than to profile).  Measured (`exprbench`,
   alternated best-of-6, all 19 examples): **total 14.0 → 5.2 ms (2.7×)**; solve/UI corpus 1.8–7.1×
   (dashboard 5.6×, polygon 7.1×, packed 3.6×, buttons 2.7×, chart 2.7×, toolbar 2.2×); shader-only
   programs within ±8 % (frep 0.82× worst: site profiling on tiny trees — sub-µs absolute).
2. **Purity hardening the memo forced** (the interesting part): a list's *static* free-variable
   purity says nothing about a *callee's* effects — `[for (i in xs) f 1]` is only as pure as `f`,
   and memotest's three impurity gates caught it (hits on assigns-outer/prints/parametric-through-
   closure).  Two layers: (a) at election, every closure reachable from the free values (bounded
   scan, depth ≤ 3 / 32 values) must itself be statically pure and non-printing — over-approximate
   skips are safe; (b) a **measure-phase tripwire** (envEpoch / `params.length` / new `printCount`
   snapshots around each sampled run) catches host effects an unsampled callee branch could hide.
   `memotest` negative-case assertion is now **per-site** ("no MEMO row on the impure construct"),
   not "no hits in the frame" — a legitimately elected pure lambda beside an impure site would
   flake the old proxy, and the λ here is semantically correct (time-keyed, verified by the
   same/dep columns).  New positive cases: list literal / comprehension / viewport lists (values,
   time-dependence, trace replay) and list identity across frames (same array object).
3. `setExprMemo` bench switch; `callMemoTable()` now reports «list» rows for `prof -v`; invariants
   section grew rules for callee purity, the tripwire, the per-site gate assertion, and the
   `EXPR_LRU`/threshold reuse.

## Round 15 recap (kept from the round-15 handoff — all still in force)


1. **Hash-consing (`inode`, shapes.ts) — studied, measured, kept OFF.**  Design: S() hash-conses every
   constructed node through a WeakRef table keyed by a numeric content hash (`cHash`, two u32 lanes
   stored on the node as `__ch__`, table key `__ik__`, coverage 1:1 with `nodeHashRaw`), so equal
   subtrees become one object and every identity-keyed memo hits across frames.  Measured
   (`internbench`, in-process alternated ON/OFF, best-of-6, all 19 examples): the fresh-tree
   key+param walk drops 8–48× as designed — **but full eval costs 2.4× more, on every shape-bearing
   example, so all 19 net negative.**  The mechanism, measured by bisection (off / hash-only /
   full table): the entire regression is the *hasher*, not the WeakRef table; it is not the string
   hash (a WeakMap-keyed string hash and an inline-field numeric hash cost the same), it is the
   per-call constant work + allocation churn (CHash objects, closures, table stores) on ~10²–10³
   constructed nodes per frame — while the walks it replaces were already mostly amortised by the
   existing WeakMap memos.  **Verdict: default OFF, infrastructure kept** (`setInterning`, bench),
   same outcome class as round-12/13's off-by-default shader variants.  The invariant it would have
   needed stays recorded: *amortised WalkMap walks are cheaper than correct eager hashing; sharing
   identity only pays when the hash itself is (nearly) free or the shared work is per-node ×K, not
   per-frame ×1.*
2. **Structural keys are two avalanche-mixed u32 lanes now (the shipped win).**  `structKeyRaw`'s
   per-fresh-node string concatenation was the largest *legitimate* residual on dirty frames
   (internbench's fresh-tree walk column: 1.86 ms/frame on wrapfit, 1.59 on toolbar).  Same
   coverage (kinds, tree layout and child order, repeat mode, text align, polygon arity, unit-scale
   xform, per-child cull-bracket state), same memo-per-(cull,flags)-slot design, but lanes are mixed
   with inline `Math.imul` arithmetic (no closures — closure allocation per node ate the first
   attempt's win on medium trees) and materialised as ONE short `flags|h1.h2` string per tree.
   `skNum`'s `h1==0` sentinel is stored mapped (`-0x80000000`) **uniformly on miss and hit** —
   memo-hit/miss lane mismatches would fork every parent key.  Fresh-tree key+walk, same machine
   and harness before→after: wrapfit 1.92→0.55, toolbar 1.59→0.61, dashboard 0.83→0.72,
   tooltip 0.50→0.38, chart 0.46→0.36, buttons 0.29→0.14, everything else ~1.1–2× better,
   custom-function trees unchanged (they skip the walk).  `paramcheck` stayed 19/19 bitwise-green
   (the oracle's `reused`/`codeSame`/`memo=`/`skip=safe` columns all exercise key semantics).
3. `tsconfig` target/lib ES2020 → ES2021 (`WeakRef`, for the kept-off inode table).

## Round 14 recap (kept from the round-14 handoff — all still in force)


Upstream psolve moved to `main` (`05f9411cccbc`, merge of `arena/01a07358-psolve`, PR #1: certified QP
Phase-I infeasibility, warm starts, wall-clock budgets, the psolve-owned wasm bridge).  This round
re-syncs the vendored solver and adopts the new contract end-to-end; the exact text of the plan this
implements lives in the psolve repo at `docs/CURV_PS_PLAN.md` (P0.1/P0.2/P0.3 acceptance + §6 items 1–5).

1. **psolve re-vendored from `main@05f9411cccbc`, reproducibly.**  `psolve-src/` now carries the
   upstream bridge *verbatim* (`psolve_web.c` ABI 3 + `psolve_web.h`), a `PIN` (upstream commit,
   blob sha256, toolchain), and `build-wasm.sh` — verified to reproduce the committed blob
   **byte-identically** (`bcbe7b1d…`, two consecutive builds).  The recipe mirrors upstream's
   `tools/wasm_build.sh` with the two documented deltas modern wasi-sdk forces: `shim/` (setjmp —
   hard error since wasi-sdk 25; the psw_* paths never arm a `PSolveErrFrame`, so it is dead code —
   plus empty `immintrin.h` and a nearest-only `fenv.h`, same semantics as the round-3 shims) and an
   explicit 32 MB initial memory.  Errata discovered and fixed while doing this: host `nm` cannot
   read wasm objects (the export list silently came out empty → a *different, broken* module — the
   script now calls wasi-sdk's `llvm-nm`), and link object order changes the hash, so the recipe's
   object glob order is load-bearing.  The blob fell from ~263 KB to 215.7 KB binary
   (`--gc-sections`; recipe uses plain `-O2`, not `-flto` — LTO on the old corpus cost more link
   time than it saved bytes here; re-A/B if module size matters again).
2. **`src/psolve/psolve.ts` rewritten for ABI 3.**  ABI asserted on load; status/verdict **strings
   come from the wasm module** (`psw_qp_status_name` / `psw_qp_verdict_name`) so a give-up
   (`NO_FEASIBLE_START`) can never be renamed "infeasible" by a stale JS table; a real WASI
   `clock_time_get` shim (budgets are wall-clock); `qpStartFeasible()` exposed (the engine's own
   warm-start acceptance test); `SolveResult` gains `verdictText`, `certified`, `approximate`
   (status 2/6 = usable incumbent, *not* a certified optimum — plan P2.1), `warm`, `warmRetry`,
   `proven`, `farkas`, `maxResid`.  Warm starts are handed over **only when
   `psw_qp_start_feasible` accepts them** — a rejected start would still sway the Phase-I search
   point, and with it the numerics; a rejected x0 therefore runs the byte-exact cold path.
3. **`constraints.ts` per plan §6.1/§6.3.**  (a) All LP/QP rows are normalised to unit max
   coefficient before marshalling (pixels vs the engine's absolute working-set tolerances).
   (b) Presolve thresholds are *relative to each row's own scale* (pivot `1e-11·rowmax`,
   inconsistency `1e-9·(1+rowmax)`) — the old absolute `1e-6` test could declare a pixel-scale
   layout inconsistently at the front end.  (c) When the equality presolve declines, the problem is
   handed to psolve **unreduced** (hard equalities as ≤/≥ pairs — reliable upstream since the
   probe's encoding-equivalence fix) instead of the old `INFEASIBLE, amount: Infinity`
   short-circuit.  (d) A required constraint that propagates to a constant is itself a *proof*: it
   returns a certified `INFEASIBLE_PROVEN` result naming the constraint (it used to throw straight
   out of `Problem.solve`, dodging every recovery path).  (e) `Problem.solve({x0, budgetMs,
   warmBudgetMs})`: a warm attempt (accepted starts only) gets a 4 ms sub-budget; if it is STOPPED,
   the problem is retried cold inside the frame budget and the *feasible/certified* of the two
   attempts wins (`warmRetry`, timings summed).  Rationale, measured (`scripts/warmbench.ts`,
   interleaved best-of-4): px-continuous drags win (chart **2.1×**: 0.114→0.054 ms/frame; upstream's
   probe measures 23–35× at N=8–32 with 1 px steps), while resize jumps with *discrete* structure
   changes (toolbar/wrapfit/buttons 40 px/frame) get **0/5 accepts** — the prior point is simply
   infeasible for the new row set — and cost nothing (≈1.0×).  First un-interleaved measurements
   reported "toolbar 6× slower, chart 18×" — both were JIT noise; the round-12 lesson applies to
   every benchmark, including new ones.
4. **`interp.ts` per plan §6.2/§6.4.**  `warmCache` (per block-astId: names + last good values)
   feeds `x0`; a warm start is *legal only when the cached variable names are a prefix of the new
   problem's in declaration order* (ids shift with `for`-loop counts — same-text blocks with
   different `n` must not start from each other).  A failed solve **never throws when the block has
   any previous good result** with enough values: the block degrades to that layout and the trace is
   marked amber (`degraded`), listing the failure verdict and Farkas-conflict rows (§6.2: amber, not
   a red screen).  Failures are **never cached** — not in the fingerprint LRU, not in the block memo
   (`unmemoizableFrame` skips the store), not in the call memo (same flag in `applyMemo`) — so the
   next frame re-attempts and recovery is observable (`warmcheck` [2]: recovered frame is
   bitwise-identical to a clean-cache evaluation, i.e. zero memo pollution).  A first-frame failure
   still throws, now with the certified verdict and the conflicting constraint labels.  Every solve
   runs under `SOLVE_BUDGET_MS = 16 ms` (one 60 fps frame): a binding budget reports
   STOPPED + incumbent (trace badge "incumbent", `approx:true`) instead of hanging the UI.
   The block's `solver` record gains `verdict/proven/approx/warm/max_resid/degraded`.
5. **SolverPanel** shows the new vocabulary: the pill honours verdicts and incumbents; per-block
   badges "warm start" / "warm → cold retry" / "incumbent" / amber "fallback: last good" (with the
   failure status and Farkas rows); a proven-infeasible banner names the conflicting constraints;
   the footer carries the provenance (bridge ABI, wasm sha256 head, upstream pin — plan §6.5).
6. **Scripts**: `warmcheck.ts` (above) and `warmbench.ts` (above) are new; `paramcheck.ts`'s
   `memo=` column is now explicitly two properties: replay integrity (**bitwise** — a replay
   rebuilds from the stored result object) and warm-path equality vs cold (**≤ 1e-6**; the sole
   nonzero on the matrix is `chart`, `warmΔ=9.5e-7` on 1/699 floats — the accepted warm start lands
   a different rounding of the same optimum; §Invariants updated accordingly).  Reference rows for
   all of this are in `warmcheck.ts`'s output.

## Round 13 recap (kept from the round-13 handoff — all still in force)

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
src/curv/shapes.ts      SNode F-Rep tree, bboxOf/bbox3Of (memoised), flags3Of, textMetrics/textGlyphs,
                        nodeHash (memoised), weight (memoised), structKey (numeric two-lane, memoised
                        per (cull,flags) slot), inode hash-consing (off by default — round-15 study),
                        genShape (one body, two modes: "slice" | "solid"), walkParams (segment-memoised)
src/curv/prelude.ts     palette, box helpers, layout combinators (incl. flow / hstack_fit), UI components — in Curv
src/curv/examples.ts    example programs (group "solve" | "curv" | "3d")
src/gpu/gen.ts          code generators: WGSL, JS, ParamsOnly; dynBlock/finalParams; Gen.usesTime
src/components/GenOptions.tsx  the preview toolbar's shader-generation menu (branched / branchless + every
                        SHADER_FLAGS option, with measured costs and a branch census)
src/gpu/renderer.ts     WebGPU renderer (pipeline cache keyed by code, timestamp queries) + CPU
                        fallback; 3D raymarch (WGSL `stepf`/`colf` + CPU `march3`), orbit camera,
                        per-mode pipeline caches, `stats.nan` counter
src/gpu/atlas.ts        SDF glyph atlas (Canvas2D + EDT), GLYPHS charset, kerning
src/psolve/constraints.ts  Lin/Quad affine exprs, Cons, presolve (relative thresholds, unreduced
                           fallback, constant-false = certified proof), row normalisation, QP/LP
                           assembly, warm-start + budget + cold-retry policy, Farkas conflict labels
src/psolve/psolve.ts    ABI-3 bridge to psolve.wasm (wasm-side status/verdict names, clock shim,
                           qpStartFeasible, SolveResult flags), psolveInfo() provenance
psolve-src/             vendored upstream bridge (verbatim) + shims + build-wasm.sh + PIN
                           (reproduces the committed blob byte-identically)
src/App.tsx             UI: editor, preview (camera, pause, CPU-aware quality controller, static-frame
                        skip cache, shader-time re-render path, single-eval camera fitting), solver +
                        params panels, memo hits + static badge in the status line
scripts/                selftest, paramcheck, memotest, warmcheck, threedcheck, stdcheck, pdiff
                        (+ scripts/golden/pdiff.json), warmbench, internbench, exprbench, prof,
                        shaderbench, sheet (headless, tsx)
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
  **Round-17 trap, hit twice:** a branch on a *parameter value* is a branch on structure as far as the
  shader cache is concerned, because `structKey` deliberately ignores parameter *values*.  `repeat`'s
  generated code skips the lanes whose spacing is 0 and `cone` picks a field by `mode`, so both are part
  of the structural key now (see the comments at those cases) — otherwise two trees that share a key but
  differ in a zero lane / mode silently reuse the wrong shader (measured: a whole frame of NaN).
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
* **3D: one field, two views.**  `genShape` always compiles a `vec3` point body; the 2D view is the
  `z = 0` slice, the 3D view raymarches the same body.  Consequences to respect:
  - a transform node's matrix is a **domain** transform (`q = M·(p − t)`), so its image box / slice is
    `t + M⁻¹·child` — `bbox3Of("xform3")` uses the transpose, and the 2D box cuts that box with `z = 0`
    (corners on the plane + edge crossings), it does not project the child's 2D box;
  - `bbox3Of` must **contain** the shape (`extrude`/`loft`/`cylinder` store a *half* height — the 3D
    camera fit frames `bbox3Of`, so a too-small box clips the view) — `stdcheck` asserts it by sampling;
  - nothing may produce a non-finite distance: one NaN lane poisons a pixel (`min`/`length`) or a whole
    frame.  `mod(x, 0)`, `normalize(0)`, `x/0` and vector-size mismatches are the usual suspects.
* **Two branches are load-bearing, do not "optimise" them away.**  The bbox-cull bracket in
  `kidCulled` skips a whole subtree for pixels outside its box, and the 3D raymarch's `break` stops
  marching when a ray hits or escapes.  Round 19 measured the branchless lowering of both: 2.8–3.0×
  slower in the 2D view and 9.7× in the 3D view (up to 19× for label-heavy trees in the 3D view).
  A branchless build is ≥ the branching build in ALU work *by construction* — it computes both
  sides — so only measure it, never assume it.  The one branch that is free to remove is
  short-circuit: `&&`/`||` → `&`/`|` measured 1.00× and is the shipped default
  (`SHADER_FLAGS.noShortCircuit`).
* **Hand-written shader text is per-backend code, and only one backend ever runs it.**  `wrapWGSL2D`
  / `wrapWGSL3D` (WGSL) and the two `new Function` bodies in `createCPU` (JS) are written by hand;
  the headless gates use the CPU renderer and the browser uses WebGPU, so neither exercises the
  other's wrapper.  WGSL is the stricter language — a compound statement is required after `if`/`for`
  /`while`, there are no implicit conversions — and round 18 shipped a brace-less `if` in the 3D
  raymarch loop that every gate passed and the browser rejected.  `scripts/wgslcheck.ts` parses the
  wrapped source (wrapper included) of every example in both view modes; run it after touching any
  wrapper.  It is a parser, not a validator: types still need a real device.
* **No vector → vector broadcast**: `Gen.bcast` throws (WGSL's constructor used to truncate a `v3` to a
  `v2`, the JS runtime built a nested array and produced NaN).  Broadcast a scalar, or swizzle.
* `bbox3Of`/`flags3Of`/`bboxOf` memoise per node in `WeakMap`s that ignore `atlas` — fine while the atlas
  is a build-time singleton, as `bboxMemo` already assumed.
* **Golden frames need deterministic solves**: `scripts/pdiff.ts` and `scripts/stdcheck.ts` call
  `setSolveBudget(0)`.  The UI keeps `SOLVE_BUDGET_MS = 16`, whose STOPPED incumbent depends on machine
  load — a gate that compares pixels must not inherit that (measured: `toolbar`'s hash changed between
  two runs of the same build).
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
* **A failed solve is never cached anywhere** (fingerprint LRU, block memo, call memo): a degraded
  result is history-dependent by construction, and caching one would make recovery unreachable.
  `unmemoizableFrame` is the single guard — set it on any future failure/degrade path.
* **Warm starts are numerics-only, never identity**: `warmCache` may only seed `x0` when (a) the
  cached names prefix the new problem's names in declaration order and (b) the engine's own
  `psw_qp_start_feasible` accepts the point.  A rejected start must run the *exact* cold path (it is
  what keeps paramcheck's replay-vs-cold Δ a rounding artifact instead of a semantics question).
* **`verdict` vs `status`**: `-1` is `NO_FEASIBLE_START` unless `proven` — never relabel it
  "infeasible" (that is the bug class upstream's P0.1 exists to kill; the JS prints wasm-side
  strings only).  `approximate` (STOPPED / ITER_LIMIT) results are wall-clock-dependent and may
  differ between machines; certified results may not.
* Budgets: only the *quality* of a STOPPED outcome is machine-dependent; correctness is the
  `maxResid`/violations checks.  Keep `SOLVE_BUDGET_MS` ≥ worst honest solve (≈2 ms today) with
  generous headroom (16 ms), so certified answers are the steady state.
* When touching the wasm: bump `PIN`, `PSOLVE_WASM_SHA256`/`PSOLVE_UPSTREAM_PIN`, keep
  `psw_abi()` == `PSOLVE_BRIDGE_ABI`, re-run the build twice and compare sha256 before committing
  the blob.
* **Structural-key coverage is a correctness invariant on its own** (`skRaw`): any new `SNode`
  kind, or any new codegen branch on a *value*, must be mixed into the numeric lanes in lockstep
  (the old string-key rule, now `skNum`); the `(0,0)` pair means "unhashable" and `h1==0` is
  stored as `-0x80000000` through ONE code path so memo-hit and memo-miss return identical lanes.
  `paramcheck` (exit code) is the oracle — its `reused`/`codeSame` and skip-oracle only hold when
  keys partition exactly like codegen.
* `__ch__`/`__ik__` on nodes are inode's private cache fields; never enumerate or branch on them
  (all evaluator observation goes through `n.k`-switched code — keep that exhaustive).
* `inode` is OFF by default (round-15 measured net loss at S()-level on all 19 examples); enabling
  it anywhere needs an internbench run first.  Do not diversify its hash coverage away from
  `nodeHashRaw` — the intern table's correctness argument is the same interchangeability lemma.
* **Expression memo (round 16) is bound by callee purity, not just site purity**: any new memo site
  must (a) reject statically impure free-variable closures *reachable from the free values* (the
  bounded scan in `applyExprMemo`), and (b) keep the measure-phase tripwire (envEpoch /
  `params.length` / `printCount`) armed so host effects through unsampled callee branches are
  observed exactly once.  New host-state reads reachable from expression evaluation also need a
  tripwire channel (or to mark the site impure statically) — a memoised site that hides an effect
  shows stale pictures with no error.
* `memotest` negative cases assert **per-site** (no MEMO row on the impure construct), never
  "no hits in the frame" — unrelated pure lambdas may be elected legitimately beside an impure
  site (JIT-dependent), and that is not a violation.

## Known gaps / next steps

* The solver side is now upstream-shaped; the next capacity items live in psolve and are enumerated
  in `docs/CURV_PS_PLAN.md` there: **P1.1 native equalities & variable bounds in the QP** (would let
  this repo delete its Gaussian `eliminate` + the ≤/≥ pair fallback and shrink `m` 2–3×),
  **P1.2 sparse QP input / diagonal+rank-1 Q** (`n²` marshalling dominates at n≳32),
  **P1.3 IIS/conflict rows on the LP path & the sparse KKT** (also the honest fix for
  KKT_FAIL/ITER_LIMIT at 1e3–1e6 scales).  The LP warm start does not exist upstream yet; LPs here
  are rare and tiny.
* Warm starts are accepted on only some workloads (continuous drags: yes; jump-resizes with discrete
  structure changes: no — by engine design).  The adaptive piece worth having is MPC-style *active-set*
  reuse (upstream roadmap §13.2 "sequence API", listed as plan P0.2's persistent handle), not
  tolerance loosening.  `psw_qp_set_phase1_lp_first` is plumbed but unused (dense-first answers more
  models at our sizes; flip if n+m ≳ 600 models appear — that is where the upstream gate already
  makes LP-first bind).
* The psolve arena (`psw_arena_*`) is deliberately **not** used: upstream measured it *slower* than
  libc malloc on this QP workload (their P2.4), and an exhausted arena aborts the module; it stays a
  determinism option, not a speed one.
* Eval of the *rest* of an animated cached frame is now covered by three memo layers: block memo
  (solve), call memo (function bodies) and the round-16 expression memo (list assembly sites);
  exprbench totals 14.0 → 5.2 ms.  What remains below that: list *item* evaluation that was too
  cheap to memoise individually (the honest tail), record literals (`rec` is not a memo site yet —
  worth benching if a profile shows it), and genuinely time-varying trees (chart/frep: misses are
  physics, not overhead — the gate keeps their extra hashing at ≤2× the would-be body cost).
* The shader-only-time fast path keeps the quality scale while animating; settling to full resolution
  only happens on pause / interactions (a settle tick that schedules itself per frame was judged too
  finicky).
* **3D is young** (round 17): the raymarcher has no bounding-volume early-out (every pixel marches from
  `t = 0.02`), a fixed 128-step cap and `FAR = 400`, and `wrapWGSL3D` inlines the whole body **twice**
  (`stepf` + `colf`) — the first thing to hurt on big UI trees.  `gyroid` keeps C++'s uncompensated
  Lipschitz 4/3 (`lipschitz 1.33` after extracting isosurfaces, per `std.curv`), so it is the first
  candidate to alias at a fixed step count.  Deliberate divergences from `std.curv`, all commented in
  the source: `loft` mixes its children's colours (C++ leaves it white), `distance_field` drops the
  green `bit(abs(d) == inf)` channel, `warp_domain_xy` ignores `warp.function` (so the bbox falls back
  to the child's), `chamfer` folds a list instead of taking exactly two shapes, and 2D `inter` keeps
  its own AA-aware colour rule (`sel(b.d > acc.d, …)`) instead of C++'s "`colour = s1.colour`" — the
  solid-mode rule does follow C++.
  A GPU-side branch-vs-branchless measurement is **missing**: `scripts/branchbench.ts` can only
  time the CPU fallback (no WebGPU device in headless Node), so the round-19 3×/9.7× numbers are
  CPU numbers — the ALU half of the trade is the same on a GPU, the coherence half is not.
  The WGSL path is **syntax-checked only**: no headless WebGPU device exists in this environment
  (`@kmamal/gpu` + Dawn hangs with no adapter), so type errors, uniform-layout questions and how a
  real GPU rasterises the 3D view are unverified — the sandbox's browser preview is the only oracle.
* `flow`/`flow_fit`/`fit_labels` need *numeric* budgets (wrapping is discrete); `hstack_fit` gives all
  items the same font size / padding.
* Kerning is measured pairwise from the canvas font, so metrics can differ slightly between machines; the
  atlas has one weight, no ligatures, no combining marks.
* The GPU budget is derived from the *previous* frame's CPU time; a sudden CPU spike is corrected one
  frame late.
