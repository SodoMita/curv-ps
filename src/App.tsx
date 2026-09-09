import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Editor } from "./components/Editor";
import { SolverPanel } from "./components/SolverPanel";
import { Reference } from "./components/Reference";
import { ParamsPanel } from "./components/ParamsPanel";
import { EXAMPLES } from "./curv/examples";
import { Interp, compileTree, type CompiledTree, type SolveTrace, type ParamDesc } from "./curv/interp";
import { CurvError } from "./curv/parser";
import { bboxOf, bbox3Of, finiteBBox, type SNode } from "./curv/shapes";
import { buildAtlas, type Atlas } from "./gpu/atlas";
import { wrapWGSL, wrapJS, createRenderer, type Renderer, type Camera, type Camera3 } from "./gpu/renderer";
import { SHADER_FLAGS, flagsKey } from "./gpu/gen";
import { GenOptions, type GenFlags, type Census } from "./components/GenOptions";
import { Splitter } from "./components/Splitter";
import { loadPsolve } from "./psolve/psolve";
import { cn } from "./utils/cn";

// One world, one camera: ordinary Curv space (y up, origin at the centre).  Programs that
// read `viewport` are re-evaluated whenever the visible world rectangle changes.
const BG: Record<"light" | "dark", [number, number, number]> = { light: [0.965, 0.965, 0.975], dark: [0x0e / 255, 0x13 / 255, 0x22 / 255] };
type ParamValues = Record<string, number | boolean | number[]>;
type ViewMode = "2d" | "3d";
type PanelKey = "params" | "solver" | "gen";
const PANEL_TITLE: Record<PanelKey, string> = { params: "the parameters", solver: "the solver trace", gen: "the shader options" };
const HOME: Camera = { cx: 0, cy: 0, zoom: 1 };
const HOME3: Camera3 = { tx: 0, ty: 0, tz: 0, dist: 14, yaw: 0.65, pitch: 0.42, fov: (38 * Math.PI) / 180 };
const DEBOUNCE_MS = 100;
const FRAME_BUDGET_MS = 13;   // CPU (eval + params) + GPU render pass per animated frame, leaving headroom for the compositor
const GPU_BUDGET_MS = 8;      // upper bound of the render-pass budget the adaptive-resolution controller aims for
const MIN_GPU_BUDGET_MS = 2.5; // never squeeze the GPU below this, however slow the CPU side is
const MIN_QUALITY = 0.3;      // lowest render scale (0.3 → 9 % of the pixels)

export default function App() {
  const [exampleId, setExampleId] = useState(EXAMPLES[0].id);
  const [src, setSrc] = useState(EXAMPLES[0].src);
  const [error, setError] = useState<{ message: string; line?: number } | null>(null);
  const [traces, setTraces] = useState<SolveTrace[]>([]);
  const [params, setParams] = useState<ParamDesc[]>([]);
  const [paramValues, setParamValues] = useState<ParamValues>({});
  const [stats, setStats] = useState({ evalMs: 0, genMs: 0, fps: 0, compileMs: 0, lines: 0, compiles: 0, quality: 1, reused: false, gpuMs: 0, timestamps: false, memoHits: 0, memoCalls: 0, staticSkip: false });
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [rendererInfo, setRendererInfo] = useState<{ kind: string; info?: string } | null>(null);
  const [previewPct, setPreviewPct] = useState(100);
  const [showRef, setShowRef] = useState(false);
  const [debugBoxes, setDebugBoxes] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  const [showCode, setShowCode] = useState(false);
  // shader-generation options (SHADER_FLAGS); every flag is part of the structural key, so a change
  // recompiles and refills nothing else — but the static-skip fingerprint has to know about them
  const [gen, setGen] = useState<GenFlags>({ ...SHADER_FLAGS });
  const applyGen = useCallback((patch: Partial<GenFlags>) => {
    Object.assign(SHADER_FLAGS, patch);
    setGen((g) => ({ ...g, ...patch }));
    lastProg.current = null;      // force a fresh compile (the structural key already differs)
    staticCache.current = null;   // …and do not let the static-skip fingerprint answer instead
    dirty.current = true;
  }, []);
  const [code, setCode] = useState("");          // the generated body (feeds the branch census)
  const [whole, setWhole] = useState("");        // everything the backend compiles: body + wrapper
  const [codeView, setCodeView] = useState<"whole" | "body">("whole");
  const [paused, setPaused] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [responsive, setResponsive] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [camView, setCamView] = useState<Camera>(HOME);
  const [cam3View, setCam3View] = useState<Camera3>(HOME3);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const atlas = useRef<Atlas | null>(null);
  const srcRef = useRef(src);
  const dirty = useRef(true);
  const dynamic = useRef({ time: false, mouse: false, viewport: false });
  const shaderTimeOnly = useRef(false); // time is read only inside compiled shader code: animate by re-rendering, no re-evaluation
  // last static frame: a program that read no time/mouse/viewport whose src + parametric values + debug flag
  // are unchanged has no possible way to produce a different tree — evaluation and codegen are skipped wholesale
  const staticCache = useRef<{ fp: string } | null>(null);
  const mousePx = useRef({ x: -1e6, y: -1e6, down: false });
  const clock = useRef({ t0: performance.now(), pausedAt: 0 });
  const pausedRef = useRef(false);
  const lastUi = useRef(0);
  const frames = useRef({ n: 0, t: performance.now(), last: 0 });
  const debugRef = useRef(false);
  const bgRef = useRef<"light" | "dark">("light");
  const viewModeRef = useRef<ViewMode>("2d");
  const cam = useRef<Camera>({ ...HOME });
  const cam3 = useRef<Camera3>({ ...HOME3 });
  const needFit = useRef(true);
  const needFit3 = useRef(true);
  const paramRef = useRef<ParamValues>({});
  // 2D pan: one tracked pointer.  3D orbit: one pointer.  Pinch: two pointers (both views).
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const orbit = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const pinch = useRef<{ d0: number; id1: number; id2: number } | null>(null);
  const pinchCam = useRef<{ cx: number; cy: number; zoom: number; mx: number; my: number } | null>(null);
  const pinch3 = useRef<{ dist: number; yaw: number; pitch: number } | null>(null);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const rendering = useRef(false);
  const codeRef = useRef("");    // last body shown (also what the census counts)
  const wholeRef = useRef("");   // mode + body: the wrapper depends on the view mode, not just the body
  const quality = useRef(1); // adaptive render scale while animating
  const cpuMs = useRef(0);   // eval + params/codegen time of the last frame (feeds the GPU budget)
  const settle = useRef<number | null>(null);
  const lastProg = useRef<CompiledTree | null>(null); // structural-key cache: same tree shape → reuse shader, refill params only

  useEffect(() => { srcRef.current = src; }, [src]);
  useEffect(() => { debugRef.current = debugBoxes; dirty.current = true; }, [debugBoxes]);
  useEffect(() => { bgRef.current = bgMode; dirty.current = true; }, [bgMode]);
  useEffect(() => { paramRef.current = paramValues; dirty.current = true; }, [paramValues]);
  useEffect(() => { viewModeRef.current = viewMode; dirty.current = true; }, [viewMode]);

  // ---- 2D/3D view toggle: separate cameras, never rendered simultaneously (the compile mode +
  // pipeline are chosen per view, so only one is ever live)
  const setMode = useCallback((m: ViewMode) => {
    setViewMode(m);
    if (m === "3d") needFit3.current = true; else needFit.current = true;
    drag.current = orbit.current = pinch.current = null;
    pts.current.clear();
    dirty.current = true;
  }, []);
  const setCam3 = useCallback((c: Camera3) => {
    cam3.current = c; dirty.current = true;
    setCam3View((v) => (v.tx === c.tx && v.ty === c.ty && v.tz === c.tz && v.dist === c.dist && v.yaw === c.yaw && v.pitch === c.pitch ? v : c));
  }, []);

  // ---- error reporting: a bug report is only useful with the context that produced it, so the
  // copy button takes the error, the example, the view mode, the backend and the program
  const [copied, setCopied] = useState(false);
  const copyError = useCallback(async () => {
    if (!error) return;
    const text = [
      `curv-ps: error${error.line ? ` (line ${error.line})` : ""}: ${error.message}`,
      `example: ${exampleId} \u00b7 view: ${viewMode === "3d" ? "3d (solid raymarch)" : "2d (slice)"} \u00b7 renderer: ${rendererInfo?.kind ?? "unknown"}${rendererInfo?.info ? ` (${rendererInfo.info})` : ""}`,
      "",
      src,
    ].join("\n");
    let done = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); done = true; } } catch { /* denied or unavailable */ }
    if (!done) { // http (not https) or a denied permission: the textarea route still works
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { done = document.execCommand("copy"); } catch { /* nothing else to try */ }
      document.body.removeChild(ta);
    }
    setCopied(done);
    window.setTimeout(() => setCopied(false), 1400);
  }, [error, exampleId, viewMode, rendererInfo, src]);

  // ---- boot: psolve wasm + glyph atlas + renderer
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadPsolve();
        atlas.current = buildAtlas();
        if (!canvasRef.current || cancelled) return;
        const r = await createRenderer(canvasRef.current, atlas.current);
        if (cancelled) { r.destroy(); return; }
        renderer.current = r;
        setRendererInfo({ kind: r.kind, info: r.adapterInfo });
        setStatus("ready");
        dirty.current = true;
      } catch (e) {
        console.error(e); setStatus("failed");
        setError({ message: "Failed to initialise: " + (e as Error).message });
      }
    })();
    return () => { cancelled = true; renderer.current?.destroy(); };
  }, []);

  // ---- time (pausable)
  const now = () => (pausedRef.current ? clock.current.pausedAt : (performance.now() - clock.current.t0) / 1000);
  const togglePause = useCallback(() => {
    setPaused((p) => {
      const next = !p;
      if (next) clock.current.pausedAt = (performance.now() - clock.current.t0) / 1000;
      else clock.current.t0 = performance.now() - clock.current.pausedAt * 1000;
      pausedRef.current = next; dirty.current = true; return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.code === "Space" && tag !== "TEXTAREA" && tag !== "INPUT" && tag !== "SELECT") { e.preventDefault(); togglePause(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [togglePause]);

  // ---- world <-> screen
  const viewportOf = (W: number, H: number, c: Camera) => ({ x: c.cx - W / (2 * c.zoom), y: c.cy - H / (2 * c.zoom), w: W / c.zoom, h: H / c.zoom });
  const worldMouse = useCallback(() => {
    const cv = canvasRef.current!; const m = mousePx.current; const c = cam.current;
    // no pointer yet: report the middle of the view, not a far-away sentinel.  A program that
    // places geometry at the mouse (the constrained tooltip) would otherwise stretch its bbox to
    // ±1e6 and the one-shot camera fit would zoom out by six orders of magnitude.
    if (m.x < -1e5) return { x: c.cx, y: c.cy, down: false };
    return { x: (m.x - cv.clientWidth / 2) / c.zoom + c.cx, y: -(m.y - cv.clientHeight / 2) / c.zoom + c.cy, down: m.down };
  }, []);
  const setCam = useCallback((c: Camera) => {
    cam.current = c; dirty.current = true;
    setCamView((v) => (v.cx === c.cx && v.cy === c.cy && v.zoom === c.zoom ? v : c));
  }, []);

  // ---- one evaluation + render
  const evaluate = useCallback((force = false) => {
    const cv = canvasRef.current, r = renderer.current, at = atlas.current;
    if (!cv || !r || !at) return;
    const tStart = performance.now();
    const W = cv.clientWidth, H = cv.clientHeight;
    const time = now();
    const solid = viewModeRef.current === "3d";
    const paint = (prog: CompiledTree, q: number, updateCode: boolean) => {
      if (!rendering.current) {
        rendering.current = true;
        r.render({ ...prog, solid }, cam.current, BG[bgRef.current], time, q, solid ? cam3.current : undefined)
          .then(() => {
            rendering.current = false;
            if (updateCode && prog.code !== codeRef.current) {
              codeRef.current = prog.code;
              setCode(prog.code);
            }
            // the body alone is the middle of the file: the panel should show the shader/module the
            // backend actually compiles (uniforms, entry point, raymarch loop and all).  A shape whose
            // two bodies are identical (a plain `circle`) still has two different wrappers, hence the
            // mode in the key.
            const wk = (solid ? "3|" : "2|") + prog.code;
            if (updateCode && wk !== wholeRef.current) {
              wholeRef.current = wk;
              setWhole(r.kind === "webgpu" ? wrapWGSL({ ...prog, solid }) : wrapJS({ ...prog, solid }));
            }
          })
          .catch((e: Error) => { rendering.current = false; setError({ message: e.message }); });
      } else dirty.current = true; // shader still compiling: try again next frame
      if (q < 1) { // re-render at full quality once things settle (only useful while not animating through the CPU)
        if (settle.current) clearTimeout(settle.current);
        settle.current = window.setTimeout(() => { if (!(dynamic.current.time && !pausedRef.current)) dirty.current = true; }, 180);
      }
    };
    // everything below except the camera is a program input; the camera/screen size are render uniforms only
    const fp = srcRef.current + "\u0001" + JSON.stringify(paramRef.current) + "\u0001" + debugRef.current + "\u0001" + (solid ? "3d" : "2d") + "\u0001" + flagsKey();
    const sk = staticCache.current, prog0 = lastProg.current;
    const needFitNow = solid ? needFit3.current : needFit.current;
    if (sk && sk.fp === fp && prog0 && !needFitNow) {
      // static program, unchanged inputs: re-render the existing program, nothing else to do
      cpuMs.current = 0;
      paint(prog0, drag.current ? quality.current : 1, prog0.code !== codeRef.current);
      if (force || tStart - lastUi.current > 250) {
        lastUi.current = tStart;
        setStats((st) => ({ ...st, evalMs: performance.now() - tStart, genMs: 0, quality: drag.current ? quality.current : 1, reused: true, gpuMs: r.stats.gpuMs, timestamps: r.stats.timestamps, memoHits: 0, memoCalls: 0, staticSkip: true }));
      }
      return;
    }
    const inputs = { viewport: viewportOf(W, H, cam.current), time, mouse: worldMouse(), params: paramRef.current };
    const it = new Interp(at, inputs);
    staticCache.current = null; // re-evaluating: the cache describes the last successful run, refreshed below
    try {
      let res = it.run(srcRef.current);
      // camera: responsive programs start at 1 unit = 1 px around the origin, everything else is fitted once
      if (needFit.current && !solid) {
        needFit.current = false;
        if (res.usesViewport && (cam.current.cx !== 0 || cam.current.cy !== 0 || cam.current.zoom !== 1)) {
          const c = { ...HOME };
          cam.current = c; setCamView(c); // re-evaluate once with the home viewport (run() is idempotent)
          inputs.viewport = { x: -W / 2, y: -H / 2, w: W, h: H };
          res = it.run(srcRef.current);
        } else if (!res.usesViewport) {
          const raw = res.shape ?? { k: "nothing" as const };
          const bb = finiteBBox(bboxOf(raw, at)) ?? [-10, -10, 10, 10];
          const zoom = 0.85 * Math.min(W / Math.max(bb[2] - bb[0], 1e-6), H / Math.max(bb[3] - bb[1], 1e-6));
          const c = { cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1 };
          cam.current = c; setCamView(c);
        }
      } else if (needFit3.current && solid) {
        needFit3.current = false;
        if (!res.usesViewport) {
          const raw = res.shape ?? { k: "nothing" as const };
          const bb3 = finiteBBox3(bbox3Of(raw, at)) ?? [-1, -1, -1, 1, 1, 1];
          const tx = (bb3[0] + bb3[3]) / 2, ty = (bb3[1] + bb3[4]) / 2, tz = (bb3[2] + bb3[5]) / 2;
          const extent = Math.max(bb3[3] - bb3[0], bb3[4] - bb3[1], bb3[5] - bb3[2], 1) / 2;
          // frame the whole bounding box in the fov, with 1.5× headroom
          const dist = Math.max(0.5, (extent / Math.tan(HOME3.fov / 2)) * 1.5);
          const c = { tx, ty, tz, dist, yaw: HOME3.yaw, pitch: HOME3.pitch, fov: HOME3.fov };
          cam3.current = c; setCam3View(c);
        }
      }
      let node: SNode = res.shape ?? { k: "nothing" };
      if (debugRef.current) {
        const kids: SNode[] = [node];
        const th = 1.5; // constant world units: the overlay must not change when the camera zooms (else the skip cache would be invalid)
        for (const t of res.traces) for (const b of t.boxes)
          kids.push({ k: "xform", tx: b.x + b.w / 2, ty: b.y + b.h / 2, rot: 0, sc: 1, s: { k: "colour", c: [0.96, 0.45, 0.71, 0.9], s: { k: "stroke", w: th, s: { k: "rect", w: b.w, h: b.h, r: 0 } } } });
        node = { k: "union", kids };
      }
      const t1 = performance.now();
      const prog = compileTree(node, at, r.kind === "webgpu" ? "wgsl" : "js", lastProg.current, undefined, solid ? "solid" : "slice");
      lastProg.current = prog;
      const t2 = performance.now();
      cpuMs.current = t2 - tStart;
      const usesTime = res.usesTime || prog.usesTime; // evaluator-side time, or time read inside compiled shader code
      dynamic.current = { time: usesTime, mouse: res.usesMouse, viewport: res.usesViewport };
      shaderTimeOnly.current = prog.usesTime && !res.usesTime;
      if (!usesTime && !res.usesMouse && !res.usesViewport) staticCache.current = { fp };
      const animating = usesTime && !pausedRef.current;
      const q = animating || drag.current ? quality.current : 1;
      paint(prog, q, true);
      if (force || !animating || tStart - lastUi.current > 250) {
        lastUi.current = tStart;
        setTraces(res.traces); setParams(res.params); setError(null); setAnimated(usesTime); setResponsive(res.usesViewport);
        setStats((s) => ({ ...s, evalMs: t1 - tStart, genMs: t2 - t1, compileMs: r.stats.lastCompileMs, lines: prog.code.split("\n").length, compiles: r.stats.compiles, quality: q, reused: prog.reused, gpuMs: r.stats.gpuMs, timestamps: r.stats.timestamps, memoHits: res.callMemo.hits, memoCalls: res.callMemo.hits + res.callMemo.misses, staticSkip: false }));
      }
    } catch (e) {
      const err = e as CurvError;
      setError({ message: err.message, line: err instanceof CurvError ? err.line : undefined });
      setTraces(it.traces); setParams(it.params);
      dynamic.current = { time: false, mouse: false, viewport: it.usesViewport };
      shaderTimeOnly.current = false;
    }
  }, [worldMouse]);

  // ---- frame loop (only does work when something changed or the program animates)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (status !== "ready") return;
      const animating = dynamic.current.time && !pausedRef.current;
      if (dirty.current || animating) {
        const t = performance.now();
        const f = frames.current;
        if (animating && f.last) { // adaptive quality: GPU timestamps when available, otherwise rAF pacing
          const dt = t - f.last, gpu = renderer.current?.stats.gpuMs ?? 0, q = quality.current;
          if (gpu > 0) {
            // Budget controller: render-pass cost scales with pixel count (∝ q²), so the scale that
            // would hit the budget exactly is q·sqrt(budget / gpu).  Move part of the way there each
            // frame, with a dead band around the budget so a stable program does not oscillate.
            // The GPU budget is whatever the frame budget leaves after the CPU side (eval + params).
            const budget = Math.min(GPU_BUDGET_MS, Math.max(MIN_GPU_BUDGET_MS, FRAME_BUDGET_MS - cpuMs.current));
            const target = q * Math.sqrt(budget / Math.max(gpu, 0.1));
            const inBand = gpu > budget * 0.7 && gpu < budget * 1.15;
            if (!inBand || dt > 34) quality.current = Math.min(1, Math.max(MIN_QUALITY, q + (Math.min(target, dt > 34 ? q * 0.9 : 1) - q) * 0.35));
          } else { // no timestamp-query feature: rAF pacing heuristic
            if (dt > 24 && q > MIN_QUALITY) quality.current = Math.max(MIN_QUALITY, q * 0.85);
            else if (dt < 13 && q < 1) quality.current = Math.min(1, q * 1.08);
          }
        }
        f.last = animating ? t : 0;
        const wasDirty = dirty.current; dirty.current = false;
        if (!wasDirty && shaderTimeOnly.current && lastProg.current && renderer.current && !rendering.current) {
          // the tree cannot change between frames: just draw it again with the new time uniform
          const r = renderer.current; rendering.current = true; cpuMs.current = 0;
          const solid = viewModeRef.current === "3d";
          r.render({ ...lastProg.current, solid }, cam.current, BG[bgRef.current], now(), quality.current, solid ? cam3.current : undefined)
            .then(() => { rendering.current = false; }).catch((e: Error) => { rendering.current = false; setError({ message: e.message }); });
        } else evaluate(wasDirty);
        f.n++;
        if (t - f.t > 1000) { const fps = animating ? (f.n * 1000) / (t - f.t) : 0; setStats((s) => (s.fps === fps ? s : { ...s, fps })); f.n = 0; f.t = t; }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, evaluate]);

  // ---- source changes (debounced), resize
  useEffect(() => { const h = setTimeout(() => { dirty.current = true; }, DEBOUNCE_MS); return () => clearTimeout(h); }, [src]);
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const ro = new ResizeObserver(() => {
      renderer.current?.resize(); dirty.current = true;
      setBottomPx((px) => (px === null ? null : Math.min(px, Math.max(120, window.innerHeight - 160))));
      setLeftPx((px) => (px === null ? null : clampLeft(px)));
    });
    ro.observe(cv); return () => ro.disconnect();
  }, []);

  // ---- pointer: mouse input (world units) + gestures.
  // 2D: one finger/mouse pans, two pinch-zoom (the world point under the initial midpoint stays fixed).
  // 3D: one finger/mouse orbits, two pinch-zoom (camera distance).
  const setMouse = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mousePx.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, down: e.buttons > 0 };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setMouse(e); e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    pts.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (pts.current.size === 2) {
      // second finger landed: switch from pan/orbit to pinch
      const [a, b] = [...pts.current.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pinch.current = { d0, id1: e.pointerId, id2: e.pointerId };
      if (viewModeRef.current === "3d") {
        pinch3.current = { dist: cam3.current.dist, yaw: cam3.current.yaw, pitch: cam3.current.pitch };
        orbit.current = null;
      } else {
        pinchCam.current = { cx: cam.current.cx, cy: cam.current.cy, zoom: cam.current.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag.current = null;
      }
    } else if (viewModeRef.current === "3d") {
      orbit.current = { x: e.clientX, y: e.clientY, yaw: cam3.current.yaw, pitch: cam3.current.pitch };
    } else {
      drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.cx, cy: cam.current.cy };
    }
    if (dynamic.current.mouse) dirty.current = true;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setMouse(e);
    const cv = e.currentTarget; const rect = cv.getBoundingClientRect();
    if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    if (viewModeRef.current === "3d") {
      if (pinch.current && pts.current.size === 2 && pinch3.current) {
        const [a, b] = [...pts.current.values()];
        const d1 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const dist = Math.min(1e4, Math.max(0.05, pinch3.current.dist * (pinch.current.d0 / d1)));
        setCam3({ ...cam3.current, dist });
      } else if (orbit.current && pts.current.size === 1 && e.buttons > 0) {
        const c3 = cam3.current; const o = orbit.current;
        setCam3({ ...c3, yaw: o.yaw + (e.clientX - o.x) * 0.006, pitch: Math.min(1.55, Math.max(-1.55, o.pitch + (e.clientY - o.y) * 0.006)) });
      } else if (dynamic.current.mouse) dirty.current = true;
    } else {
      if (pinch.current && pts.current.size === 2 && pinchCam.current) {
        const [a, b] = [...pts.current.values()];
        const d1 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const z = pinchCam.current;
        const zoom = Math.min(1e6, Math.max(1e-6, z.zoom * (d1 / pinch.current.d0)));
        const mx = z.mx - cv.clientWidth / 2, my = z.my - cv.clientHeight / 2;
        // keep the world point under the initial pinch midpoint fixed while zooming
        setCam({ cx: z.cx + mx / z.zoom - mx / zoom, cy: z.cy - my / z.zoom + my / zoom, zoom });
      } else if (drag.current && pts.current.size === 1 && e.buttons > 0) {
        const c = cam.current; const d = drag.current;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 2) setCam({ ...c, cx: d.cx - (e.clientX - d.x) / c.zoom, cy: d.cy + (e.clientY - d.y) / c.zoom });
      } else if (dynamic.current.mouse) dirty.current = true;
    }
  };
  const endPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pts.current.delete(e.pointerId);
    if (pinch.current && pts.current.size < 2) { pinch.current = null; pinchCam.current = null; pinch3.current = null; }
    if (pts.current.size === 1) {
      // re-anchor the surviving finger so pan/orbit continues without a jump
      const [a] = [...pts.current.values()];
      const rect = e.currentTarget.getBoundingClientRect();
      if (viewModeRef.current === "3d") orbit.current = { x: a.x + rect.left, y: a.y + rect.top, yaw: cam3.current.yaw, pitch: cam3.current.pitch };
      else drag.current = { x: a.x + rect.left, y: a.y + rect.top, cx: cam.current.cx, cy: cam.current.cy };
    } else if (pts.current.size === 0) { drag.current = null; orbit.current = null; }
    dirty.current = true;
  };
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (viewModeRef.current === "3d") {
        const c3 = cam3.current;
        setCam3({ ...c3, dist: Math.min(1e4, Math.max(0.05, c3.dist * Math.exp(e.deltaY * 0.0012))) });
        return;
      }
      const rect = cv.getBoundingClientRect(); const mx = e.clientX - rect.left - cv.clientWidth / 2, my = e.clientY - rect.top - cv.clientHeight / 2;
      const c = cam.current; const k = Math.exp(-e.deltaY * 0.0015);
      const zoom = Math.min(1e6, Math.max(1e-6, c.zoom * k));
      setCam({ cx: c.cx + mx / c.zoom - mx / zoom, cy: c.cy - my / c.zoom + my / zoom, zoom });
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [setCam, setCam3]);

  const loadExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)!; setExampleId(id); setSrc(ex.src); setParamValues({});
    clock.current = { t0: performance.now(), pausedAt: 0 }; needFit.current = true; needFit3.current = true; quality.current = 1;
    setMode(ex.group === "3d" ? "3d" : "2d"); // 3D examples open in the solid view
  };
  const example = EXAMPLES.find((e) => e.id === exampleId);
  // branch census of the last compiled shader body (the 3D wrapper adds its own 4 ifs / 3 breaks)
  const census: Census = useMemo(() => {
    const strip = code.replace(/\/\/[^\n]*/g, "");
    return { lines: code ? code.split("\n").length : 0, ifs: (strip.match(/\bif\s*\(/g) ?? []).length, brks: (strip.match(/\bbreak\b|\bcontinue\b/g) ?? []).length, logic: (strip.match(/&&|\|\|/g) ?? []).length, loops: (strip.match(/\bfor\s*\(/g) ?? []).length };
  }, [code]);
  // The bottom row always holds the shader-generation panel; the params and solver panels join it when
  // the program has parameters or solve blocks.  They stack, each at the full width of the row: three
  // of them side by side were three narrow tables.  Any of the three folds to a labelled bar.
  const [folded, setFolded] = useState({ params: false, solver: false, gen: false });
  const fold = (k: PanelKey) => setFolded((f) => ({ ...f, [k]: !f[k] }));
  const vis: PanelKey[] = [params.length ? "params" : null, traces.length ? "solver" : null, "gen"].filter(Boolean) as PanelKey[];
  // a folded panel is a bar (auto); an open one takes a share of the row — and that share is exactly
  // what the seam between two open panels trades
  const [frs, setFrs] = useState<Record<PanelKey, number>>({ params: 1, solver: 1, gen: 1 });
  const frsRef = useRef(frs); frsRef.current = frs;
  const rows = vis.map((k) => (folded[k] ? "auto" : `minmax(0,${frs[k]}fr)`)).join(" ");
  const openCount = vis.filter((k) => !folded[k]).length;
  // The row grows with what is open (a percentage of the preview column, with a floor so a landscape
  // window cannot squeeze the panels down to a title bar), and it can be dragged: the splitter hands
  // the height over to the pointer, double-click gives it back to the layout.
  const [bottomPx, setBottomPx] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const splitSt = useRef(0);
  const rowH = openCount === 0 ? "auto"
    : bottomPx !== null ? `${bottomPx}px`
    : openCount === 1 ? "minmax(min(150px,50%),32%)"
    : openCount === 2 ? "minmax(min(230px,55%),44%)"
    : "minmax(min(320px,60%),54%)";

  // ---- draggable edges.  Every seam between two regions is a Splitter: it reports a pixel delta from
  // where the drag started, and these handlers decide what that means.  Each keeps a floor so no region
  // can be dragged out of existence, and each hands its size back to the layout when it is reset.
  const PANEL_MIN = 44;   // a folded bar is ~18px: never let a drag take a panel below two of those
  const panelEl = useRef<Partial<Record<PanelKey, HTMLDivElement | null>>>({});
  const pairSt = useRef<{ a: PanelKey; b: PanelKey; ha: number; hb: number; fa: number; fb: number } | null>(null);
  const beginPair = (a: PanelKey, b: PanelKey) => {
    const ea = panelEl.current[a], eb = panelEl.current[b]; if (!ea || !eb) return;
    pairSt.current = { a, b, ha: ea.getBoundingClientRect().height, hb: eb.getBoundingClientRect().height, fa: frsRef.current[a], fb: frsRef.current[b] };
  };
  const movePair = (dy: number) => {
    const st = pairSt.current; if (!st || st.ha <= 0 || st.hb <= 0) return;
    // the two neighbours trade height; the pair's total is unchanged, so the other panels never move
    const total = st.ha + st.hb;
    if (total < PANEL_MIN * 2) return;                    // nothing sensible to trade
    const na = Math.max(PANEL_MIN, Math.min(total - PANEL_MIN, st.ha + dy));
    const nb = total - na;
    // fr units are proportional to heights, so scaling each by its own growth leaves the sum put
    const fa = Math.max(0.02, st.fa * (na / st.ha)), fb = Math.max(0.02, st.fb * (nb / st.hb));
    setFrs((f) => ({ ...f, [st.a]: fa, [st.b]: fb }));
  };
  const resetPair = (a: PanelKey, b: PanelKey) => setFrs((f) => ({ ...f, [a]: 1, [b]: 1 }));

  // editor column | preview column
  const [leftPx, setLeftPx] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const leftColRef = useRef<HTMLElement>(null);
  const leftSt = useRef(0);
  const clampLeft = (px: number) => {
    const w = bodyRef.current?.clientWidth ?? window.innerWidth;
    return Math.max(280, Math.min(px, Math.max(280, w - 360)));
  };

  // reference drawer (the bottom of the page)
  const [refPx, setRefPx] = useState<number | null>(null);
  const refRef = useRef<HTMLDivElement>(null);
  const refSt = useRef(0);

  // the code view floats over the canvas: its bottom edge is draggable, so it can be made short
  // enough to keep an eye on the picture it is describing
  const [codeH, setCodeH] = useState<number | null>(null);
  const codePanelRef = useRef<HTMLDivElement>(null);
  const codeBoxRef = useRef<HTMLDivElement>(null);
  const codeSt = useRef({ h: 0, max: 0 });
  const fmtZoom = (z: number) => (z >= 100 ? z.toFixed(0) : z >= 1 ? z.toFixed(z >= 10 ? 1 : 2) : z.toPrecision(2));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface/70 px-3 py-2 backdrop-blur sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-accent to-accent-2 font-mono text-[13px] font-bold text-white shadow-lg shadow-accent/30">C⁺</div>
          <div className="min-w-0 leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">Curv<sup className="text-accent-2">+solve</sup></div>
            <div className="hidden truncate text-[10.5px] text-muted md:block">F-Rep in the browser · Curv programs compiled to WGSL · <span className="font-mono">solve {"{ }"}</span> constraints via psolve</div>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5 text-[11px]">
          <Badge dot={status === "ready" ? "ok" : status === "failed" ? "bad" : "wait"}>
            <span className="hidden sm:inline">psolve wasm · </span>{status === "ready" ? "LP + QP" : status}
          </Badge>
          <Badge dot={rendererInfo?.kind === "webgpu" ? "ok" : rendererInfo ? "warn" : "wait"}>
            <span className="max-w-[40vw] truncate sm:max-w-[260px]">{rendererInfo ? (rendererInfo.kind === "webgpu" ? rendererInfo.info ?? "WebGPU" : "CPU fallback (no WebGPU)") : "renderer…"}</span>
          </Badge>
          <button onClick={() => setShowRef((s) => !s)} className={cn("rounded-md border border-line px-2.5 py-1 hover:bg-surface-2", showRef && "bg-surface-3 text-white")}>Reference</button>
        </div>
      </header>

      {/* body */}
      <div ref={bodyRef} className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[var(--left)_5px_minmax(0,1fr)] lg:overflow-hidden"
        style={{ "--left": leftPx === null ? "minmax(360px,42%)" : `${leftPx}px` } as React.CSSProperties}>
        {/* left: examples + editor */}
        <section ref={leftColRef} className="flex min-h-[70vh] flex-col border-b border-line lg:min-h-0 lg:border-r lg:border-b-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Example</label>
            <select value={exampleId} onChange={(e) => loadExample(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent">
              <optgroup label="Curv + solve { } (constraints)">
                {EXAMPLES.filter((e) => e.group === "solve").map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
              </optgroup>
              <optgroup label="3D (solid raymarch)">
                {EXAMPLES.filter((e) => e.group === "3d").map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
              </optgroup>
              <optgroup label="Original curv/examples">
                {EXAMPLES.filter((e) => e.group === "curv").map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
              </optgroup>
            </select>
            <button onClick={() => loadExample(exampleId)} title="Reload example source" className="rounded-md border border-line px-2 py-1 text-[11px] text-muted hover:bg-surface-2">reset</button>
          </div>
          {example && <div className="border-b border-line px-4 py-2 text-[11.5px] text-muted">{example.blurb}</div>}
          <div className="min-h-0 flex-1 bg-ink">
            <Editor value={src} onChange={setSrc} errorLine={error?.line} />
          </div>
          <div className={cn("shrink-0 border-t border-line px-4 py-2 font-mono text-[11.5px]", error ? "bg-rose-500/10 text-rose-300" : "text-muted")}>
            {error
              ? <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1"><span className="font-semibold">error</span>{error.line ? ` (line ${error.line})` : ""}: {error.message}</span>
                  <button onClick={copyError} title="Copy the error, the view/backend it happened on, and the program — everything a bug report needs"
                    className={cn("shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors", copied ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-200" : "border-rose-400/40 text-rose-200 hover:bg-rose-400/15")}>
                    {copied ? "copied" : "copy"}
                  </button>
                </div>
              : <>✓ {src.split("\n").length} lines · eval {stats.evalMs.toFixed(1)} ms{stats.staticSkip ? <span className="text-emerald-300/90" title="The program read no time/mouse/viewport on its last evaluation and its src and parametric inputs are unchanged: the tree cannot differ, so evaluation and codegen were skipped entirely (the camera is a render uniform)"> · static</span> : ""}{stats.memoCalls > 0 ? <span title="Calls of pure user functions answered from the call memo (same function, same arguments and free variables as an earlier evaluation) / calls that were expensive enough to be memoised">{` (${stats.memoHits}/${stats.memoCalls} memo)`}</span> : ""} · {stats.reused ? <span title="Shape tree structure unchanged: shader reused, only the parameter buffer was refilled">params {stats.genMs.toFixed(1)} ms</span> : <>codegen {stats.genMs.toFixed(1)} ms</>} · shader {stats.lines} lines{stats.compiles ? ` · ${stats.compiles} compile${stats.compiles > 1 ? "s" : ""} (last ${stats.compileMs.toFixed(0)} ms)` : ""}{stats.fps > 0 ? ` · ${stats.fps.toFixed(0)} fps` : ""}{stats.timestamps && stats.gpuMs > 0 ? <span title="GPU render-pass time (WebGPU timestamp query)">{` · gpu ${stats.gpuMs.toFixed(1)} ms`}</span> : ""}{stats.quality < 1 ? ` · ${Math.round(stats.quality * 100)}% res` : ""}</>}
          </div>
        </section>

        {/* the seam between the editor column and the preview column (stacked below lg, where there is
            nothing to drag: the splitter is display:none there, so it never takes a grid cell) */}
        <Splitter dir="col" className="hidden w-[5px] lg:block"
          title="Drag to give the editor or the preview more width · double-click to hand it back to the layout"
          onBegin={() => { leftSt.current = leftColRef.current?.getBoundingClientRect().width ?? 0; }}
          onMove={(d) => setLeftPx(clampLeft(leftSt.current + d))}
          onReset={() => setLeftPx(null)} />

        {/* right: preview + panels (first on mobile so the canvas is what you see and touch) */}
        <section className={cn("order-first grid min-h-[80vh] lg:order-none lg:min-h-0", `grid-rows-[minmax(0,1fr)_5px_${rowH}]`)}>
          <div className="flex min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-3 py-2 text-[11px] text-muted sm:px-4">
              <span className="font-semibold uppercase tracking-[0.14em]">Preview</span>
              <div className="flex overflow-hidden rounded-md border border-line" title="Slice view (2D) vs solid raymarched view (3D) — separate cameras, one active at a time">
                <button onClick={() => setMode("2d")} className={cn("px-2 py-0.5 font-mono transition-colors", viewMode === "2d" ? "bg-accent/80 text-white" : "hover:bg-surface-2")}>2D</button>
                <button onClick={() => setMode("3d")} className={cn("px-2 py-0.5 font-mono transition-colors", viewMode === "3d" ? "bg-accent-2/80 text-white" : "hover:bg-surface-2")}>3D</button>
              </div>
              <button onClick={togglePause} disabled={!animated} title="Pause / resume animation (space)"
                className={cn("flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono", animated ? (paused ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : "border-line text-fg hover:bg-surface-2") : "border-line/50 text-muted/50")}>
                {paused ? <><Icon d="M8 5v14l11-7z" /> resume</> : <><Icon d="M6 5h4v14H6zm8 0h4v14h-4z" /> pause</>}
              </button>
              <button onClick={() => { (viewMode === "3d" ? needFit3 : needFit).current = true; dirty.current = true; }} title={viewMode === "3d" ? "Fit the solid in view" : "Fit the shape (or reset the viewport to 1 unit = 1 px)"} className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-2">{responsive ? "home" : "fit"}</button>
              {viewMode === "3d"
                ? <span className="hidden font-mono xl:inline" title="orbit target · distance">({fmtNum(cam3View.tx)}, {fmtNum(cam3View.ty)}, {fmtNum(cam3View.tz)}) · {fmtZoom(cam3View.dist)} away</span>
                : <span className="hidden font-mono xl:inline" title="camera centre · zoom (px per unit)">({fmtNum(camView.cx)}, {fmtNum(camView.cy)}) · {fmtZoom(camView.zoom)}×</span>}
              <span className="hidden 2xl:inline">{viewMode === "3d" ? "drag to orbit · wheel or pinch to zoom" : `y up · drag to pan · wheel or pinch to zoom${responsive ? " · re-solves on viewport change" : ""}`}</span>
              <label className="ml-auto flex items-center gap-2">
                <span className="hidden sm:inline">width</span>
                <input type="range" min={35} max={100} value={previewPct} onChange={(e) => setPreviewPct(+e.target.value)} className="w-20 accent-[#7c5cff] sm:w-32" />
                <span className="w-9 font-mono">{previewPct}%</span>
              </label>
              <button onClick={() => setBgMode((m) => (m === "light" ? "dark" : "light"))} title="Background" className="rounded-md border border-line px-2 py-0.5 font-mono hover:bg-surface-2">{bgMode === "light" ? "☼ light" : "☾ dark"}</button>
              {/* the pink rectangles: a debug overlay that draws the boxes `solve` computed.  It is
                  not an optimisation (it adds shapes, so it costs a little) — hence the name. */}
              <label title="Debug overlay — draws the boxes the solver computed as pink outlines on top of the picture. This is a drawing aid for `solve { }` blocks, NOT an optimisation: it adds shapes, so it costs a little performance."
                className={cn("flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 transition-colors",
                  debugBoxes ? "border-[#ff73b5]/50 bg-[#ff73b5]/10 text-[#ff73b5]" : "border-line/60 hover:bg-surface-2")}>
                <input type="checkbox" checked={debugBoxes} onChange={(e) => setDebugBoxes(e.target.checked)} className={cn(debugBoxes ? "accent-[#ff73b5]" : "accent-[#7c5cff]")} />debug boxes</label>
              <button onClick={() => setShowCode((s) => !s)} className={cn("rounded-md border border-line px-2 py-0.5 hover:bg-surface-2", showCode && "bg-surface-3 text-fg")}>{renderer.current?.kind === "cpu" ? "JS" : "WGSL"}</button>
            </div>
            <div ref={codeBoxRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#0e1322] p-3 sm:p-4"
              style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #1d2537 1px, transparent 0)", backgroundSize: "20px 20px" }}>
              <div className="mx-auto h-full transition-[width] duration-150" style={{ width: `${previewPct}%` }}>
                <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer}
                  onPointerCancel={endPointer}
                  onPointerLeave={() => { if (pts.current.size === 0) { mousePx.current = { x: -1e6, y: -1e6, down: false }; if (dynamic.current.mouse) dirty.current = true; } }}
                  className="block h-full w-full cursor-grab touch-none rounded-xl border border-line shadow-2xl shadow-black/50 active:cursor-grabbing" />
              </div>
              {paused && <div className="pointer-events-none absolute left-6 top-6 rounded-md border border-amber-400/40 bg-ink/80 px-2 py-0.5 font-mono text-[11px] text-amber-200">paused · t = {clock.current.pausedAt.toFixed(2)} s</div>}
              {status !== "ready" && (
                <div className="absolute inset-0 grid place-items-center bg-ink/70 text-sm text-muted">
                  {status === "failed" ? "Initialisation failed — see error" : "Loading psolve.wasm & building glyph atlas…"}
                </div>
              )}
              {showCode && (
                <div ref={codePanelRef} style={{ bottom: codeH ?? undefined }}
                  className={cn("absolute left-3 right-3 top-3 sm:left-4 sm:right-4 sm:top-4", codeH === null && "bottom-3 sm:bottom-4")}>
                <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-ink/95">
                  <div className="flex items-center gap-2 border-b border-line px-3 py-1 font-mono text-[10.5px] text-muted">
                    <span className="text-fg">{renderer.current?.kind === "cpu" ? "JS · CPU fallback" : "WGSL"}</span>
                    <div className="flex overflow-hidden rounded border border-line">
                      {(["whole", "body"] as const).map((v) => (
                        <button key={v} onClick={() => setCodeView(v)}
                          title={v === "whole" ? "Everything the backend compiles — uniforms, entry point and the 3D raymarch loop included" : "Just the generated body: the straight-line distance/colour code for this program"}
                          className={cn("px-1.5 py-0.5 transition-colors", codeView === v ? "bg-accent/80 text-white" : "hover:bg-surface-2")}>{v}</button>
                      ))}
                    </div>
                    <span className="ml-auto">{((codeView === "whole" ? whole : code) || "").split("\n").length} lines</span>
                  </div>
                  <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[10.5px] leading-snug text-fg/80">{(codeView === "whole" ? whole : code) || "// nothing compiled yet"}</pre>
                </div>
                <Splitter dir="row" variant="overlay" className="-bottom-[4px] left-0 right-0 h-[8px]"
                  title="Drag to give the code view more or less height · double-click to hand it back to the layout"
                  onBegin={() => { codeSt.current = { h: codePanelRef.current?.getBoundingClientRect().height ?? 0, max: Math.max(140, (codeBoxRef.current?.clientHeight ?? 600) - 40) }; }}
                  onMove={(d) => setCodeH(Math.max(120, Math.min(codeSt.current.max, codeSt.current.h + d)))}
                  onReset={() => setCodeH(null)} />
                </div>
              )}
            </div>
          </div>
          <Splitter dir="row" className="h-[5px]"
            title="Drag to give the panels more or less height · double-click to hand it back to the layout"
            onBegin={() => { splitSt.current = bottomRef.current?.getBoundingClientRect().height ?? 0; }}
            onMove={(d) => setBottomPx(Math.max(60, Math.min(Math.max(120, window.innerHeight - 160), splitSt.current - d)))}
            onReset={() => setBottomPx(null)} />
          <div ref={bottomRef} className="grid min-h-0 bg-ink" style={{ gridTemplateRows: rows }}>
            {vis.map((k, i) => (
              // the cell is not clipped: the seam floats on the border above it, which is the only way
              // a drag target can straddle two panels without paying for a track of its own
              <div key={k} ref={(el) => { panelEl.current[k] = el; }} className="relative min-h-0">
                {i > 0 && !folded[k] && !folded[vis[i - 1]] && (
                  <Splitter dir="row" variant="overlay" className="-top-[4px] left-0 right-0 h-[8px]"
                    title={`Drag to trade height between ${PANEL_TITLE[vis[i - 1]]} and ${PANEL_TITLE[k]} · double-click to even them out`}
                    onBegin={() => beginPair(vis[i - 1], k)} onMove={movePair} onReset={() => resetPair(vis[i - 1], k)} />
                )}
                <div className={cn("h-full min-h-0 overflow-hidden", i < vis.length - 1 && "border-b border-line", k === "gen" && "bg-surface/40")}>
                  {k === "params" && <ParamsPanel params={params} values={paramValues} onChange={(n, v) => setParamValues((p) => ({ ...p, [n]: v }))} onReset={() => setParamValues({})} collapsed={folded.params} onToggle={() => fold("params")} />}
                  {k === "solver" && <SolverPanel traces={traces} evalMs={stats.evalMs} fps={stats.fps} collapsed={folded.solver} onToggle={() => fold("solver")} />}
                  {k === "gen" && <GenOptions flags={gen} onChange={applyGen} census={census} collapsed={folded.gen} onToggle={() => fold("gen")} />}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {showRef && (<>
        <Splitter dir="row" className="h-[5px] shrink-0"
          title="Drag to give the reference more or less height · double-click to hand it back to the layout"
          onBegin={() => { refSt.current = refRef.current?.getBoundingClientRect().height ?? 0; }}
          onMove={(d) => setRefPx(Math.max(80, Math.min(Math.max(120, window.innerHeight - 200), refSt.current - d)))}
          onReset={() => setRefPx(null)} />
        <div ref={refRef} style={{ height: refPx ?? undefined }}
          className={cn("shrink-0 overflow-auto border-t border-line bg-surface/60 px-4 py-4 sm:px-6 sm:py-5", refPx === null && "max-h-[46vh]")}>
          <div className="mb-4 max-w-4xl text-[12px] leading-relaxed text-muted">
            <span className="text-fg">How it works.</span> Curv programs are evaluated by a tree-walking interpreter; shape values form an F-Rep tree which is compiled to a
            straight-line <span className="font-mono">WGSL</span> fragment shader (numbers go into a parameter buffer, so animation and re-solving never recompile;
            subtrees are bbox-culled per pixel). User functions inside <span className="font-mono text-accent-2">make_shape</span> / <span className="font-mono text-accent-2">colour</span> are
            compiled by a SubCurv compiler. A <span className="font-mono text-accent-2">solve</span> block is an ordinary expression: it collects linear constraints, hands the convex problem to{" "}
            <a className="text-accent-2 underline decoration-dotted" href="https://github.com/SodoMita/psolve/tree/arena/cp-engine-correctness" target="_blank" rel="noreferrer">psolve</a>{" "}
            (LP by revised simplex, QP by active set, compiled to WebAssembly) and returns a record of plain numbers that feed regular Curv shape operators.
            There is a single coordinate system: Curv's (y up, origin in the middle, any units). <span className="font-mono text-accent-2">viewport</span> is the visible world rectangle
            as a box record, so layouts are just constraints against it — and they re-solve when you resize, pan or zoom.
          </div>
          <Reference />
        </div>
      </>)}
    </div>
  );
}

const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const finiteBBox3 = (b: number[] | null): number[] | null => (b && b.length === 6 && b.every(Number.isFinite) ? b : null);

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current"><path d={d} /></svg>;
}

function Badge({ dot, children }: { dot: "ok" | "warn" | "bad" | "wait"; children: React.ReactNode }) {
  const c = dot === "ok" ? "bg-emerald-400" : dot === "warn" ? "bg-amber-400" : dot === "bad" ? "bg-rose-400" : "bg-slate-500 animate-pulse";
  return (
    <span className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-muted">
      <span className={cn("h-1.5 w-1.5 rounded-full", c)} />{children}
    </span>
  );
}
