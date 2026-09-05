/// <reference types="@webgpu/types" />
// Renderer: takes compiled shape programs (straight-line shader code + a
// parameter array) and draws them.  WebGPU pipelines are cached by generated
// code, so animation / re-solving only re-uploads the parameter buffer.  The
// CPU fallback runs the JS flavour of the same generated code.
import { ATLAS_W, ATLAS_H, type Atlas } from "./atlas";
import { makeJSRuntime } from "./gen";

export interface Compiled { code: string; d: string; c: string; params: Float32Array }
/** World-space camera: centre in world units, zoom = device-independent px per world unit.  y is always up. */
export interface Camera { cx: number; cy: number; zoom: number }
export interface Renderer {
  kind: "webgpu" | "cpu";
  adapterInfo?: string;
  /** `scale` (0..1] renders at a fraction of the device resolution (adaptive quality while animating). */
  render(prog: Compiled, cam: Camera, bg: [number, number, number], time: number, scale?: number): Promise<void>;
  resize(scale?: number): void;
  destroy(): void;
  stats: { compiles: number; lastCompileMs: number; cached: number; gpuMs: number; timestamps: boolean };
}

export async function createRenderer(canvas: HTMLCanvasElement, atlas: Atlas, mode: "auto" | "cpu" = "auto"): Promise<Renderer> {
  if (mode === "auto") {
    try { const r = await createWebGPU(canvas, atlas); if (r) return r; }
    catch (e) { console.warn("WebGPU init failed, using CPU fallback", e); }
  }
  return createCPU(canvas, atlas);
}

const PREAMBLE = /* wgsl */ `
struct U { res: vec2f, time: f32, pad0: f32, bg: vec4f, atlas: vec4f, cam: vec4f };
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
`;
const wrapWGSL = (c: Compiled) => `${PREAMBLE}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = fc.xy / u.atlas.w;
  let p0 = vec2f(1.0, -1.0) * (px - u.res * 0.5) / u.cam.z + u.cam.xy;
${c.code}
  let d = ${c.d}; let col = ${c.c};
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}`;

async function createWebGPU(canvas: HTMLCanvasElement, atlas: Atlas): Promise<Renderer | null> {
  if (!("gpu" in navigator) || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  // optional GPU timestamps: exact per-frame render time for the adaptive-quality controller
  const hasTs = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({ requiredFeatures: hasTs ? ["timestamp-query"] : [] });
  const ctx = canvas.getContext("webgpu");
  if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  const bgl = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const tex = device.createTexture({ size: [ATLAS_W, ATLAS_H], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: tex }, atlas.data, { bytesPerRow: ATLAS_W }, [ATLAS_W, ATLAS_H]);
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  let paramCap = 4096, paramBuf: GPUBuffer, bind: GPUBindGroup;
  const makeParams = (cap: number) => {
    paramCap = cap;
    paramBuf = device.createBuffer({ size: cap * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    bind = device.createBindGroup({ layout: bgl, entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: paramBuf } },
      { binding: 2, resource: tex.createView() }, { binding: 3, resource: sampler },
    ] });
  };
  makeParams(paramCap);

  let info = "WebGPU";
  try {
    const ai = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
    if (ai && (ai.description || ai.vendor)) info = `WebGPU · ${ai.description || ai.vendor}${ai.architecture ? " (" + ai.architecture + ")" : ""}`;
  } catch { /* ignore */ }

  const cache = new Map<string, GPURenderPipeline>();
  const pending = new Map<string, Promise<GPURenderPipeline>>();
  const stats = { compiles: 0, lastCompileMs: 0, cached: 0, gpuMs: 0, timestamps: hasTs };
  // timestamp query: begin/end of the render pass → resolve → copy to a mappable buffer (skipped while a readback is in flight)
  const qs = hasTs ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
  const qResolve = hasTs ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const qRead = hasTs ? device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;
  let qBusy = false;
  const getPipeline = (c: Compiled): Promise<GPURenderPipeline> => {
    const hit = cache.get(c.code); if (hit) return Promise.resolve(hit);
    const p0 = pending.get(c.code); if (p0) return p0;
    const t0 = performance.now();
    const p = (async () => {
      const code = wrapWGSL(c);
      device.pushErrorScope("validation");
      const module = device.createShaderModule({ code });
      let pipeline: GPURenderPipeline;
      try {
        pipeline = await device.createRenderPipelineAsync({ layout, vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format }] }, primitive: { topology: "triangle-list" } });
      } catch (e) {
        await device.popErrorScope().catch(() => null);
        const ci = await module.getCompilationInfo();
        const errs = ci.messages.filter((m) => m.type === "error");
        throw new Error("shader: " + (errs.length ? errs.map((m) => `${m.message} (line ${m.lineNum - 20})`).join("; ") : (e as Error).message));
      }
      const e = await device.popErrorScope(); if (e) throw new Error("shader: " + e.message);
      if (cache.size > 24) cache.delete(cache.keys().next().value!);
      cache.set(c.code, pipeline); stats.compiles++; stats.lastCompileMs = performance.now() - t0; stats.cached = cache.size;
      return pipeline;
    })();
    pending.set(c.code, p); p.finally(() => pending.delete(c.code)); return p;
  };

  let curScale = 1;
  const resize = (scale = curScale) => {
    curScale = scale;
    const dpr = Math.min(2, window.devicePixelRatio || 1) * scale;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };
  resize();
  const ubuf = new Float32Array(16);
  let serial = 0;
  return {
    kind: "webgpu", adapterInfo: info, resize, stats,
    async render(prog, cam, bg, time, scale = 1) {
      const my = ++serial;
      const pipeline = await getPipeline(prog);
      if (my !== serial && cache.has(prog.code) === false) return; // superseded
      resize(scale);
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      if (prog.params.length > paramCap) makeParams(Math.max(prog.params.length, paramCap * 2));
      ubuf.set([canvas.clientWidth, canvas.clientHeight, time, 0, bg[0], bg[1], bg[2], 1, ATLAS_W, ATLAS_H, 8, dpr, cam.cx, cam.cy, cam.zoom, 0]);
      device.queue.writeBuffer(uniform, 0, ubuf);
      if (prog.params.length) device.queue.writeBuffer(paramBuf, 0, prog.params.buffer, prog.params.byteOffset, prog.params.byteLength);
      const enc = device.createCommandEncoder();
      const measure = qs !== null && !qBusy;
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: bg[0], g: bg[1], b: bg[2], a: 1 } }],
        ...(measure ? { timestampWrites: { querySet: qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {}),
      });
      pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end();
      if (measure) { enc.resolveQuerySet(qs, 0, 2, qResolve!, 0); enc.copyBufferToBuffer(qResolve!, 0, qRead!, 0, 16); }
      device.queue.submit([enc.finish()]);
      if (measure) {
        qBusy = true;
        qRead!.mapAsync(GPUMapMode.READ).then(() => {
          const t = new BigInt64Array(qRead!.getMappedRange()); const ms = Number(t[1] - t[0]) / 1e6; qRead!.unmap();
          if (ms >= 0 && ms < 1e4) stats.gpuMs = stats.gpuMs ? stats.gpuMs * 0.6 + ms * 0.4 : ms; // light smoothing
        }).catch(() => { /* device lost / destroyed */ }).finally(() => { qBusy = false; });
      }
    },
    destroy() { try { device.destroy(); } catch { /* ignore */ } },
  };
}

type PixelFn = (P: Float32Array, R: unknown, W: number, H: number, scale: number, cam: Camera, T: number, bg: number[], px: Uint8ClampedArray) => void;

function createCPU(canvas: HTMLCanvasElement, atlas: Atlas): Renderer {
  const ctx2d = canvas.getContext("2d")!;
  const R = makeJSRuntime((u, v) => {
    const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5))), y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
    return atlas.data[y * ATLAS_W + x] / 255;
  });
  const cache = new Map<string, PixelFn>();
  const stats = { compiles: 0, lastCompileMs: 0, cached: 0, gpuMs: 0, timestamps: false };
  const compile = (c: Compiled): PixelFn => {
    let f = cache.get(c.code); if (f) return f;
    const t0 = performance.now();
    const body = `
      const zoom = cam.zoom;
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const p0 = [((i + 0.5) / scale - RW * 0.5) / zoom + cam.cx, -((j + 0.5) / scale - RH * 0.5) / zoom + cam.cy];
${c.code}
        const d = ${c.d}, col = ${c.c};
        const aa = Math.min(1, Math.max(0, 0.5 - d * zoom)) * col[3];
        const q = (j * W + i) * 4;
        px[q] = (bg[0] + (col[0] - bg[0]) * aa) * 255; px[q + 1] = (bg[1] + (col[1] - bg[1]) * aa) * 255; px[q + 2] = (bg[2] + (col[2] - bg[2]) * aa) * 255; px[q + 3] = 255;
      }`;
    f = new Function("P", "R", "W", "H", "scale", "cam", "T", "bg", "px", "RW", "RH", body) as unknown as PixelFn;
    const raw = f;
    f = (P, R2, W, H, scale, cam, T, bg, px) => (raw as unknown as (...a: unknown[]) => void)(P, R2, W, H, scale, cam, T, bg, px, W / scale, H / scale);
    if (cache.size > 24) cache.delete(cache.keys().next().value!);
    cache.set(c.code, f); stats.compiles++; stats.lastCompileMs = performance.now() - t0; stats.cached = cache.size;
    return f;
  };
  const resize = () => {
    const w = Math.max(1, Math.floor(canvas.clientWidth)), h = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };
  resize();
  let scale = 0.5;
  return {
    kind: "cpu", resize, stats,
    async render(prog, cam, bg, time) {
      resize();
      const W = canvas.width, H = canvas.height;
      const w = Math.max(1, Math.floor(W * scale)), h = Math.max(1, Math.floor(H * scale));
      const img = ctx2d.createImageData(w, h);
      const f = compile(prog);
      const t0 = performance.now();
      f(prog.params, R, w, h, scale, cam, time, bg, img.data);
      const ms = performance.now() - t0;
      // adapt resolution to keep the CPU path interactive
      if (ms > 120 && scale > 0.2) scale = Math.max(0.2, scale * 0.7); else if (ms < 30 && scale < 1) scale = Math.min(1, scale * 1.25);
      const off = document.createElement("canvas"); off.width = w; off.height = h; off.getContext("2d")!.putImageData(img, 0, 0);
      ctx2d.imageSmoothingEnabled = true; ctx2d.drawImage(off, 0, 0, W, H);
    },
    destroy() { /* nothing */ },
  };
}
