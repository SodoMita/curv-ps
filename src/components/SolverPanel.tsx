import type { SolveTrace } from "../curv/interp";

export function SolverPanel({ traces, evalMs, fps }: { traces: SolveTrace[]; evalMs: number; fps: number }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Solver trace</div>
        <div className="flex gap-3 font-mono text-[11px] text-muted">
          <span>eval {evalMs.toFixed(2)} ms</span>
          <span>{fps > 0 ? `${fps.toFixed(0)} fps` : "static"}</span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 space-y-3">
        {traces.length === 0 && <div className="text-xs text-muted">No <span className="font-mono">solve {"{ }"}</span> block in this program.</div>}
        {traces.map((t, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface/60">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[11px]">
              <span className="font-mono text-fg">solve @ line {t.line}</span>
              <span className={"rounded px-1.5 py-0.5 font-mono text-[10px] " + (t.ok ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300")}>{t.status}</span>
              <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">{t.engine}</span>
              <span className="font-mono text-muted">{t.nVars} vars · {t.nCons} constraints · {t.eliminated} eliminated by presolve</span>
              <span className="font-mono text-muted">{t.iterations} it · {t.timeMs.toFixed(2)} ms</span>
              {Number.isFinite(t.objective) && t.engine !== "presolve" && <span className="font-mono text-muted">obj {t.objective.toFixed(3)}</span>}
            </div>
            {t.violations.length > 0 && (
              <div className="border-b border-line px-3 py-1.5 text-[11px] text-amber-300">
                {t.violations.length} hard constraint(s) not met: {t.violations.slice(0, 3).map((v) => `${v.label} (${v.amount.toFixed(2)})`).join(", ")}
              </div>
            )}
            <table className="w-full font-mono text-[11px]">
              <tbody>
                {t.values.map((v) => (
                  <tr key={v.name} className="border-b border-line/50 last:border-0">
                    <td className="w-28 px-3 py-1 text-accent-2">{v.name}</td>
                    <td className="px-3 py-1 text-fg/85">{v.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
