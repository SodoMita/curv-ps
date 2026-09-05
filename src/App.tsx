import { useCallback, useEffect, useRef, useState } from "react";
import { Editor } from "./components/Editor";
import { SolverPanel } from "./components/SolverPanel";
import { Reference } from "./components/Reference";
import { ParamsPanel } from "./components/ParamsPanel";
import { EXAMPLES } from "./curv/examples";
import { Interp, compileTree, type SolveTrace, type ParamDesc } from "./curv/interp";
import { CurvError } from "./curv/parser";
import { bboxOf, finiteBBox, type SNode } from "./curv/shapes";
import { buildAtlas, type Atlas } from "./gpu/atlas";
import { createRenderer, type Renderer, type Camera } from "./gpu/renderer";
import { loadPsolve } from "./psolve/psolve";
import { cn } from "./utils/cn";

// One world, one camera: ordinary Curv space (y up, origin at the centre).  Programs that
// read `viewport` are re-evaluated whenever the visible world rectangle changes.
const BG: Record<"light" | "dark", [number, number, number]> = { light: [0.965, 0.965, 0.975], dark: [0x0e / 255, 0x13 / 255, 0x22 / 255] };
type ParamValues = Record<string, number | boolean | number[]>;
const HOME: Camera = { cx: 0, cy: 0, zoom: 1 };
const DEBOUNCE_MS = 100;

export default function App() {
  const [exampleId, setExampleId] = useState(EXAMPLES[0].id);
  const [src, setSrc] = useState(EXAMPLES[0].src);
  const [error, setError] = useState<{ message: string; line?: number } | null>(null);
  const [traces, setTraces] = useState<SolveTrace[]>([]);
  const [params, setParams] = useState<ParamDesc[]>([]);
  const [paramValues, setParamValues] = useState<ParamValues>({});
  const [stats, setStats] = useState({ evalMs: 0, genMs: 0, fps: 0, compileMs: 0, lines: 0, compiles: 0, quality: 1 });
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [rendererInfo, setRendererInfo] = useState<{ kind: string; info?: string } | null>(null);
  const [previewPct, setPreviewPct] = useState(100);
  const [showRef, setShowRef] = useState(false);
  const [debugBoxes, setDebugBoxes] = useState(false);
  const [bgMode, setBgMode] = useState<"light" | "dark">("light");
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");
  const [paused, setPaused] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [responsive, setResponsive] = useState(false);
  const [camView, setCamView] = useState<Camera>(HOME);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const atlas = useRef<Atlas | null>(null);
  const srcRef = useRef(src);
  const dirty = useRef(true);
  const dynamic = useRef({ time: false, mouse: false, viewport: false });
  const mousePx = useRef({ x: -1e6, y: -1e6, down: false });
  const clock = useRef({ t0: performance.now(), pausedAt: 0 });
  const pausedRef = useRef(false);
  const lastUi = useRef(0);
  const frames = useRef({ n: 0, t: performance.now(), last: 0 });
  const debugRef = useRef(false);
  const bgRef = useRef<"light" | "dark">("light");
  const cam = useRef<Camera>({ ...HOME });
  const needFit = useRef(true);
  const paramRef = useRef<ParamValues>({});
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const rendering = useRef(false);
  const codeRef = useRef("");
  const quality = useRef(1); // adaptive render scale while animating
  const settle = useRef<number | null>(null);

  useEffect(() => { srcRef.current = src; }, [src]);
  useEffect(() => { debugRef.current = debugBoxes; dirty.current = true; }, [debugBoxes]);
  useEffect(() => { bgRef.current = bgMode; dirty.current = true; }, [bgMode]);
  useEffect(() => { paramRef.current = paramValues; dirty.current = true; }, [paramValues]);

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
    if (m.x < -1e5) return { x: -1e6, y: -1e6, down: false };
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
    const inputs = { viewport: viewportOf(W, H, cam.current), time, mouse: worldMouse(), params: paramRef.current };
    const it = new Interp(at, inputs);
    try {
      const res = it.run(srcRef.current);
      let node: SNode = res.shape ?? { k: "nothing" };
      if (debugRef.current) {
        const kids: SNode[] = [node];
        const th = 1 / cam.current.zoom;
        for (const t of res.traces) for (const b of t.boxes)
          kids.push({ k: "xform", tx: b.x + b.w / 2, ty: b.y + b.h / 2, rot: 0, sc: 1, s: { k: "colour", c: [0.96, 0.45, 0.71, 0.9], s: { k: "stroke", w: th, s: { k: "rect", w: b.w, h: b.h, r: 0 } } } });
        node = { k: "union", kids };
      }
      // camera: responsive programs start at 1 unit = 1 px around the origin, everything else is fitted once
      if (needFit.current) {
        needFit.current = false;
        if (res.usesViewport) {
          const c = cam.current;
          if (c.cx !== 0 || c.cy !== 0 || c.zoom !== 1) { setCam({ ...HOME }); return; } // re-evaluate with the home viewport
        } else {
          const bb = finiteBBox(bboxOf(node, at)) ?? [-10, -10, 10, 10];
          const zoom = 0.85 * Math.min(W / Math.max(bb[2] - bb[0], 1e-6), H / Math.max(bb[3] - bb[1], 1e-6));
          setCam({ cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1 });
          dirty.current = false; // the tree does not depend on the camera: just draw it
        }
      }
      const t1 = performance.now();
      const prog = compileTree(node, at, r.kind === "webgpu" ? "wgsl" : "js");
      const t2 = performance.now();
      dynamic.current = { time: res.usesTime, mouse: res.usesMouse, viewport: res.usesViewport };
      const animating = res.usesTime && !pausedRef.current;
      const q = animating || drag.current ? quality.current : 1;
      if (!rendering.current) {
        rendering.current = true;
        r.render(prog, cam.current, BG[bgRef.current], time, q)
          .then(() => { rendering.current = false; if (prog.code !== codeRef.current) { codeRef.current = prog.code; setCode(prog.code); } })
          .catch((e: Error) => { rendering.current = false; setError({ message: e.message }); });
      } else dirty.current = true; // shader still compiling: try again next frame
      if (q < 1) { // re-render at full quality once things settle
        if (settle.current) clearTimeout(settle.current);
        settle.current = window.setTimeout(() => { if (!(dynamic.current.time && !pausedRef.current)) dirty.current = true; }, 180);
      }
      if (force || !animating || tStart - lastUi.current > 250) {
        lastUi.current = tStart;
        setTraces(res.traces); setParams(res.params); setError(null); setAnimated(res.usesTime); setResponsive(res.usesViewport);
        setStats((s) => ({ ...s, evalMs: t1 - tStart, genMs: t2 - t1, compileMs: r.stats.lastCompileMs, lines: prog.code.split("\n").length, compiles: r.stats.compiles, quality: q }));
      }
    } catch (e) {
      const err = e as CurvError;
      setError({ message: err.message, line: err instanceof CurvError ? err.line : undefined });
      setTraces(it.traces); setParams(it.params);
      dynamic.current = { time: false, mouse: false, viewport: it.usesViewport };
    }
  }, [worldMouse, setCam]);

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
        if (animating && f.last) { // adaptive quality from measured frame pacing
          const dt = t - f.last;
          if (dt > 24 && quality.current > 0.35) quality.current = Math.max(0.35, quality.current * 0.85);
          else if (dt < 13 && quality.current < 1) quality.current = Math.min(1, quality.current * 1.08);
        }
        f.last = animating ? t : 0;
        const wasDirty = dirty.current; dirty.current = false;
        evaluate(wasDirty);
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
    const ro = new ResizeObserver(() => { renderer.current?.resize(); dirty.current = true; });
    ro.observe(cv); return () => ro.disconnect();
  }, []);

  // ---- pointer: mouse input (world units) + pan/zoom
  const setMouse = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    mousePx.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, down: e.buttons > 0 };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setMouse(e); e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.cx, cy: cam.current.cy };
    if (dynamic.current.mouse) dirty.current = true;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    setMouse(e);
    if (drag.current && e.buttons > 0) {
      const c = cam.current; const d = drag.current;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 2) setCam({ ...c, cx: d.cx - (e.clientX - d.x) / c.zoom, cy: d.cy + (e.clientY - d.y) / c.zoom });
    } else if (dynamic.current.mouse) dirty.current = true;
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => { setMouse(e); drag.current = null; dirty.current = true; };
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = cv.getBoundingClientRect(); const mx = e.clientX - rect.left - cv.clientWidth / 2, my = e.clientY - rect.top - cv.clientHeight / 2;
      const c = cam.current; const k = Math.exp(-e.deltaY * 0.0015);
      const zoom = Math.min(1e6, Math.max(1e-6, c.zoom * k));
      setCam({ cx: c.cx + mx / c.zoom - mx / zoom, cy: c.cy - my / c.zoom + my / zoom, zoom });
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [setCam]);

  const loadExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)!; setExampleId(id); setSrc(ex.src); setParamValues({});
    clock.current = { t0: performance.now(), pausedAt: 0 }; needFit.current = true; quality.current = 1; dirty.current = true;
  };
  const example = EXAMPLES.find((e) => e.id === exampleId);
  const bottomCount = (params.length ? 1 : 0) + (traces.length ? 1 : 0);
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
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[minmax(360px,42%)_1fr] lg:overflow-hidden">
        {/* left: examples + editor */}
        <section className="flex min-h-[70vh] flex-col border-b border-line lg:min-h-0 lg:border-r lg:border-b-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Example</label>
            <select value={exampleId} onChange={(e) => loadExample(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent">
              <optgroup label="Curv + solve { } (constraints)">
                {EXAMPLES.filter((e) => e.group === "solve").map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
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
            {error ? <><span className="font-semibold">error</span>{error.line ? ` (line ${error.line})` : ""}: {error.message}</> : <>✓ {src.split("\n").length} lines · eval {stats.evalMs.toFixed(1)} ms · codegen {stats.genMs.toFixed(1)} ms · shader {stats.lines} lines{stats.compiles ? ` · ${stats.compiles} compile${stats.compiles > 1 ? "s" : ""} (last ${stats.compileMs.toFixed(0)} ms)` : ""}{stats.fps > 0 ? ` · ${stats.fps.toFixed(0)} fps` : ""}{stats.quality < 1 ? ` · ${Math.round(stats.quality * 100)}% res` : ""}</>}
          </div>
        </section>

        {/* right: preview + panels */}
        <section className={cn("grid min-h-[80vh] lg:min-h-0", bottomCount ? "grid-rows-[minmax(0,1fr)_minmax(160px,34%)]" : "grid-rows-[minmax(0,1fr)_auto]")}>
          <div className="flex min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-3 py-2 text-[11px] text-muted sm:px-4">
              <span className="font-semibold uppercase tracking-[0.14em]">Preview</span>
              <button onClick={togglePause} disabled={!animated} title="Pause / resume animation (space)"
                className={cn("flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono", animated ? (paused ? "border-amber-400/50 bg-amber-400/10 text-amber-200" : "border-line text-fg hover:bg-surface-2") : "border-line/50 text-muted/50")}>
                {paused ? <><Icon d="M8 5v14l11-7z" /> resume</> : <><Icon d="M6 5h4v14H6zm8 0h4v14h-4z" /> pause</>}
              </button>
              <button onClick={() => { needFit.current = true; dirty.current = true; }} title="Fit the shape (or reset the viewport to 1 unit = 1 px)" className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-2">{responsive ? "home" : "fit"}</button>
              <span className="hidden font-mono xl:inline" title="camera centre · zoom (px per unit)">({fmtNum(camView.cx)}, {fmtNum(camView.cy)}) · {fmtZoom(camView.zoom)}×</span>
              <span className="hidden 2xl:inline">y up · drag to pan · wheel to zoom{responsive ? " · re-solves on viewport change" : ""}</span>
              <label className="ml-auto flex items-center gap-2">
                <span className="hidden sm:inline">width</span>
                <input type="range" min={35} max={100} value={previewPct} onChange={(e) => setPreviewPct(+e.target.value)} className="w-20 accent-[#7c5cff] sm:w-32" />
                <span className="w-9 font-mono">{previewPct}%</span>
              </label>
              <button onClick={() => setBgMode((m) => (m === "light" ? "dark" : "light"))} title="Background" className="rounded-md border border-line px-2 py-0.5 font-mono hover:bg-surface-2">{bgMode === "light" ? "☼ light" : "☾ dark"}</button>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={debugBoxes} onChange={(e) => setDebugBoxes(e.target.checked)} className="accent-[#7c5cff]" />boxes</label>
              <button onClick={() => setShowCode((s) => !s)} className={cn("rounded-md border border-line px-2 py-0.5 hover:bg-surface-2", showCode && "bg-surface-3 text-fg")}>{renderer.current?.kind === "cpu" ? "JS" : "WGSL"}</button>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0e1322] p-3 sm:p-4"
              style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #1d2537 1px, transparent 0)", backgroundSize: "20px 20px" }}>
              <div className="mx-auto h-full transition-[width] duration-150" style={{ width: `${previewPct}%` }}>
                <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                  onPointerLeave={() => { if (!drag.current) { mousePx.current = { x: -1e6, y: -1e6, down: false }; if (dynamic.current.mouse) dirty.current = true; } }}
                  className="block h-full w-full cursor-grab touch-none rounded-xl border border-line shadow-2xl shadow-black/50 active:cursor-grabbing" />
              </div>
              {paused && <div className="pointer-events-none absolute left-6 top-6 rounded-md border border-amber-400/40 bg-ink/80 px-2 py-0.5 font-mono text-[11px] text-amber-200">paused · t = {clock.current.pausedAt.toFixed(2)} s</div>}
              {status !== "ready" && (
                <div className="absolute inset-0 grid place-items-center bg-ink/70 text-sm text-muted">
                  {status === "failed" ? "Initialisation failed — see error" : "Loading psolve.wasm & building glyph atlas…"}
                </div>
              )}
              {showCode && (
                <pre className="absolute inset-3 overflow-auto rounded-xl border border-line bg-ink/95 p-3 font-mono text-[10.5px] leading-snug text-fg/80 sm:inset-4">{code || "// nothing compiled yet"}</pre>
              )}
            </div>
          </div>
          {bottomCount > 0 && (
            <div className="grid min-h-0 border-t border-line bg-ink" style={{ gridTemplateColumns: params.length && traces.length ? "minmax(220px,34%) 1fr" : "1fr" }}>
              {params.length > 0 && <div className="min-h-0 overflow-auto border-r border-line"><ParamsPanel params={params} values={paramValues} onChange={(n, v) => setParamValues((p) => ({ ...p, [n]: v }))} onReset={() => setParamValues({})} /></div>}
              {traces.length > 0 && <div className="min-h-0"><SolverPanel traces={traces} evalMs={stats.evalMs} fps={stats.fps} /></div>}
            </div>
          )}
        </section>
      </div>

      {showRef && (
        <div className="max-h-[46vh] shrink-0 overflow-auto border-t border-line bg-surface/60 px-4 py-4 sm:px-6 sm:py-5">
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
      )}
    </div>
  );
}

const fmtNum = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

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
