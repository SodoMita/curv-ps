import { useEffect, useState } from "react";
import { cn } from "../utils/cn";
import { CollapsedBar, PanelHeader } from "./Panel";

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
  sdfSteps: number;
}

/** Branch census of the last compiled shader body (`if` / `break` / short-circuit / `for`). */
export interface Census {
  lines: number;
  ifs: number;
  brks: number;
  logic: number;
  loops: number;
}

/**
 * An editable integer field for a numeric flag.  These used to be dropdowns with four fixed values
 * each — which is a poor control for a number: any value in range is legal (and the interesting
 * ones, like 96 steps or a cull weight of 6, were not on the list).
 *
 * The text is local state so typing is free: the transient empty string while clearing the field
 * never snaps back mid-keystroke, and `apply` only fires on a parseable integer, clamped to
 * [min, max].  When the value changes from elsewhere (a preset, a future master switch) the field
 * follows: the effect below re-canonicalises the text whenever the prop moves — and only then, so
 * an in-progress edit that already parses to the current value ("04" for 4) is left alone.
 *
 * `offValue` (cull weight): the field is empty and a cleared field applies `offValue` — the
 * flag-level "off" (Infinity = never cull).  The other two have no off state; 0 is a real value
 * for unrolling (0 = don't) and steps clamp at 1.
 */
function NumField({ value, min, max, offValue, title, apply }: { value: number; min: number; max: number; offValue?: number; title: string; apply: (v: number) => void }) {
  const canon = (v: number) => (v === offValue ? "" : String(v));
  const parse = (s: string) => Math.round(Number(s));
  const [text, setText] = useState(canon(value));
  useEffect(() => {
    if (text !== "" && parse(text) === value) return;   // already showing it
    setText(canon(value));
  }, [value]);
  return (
    <input type="number" inputMode="numeric" min={min} max={max} step={1} value={text} title={title}
      placeholder={offValue !== undefined ? "off" : ""}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => setText(canon(value))}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        if (raw === "") { if (offValue !== undefined && value !== offValue) apply(offValue); return; }
        const n = parse(raw);
        if (Number.isFinite(n)) apply(Math.min(max, Math.max(min, n)));
      }}
      className="w-14 rounded border border-line bg-surface-2 px-1 py-0 text-right font-mono text-[10.5px] tabular-nums text-fg outline-none focus:border-accent" />
  );
}

export function GenOptions({ flags, onChange, census, collapsed, onToggle }: { flags: GenFlags; onChange: (p: Partial<GenFlags>) => void; census: Census; collapsed?: boolean; onToggle?: () => void }) {
  if (collapsed) return <CollapsedBar title="shader generation" sub={flags.branchless ? "branchless" : "branched"} onOpen={onToggle ?? (() => {})} />;
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
  const int = (label: string, value: number, hint: string, opts: { min: number; max: number; offValue?: number; apply: (v: number) => void }) => (
    <label className="flex items-center gap-2 rounded px-1 py-[3px]" title={hint}>
      <span className="flex-1">{label}</span>
      <NumField value={value} min={opts.min} max={opts.max} offValue={opts.offValue} title={hint} apply={opts.apply} />
    </label>
  );

  return (
    <div className="flex h-full min-h-0 flex-col text-[11px] text-muted">
      <PanelHeader title="shader generation" onToggle={onToggle ?? (() => {})}>
        <div className="flex shrink-0 overflow-hidden rounded border border-line">
          {(["branched", "branchless"] as const).map((m, i) => (
            <button key={m} onClick={() => onChange({ branchless: i === 1 })}
              title={i === 1 ? "no if / break / short-circuit: both arms of every branch are computed" : "cull and early-out branches are kept — the fast build"}
              className={cn("px-1.5 py-0 font-mono text-[9.5px] transition-colors", (flags.branchless ? i === 1 : i === 0) ? "bg-accent/80 text-white" : "hover:bg-surface-2")}>
              {m}
            </button>
          ))}
        </div>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-1.5">
        <div className="px-1 pb-1 text-[10px] leading-snug">
          {flags.branchless
            ? "No if / break / short-circuit at all: both arms of every branch are computed. Measured 3× slower in 2D, and far worse in the 3D view, where the branched build's empty-space skip (4.7× on its own) cannot help a loop that must run every step — the picture is identical."
            : "Cull and early-out branches are kept — the fast build. The branchless build exists to measure what those branches are worth on a real GPU."}
        </div>

        <div className="mt-1 border-t border-line pt-1.5">
          <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/50">branches</div>
          {row("non-short-circuit && / ||", "noShortCircuit", "Emit & and | instead of && and ||: no short-circuit, no branch. Measured free (1.00×).", implied("noShortCircuit"))}
          {row("cull bracket → select", "cullSelect", "Replace the bbox-cull if with a select — the child is then evaluated for every pixel (2.8× in 2D).", implied("cullSelect"))}
          {row("branchless raymarch (3D)", "branchless3D", `The 3D loop keeps marching instead of breaking: all ${flags.sdfSteps} steps and shading for every pixel, with no help from the empty-space skip — dozens of times slower (branchbench).`, implied("branchless3D"))}
        </div>

        <div className="mt-1.5 border-t border-line pt-1.5">
          <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/50">3d raymarch</div>
          {int("sdf steps", flags.sdfSteps,
            "Sphere-tracing steps per ray in the 3D view, any integer 1…4096. Baked into the generated shader and marcher as a literal — a compile-time constant, not a uniform — so each setting compiles its own pipeline and the compiler can unroll around the bound. Fewer steps march faster (the sweep is worth ~1.2× here) but can miss grazing surfaces; hits are monotone in the count. Together with the bounding-box empty-space skip (4.7× on its own) this is what marchbench measures.",
            { min: 1, max: 4096, apply: (v) => onChange({ sdfSteps: v }) })}
        </div>

        <div className="mt-1.5 border-t border-line pt-1.5">
          <div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/50">other codegen</div>
          {int("cull weight", flags.cullWeight,
            "Minimum subtree weight that earns a bbox-cull branch, any integer ≥ 1. Clear the field (or type 0) to turn culling off entirely.",
            { min: 0, max: 1e9, offValue: Infinity, apply: (v) => onChange({ cullWeight: v < 1 ? Infinity : v }) })}
          {int("unroll loops ≤", flags.unrollMax,
            "Unroll for-loops whose trip count is a compile-time constant ≤ N, any integer 0…4096 (0 = never unroll).",
            { min: 0, max: 4096, apply: (v) => onChange({ unrollMax: v }) })}
          {row("polygon: select instead of %", "polySelect", "Polygon winding via select (branchless) instead of a modulo and an if.")}
          {row("text: sample every glyph", "textBranchless", "Sample the atlas for every glyph and select, instead of testing the cell box first.")}
          {row("text: glyph window", "textWindow", "Binary-search the ~6 glyph cells under the pixel instead of looping over the whole label.")}
          {row("SubCurv: flatten tiny ifs", "flattenIf", "Compile a small dynamic if as select(cond, then, else) — both sides evaluated.")}
        </div>
      </div>

      <div className="border-t border-line px-2 py-[3px] font-mono text-[9.5px] text-fg/60">
        last shader: {census.lines} lines · {census.ifs} if · {census.brks} break · {census.logic} &amp;&amp; ||· {census.loops} loops
      </div>
    </div>
  );
}
