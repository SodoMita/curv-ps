# Curv+solve — handoff (dev round 3)

Browser playground for **Curv** (2D F-Rep, compiled to WGSL / JS) extended with
`solve { }` constraint blocks solved by **psolve** (LP + convex QP, WebAssembly).

Live build: `npm run build` → single-file `dist/index.html`.
Headless check: `npx tsx scripts/selftest.ts [id | file.curv ...]` renders every example
with the JS backend to `/tmp/t/<id>.png`. `npx tsx scripts/prof.ts` prints warm eval/codegen times.

## What changed in this round

1. **One coordinate system.** The separate "UI mode (px, y down, origin top-left)" is gone.
   Everything — original Curv examples and constraint layouts — lives in ordinary Curv space:
   y up, origin at the centre, arbitrary units. `solve { }` is just an expression that returns
   plain numbers; those numbers feed the normal shape operators. This also fixes the
   "preview upside down" report (text glyphs and `parent`-based layouts were drawn in y-down
   space while the camera was y-up).
   * `parent` (px) → **`viewport`**: the visible world rectangle as a box record
     (`left/right/bottom/top/w/h/cx/cy/center/size/pos`). Programs that reference it are
     "responsive" and re-solve when the canvas is resized or the camera pans/zooms.
     `parent` remains as an alias.
   * Box records are `{x, y, w, h}` with `(x, y)` = **bottom-left** corner (= a Curv bbox).
     `top = y + h`, `bottom = y`. Prelude gained `box_at centre size`, `bbox_box shape`,
     `fit_in box shape`.
   * Camera: responsive programs start at *home* (1 unit = 1 px, centred on the origin);
     other programs are fitted to their bbox once. Pan/zoom is always available; the
     `fit`/`home` button resets.
   * Text glyph SDF sampling and metrics flipped to y-up (`src/curv/shapes.ts`).
   * Examples rewritten (`src/curv/examples.ts`): new **Packed circles** (constraints in
     plain units, no viewport), the responsive ones use `viewport.top - pad` etc.,
     **F-Rep + solve** now uses world units with an auto-fitted camera.
2. **Pause / resume button** (and <kbd>space</kbd>) instead of clicking on the canvas.
   Time is frozen while paused and continues from where it stopped.
3. **Performance**
   * Glyph atlas: brute-force SDF (≈2.4 s at startup) replaced by an exact Euclidean
     distance transform (Felzenszwalb) — a few ms.
   * Adaptive render resolution while animating / dragging (frame-time driven, 35–100 %),
     with a full-resolution re-render once things settle. Shown as `NN% res` in the status line.
   * AST cache: the prelude and the current source are parsed once, not every frame.
   * Shader compile path no longer awaits `getCompilationInfo()` on the happy path.
   * Edit debounce 150 → 100 ms.
4. Background toggle (Curv-white default / dark), camera readout in the preview bar.

## Layout of the code

```
src/curv/parser.ts      lexer + parser (Curv syntax + solve/var/weak:/minimize statements)
src/curv/interp.ts      tree-walking interpreter, builtins, solve { } → psolve Problem, compileTree
src/curv/subcurv.ts     SubCurv: compiles user dist/colour functions to shader code (inlining, loops)
src/curv/shapes.ts      SNode F-Rep tree, bboxOf, genShape (shape → straight-line code)
src/curv/prelude.ts     palette, box helpers, UI components — written in Curv
src/curv/examples.ts    example programs (group "solve" | "curv")
src/gpu/gen.ts          code generators (WGSL, JS) with a parameter buffer for all numbers
src/gpu/renderer.ts     WebGPU renderer (pipeline cache keyed by code) + CPU fallback
src/gpu/atlas.ts        SDF glyph atlas (Canvas2D + EDT)
src/psolve/*.ts         Lin/Quad affine expressions, presolve, bridge to psolve.wasm (b64 inline)
psolve-src/             C bridge + build instructions for the wasm (unmodified psolve cores)
src/App.tsx             UI: editor, preview (camera, pause, quality), solver + params panels
```

## Known gaps / next steps

* Codegen still runs every frame for animated programs (~3–5 ms for the dashboard).
  A structural hash of the SNode tree could skip codegen and only refill the parameter buffer.
* Adaptive quality only measures rAF pacing; WebGPU timestamp queries would be more precise.
* Layout components in the prelude are minimal; `hstack`/`vstack` generators that emit
  constraints would make responsive examples shorter.
* `text` uses a single Inter atlas at one weight; no kerning, ASCII only.
* Only 2D shapes are supported (no 3D ray-marching).
