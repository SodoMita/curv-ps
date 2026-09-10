# Getting the best performance from lavapipe

lavapipe is Mesa's software Vulkan implementation: a multithreaded,
LLVM-JIT-compiled rasterizer that runs Vulkan (and, through wgpu, WebGPU) with
no GPU. For curv-ps's WebGPU path it was the **fastest software backend
measured** — 1.3–12.7× faster per shader than SwiftShader on the same CPU (see
[webgpu-software-rendering-benchmark.md](webgpu-software-rendering-benchmark.md)
§2.2). This guide covers setup, the tuning knobs that actually matter
(measured, not folklore), and how to verify them.

Measured environment: Mesa 25.0.7 (LLVM 19.1 backend), 2 vCPU headless Linux
container, Deno 2.5.4 wgpu. 2D programs at 500×500, 3D at 384×384.

## 1. Setup

```bash
# Debian/Ubuntu: the lavapipe driver ships with Mesa's Vulkan drivers
sudo apt install mesa-vulkan-drivers
ls /usr/share/vulkan/icd.d/lvp_icd.json   # the lavapipe ICD

# Force lavapipe for a WebGPU run (Deno's wgpu ignores WGPU_BACKEND;
# ICD selection is the only switch that works)
export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
```

Verify you actually got lavapipe — Deno exposes no adapter strings, so
fingerprint the adapter from limits+features (the bench harness does this and
aborts on mismatch):

| driver | maxComputeWorkgroupSizeX | maxSamplersPerShaderStage | spirv-shader-passthrough |
|---|---|---|---|
| **lavapipe** | 1024 | 1000000 | yes (37 features) |
| SwiftShader | 256 | 64 | yes (32 features) |
| llvmpipe-GLES fallback | 1024 | 16 | no (22 features) |

If you see the GLES row, Vulkan init failed (usually a bad `VK_ICD_FILENAMES`)
and wgpu silently fell back to llvmpipe over GL.

## 2. Measured performance (lavapipe column)

Steady wall = submit→pixels incl. ~11.5 ms of Deno/wgpu host round-trip (see
benchmark doc §1.4); true GPU = pass-scoped timestamp delta (1 ns period).
JS = single-threaded fallback median on the same CPU.

| program | compile ms | frame0 ms | steady wall ms | true GPU ms | speedup vs JS (wall / GPU) |
|---|---|---|---|---|---|
| mandelbrot | 4 | 23 | 14.4 | 2.8 | 60× / 307× |
| smoke | 15 | 27 | 25.7 | 14.0 | 1798× / 3300× |
| voronoi | 2 | 14 | 13.6 | 2.1 | 115× / 746× |
| polygon | 10 | 18 | 16.6 | 5.1 | 232× / 755× |
| circlattice | 2 | 16 | 12.9 | 1.4 | 43× / 399× |
| log_spiral | 2 | 14 | 12.9 | 1.5 | 32× / 277× |
| plot | 2 | 13 | 13.0 | 1.5 | 120× / 1038× |
| liquid_paint | 7 | 35 | 34.9 | 23.3 | 287× / 429× |
| peppermint | 9 | 15 | 14.3 | 2.8 | 52× / 266× |
| ball3d | 5 | 16 | 15.0 | 3.6 | 58× / 243× |
| rings3d | 9 | 24 | 20.0 | 8.4 | 10× / 24× |
| mol3d_ps | 16 | 25 | 24.0 | 12.6 | 71× / 136× |
| twist3d | 8 | 22 | 21.0 | 9.5 | 26× / 58× |
| gyr3d_ps | 5 | 19 | 17.4 | 5.9 | 24× / 71× |

Two things stand out: pipeline compile is 2–16 ms (effectively free), and light
shaders bottom out at ~13 ms wall — almost entirely the 11.5 ms host constant,
with ~1.5 ms of actual rendering. Compare GPU-to-GPU (timestamps), not
wall-to-wall, when judging the driver.

## 3. Tuning knobs (measured)

### 3.1 `LP_NUM_THREADS` — the only knob that matters

lavapipe honors `LP_NUM_THREADS` (verified both in the driver's binary strings
and behaviorally). It sizes the Gallium rasterizer thread pool; unset = all CPU
cores. Measurement on the 2-core box (true-GPU ms, median of 5 frames):

| program | unset (2 threads) | `=1` | `=4` (oversubscribed) |
|---|---|---|---|
| mol3d_ps | 18.1 | 32.0 (1.77× slower) | 17.1 (≈ same) |
| polygon | 8.4 | 14.8 (1.76× slower) | 7.9 (≈ same) |
| circlattice | 2.0 | 3.2 (1.6× slower) | 2.1 (≈ same) |

(Absolute numbers differ slightly from §2 — cross-session machine variance;
the ratios are the point.)

Guidance:

- **Leave it unset** (or set it to your core count explicitly). One thread
  costs you ~40% throughput; oversubscribing gains nothing.
- Scaling past 2 cores was not measured here, but lavapipe's tile-based
  rasterization is designed for it — expect near-linear scaling on
  fragment-heavy shaders like these (full-screen, ALU-bound).
- If your app is itself CPU-hot on the same cores, consider reserving a core
  (`LP_NUM_THREADS=$(($(nproc) - 1))`) — general guidance, not measured here.

### 3.2 There are no other performance knobs

The driver's remaining environment variables are debug-only, confirmed via
`strings libvulkan_lvp.so`: `LVP_CMD_DEBUG`, `LVP_POISON_MEMORY`,
`LVP_SNORM_BLEND`, and the `GALLIUM_*` trace/dump family. Don't chase env
vars — the real levers are core count (§3.1), the LLVM backend (§4), and
application/shader structure (§§5–6).

## 4. Environment (general guidance)

- **Verify the LLVM backend.** lavapipe's speed comes from LLVM-JIT-compiled
  rasterizer/FS code. Debian's Mesa 25.0.7 ships it (LLVM 19.1 — visible in
  the driver's version strings and `vulkaninfo` driver info). A Mesa built
  without LLVM would be dramatically slower; if your numbers look nothing like
  §2, check this first.
- **CPU frequency scaling.** For benchmarking, pin the `performance` governor;
  on-demand stepping adds exactly the kind of ±15% cross-session variance seen
  in these measurements.
- **Keep Mesa reasonably current.** lavapipe is under active development and
  gets faster; 25.0.x is a good baseline as of this writing.

## 5. Application-level advice (wgpu / Deno)

- **Reuse the device and pipelines.** Pipeline creation is cheap here (2–16 ms)
  but not free; create once per shader, and prefer async pipeline creation in
  real apps to keep it off the critical path.
- **Don't read back every frame.** The bench harness maps a readback buffer per
  frame for pixel verification — a real app presents to a canvas/swapchain
  instead. Per-frame submit+fence+map round-trips cost ~11.5 ms in this Deno
  setup regardless of driver; batch work and present.
- **Separate GPU time from host time.** Use timestamp queries around the render
  pass (as the harness does) so driver comparisons aren't polluted by host
  overhead. lavapipe's timestamp period is 1 ns (proven by the 42-cell
  constancy argument in the benchmark doc §1.4).

## 6. Shader-level advice (from the measured cost ordering)

- **3D cost ≈ raymarch steps × SDF cost.** `mol3d_ps` (12.6 ms true GPU) vs
  `ball3d` (3.6 ms) is the same loop over a cheaper SDF; `rings3d` (8.4 ms)
  sits between. To go faster, cut march steps or bail out early first —
  shading tweaks are second-order.
- **2D heavyweights are fbm octaves + transcendentals.** `liquid_paint`
  (23.3 ms) and `smoke` (14.0 ms) vs ~1.5 ms for the light shaders: octave
  count and `sin`/`pow`/`atan` density dominate. Fewer octaves is the biggest
  lever.
- **Precision note.** Everything runs float32. Programs using chaotic
  `sin`-hash noise (`smoke`, `voronoi`) render different-but-valid noise
  fields per backend (Mesa's libm happens to agree closely with JS's:
  `voronoi` lavapipe-vs-JS mean diff is 4.73). Deterministic given the
  backend — just not portable pixel-for-pixel. See benchmark doc §3.4.

## 7. Troubleshooting

- **Wrong driver**: fingerprint every run (table in §1). The GLES-fallback row
  means `VK_ICD_FILENAMES` didn't resolve — check the path.
- **No adapter at all**: the Vulkan loader (`libvulkan.so.1`) or the ICD JSON
  is missing/broken; `VK_LOADER_DEBUG=error` prints loader diagnostics.
- **Deno-specific gotchas**: `WGPU_BACKEND` is ignored (ICD is the only
  switch); `createRenderPipelineAsync` is broken in Deno 2.5.4 (use the sync
  call); `queue.onSubmittedWorkDone()` never resolves here (fence on a buffer
  map instead). Details in the benchmark doc §§1.3/1.5.

## 8. Repro commands

```bash
export DENO=/tmp/deno-exe/deno   # Deno 2.5.4, see benchmark doc §5.1
cd sxs/webgpu
./run-matrix.sh lvp 6            # full 14-program lavapipe matrix
# thread experiment (§3.1):
VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json $DENO run --no-check --allow-all \
  --unstable-sloppy-imports wgpu-bench.ts --expect=lvp --frames=6 --out=/tmp/lvp-t/ \
  mol3d_ps:../progs/mol3d_ps.curv:384:384:solid polygon:../progs/polygon.curv:500:500:slice \
  circlattice:../progs/circlattice.curv:500:500:slice
LP_NUM_THREADS=1 VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json $DENO run ... # same specs
```
