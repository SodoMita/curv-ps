# WebGPU software-rendering benchmark (SwiftShader / lavapipe / llvmpipe)

Measured 2026-09-10 on a headless Linux x86-64 container (2 vCPU, no GPU).
This document records the full results and the exact method, so anyone can
reproduce the numbers. The benchmark harness itself is preserved verbatim in
[webgpu-bench-harness.md](webgpu-bench-harness.md); the exact shaders measured
are in [shaders/](shaders/).

## TL;DR

- All 14 benchmark programs render correctly on **SwiftShader WebGPU**, driven
  through Deno's built-in WebGPU using this repo's production modules
  (`Interp`, `compileTree`, `wrapWGSL`) and the **byte-identical WGSL** curv-ps
  sends to browsers.
- **Pipeline compile: 4–47 ms** per program. **Steady frame: 17–153 ms wall**,
  decomposing into **true GPU pass 5.5–141.6 ms + a constant ~11.5 ms host
  round-trip** (Deno/wgpu submit+fence+map latency, identical on all drivers).
- **vs the single-threaded JS fallback on the same CPU: 2×–975× faster**
  (smoke: 46.2 s → 47 ms true GPU; liquid_paint: 10.0 s → 41 ms).
- Bonus columns from the same harness: **lavapipe** (Mesa software Vulkan) is
  1.3–12.7× faster than SwiftShader per shader; see also the separate
  [lavapipe performance guide](lavapipe-performance-guide.md). llvmpipe
  (wgpu GLES backend) ≈ lavapipe steady-state.
- Pixels verified against JS-fallback references: 12/14 match to ≤1.3
  mean-abs-diff; `smoke` and `voronoi` use precision-chaotic `sin`-hash noise,
  so every backend renders a different-but-valid noise field.

## 1. Method

### 1.1 Why Deno instead of Chrome

The original plan was headless Chrome + `--enable-unsafe-swiftshader`. It failed:
Chromium 153's Dawn reports **"No available adapters"** for `requestAdapter()` —
plain and `forceFallbackAdapter:true` — under every flag combination tried
(software GL, Vulkan, `VK_ICD_FILENAMES` pointing at Chrome's own
`libvk_swiftshader.so`, Xvfb-headed, single process), while **WebGL2 on the same
SwiftShader works** in the same binary. Dawn never enumerates the bundled driver
in a headless container, so the Chrome route was abandoned after an 11-step flag
matrix (one combo even made `navigator.gpu` disappear entirely).

The replacement is **Deno 2.5.4**, whose built-in WebGPU is wgpu-native — the same
`requestAdapter`/`requestDevice`/`createRenderPipeline` API — with
`VK_ICD_FILENAMES` selecting the Vulkan driver. The fragment work is done by the
**same SwiftShader** compiling the **same production WGSL**. What differs from a
browser run is only the host binding (Deno vs Blink) and presentation (texture
readback instead of canvas swap).

### 1.2 Harness design

`wgpu-bench.ts` (Deno; full listing in
[webgpu-bench-harness.md](webgpu-bench-harness.md)) imports production code
directly — no reimplementation, no DOM:

- `src/curv/interp.ts`: `Interp`, `compileTree`, `resetSolveCache`
- `src/curv/shapes.ts`: `bboxOf`, `finiteBBox` (2D framing)
- `src/gpu/renderer.ts`: `wrapWGSL` (the exact shader builder browsers use)
- `src/gpu/atlas.ts`: atlas constants (glyph data deserialized from a
  `atlas.bin`+`atlas.json` snapshot — `buildAtlas()` needs Canvas2D; the snapshot
  is produced once from Node, see §5.3)
- `src/psolve/psolve.ts`: `loadPsolve` (WASM constraint solver)

It replicates `renderer.ts`'s WebGPU setup exactly: bind-group layout (uniform
`U[96B]` @0, read-only-storage params @1, `r8unorm` atlas texture @2, filtering
sampler @3), the 24-float uniform block, fullscreen-triangle pass, `rgba8unorm`
target. Framing matches the JS-fallback bench: 2D = bbox-fit letterbox, 3D =
fixed orbit camera (dist 8, yaw 0.65, pitch 0.42, fov 38°), `TIME=0`, `dpr=1`.

Per program: 1 cold eval + WGSL codegen → `createShaderModule` +
`createRenderPipeline` (timed) → 6 frames. Each frame uploads uniforms+params,
runs the render pass with timestamp writes, resolves + copies to a readback
buffer, submits, and fences on the buffer map. Frame time is **submit →
pixels-mapped** (readback included). Reported: pipeline ms, frame-0 ms,
steady = median of frames 1–5, median pass timestamp delta.

### 1.3 Driver selection & fingerprinting

`WGPU_BACKEND` is **ignored** by Deno's wgpu, and Deno exposes no adapter strings
(`adapter.info` is `{}`, no `requestAdapterInfo`). Selection is purely by
`VK_ICD_FILENAMES`, and the harness **fingerprints the adapter from
limits+features and aborts unless it matches the expected driver**:

| env | maxComputeWorkgroupSizeX | maxSamplersPerShaderStage | spirv-passthrough | verdict |
|---|---|---|---|---|
| `swift-icd.json` (Chrome `libvk_swiftshader.so`, `api_version` 1.0.5) | 256 | 64 | yes (32 feats) | **SwiftShader** |
| `/usr/share/vulkan/icd.d/lvp_icd.json` (Mesa) | 1024 | 1000000 | yes (37 feats) | **lavapipe** |
| bogus ICD path (Vulkan init fails → GLES) | 1024 | 16 | no (22 feats) | **llvmpipe/GL** |

(`vulkaninfo` confirms the SwiftShader ICD yields Google vendor `0x1ae0`, device
`0xc0de`. ICD JSON `api_version` must be `1.0.5` — `1.3.0` gives
`ERROR_INCOMPATIBLE_DRIVER` with Chrome's bundled library against a modern
loader. This matches Google's own shipped `vk_swiftshader_icd.json`.)

### 1.4 Timing: the ~11.5 ms host constant

Timestamp queries bracket the render pass. Across **all 42 (program × driver)
cells**, `wall − ticks/1e6 = 11.2–11.7 ms`, constant. This simultaneously proves
the timestamp period is **1 ns on all three backends** and that every frame pays
a **driver-independent ~11.5 ms host round-trip** (Deno↔wgpu
submit+fence+`mapAsync` latency — most likely event-loop/poll granularity, not
driver cost). Tables below therefore show both the measured wall (submit→pixels)
and the **true GPU pass time** (timestamps, ns→ms).

### 1.5 Deno/WebGPU quirks (for reproducers)

- `device.createRenderPipelineAsync` is **broken** in Deno 2.5.4 (its WebIDL
  converter drops `layout`, so every call fails); the harness uses the sync call
  (browsers use the async one in `renderer.ts` — same shader, same pipeline).
- `device.queue.onSubmittedWorkDone()` **never resolves** in this setup (even for
  a trivial triangle); frames are fenced on the readback `mapAsync` instead —
  the better fence anyway (time to pixels, not time to queue-idle).

### 1.6 Harness revisions

The listing in [webgpu-bench-harness.md](webgpu-bench-harness.md) includes three
behavior-neutral cleanups applied after the measurement runs (a source-read moved
inside its `try`, the 3D camera-override key spelled `gyroid3d` to match the
JS-fallback bench, 3D mouse set offscreen to match that bench). All three are
provable no-ops for these programs (override key never fires either way; bench
programs never read `mouse`, verified by grep); a re-render with the fixed
harness reproduces the archived pixels and shaders byte-for-bit.

## 2. Results

Deno 2.5.4 / wgpu, SwiftShader from Chrome 153, Mesa 25.0.7 lavapipe/llvmpipe,
Node v20.20.2 for the JS reference. JS-render column = medians of 5 from the
single-threaded fallback (per-pixel compiled JS for 2D, CPU raymarch for 3D).
2D at 500×500, 3D at 384×384, TIME=0.

### 2.1 SwiftShader, full per-program table

| program | mode | eval ms | wgslgen ms | **compile ms** | frame0 wall ms | **steady wall ms** | **true GPU ms** † | JS render ms | speedup vs JS ‡ |
|---|---|---|---|---|---|---|---|---|---|
| mandelbrot | 2d | 25.0* | 4.2 | 5 | 65 | 42.3 | 30.6 | 859.8 | 20× / 28× |
| smoke | 2d | 0.8 | 2.4 | 17 | 80 | 59.1 | 47.4 | 46202.5 | 782× / **975×** |
| voronoi | 2d | 0.5 | 0.4 | 4 | 24 | 19.1 | 7.7 | 1566.4 | 82× / 203× |
| polygon | 2d | 1.1 | 1.6 | 20 | 136 | 76.1 | 64.7 | 3851.2 | 51× / 60× |
| circlattice | 2d | 0.4 | 0.3 | 6 | 29 | 19.0 | 7.7 | 558.9 | 29× / 73× |
| log_spiral | 2d | 1.0 | 0.4 | 4 | 24 | 17.2 | 5.5 | 415.5 | 24× / 76× |
| plot | 2d | 0.4 | 0.7 | 5 | 29 | 19.3 | 8.0 | 1557.2 | 81× / 195× |
| liquid_paint | 2d | 1.1 | 0.4 | 6 | 59 | 52.4 | 41.0 | 10001.9 | 191× / 244× |
| peppermint | 2d | 0.8 | 0.4 | 5 | 34 | 20.9 | 9.4 | 744.9 | 36× / 79× |
| ball3d | 3d | 0.3 | 0.5 | 14 | 36 | 27.1 | 15.4 | 873.4 | 32× / 57× |
| rings3d | 3d | 0.9 | 0.5 | 33 | 147 | 105.4 | 94.2 | 203.0 | 1.9× / 2.2× |
| mol3d_ps | 3d | 2.7 | 0.5 | 47 | 209 | 153.2 | 141.6 | 1709.5 | 11× / 12× |
| twist3d | 3d | 4.5 | 0.4 | 19 | 112 | 81.4 | 69.8 | 546.8 | 6.7× / 7.8× |
| gyr3d_ps | 3d | 0.7 | 0.3 | 14 | 54 | 33.4 | 22.0 | 419.6 | 13× / 19× |

\* First program in the process pays psolve/WASM warmup (~20 ms); the rest show
true cold-eval cost (<5 ms).
† Pass-scoped GPU time from timestamp queries (1 ns period, proven §1.4).
‡ wall-speedup / true-GPU-speedup.

Headlines: **compile 4–47 ms** (WGSL→SPIR-V→JIT — no shader costs more than one
slow frame to compile); **first frame 24–209 ms**; **steady 17–153 ms wall,
5.5–141.6 ms true GPU**. A same-session repeat run reproduced every steady
number within ~2%.

`rings3d` is the instructive outlier (~2× over JS): its JS raymarch early-outs
fast (203 ms — the cheapest 3D program in JS), while on SwiftShader it is the
second-heaviest 3D shader (94 ms — costly SDF × fixed march count). Software
rasterizers win by throughput, not latency; cheap shaders show it least.

### 2.2 All three software backends (steady wall ms / true GPU ms)

| program | SwiftShader wall | SwiftShader GPU | lavapipe wall | lavapipe GPU | llvmpipe-GL wall | llvmpipe-GL GPU |
|---|---|---|---|---|---|---|
| mandelbrot | 42.3 | 30.6 | 14.4 | 2.8 | 14.4 | 3.0 |
| smoke | 59.1 | 47.4 | 25.7 | 14.0 | 25.5 | 14.2 |
| voronoi | 19.1 | 7.7 | 13.6 | 2.1 | 13.1 | 1.8 |
| polygon | 76.1 | 64.7 | 16.6 | 5.1 | 17.3 | 5.9 |
| circlattice | 19.0 | 7.7 | 12.9 | 1.4 | 12.7 | 1.4 |
| log_spiral | 17.2 | 5.5 | 12.9 | 1.5 | 12.7 | 1.4 |
| plot | 19.3 | 8.0 | 13.0 | 1.5 | 12.7 | 1.4 |
| liquid_paint | 52.4 | 41.0 | 34.9 | 23.3 | 33.9 | 22.4 |
| peppermint | 20.9 | 9.4 | 14.3 | 2.8 | 13.9 | 2.6 |
| ball3d | 27.1 | 15.4 | 15.0 | 3.6 | 14.8 | 3.4 |
| rings3d | 105.4 | 94.2 | 20.0 | 8.4 | 17.5 | 6.1 |
| mol3d_ps | 153.2 | 141.6 | 24.0 | 12.6 | 23.3 | 12.4 |
| twist3d | 81.4 | 69.8 | 21.0 | 9.5 | 21.1 | 9.7 |
| gyr3d_ps | 33.4 | 22.0 | 17.4 | 5.9 | 17.2 | 5.9 |

lavapipe beats SwiftShader on **every** shader (true-GPU ratios: 1.3× log_spiral
… 12.7× polygon, 11.2× rings3d/mol3d) — Mesa's LLVM JIT beats SwiftShader's
Reactor JIT on ALU-heavy fragment code on this CPU. llvmpipe-GL ≈ lavapipe on
steady frames but pays much higher first-frame cost on big shaders (smoke
frame0: 346 ms GL vs 27 ms lvp — GLSL compile spilling past pipeline creation).

## 3. Pixel verification

### 3.1 Protocol & orientation

Each `.rgba` readback was scored against the JS-fallback reference PNG in both
orientations (normal and vflipped). **Normal won on all 14 programs on all 3
drivers** — no vflip anywhere, consistent with the in-shader y-flip (§4.2):
readback row 0 = PNG row 0.

### 3.2 Match table (mean abs diff / %channels >24 / max, 0–255 scale)

| program | SwiftShader vs JS | lavapipe vs JS | llvmpipe-GL vs JS |
|---|---|---|---|
| mandelbrot | 0.01 / 0.01% / 241 | 0.01 / 0.01% / 241 | same as lvp |
| smoke | 42.39 / 57.53% / 187 | 28.00 / 42.11% / 152 | same as lvp |
| voronoi | 55.04 / 73.24% / 240 | 4.73 / 2.43% / 232 | same as lvp |
| polygon | 0.00 / 0.00% / 3 | 0.00 / 0.00% / 1 | same as lvp |
| circlattice | 0.00 / 0.00% / 0 | 0.00 / 0.00% / 0 | same as lvp |
| log_spiral | 0.00 / 0.00% / 1 | 0.00 / 0.00% / 1 | same as lvp |
| plot | 0.01 / 0.00% / 10 | 0.01 / 0.00% / 10 | same as lvp |
| liquid_paint | 0.09 / 0.00% / 17 | 0.00 / 0.00% / 1 | same as lvp |
| peppermint | 0.00 / 0.00% / 209 | 0.00 / 0.00% / 1 | same as lvp |
| ball3d | 0.83 / 1.02% / 218 | 0.83 / 1.03% / 218 | same as lvp |
| rings3d | 1.29 / 1.71% / 203 | 1.29 / 1.71% / 203 | same as lvp |
| mol3d_ps | 0.59 / 0.82% / 184 | 0.59 / 0.82% / 185 | same as lvp |
| twist3d | 0.86 / 1.21% / 185 | 0.86 / 1.21% / 185 | same as lvp |
| gyr3d_ps | 0.01 / 0.00% / 1 | 0.00 / 0.00% / 1 | same as lvp |

### 3.3 The 12 matching programs

- **2D non-chaotic**: means ≤ 0.09 — pixel-exact modulo float32-vs-float64
  rounding.
- **3D**: means 0.01–1.29 with ~1% edge pixels. The `ball3d` 8×-amplified diff
  shows a 1-pixel silhouette ring, faint concentric banding, and two faint
  specular-arc boundaries — the textbook float32-vs-float64 raymarch signature
  (step counts and hit points differing in last bits on curved surfaces).
- **`mandelbrot` max=241 at 0.01%**: isolated iteration-boundary pixels where
  float32 flips the escape-count branch — a few dozen scattered pixels, identical
  on all three GPU backends.
- **`peppermint`-on-SwiftShader max=209**: exactly **8 pixels** of 250,000, all
  diff 209, at 8-fold-symmetric pattern tips — precision, not a bug.

### 3.4 The two chaotic programs (`smoke`, `voronoi`)

Both use precision-chaotic `sin` hashes, randomized by last-bit `sin()`
differences between implementations:

```curv
random xy = frac(sin(dot[xy, [12.9898,78.233]])*43758.5453123);   // smoke (Book of Shaders)
random2f[x,y] = let t = sin(x+y*1e3); in [frac(t*1e4), frac(t*1e6)]; // voronoi
```

All three backends pairwise differ (`voronoi` SwiftShader-vs-lavapipe mean
55.55; `smoke` 20.40) while agreeing to ≤0.01 on non-chaotic programs — and
lavapipe nearly matches JS-double on `voronoi` (4.73) because Mesa's libm `sin`
is close to the system/V8 libm. Structure was verified visually on every
backend (proper fbm clouds, textbook voronoi cells), and `voronoi` luminance
statistics match on all three (mean≈110, sd≈48). `smoke` distributions differ
(js 73.2/44.7, swift 33.3/14.4, lvp 48.1/26.0) because domain-warped fbm
amplifies noise-function differences into different large-scale clouds — all
valid smoke. These two programs would equally differ across real browsers and
discrete GPUs; their timings stand, only pixel-identity is not expected.

### 3.5 Cross-driver identity

lavapipe vs llvmpipe-GL: **bit-identical on 8/14** (all 2D except `smoke` — both
are Mesa Gallium with the same LLVM codegen and libm), sub-LSB differences on
`smoke` and the five 3D programs.

## 4. Shaders

### 4.1 Inventory

Full WGSL as executed (wrapper + generated body), one file per program, in
[shaders/](shaders/) — byte-identical to the strings the harness passed to
`createShaderModule` during measurement:

| program | file | lines | bytes |
|---|---|---|---|
| mandelbrot | `ps-mandelbrot.wgsl` | 42 | 1804 |
| smoke | `ps-smoke.wgsl` | 108 | 9357 |
| voronoi | `ps-voronoi.wgsl` | 41 | 1902 |
| polygon | `ps-polygon.wgsl` | 127 | 8904 |
| circlattice | `ps-circlattice.wgsl` | 42 | 2397 |
| log_spiral | `ps-log_spiral.wgsl` | 26 | 1729 |
| plot | `ps-plot.wgsl` | 45 | 2773 |
| liquid_paint | `ps-liquid_paint.wgsl` | 32 | 1582 |
| peppermint | `ps-peppermint.wgsl` | 42 | 2434 |
| ball3d | `ps-ball3d.wgsl` | 72 | 3419 |
| rings3d | `ps-rings3d.wgsl` | 108 | 5711 |
| mol3d_ps | `ps-mol3d.wgsl` | 142 | 8119 |
| twist3d | `ps-twist3d.wgsl` | 92 | 4707 |
| gyr3d_ps | `ps-gyr3d.wgsl` | 92 | 4411 |

### 4.2 Wrapper anatomy (`wrapWGSL` in `src/gpu/renderer.ts`)

Every shader shares the preamble: `struct U` (res, time, bg, atlas-dims, 2D
cam, 3D cam ×2 = the 24-float uniform block), bindings 0–3 (uniform, param
storage, atlas texture, sampler), a 3-vertex fullscreen-triangle `vs`, an
`hsv2rgb` helper, and `fs`:

- **slice (2D)**: `px = fc.xy / u.atlas.w`; `p0 = vec2f(1,-1) *
  (px - res*0.5)/zoom + center` on the z=0 plane — **the y-flip is in-shader**,
  which is why readback row 0 equals PNG row 0 (§3.1). Then the generated
  `t1..tn` lets (SDF + colour over `P[n]` params), `d`/`col`, coverage AA
  `clamp(0.5 - d*zoom) * alpha`, `mix(bg)`.
- **solid (3D)**: the same SDF/colour generator (`stepf`/`colf`) driven by a
  fixed-count raymarch loop with orbit camera and diffuse+specular shading.
  (wgpu/naga prints `Skip function Some("stepf"/"colf")` to stderr during
  pipeline creation — harmless log noise; §3 proves the functions execute
  correctly.)

### 4.3 Full example: `log_spiral` (complete, 26 lines / 1729 B)

```wgsl
struct U { res: vec2f, time: f32, pad0: f32, bg: vec4f, atlas: vec4f, cam: vec4f, cam3a: vec4f, cam3b: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> P: array<f32>;
@group(0) @binding(2) var atlasTex: texture_2d<f32>;
@group(0) @binding(3) var atlasSamp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn hsv2rgb(c: vec3f) -> vec3f {
  let k = (vec3f(5.0, 3.0, 1.0) + c.x * 6.0) % 6.0;
  return c.z - c.z * c.y * max(vec3f(0.0), min(min(k, 4.0 - k), vec3f(1.0)));
}

@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = fc.xy / u.atlas.w;
  // 3D-native body: the point is a vec3 on the z = 0 plane (the exact 2D slice)
  let p0 = vec3f(vec2f(1.0, -1.0) * (px - u.res * 0.5) / u.cam.z + u.cam.xy, 0.0);
  let t0: vec4f = vec4f(p0, u.time);
  let t1: bool = (length(vec2f(t0.x, t0.y)) == 0.0);
  let t2: f32 = select(((min(abs(((P[3] * pow(2.718281828459045, (P[2] * (atan2(t0.y, t0.x) + (6.283185307179586 * ceil((((log((length(vec2f(t0.x, t0.y)) / P[0])) / P[1]) - atan2(t0.y, t0.x)) / 6.283185307179586))))))) - length(vec2f(t0.x, t0.y)))), abs((length(vec2f(t0.x, t0.y)) - (P[5] * pow(2.718281828459045, (P[4] * (atan2(t0.y, t0.x) + (6.283185307179586 * floor((((log((length(vec2f(t0.x, t0.y)) / P[0])) / P[1]) - atan2(t0.y, t0.x)) / 6.283185307179586)))))))))) - (length(vec2f(t0.x, t0.y)) * P[6])) / 1.24), 0.0, t1);
  let t3: vec4f = vec4f(0.86, 0.82, 0.55, 1.0);
  let d = t2; let col = t3;
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}
```

Note the codegen style: fully inlined expression lets over a float param array
(`P[0..6]` hold the spiral's radii/growth/width constants), `f32` literals with
full double precision spelled out (`2.718281828459045`, `6.283185307179586` —
parsed as f32 by WGSL), and the `select(..., 0.0, t1)` branchless singularity
guard at the origin. Heavier programs scale this pattern up — e.g. `smoke`
(108 lines: fbm octaves + domain warp) and `mol3d_ps` (142 lines: 3D SDF +
raymarch).

## 5. Repro

### 5.1 Pinned toolchain

| component | version / source |
|---|---|
| Deno | 2.5.4 (V8 14.0.365.5, TS 5.9.2) from `https://dl.deno.land/release/v2.5.4/deno-x86_64-unknown-linux-gnu.zip` |
| SwiftShader | `libvk_swiftshader.so` from Chrome-for-Testing `153.0.8010.36` `chrome-linux64.zip`, selected via a `VK_ICD_FILENAMES` JSON with `api_version 1.0.5` and an absolute `library_path` |
| lavapipe / llvmpipe | system Mesa 25.0.7 (`mesa-vulkan-drivers`; ICD at `/usr/share/vulkan/icd.d/lvp_icd.json`) |
| Node | v20.20.2; `npm i tsx @napi-rs/canvas` for the `.mts` support scripts |
| this repo | `src/` at the commit recorded alongside these docs (production code, unmodified by the bench) |

### 5.2 Layout

The bench workspace sits next to the repo checkout (sibling directories):

```text
<work>/
  curv-ps/                 # this repo
  sxs/
    progs/                 # the 14 .curv benchmark programs
    webgpu/
      wgpu-bench.ts        # the harness (listing: webgpu-bench-harness.md)
      run-matrix.sh        # matrix runner (swift | lvp, N frames)
      swift-icd.json       # ICD forcing the SwiftShader .so
      atlas.bin atlas.json # serialized glyph atlas (see §5.3)
    results/               # .rgba/.png/-diff.png/.wgsl/.log outputs
```

### 5.3 Commands

```bash
# 0. fetch Deno 2.5.4
curl -sL -o deno.zip https://dl.deno.land/release/v2.5.4/deno-x86_64-unknown-linux-gnu.zip
mkdir -p /tmp/deno-exe && cd /tmp/deno-exe && unzip -o -q /tmp/deno.zip  # → /tmp/deno-exe/deno

# 1. serialize the glyph atlas once (buildAtlas needs Canvas2D; Deno has none)
cd sxs && npm i tsx @napi-rs/canvas
npx tsx mkatlas.mts   # → webgpu/atlas.bin + webgpu/atlas.json (1024×896 r8, 221 glyphs)

# 2. run a matrix (~15 s for 14 programs × 6 frames)
cd webgpu && export DENO=/tmp/deno-exe/deno
./run-matrix.sh swift 6   # → ../results/wgpu-swift.log (+ .rgba/.wgsl per program)
./run-matrix.sh lvp 6     # lavapipe bonus column
# llvmpipe-GL: same harness with VK_ICD_FILENAMES=/tmp/does-not-exist.json --expect=gl

# 3. pixel-verify against JS-fallback references
cd .. && npx tsx compare-rgba.mts swift <ids...>   # scores normal + vflip orientations
# (references regenerate via: npx tsx sxsbench.mts --mode=2d --res=500 ... and --mode=3d --res=384 ...)
```

The harness aborts unless the fingerprinted driver matches `--expect`, so a
completed run is self-attesting as to which driver produced it.

### 5.4 What to keep

`results/` per driver per program: `.rgba` (raw readback), `.png` (oriented
render), `-diff.png` (8× amplified diff vs reference), `.wgsl` (exact executed
shader — must stay byte-identical to `docs/shaders/ps-*.wgsl`), plus the matrix
`.log` files §2 is transcribed from.

## 6. Caveats

- A software rasterizer is not a discrete GPU: absolute frame times do **not**
  predict real-GPU performance. What transfers: shader validity (all 14 compile
  and render correctly through a real WebGPU stack), relative shader-cost
  ordering, compile-time scale (tens of ms), and the JS-fallback-vs-GPU gap
  direction (3 orders of magnitude on heavy shaders — a real GPU only widens it).
- Steady = median of 5 in-process frames; same-session repeat ±2%,
  cross-session wall variance ~15% (machine load). The timestamp GPU column is
  the stable comparator.
- The ~11.5 ms host overhead is Deno/wgpu harness round-trip, excluded via
  timestamps — do not attribute it to SwiftShader.
- The 1 ns timestamp period is proven by the 42-cell constancy argument (§1.4),
  not queried through an API (WebGPU exposes no period query).
- `smoke`/`voronoi` pixels are libm-implementation-defined on every backend.
- Deno's wgpu translates WGSL via naga; Chrome would use Tint on the identical
  source — same language semantics.
- There are deliberately no Chrome numbers: Dawn enumerates zero adapters in a
  headless container. The measured stack is SwiftShader-through-wgpu, stated as
  such throughout.
