/// <reference types="@webgpu/types" />
// Renderer: takes compiled shape programs (straight-line shader code + a
// parameter array) and draws them.  WebGPU pipelines are cached by generated
// code, so animation / re-solving only re-uploads the parameter buffer.  The
// CPU fallback runs the JS flavour of the same generated code.
import { ATLAS_W, ATLAS_H, type Atlas } from "./atlas";
import { makeJSRuntime, SHADER_FLAGS } from "./gen";

export interface Compiled { code: string; d: string; c: string; params: Float32Array; solid?: boolean }
/** World-space camera: centre in world units, zoom = device-independent px per world unit.  y is always up. */
export interface Camera { cx: number; cy: number; zoom: number }
/** Orbit camera for the 3D (solid) view: target + distance + yaw/pitch around it, fov in radians. */
export interface Camera3 { tx: number; ty: number; tz: number; dist: number; yaw: number; pitch: number; fov: number }
export interface Renderer {
  kind: "webgpu" | "cpu";
  adapterInfo?: string;
  /** `scale` (0..1] renders at a fraction of the device resolution (adaptive quality while animating). */
  render(prog: Compiled, cam: Camera, bg: [number, number, number], time: number, scale?: number, cam3?: Camera3): Promise<void>;
  resize(scale?: number): void;
  destroy(): void;
  stats: { compiles: number; lastCompileMs: number; cached: number; gpuMs: number; timestamps: boolean;
    /** non-finite distances seen by the CPU raster loops (a NaN distance paints a black pixel);
     *  always 0 on the WebGPU path, which cannot report per-pixel values back */ nan: number };
}

export interface RendererOptions {
  /** Pin the CPU fallback's adaptive resolution (0..1] instead of letting it settle from frame
   *  time — used by the gates so two builds can be timed on exactly the same pixel count. */
  fixedScale?: number;
}
export async function createRenderer(canvas: HTMLCanvasElement, atlas: Atlas, mode: "auto" | "cpu" = "auto", opts: RendererOptions = {}): Promise<Renderer> {
  if (mode === "auto") {
    try { const r = await createWebGPU(canvas, atlas); if (r) return r; }
    catch (e) { console.warn("WebGPU init failed, using CPU fallback", e); }
  }
  return createCPU(canvas, atlas, opts.fixedScale);
}

// cam: 2D slice camera (cx, cy, zoom); cam3a: 3D target + distance; cam3b: yaw, pitch, tan(fov/2), aspect
const PREAMBLE = /* wgsl */ `
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
`;
/** Which flavour of the 3D wrapper is in force: with `branchless3D` (or the master `branchless`
 *  flag) the raymarch loop has no `if` and no `break`, so every ray runs all 128 steps and is shaded
 *  even when it hits nothing — same pixels, strictly more work. */
const solidBranchless = () => SHADER_FLAGS.branchless3D || SHADER_FLAGS.branchless;

const wrapWGSL2D = (c: Compiled) => `${PREAMBLE}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = fc.xy / u.atlas.w;
  // 3D-native body: the point is a vec3 on the z = 0 plane (the exact 2D slice)
  let p0 = vec3f(vec2f(1.0, -1.0) * (px - u.res * 0.5) / u.cam.z + u.cam.xy, 0.0);
${c.code}
  let d = ${c.d}; let col = ${c.c};
  let aa = clamp(0.5 - d * u.cam.z, 0.0, 1.0) * col.a;
  return vec4f(mix(u.bg.rgb, col.rgb, aa), 1.0);
}`;
// 3D solid view: raymarch the distance field; the same straight-line body becomes a step() and
// a colour() function of the ray position.  Lighting matches the C++ viewer (ambient + 2 key
// lights + rim).
const wrapWGSL3D = (c: Compiled) => `${PREAMBLE}
fn stepf(q: vec3f) -> f32 {
  let p0 = q;
${c.code}
  return ${c.d};
}
fn colf(q: vec3f) -> vec4f {
  let p0 = q;
${c.code}
  return ${c.c};
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let tgt = u.cam3a.xyz;
  let rad = max(u.cam3a.w, 0.001);
  let cy = cos(u.cam3b.x); let sy = sin(u.cam3b.x);
  let cp = cos(u.cam3b.y); let sp = sin(u.cam3b.y);
  let ro = tgt + rad * vec3f(sy * cp, sp, cy * cp);
  let fw = normalize(tgt - ro);
  let rt = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(rt, fw);
  // normalised device coords in [-1, 1] — the CPU marcher divides by (res * 0.5); this used to
  // multiply by 2.0 instead, which made nd ~res wide (e.g. ±800), so every ray left at a right
  // angle to the view direction and the 3D view came out empty on the GPU while the CPU path
  // (and therefore every headless gate) looked fine.
  let nd = vec2f(1.0, -1.0) * (fc.xy / u.atlas.w - u.res * 0.5) / (u.res * 0.5);
  let rd = normalize(fw + rt * (nd.x * u.cam3b.z * u.cam3b.w) + up * (nd.y * u.cam3b.z));
  // the far plane follows the camera: a viewport-sized 2D program is ~900 units across and the
  // auto-fit puts the eye ~1900 units out, where a fixed 400-unit far plane never reaches it
  let FAR = max(400.0, rad * 6.0);
  var tt = 0.02;
  var hit = false;
  for (var i = 0u; i < 128u; i = i + 1u) {
    let dd = stepf(ro + rd * tt);
    // WGSL needs a compound statement for the body of an if: "if (dd > FAR) break;" is a syntax
    // error (naga: expected '{' for if statement), which is how round 17 shipped a 3D view that
    // only ever worked on the CPU fallback.
    if (dd < 0.001) { hit = true; break; }
    if (dd > FAR) { break; }
    tt += min(dd, FAR);
    if (tt > FAR) { break; }
  }
  if (!hit) { return vec4f(u.bg.rgb, 1.0); }
  let ph = ro + rd * tt;
  let e = max(0.0012, rad * 0.0006);
  let n = normalize(vec3f(
    stepf(ph + vec3f(e, 0.0, 0.0)) - stepf(ph - vec3f(e, 0.0, 0.0)),
    stepf(ph + vec3f(0.0, e, 0.0)) - stepf(ph - vec3f(0.0, e, 0.0)),
    stepf(ph + vec3f(0.0, 0.0, e)) - stepf(ph - vec3f(0.0, 0.0, e))));
  let cc = colf(ph);
  let l1 = normalize(vec3f(0.55, 0.8, 0.5));
  let l2 = normalize(vec3f(-0.5, -0.25, -0.6));
  let rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  let lum = 0.32 + 0.75 * max(dot(n, l1), 0.0) + 0.35 * max(dot(n, l2), 0.0) + 0.3 * rim;
  return vec4f(min(cc.rgb * lum, vec3f(1.0)), 1.0);
}`;
const wrapWGSL3Db = (c: Compiled) => `${PREAMBLE}
fn stepf(q: vec3f) -> f32 {
  let p0 = q;
${c.code}
  return ${c.d};
}
fn colf(q: vec3f) -> vec4f {
  let p0 = q;
${c.code}
  return ${c.c};
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let tgt = u.cam3a.xyz;
  let rad = max(u.cam3a.w, 0.001);
  let cy = cos(u.cam3b.x); let sy = sin(u.cam3b.x);
  let cp = cos(u.cam3b.y); let sp = sin(u.cam3b.y);
  let ro = tgt + rad * vec3f(sy * cp, sp, cy * cp);
  let fw = normalize(tgt - ro);
  let rt = normalize(cross(fw, vec3f(0.0, 1.0, 0.0)));
  let up = cross(rt, fw);
  // normalised device coords in [-1, 1] — the CPU marcher divides by (res * 0.5); this used to
  // multiply by 2.0 instead, which made nd ~res wide (e.g. ±800), so every ray left at a right
  // angle to the view direction and the 3D view came out empty on the GPU while the CPU path
  // (and therefore every headless gate) looked fine.
  let nd = vec2f(1.0, -1.0) * (fc.xy / u.atlas.w - u.res * 0.5) / (u.res * 0.5);
  let rd = normalize(fw + rt * (nd.x * u.cam3b.z * u.cam3b.w) + up * (nd.y * u.cam3b.z));
  // the far plane follows the camera: a viewport-sized 2D program is ~900 units across and the
  // auto-fit puts the eye ~1900 units out, where a fixed 400-unit far plane never reaches it
  let FAR = max(400.0, rad * 6.0);
  var tt = 0.02;
  var hit = 0.0;    // 1 once the ray reached a surface
  var live = 1.0;   // 1 while the ray is still marching (0 after a hit, an escape or a NaN)
  for (var i = 0u; i < 128u; i = i + 1u) {
    let dd = stepf(ro + rd * tt);
    // branchless: no break, no if.  near stops the advance, gone retires the ray (a NaN
    // distance is a retire too: it would otherwise poison tt and the normal).  Every iteration
    // runs; once live is 0 the updates are no-ops, so the result is the same as breaking out.
    let near = select(0.0, 1.0, dd < 0.001);
    let gone = select(0.0, 1.0, (dd > FAR) | (tt > FAR) | !(dd == dd));
    hit = max(hit, live * near);
    // select, not a 0 factor: min(NaN, FAR) is NaN and 0 * NaN is still NaN
    let adv = select(min(dd, FAR), 0.0, gone > 0.5);
    tt = tt + live * (1.0 - near) * adv;
    live = live * (1.0 - near) * (1.0 - gone);
  }
  let ph = ro + rd * tt;
  let e = max(0.0012, rad * 0.0006);
  // gradient length instead of normalize(): a background pixel has a zero gradient, and
  // normalize(0) is NaN - and mix(bg, NaN, 0.0) is NaN too, because 0 * NaN is NaN.
  let gv = vec3f(
    stepf(ph + vec3f(e, 0.0, 0.0)) - stepf(ph - vec3f(e, 0.0, 0.0)),
    stepf(ph + vec3f(0.0, e, 0.0)) - stepf(ph - vec3f(0.0, e, 0.0)),
    stepf(ph + vec3f(0.0, 0.0, e)) - stepf(ph - vec3f(0.0, 0.0, e)));
  let n = gv / max(length(gv), 1e-20);
  let cc = colf(ph);
  let l1 = normalize(vec3f(0.55, 0.8, 0.5));
  let l2 = normalize(vec3f(-0.5, -0.25, -0.6));
  let rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
  let lum = 0.32 + 0.75 * max(dot(n, l1), 0.0) + 0.35 * max(dot(n, l2), 0.0) + 0.3 * rim;
  // select, not mix: the shaded colour is computed for every pixel (background included) and a
  // mix() would drag its NaN/Inf into the result even at t = 0
  return vec4f(select(u.bg.rgb, min(cc.rgb * lum, vec3f(1.0)), hit > 0.5), 1.0);
}`;
/** The full shader source the GPU actually sees, for one compiled program.  Exported so the gate can
 *  parse exactly this text: the body alone is not enough (the wrapper is where the raymarch loop
 *  lives, and a syntax error there fails on the GPU while the CPU path keeps working). */
export const wrapWGSL = (c: Compiled) => (c.solid ? (solidBranchless() ? wrapWGSL3Db(c) : wrapWGSL3D(c)) : wrapWGSL2D(c));


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
  const uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
  const stats = { compiles: 0, lastCompileMs: 0, cached: 0, gpuMs: 0, timestamps: hasTs, nan: 0 };
  // timestamp query: begin/end of the render pass → resolve → copy to a mappable buffer (skipped while a readback is in flight)
  const qs = hasTs ? device.createQuerySet({ type: "timestamp", count: 2 }) : null;
  const qResolve = hasTs ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
  const qRead = hasTs ? device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }) : null;
  let qBusy = false;
  // the same generated body compiles to different frames per view mode, so the mode is part of the cache key
  // the wrapper is hand-written and depends on the branchless flag, so the cache key does too
  const keyOf = (c: Compiled) => (SHADER_FLAGS.branchless3D || SHADER_FLAGS.branchless ? "b" : "") + (c.solid ? "3|" : "2|") + c.code;
  const getPipeline = (c: Compiled): Promise<GPURenderPipeline> => {
    const k = keyOf(c);
    const hit = cache.get(k); if (hit) return Promise.resolve(hit);
    const p0 = pending.get(k); if (p0) return p0;
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
        // the line number is a line of the *generated* shader (preamble included), not of the
        // program: say so instead of subtracting a made-up constant that pointed at nonsense
        throw new Error("shader: " + (errs.length ? errs.map((m) => `${m.message} (${c.solid ? "solid" : "slice"} WGSL line ${m.lineNum})`).join("; ") : (e as Error).message));
      }
      const e = await device.popErrorScope(); if (e) throw new Error("shader: " + e.message);
      if (cache.size > 24) cache.delete(cache.keys().next().value!);
      cache.set(k, pipeline); stats.compiles++; stats.lastCompileMs = performance.now() - t0; stats.cached = cache.size;
      return pipeline;
    })();
    pending.set(k, p); p.finally(() => pending.delete(k)); return p;
  };

  let curScale = 1;
  const resize = (scale = curScale) => {
    curScale = scale;
    const dpr = Math.min(2, window.devicePixelRatio || 1) * scale;
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };
  resize();
  const ubuf = new Float32Array(24);
  let serial = 0;
  return {
    kind: "webgpu", adapterInfo: info, resize, stats,
    async render(prog, cam, bg, time, scale = 1, cam3) {
      const my = ++serial;
      const pipeline = await getPipeline(prog);
      if (my !== serial && !cache.has(keyOf(prog))) return; // superseded
      resize(scale);
      const dpr = canvas.width / Math.max(1, canvas.clientWidth);
      const c3 = cam3 ?? { tx: 0, ty: 0, tz: 0, dist: 14, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };
      if (prog.params.length > paramCap) makeParams(Math.max(prog.params.length, paramCap * 2));
      ubuf.set([canvas.clientWidth, canvas.clientHeight, time, 0, bg[0], bg[1], bg[2], 1, ATLAS_W, ATLAS_H, 8, dpr, cam.cx, cam.cy, cam.zoom, 0, c3.tx, c3.ty, c3.tz, c3.dist, c3.yaw, c3.pitch, Math.tan(c3.fov / 2), canvas.clientWidth / Math.max(1, canvas.clientHeight)]);
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

const HOME3: Camera3 = { tx: 0, ty: 0, tz: 0, dist: 14, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };

// shared 3D raymarcher (CPU path); `step`/`col` evaluate the generated body at a ray position
let nanCount = 0; // non-finite distances seen by march3 (mirrored into renderer stats.nan)
function march3(step: (q: number[]) => number, col: (q: number[]) => number[], ro: number[], rd: number[], e: number, bg: number[], far: number): number[] {
  const FAR = Math.max(400, far);   // mirrors the WGSL wrapper: a viewport-sized program sits ~1900 units out
  let tt = 0.02; let hit = false;
  for (let i = 0; i < 128; i++) {
    const dd = step([ro[0] + rd[0] * tt, ro[1] + rd[1] * tt, ro[2] + rd[2] * tt]);
    if (dd !== dd) { nanCount++; break; }   // non-finite distance: stop marching, paint background
    if (dd < 0.001) { hit = true; break; }
    if (dd > FAR) break;
    tt += Math.min(dd, FAR);
    if (tt > FAR) break;
  }
  if (!hit) return bg;
  return shade3(step, col, ro, rd, tt, e);
}
/** Shading for a ray that reached a surface at `tt` (shared by both marchers). */
function shade3(step: (q: number[]) => number, col: (q: number[]) => number[], ro: number[], rd: number[], tt: number, e: number): number[] {
  const ph = [ro[0] + rd[0] * tt, ro[1] + rd[1] * tt, ro[2] + rd[2] * tt];
  const nx = step([ph[0] + e, ph[1], ph[2]]) - step([ph[0] - e, ph[1], ph[2]]);
  const ny = step([ph[0], ph[1] + e, ph[2]]) - step([ph[0], ph[1] - e, ph[2]]);
  const nz = step([ph[0], ph[1], ph[2] + e]) - step([ph[0], ph[1], ph[2] - e]);
  const nl = Math.hypot(nx, ny, nz) || 1;
  const n = [nx / nl, ny / nl, nz / nl];
  const cc = col(ph);
  const l1 = [0.55, 0.8, 0.5], l2 = [-0.5, -0.25, -0.6];
  const n1 = Math.hypot(l1[0], l1[1], l1[2]), n2 = Math.hypot(l2[0], l2[1], l2[2]);
  const rim = Math.pow(1 - Math.max(0, Math.min(1, n[0] * -rd[0] + n[1] * -rd[1] + n[2] * -rd[2])), 3);
  const lum = 0.32 + 0.75 * Math.max(0, (n[0] * l1[0] + n[1] * l1[1] + n[2] * l1[2]) / n1) + 0.35 * Math.max(0, (n[0] * l2[0] + n[1] * l2[1] + n[2] * l2[2]) / n2) + 0.3 * rim;
  return [Math.min(1, cc[0] * lum) * 255, Math.min(1, cc[1] * lum) * 255, Math.min(1, cc[2] * lum) * 255];
}
/**
 * Branchless twin of `march3` (SHADER_FLAGS.branchless, mirroring the WGSL wrapper): no `if`, no
 * `break` — a `live` factor retires the ray, so all 128 steps run and the shading is computed for
 * every pixel and then discarded with a select.  Same pixels, no divergence, more work.
 */
function march3b(step: (q: number[]) => number, col: (q: number[]) => number[], ro: number[], rd: number[], e: number, bg: number[], far: number): number[] {
  const FAR = Math.max(400, far);
  let tt = 0.02, hit = 0, live = 1;
  for (let i = 0; i < 128; i++) {
    const dd = step([ro[0] + rd[0] * tt, ro[1] + rd[1] * tt, ro[2] + rd[2] * tt]);
    const bad = dd !== dd ? 1 : 0;                              // non-finite distance: retire
    const near = dd < 0.001 ? 1 : 0;
    const gone = dd > FAR || tt > FAR || bad ? 1 : 0;
    nanCount += bad * live;
    hit = hit + live * near;                                    // at most one: live drops to 0
    const adv = gone ? 0 : Math.min(dd, FAR);                   // select, not a 0 factor (0 * NaN)
    tt = tt + live * (1 - near) * adv;
    live = live * (1 - near) * (1 - gone);
  }
  const rgb = shade3(step, col, ro, rd, tt, e);
  return [hit ? rgb[0] : bg[0], hit ? rgb[1] : bg[1], hit ? rgb[2] : bg[2]];
}

function createCPU(canvas: HTMLCanvasElement, atlas: Atlas, fixedScale?: number): Renderer {
  const ctx2d = canvas.getContext("2d")!;
  const R = makeJSRuntime((u, v) => {
    const x = Math.min(ATLAS_W - 1, Math.max(0, Math.round(u * ATLAS_W - 0.5))), y = Math.min(ATLAS_H - 1, Math.max(0, Math.round(v * ATLAS_H - 0.5)));
    return atlas.data[y * ATLAS_W + x] / 255;
  });
  const cache = new Map<string, PixelFn>();
  const cache3 = new Map<string, { step: (P: Float32Array, T: number, q: number[]) => number; col: (P: Float32Array, T: number, q: number[]) => number[] }>();
  const stats = { compiles: 0, lastCompileMs: 0, cached: 0, gpuMs: 0, timestamps: false, nan: 0 };
  const compile3 = (c: Compiled) => {
    let f = cache3.get(c.code); if (f) return f;
    const t0 = performance.now();
    // the body may reference the frame's `zoom`/`T` free variables (child contexts inherit them);
    // in the solid view zoom is 1 (it only scales 2D AA/culling terms)
    const dist = new Function("P", "R", "zoom", "T", "q", `const p0 = q; ${c.code}; return ${c.d};`) as (P: Float32Array, R: unknown, zoom: number, T: number, q: number[]) => number;
    const col = new Function("P", "R", "zoom", "T", "q", `const p0 = q; ${c.code}; return ${c.c};`) as (P: Float32Array, R: unknown, zoom: number, T: number, q: number[]) => number[];
    f = { step: (P, T, q) => dist(P, R, 1, T, q), col: (P, T, q) => col(P, R, 1, T, q) };
    if (cache3.size > 24) cache3.delete(cache3.keys().next().value!);
    cache3.set(c.code, f); stats.compiles++; stats.lastCompileMs = performance.now() - t0;
    return f;
  };
  const compile = (c: Compiled): PixelFn => {
    let f = cache.get(c.code); if (f) return f;
    const t0 = performance.now();
    const body = `
      const zoom = cam.zoom;
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        // 3D-native body expects a vec3 point; the 2D view is the z = 0 slice
        const p0 = [((i + 0.5) / scale - RW * 0.5) / zoom + cam.cx, -((j + 0.5) / scale - RH * 0.5) / zoom + cam.cy, 0];
${c.code}
        // NaN guard: a single non-finite distance paints the pixel black and, worse, hides a
        // real bug in the field.  Count it and treat it as "far away" (background) instead.
        let d = ${c.d};
        if (d !== d) { d = 1e30; NAN.nan++; }
        const col = ${c.c};
        const aa = Math.min(1, Math.max(0, 0.5 - d * zoom)) * col[3];
        const q = (j * W + i) * 4;
        px[q] = (bg[0] + (col[0] - bg[0]) * aa) * 255; px[q + 1] = (bg[1] + (col[1] - bg[1]) * aa) * 255; px[q + 2] = (bg[2] + (col[2] - bg[2]) * aa) * 255; px[q + 3] = 255;
      }`;
    f = new Function("P", "R", "W", "H", "scale", "cam", "T", "bg", "px", "RW", "RH", "NAN", body) as unknown as PixelFn;
    const raw = f;
    f = (P, R2, W, H, scale, cam, T, bg, px) => (raw as unknown as (...a: unknown[]) => void)(P, R2, W, H, scale, cam, T, bg, px, W / scale, H / scale, stats);
    if (cache.size > 24) cache.delete(cache.keys().next().value!);
    cache.set(c.code, f); stats.compiles++; stats.lastCompileMs = performance.now() - t0; stats.cached = cache.size;
    return f;
  };
  const resize = () => {
    const w = Math.max(1, Math.floor(canvas.clientWidth)), h = Math.max(1, Math.floor(canvas.clientHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };
  resize();
  let scale = fixedScale ?? 0.5;   // 2D slice view
  let scale3 = fixedScale ?? 0.35; // 3D raymarch (much heavier: starts coarser)
  return {
    kind: "cpu", resize, stats,
    async render(prog, cam, bg, time, _scale, cam3) {
      resize();
      const W = canvas.width, H = canvas.height;
      const s = prog.solid ? scale3 : scale;
      const w = Math.max(1, Math.floor(W * s)), h = Math.max(1, Math.floor(H * s));
      const img = ctx2d.createImageData(w, h);
      const t0 = performance.now();
      if (prog.solid) {
        const c3 = cam3 ?? HOME3;
        const { step, col } = compile3(prog);
        const P = prog.params;
        const cy = Math.cos(c3.yaw), sy = Math.sin(c3.yaw), cp = Math.cos(c3.pitch), sp = Math.sin(c3.pitch);
        const ro = [c3.tx + c3.dist * sy * cp, c3.ty + c3.dist * sp, c3.tz + c3.dist * cy * cp];
        let fw = [c3.tx - ro[0], c3.ty - ro[1], c3.tz - ro[2]];
        const fl = Math.hypot(fw[0], fw[1], fw[2]) || 1; fw = [fw[0] / fl, fw[1] / fl, fw[2] / fl];
        const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        let r0 = cross(fw, [0, 1, 0]); const rl = Math.hypot(r0[0], r0[1], r0[2]) || 1; r0 = [r0[0] / rl, r0[1] / rl, r0[2] / rl];
        const upv = cross(r0, fw);
        const fovy = Math.tan(c3.fov / 2), asp = w / Math.max(1, h);
        const e = Math.max(0.0012, c3.dist * 0.0006);
        const bgpx = [bg[0] * 255, bg[1] * 255, bg[2] * 255];
        for (let j = 0; j < h; j++) {
          const ndy = -(((j + 0.5) - h * 0.5) / (h * 0.5));
          for (let i = 0; i < w; i++) {
            const ndx = ((i + 0.5) - w * 0.5) / (w * 0.5);
            const rd0 = [
              fw[0] + r0[0] * ndx * fovy * asp + upv[0] * ndy * fovy,
              fw[1] + r0[1] * ndx * fovy * asp + upv[1] * ndy * fovy,
              fw[2] + r0[2] * ndx * fovy * asp + upv[2] * ndy * fovy,
            ];
            const rl2 = Math.hypot(rd0[0], rd0[1], rd0[2]) || 1;
            const rd = [rd0[0] / rl2, rd0[1] / rl2, rd0[2] / rl2];
            const march = SHADER_FLAGS.branchless3D || SHADER_FLAGS.branchless ? march3b : march3;
            const rgb = march((q) => step(P, time, q), (q) => col(P, time, q), ro, rd, e, bgpx, c3.dist * 6);
            if (nanCount) { stats.nan += nanCount; nanCount = 0; }
            const q = (j * w + i) * 4;
            img.data[q] = rgb[0]; img.data[q + 1] = rgb[1]; img.data[q + 2] = rgb[2]; img.data[q + 3] = 255;
          }
        }
      } else {
        const f = compile(prog);
        f(prog.params, R, w, h, s, cam, time, bg, img.data);
      }
      const ms = performance.now() - t0;
      // adapt resolution to keep the CPU path interactive (pinned when the caller fixed the scale)
      if (fixedScale === undefined) {
        const cur = prog.solid ? scale3 : scale;
        const next = ms > 120 && cur > 0.2 ? Math.max(0.2, cur * 0.7) : ms < 30 && cur < 1 ? Math.min(1, cur * 1.25) : cur;
        if (prog.solid) scale3 = next; else scale = next;
      }
      const off = document.createElement("canvas"); off.width = w; off.height = h; off.getContext("2d")!.putImageData(img, 0, 0);
      ctx2d.imageSmoothingEnabled = true; ctx2d.drawImage(off, 0, 0, W, H);
    },
    destroy() { /* nothing */ },
  };
}
