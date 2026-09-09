import type { ParamDesc } from "../curv/interp";
import { CollapsedBar, PanelHeader } from "./Panel";

type V = number | boolean | number[];
interface Props { params: ParamDesc[]; values: Record<string, V>; onChange: (name: string, v: V) => void; onReset: () => void; collapsed?: boolean; onToggle?: () => void }

export function ParamsPanel({ params, values, onChange, onReset, collapsed, onToggle }: Props) {
  if (collapsed) return <CollapsedBar title="parametric" sub={`${params.length}`} onOpen={onToggle ?? (() => {})} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="parametric" onToggle={onToggle ?? (() => {})}>
        <button onClick={onReset} className="shrink-0 rounded border border-line px-1.5 py-0 font-mono text-[9.5px] text-muted hover:bg-surface-2">defaults</button>
      </PanelHeader>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {params.map((p) => {
          const cur = values[p.name] ?? p.value;
          if (p.kind === "checkbox") return (
            <label key={p.name} className="flex items-center justify-between gap-2 text-[11.5px]">
              <span className="font-mono text-accent-2">{p.label}</span>
              <input type="checkbox" checked={cur === true} onChange={(e) => onChange(p.name, e.target.checked)} className="accent-[#7c5cff]" />
            </label>
          );
          if (p.kind === "colour_picker") {
            const c = Array.isArray(cur) ? cur : [1, 1, 1];
            const hex = "#" + c.slice(0, 3).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0")).join("");
            return (
              <label key={p.name} className="flex items-center justify-between gap-2 text-[11.5px]">
                <span className="font-mono text-accent-2">{p.label}</span>
                <input type="color" value={hex} onChange={(e) => { const h = e.target.value; onChange(p.name, [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)); }} />
              </label>
            );
          }
          const n = typeof cur === "number" ? cur : 0;
          const isScale = p.kind === "scale_picker";
          const lo = isScale ? -3 : p.lo, hi = isScale ? 3 : p.hi;
          const sliderVal = isScale ? Math.log10(Math.max(1e-6, n)) : n;
          const step = p.kind === "int_slider" ? 1 : (hi - lo) / 400;
          return (
            <div key={p.name} className="text-[11.5px]">
              <div className="flex items-center justify-between">
                <span className="font-mono text-accent-2">{p.label}</span>
                <span className="font-mono text-fg/80">{p.kind === "int_slider" ? n : n.toPrecision(4).replace(/\.?0+$/, "")}</span>
              </div>
              <input type="range" min={lo} max={hi} step={step} value={sliderVal}
                onChange={(e) => { const v = +e.target.value; onChange(p.name, isScale ? Math.pow(10, v) : p.kind === "int_slider" ? Math.round(v) : v); }}
                className="w-full accent-[#7c5cff]" />
            </div>
          );
        })}
      </div>
    </div>
  );
}
