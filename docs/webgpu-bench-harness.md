# WebGPU benchmark harness (verbatim listings)

Companion to [webgpu-software-rendering-benchmark.md](webgpu-software-rendering-benchmark.md).
This file preserves the exact measurement code so the numbers stay reproducible
even if the bench workspace is lost. All three scripts are printed verbatim
below, as of the 2026-09-10 runs (plus the three behavior-neutral cleanups
noted in §1.6 of the benchmark doc).

Workspace layout assumed by the listings (sibling directories; see benchmark
doc §5.2):

```text
<work>/
  curv-ps/                 # this repo (imports below resolve into src/...)
  sxs/
    progs/                 # 14 .curv benchmark programs
    webgpu/                # ← run the harness from here
      wgpu-bench.ts run-matrix.sh swift-icd.json atlas.bin atlas.json
    results/               # outputs
```

Run with Deno 2.5.4:

```bash
VK_ICD_FILENAMES=.../swift-icd.json deno run --no-check --allow-all \
  --unstable-sloppy-imports wgpu-bench.ts --expect=swift --frames=6 \
  id:file:W:H:mode ...
```

(`--unstable-sloppy-imports` is needed because the repo uses extensionless
relative imports. No DOM is touched: the only browser-only dependency,
`buildAtlas()`, is replaced by the deserialized `atlas.bin`+`atlas.json`
snapshot; the `kern` stub returns 0, which the textless bench programs never
invoke.)

## wgpu-bench.ts

```ts
// curv-ps WebGPU backend on software Vulkan (SwiftShader / lavapipe), via Deno.
// Drives the PRODUCTION modules (Interp, compileTree, wrapWGSL) and replicates
// renderer.ts's WebGPU setup exactly (bindings, uniform layout, fullscreen pass),
// rendering to a texture + readback instead of a canvas.
//
// Usage (Deno 2.x):
//   VK_ICD_FILENAMES=.../swift-icd.json deno run --no-check --allow-all \
//     --unstable-sloppy-imports wgpu-bench.ts --expect=swift --frames=6 \
//     id:file:W:H:mode ...
//
// Driver selection is by Vulkan ICD; the harness fingerprints the adapter from
// limits+features and FAILS if it isn't the expected driver:
//   swift: cwg=256 ci=256 smp=64 spirv-pt (Chrome-bundled libvk_swiftshader)
//   lvp:   cwg=1024 ci=1024 smp=1000000 spirv-pt (Mesa lavapipe)
//   gl:    no spirv-pt, smp=16 (wgpu GLES fallback, llvmpipe)
import { Interp, compileTree, resetSolveCache } from "../../curv-ps/src/curv/interp.ts";
import { bboxOf, finiteBBox } from "../../curv-ps/src/curv/shapes.ts";
import { wrapWGSL, type Compiled, type Camera3 } from "../../curv-ps/src/gpu/renderer.ts";
import { ATLAS_W, ATLAS_H, type Atlas } from "../../curv-ps/src/gpu/atlas.ts";
import { loadPsolve } from "../../curv-ps/src/psolve/psolve.ts";

const args = Deno.args;
const opt = (n: string, d: string) => args.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const EXPECT = opt("expect", "swift");
const FRAMES = parseInt(opt("frames", "6"), 10);
const OUT = opt("out", "../results/");
const specs = args.filter((x) => !x.startsWith("--"));
await Deno.mkdir(OUT, { recursive: true });

// ---- atlas (serialized from Node; buildAtlas needs Canvas2D) ----
const abin = await Deno.readFile("./atlas.bin");
const ameta = JSON.parse(await Deno.readTextFile("./atlas.json"));
const atlas: Atlas = {
  data: new Uint8Array(abin.buffer as ArrayBuffer),
  advance: Float32Array.from(ameta.advance),
  index: new Map(ameta.index),
  cell: (code: number) => {
    const i = (atlas.index.get(code) ?? atlas.index.get(32))!;
    return [i % 16, Math.floor(i / 16)];
  },
  kern: () => 0, // textless benchmark programs never kern
};

// ---- GPU init + driver fingerprint ----
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) { console.error("FATAL: no WebGPU adapter"); Deno.exit(1); }
const L = adapter.limits;
const fp = { cwg: L.maxComputeWorkgroupSizeX, ci: L.maxComputeInvocationsPerWorkgroup, smp: L.maxSamplersPerShaderStage, spirv: adapter.features.has("spirv-shader-passthrough") };
const driver = fp.spirv && fp.cwg === 256 && fp.smp === 64 ? "swift"
  : fp.spirv && fp.cwg === 1024 && fp.smp === 1000000 ? "lvp"
  : !fp.spriv ? "gl" : "unknown";
console.log(`# driver=${driver} (cwg=${fp.cwg} ci=${fp.ci} smp=${fp.smp} spirv-pt=${fp.spirv}) expect=${EXPECT}`);
if (driver !== EXPECT) { console.error(`FATAL: driver is ${driver}, expected ${EXPECT}`); Deno.exit(1); }
const hasTs = adapter.features.has("timestamp-query");
const device = await adapter.requestDevice({ requiredFeatures: hasTs ? ["timestamp-query"] : [] });
console.log(`# timestamps=${hasTs} deno=${Deno.version.deno}`);

// ---- shared objects (mirrors renderer.ts createWebGPU) ----
const bgl = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
] });
const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
const uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const tex = device.createTexture({ size: [ATLAS_W, ATLAS_H], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
device.queue.writeTexture({ texture: tex }, atlas.data, { bytesPerRow: ATLAS_W }, [ATLAS_W, ATLAS_H]);
const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
const qs = hasTs ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
const qResolve = hasTs ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
const qRead = hasTs ? device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;

await loadPsolve();
const BG: [number, number, number] = [0.055, 0.075, 0.13];
const TIME = 0;
const CAM3: Camera3 = { tx: 0, ty: 0, tz: 0, dist: 8, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };
const CAM3_FOR: Record<string, Partial<Camera3>> = { gyroid3d: { dist: 50 } };
const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

for (const spec of specs) {
  const [id, file, Ws, Hs, mode] = spec.split(":");
  const W = parseInt(Ws, 10), H = parseInt(Hs, 10);
  const solid = mode === "solid";
  try {
    const src = await Deno.readTextFile(file);
    // cold eval + codegen (same protocol as sxsbench.mts)
    resetSolveCache();
    const VW = solid ? W : 900, VH = solid ? H : 600;
    const t0 = performance.now();
    const r = new Interp(atlas, {
      viewport: { x: -VW / 2, y: -VH / 2, w: VW, h: VH },
      time: TIME, mouse: solid ? { x: -1e6, y: -1e6, down: false } : { x: 0, y: 0, down: false }, params: {},
    }).run(src + "\n");
    const t1 = performance.now();
    if (!r.shape) throw new Error("no shape");
    const c = compileTree(r.shape, atlas, "wgsl", null, undefined, mode as "slice" | "solid");
    const t2 = performance.now();
    const prog: Compiled = { ...c, solid };

    // framebuffers
    const fmt = "rgba8unorm" as GPUTextureFormat;
    const target = device.createTexture({ size: [W, H], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const bpr = ((W * 4 + 255) >> 8) << 8;
    const readback = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    // pipeline (sync: Deno 2.5's createRenderPipelineAsync has a WebIDL bug that
    // drops `layout`; browsers use the Async call in renderer.ts — same shader,
    // same pipeline. Backend compile may spill into frame 0.)
    const pc0 = performance.now();
    const wgslSrc = wrapWGSL(prog);
    await Deno.writeFile(`${OUT}wgpu-${driver}-${id}.wgsl`, new TextEncoder().encode(wgslSrc));
    const module = device.createShaderModule({ code: wgslSrc });
    device.pushErrorScope("validation");
    const pipeline = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: fmt }] },
      primitive: { topology: "triangle-list" },
    });
    const pipelineMs = performance.now() - pc0;
    const perr0 = await device.popErrorScope();
    if (perr0) throw new Error("pipeline: " + perr0.message.slice(0, 200));
    const perr = await (async () => {
      try {
        const ci = await module.getCompilationInfo();
        return ci.messages.filter((m) => m.type === "error").map((m) => `${m.message} (line ${m.lineNum})`);
      } catch { return []; }
    })();
    if (perr.length) throw new Error("WGSL errors: " + perr.join("; "));

    // params + bind group
    const paramBuf = device.createBuffer({ size: Math.max(4, prog.params.length * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bind = device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: paramBuf } },
      { binding: 2, resource: tex.createView() }, { binding: 3, resource: sampler },
    ] });

    // cameras (same math as sxsbench.mts)
    let cam = { cx: 0, cy: 0, zoom: 1 };
    if (!solid) {
      const b = finiteBBox(bboxOf(r.shape, atlas)) ?? [-10, -10, 10, 10];
      const zoom = Math.min(W / (b[2] - b[0]), H / (b[3] - b[1]));
      cam = { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, zoom };
    }
    const c3 = { ...CAM3, ...CAM3_FOR[id] };

    const walls: number[] = [], ticks: number[] = [];
    let px: Uint8Array | null = null;
    for (let f = 0; f < FRAMES; f++) {
      const ubuf = new Float32Array([W, H, TIME, 0, BG[0], BG[1], BG[2], 1, ATLAS_W, ATLAS_H, 8, 1,
        cam.cx, cam.cy, cam.zoom, 0, c3.tx, c3.ty, c3.tz, c3.dist, c3.yaw, c3.pitch, Math.tan(c3.fov / 2), W / H]);
      device.queue.writeBuffer(uniform, 0, ubuf);
      if (prog.params.length) device.queue.writeBuffer(paramBuf, 0, prog.params);
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: BG[0], g: BG[1], b: BG[2], a: 1 } }],
        ...(qs ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
      });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
      if (qs) { enc.resolveQuerySet(qs, 0, 2, qResolve!, 0); enc.copyBufferToBuffer(qResolve!, 0, qRead!, 0, 16); }
      enc.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: bpr }, [W, H]);
      // NOTE: device.queue.onSubmittedWorkDone() never resolves under Deno 2.5.4
      // here, so the frame fence is the readback mapAsync itself: submit ->
      // pixels-ready is the honest end-to-end frame time anyway.
      const fw0 = performance.now();
      device.queue.submit([enc.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      walls.push(performance.now() - fw0);
      const mapped = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      if (qs) {
        await qRead!.mapAsync(GPUMapMode.READ);
        const t = new BigInt64Array(qRead!.getMappedRange());
        ticks.push(Number(t[1] - t[0]));
        qRead!.unmap();
      }
      // unpad rows
      px = new Uint8Array(W * H * 4);
      for (let j = 0; j < H; j++) px.set(mapped.subarray(j * bpr, j * bpr + W * 4), j * W * 4);
    }
    await Deno.writeFile(`${OUT}wgpu-${driver}-${id}.rgba`, px!);
    const steady = walls.slice(1), steadyT = ticks.slice(1);
    console.log(`wgpu-${driver} ${solid ? `3d/${W}x${H}` : `2d/${W}x${H}`} ${id.padEnd(12)} ` +
      `eval ${(t1 - t0).toFixed(1)} wgslgen ${(t2 - t1).toFixed(1)} compile ${pipelineMs.toFixed(0)} ` +
      `frame0 ${walls[0].toFixed(0)} steady ${med(steady).toFixed(1)} (min ${Math.min(...steady).toFixed(1)}) ms` +
      (steadyT.length ? ` ticks ${med(steadyT).toFixed(0)}/frame` : ""));
    target.destroy(); readback.destroy(); paramBuf.destroy();
  } catch (e) {
    console.log(`wgpu-${driver} ${id.padEnd(14)} ERR ${(e as Error).message.slice(0, 160)}`);
  }
}
device.destroy();
```

## run-matrix.sh

```bash
#!/bin/bash
# curv-ps WebGPU-on-software-Vulkan benchmark matrix.
# Driver is selected by Vulkan ICD; the harness fingerprints the adapter
# (limits+features) and aborts if it isn't the expected driver.
#   swift: Chrome-bundled libvk_swiftshader (./swift-icd.json, api_version 1.0.5)
#   lvp:   Mesa lavapipe (/usr/share/vulkan/icd.d/lvp_icd.json)
#   gl:    wgpu GLES fallback (bogus ICD path forces Vulkan init failure)
cd "$(dirname "$0")"
DENO="${DENO:-/tmp/deno-exe/deno}"   # Deno 2.5.4 (built-in WebGPU); see benchmark doc §5 for fetch
expect="$1"               # swift | lvp
frames="$2"               # frames per program (frame0 = warm, rest = steady)
shift 2
case "$expect" in
  swift) export VK_ICD_FILENAMES="$PWD/swift-icd.json" ;;
  lvp)   export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json ;;
  *) echo "usage: run-matrix.sh swift|lvp <frames>"; exit 2 ;;
esac
SPECS_2D="mandelbrot:../progs/mandelbrot.curv:500:500:slice smoke:../progs/smoke.curv:500:500:slice \
voronoi:../progs/voronoi.curv:500:500:slice polygon:../progs/polygon.curv:500:500:slice \
circlattice:../progs/circlattice.curv:500:500:slice log_spiral:../progs/log_spiral.curv:500:500:slice \
plot:../progs/plot.curv:500:500:slice liquid_paint:../progs/liquid_paint.curv:500:500:slice \
peppermint:../progs/peppermint.curv:500:500:slice"
SPECS_3D="ball3d:../progs/ball3d.curv:384:384:solid rings3d:../progs/rings3d.curv:384:384:solid \
mol3d_ps:../progs/mol3d_ps.curv:384:384:solid twist3d:../progs/twist3d.curv:384:384:solid \
gyr3d_ps:../progs/gyr3d_ps.curv:384:384:solid"
# shellcheck disable=SC2086
$DENO run --no-check --allow-all --unstable-sloppy-imports wgpu-bench.ts \
  --expect="$expect" --frames="$frames" --out=../results/ $SPECS_2D $SPECS_3D "$@"
```

## mkatlas.mts (atlas snapshot, run once from Node)

```ts
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "fs";
import { buildAtlas, ATLAS_W, ATLAS_H } from "/home/user/curv-ps/src/gpu/atlas";
(globalThis as any).document = { createElement: () => createCanvas(1, 1) as any };
const a = buildAtlas();
writeFileSync("/home/user/sxs/webgpu/atlas.bin", a.data);
writeFileSync("/home/user/sxs/webgpu/atlas.json", JSON.stringify({ W: ATLAS_W, H: ATLAS_H, advance: [...a.advance], index: [...a.index] }));
console.log("atlas", ATLAS_W, "x", ATLAS_H, a.data.length, "bytes,", a.advance.length, "glyphs");
```

(Adjust the two absolute paths to your checkout.) Produces `atlas.bin`
(917504 bytes of r8 glyph data, 1024×896) and `atlas.json`
(`{W, H, advance[], index[]}`), which the harness deserializes to reconstruct
the `Atlas` without Canvas2D.

## swift-icd.json (driver forcing)

```json
{"file_format_version":"1.0.0","ICD":{"library_path":"/absolute/path/to/libvk_swiftshader.so","api_version":"1.0.5"}}
```

`api_version` must be `1.0.5` (Google's own shipped value); `1.3.0` yields
`ERROR_INCOMPATIBLE_DRIVER` with Chrome's bundled library against a modern
Vulkan loader. Obtain the `.so` from any Chrome 153+ install
(`chrome-linux64/libvk_swiftshader.so`, e.g. via a Chrome-for-Testing download).

## Measurement protocol (recap)

- 6 frames per program; frame 0 warms the backend (compile spill, uploads);
  steady = median of frames 1–5; timestamps = median of the same frames.
- Wall clock = `submit()` → readback `mapAsync()` resolved (end-to-end,
  readback included). `onSubmittedWorkDone()` never resolves under Deno 2.5.4
  here, hence the map fence.
- True GPU time = render-pass timestamp delta (period proven 1 ns by the
  42-cell constancy argument in the benchmark doc §1.4).
- A completed run is self-attesting: the adapter fingerprint must match
  `--expect` or the harness exits before measuring anything.
