import { cn } from "../utils/cn";

/**
 * Shader-generation options (the `SHADER_FLAGS` of src/gpu/gen.ts), as a panel at the bottom of the
 * preview column — it used to be a popover off the toolbar, where ten options and their measured
 * costs did not fit and could not be read while dragging a slider.
 *
 * Adding an option is two edits: a row in the panel below and the flag itself in `ShaderFlags` — the
 * flag string is part of the structural key (`flagsKey`), so every cache invalidates itself.
 */
export interface GenFlags {
  branchless: boolean;
  noShortCircuit: boolean;
  cullSelect: boolean;
  branchless3D: boolean;
  polySelect: boolean;
  textBranchless: boolean;
  textWindow: boolean;
  flattenIf: boolean;
  cullWeight: number;
  unrollMax: number;
}

/** Branch census of the last compiled shader body (`if` / `break` / short-circuit / `for`). */
export interface Census {
  lines: number;
  ifs: number;
  brks: number;
  logic: number;
  loops: number;
}

export function GenOptions({ flags, onChange, census }: { flags: GenFlags; onChange: (p: Partial<GenFlags>) => void; census: Census }) {
  // a row that is implied by the master switch: shown as on, not editable
  const implied = (k: "noShortCircuit" | "cullSelect" | "branchless3D") => flags.branchless && flags[k];
  const row = (label: string, flag: keyof GenFlags, hint: string, force?: boolean) => (
    <label className={cn("flex items-center gap-2 rounded px-1 py-[3px]", force ? "opacity-70" : "cursor-pointer hover:bg-surface-2")}
      title={force ? "implied by branchless" : hint}>
      <input type="checkbox" checked={force ? true : (flags[flag] as boolean)} disabled={force}
        onChange={() => onChange({ [flag]: !flags[flag] } as Partial<GenFlags>)}
        className="h-3 w-3 accent-[#7c5cff] disabled:opacity-40" />
      <span className="flex-1">{label}</span>
    </label>
  );
  const sel = (label: string, value: number, opts: [string, number][], hint: string, set: (v: number) => void) => (
    <label className="flex items-center gap-2 rounded px-1 py-[3px]" title={hint}>
      <span className="flex-1">{label}</span>
      <select value={String(value)} onChange={(e) => set(Number(e.target.value))}
        className="rounded border border-line bg-surface-2 px-1 py-0 font-mono text-[10.5px] text-fg outline-none">
        {opts.map(([n, v]) => <option key={n} value={String(v)}>{n}</option>)}
      </select>
    </label>
  );

  return (
    <div className="flex h-full min-h-0 flex-col text-[11px] text-muted">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1">
        <span className="font-semibold uppercase tracking-[0.12em] text-fg/70">shader generation</span>
        <div className="ml-auto flex overflow-hidden rounded-md border border-line">
          {(["branched", "branchless"] as const).map((m, i) => (
            <button key={m} onClick={() => onChange({ branchless: i === 1 })}
              title={i === 1 ? "no if / break / short-circuit: both arms of every branch are computed" : "cull and early-out branches are kept — the fast build"}
              className={cn("px-2 py-0.5 font-mono transition-colors", (flags.branchless ? i === 1 : i === 0) ? "bg-accent/80 text-white" : "hover:bg-surface-2")}>
              {m}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
        <div className="px-1 pb-1 text-[10px] leading-snug">
          {flags.branchless
            ? "No if / break / short-circuit at all: both arms of every branch are computed. Measured 3× slower in 2D and 10× in the 3D view (branchbench) — the picture is identical."
            : "Cull and early-out branches are kept — the fast build. The branchless build exists to measure what those branches are worth on a real GPU."}
        </div>

        <div className="mt-1 border-t border-line pt-1.5">
          <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/50">branches</div>
          {row("non-short-circuit && / ||", "noShortCircuit", "Emit & and | instead of && and ||: no short-circuit, no branch. Measured free (1.00×).", implied("noShortCircuit"))}
          {row("cull bracket → select", "cullSelect", "Replace the bbox-cull if with a select — the child is then evaluated for every pixel (2.8× in 2D).", implied("cullSelect"))}
          {row("branchless raymarch (3D)", "branchless3D", "The 3D loop keeps marching instead of breaking: all 128 steps and shading for every pixel (9.7×).", implied("branchless3D"))}
        </div>

        <div className="mt-1.5 border-t border-line pt-1.5">
          <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/50">other codegen</div>
          {sel("cull weight", Number.isFinite(flags.cullWeight) ? flags.cullWeight : -1, [["off", -1], ["1", 1], ["4", 4], ["8", 8], ["16", 16]],
            "Minimum subtree weight that earns a bbox-cull branch (off = never cull).", (v) => onChange({ cullWeight: v < 0 ? Infinity : v }))}
          {sel("unroll loops ≤", flags.unrollMax, [["off", 0], ["4", 4], ["8", 8], ["16", 16]],
            "Unroll for-loops whose trip count is a compile-time constant ≤ N.", (v) => onChange({ unrollMax: v }))}
          {row("polygon: select instead of %", "polySelect", "Polygon winding via select (branchless) instead of a modulo and an if.")}
          {row("text: sample every glyph", "textBranchless", "Sample the atlas for every glyph and select, instead of testing the cell box first.")}
          {row("text: glyph window", "textWindow", "Binary-search the ~6 glyph cells under the pixel instead of looping over the whole label.")}
          {row("SubCurv: flatten tiny ifs", "flattenIf", "Compile a small dynamic if as select(cond, then, else) — both sides evaluated.")}
        </div>
      </div>

      <div className="border-t border-line px-2 py-1 font-mono text-[10px] text-fg/60">
        last shader: {census.lines} lines · {census.ifs} if · {census.brks} break · {census.logic} &amp;&amp; ||· {census.loops} loops
      </div>
    </div>
  );
}
