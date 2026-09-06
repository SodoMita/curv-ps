import type { SolveTrace } from "../curv/interp";
import { psolveInfo } from "../psolve/psolve";

function StatusPill({ t }: { t: SolveTrace }) {
  const label = t.degraded ? t.degraded!.verdict : (t.verdict ?? t.status);
  const cls = t.degraded
    ? "bg-amber-400/15 text-amber-300"
    : t.ok
      ? t.approx ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"
      : "bg-rose-400/15 text-rose-300";
  const title = t.degraded
    ? `The solve failed (${t.degraded!.status}) — showing the last good layout instead of an error.`
    : t.approx
      ? "Budget / iteration limit reached before certification: this is the best incumbent, not a proven optimum."
      : t.ok ? "Certified optimum." : (t.verdict ?? t.status);
  return <span className={"rounded px-1.5 py-0.5 font-mono text-[10px] " + cls} title={title}>{label}</span>;
}

export function SolverPanel({ traces, evalMs, fps }: { traces: SolveTrace[]; evalMs: number; fps: number }) {
  const info = psolveInfo();
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
          <div key={i} className={"rounded-lg border bg-surface/60 " + (t.degraded ? "border-amber-400/40" : "border-line")}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[11px]">
              <span className="font-mono text-fg">solve @ line {t.line}</span>
              <StatusPill t={t} />
              <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">{t.engine}</span>
              <span className="font-mono text-muted">{t.nVars} vars · {t.nCons} constraints · {t.eliminated} eliminated by presolve</span>
              {t.cached
                ? t.cacheKind === "block"
                  ? <span className="rounded bg-emerald-400/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-200" title="None of the block's inputs (free variables) changed since the last evaluation: the block was not re-evaluated at all — no constraints built, no presolve, no psolve">memoised</span>
                  : <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 font-mono text-[10px] text-cyan-200" title="The block was re-evaluated but its numeric problem (fingerprint) is identical to the last one: presolve and psolve were skipped">cached</span>
                : <span className="font-mono text-muted">{t.iterations} it · {t.timeMs.toFixed(2)} ms</span>}
              {t.warm && <span className="rounded bg-sky-400/15 px-1.5 py-0.5 font-mono text-[10px] text-sky-200" title="The block's previous solution was fed to psolve as a warm start and accepted (Phase-I skipped — upstream measures 23–35× on drag frames)">warm start</span>}
              {t.warmRetry && <span className="rounded bg-orange-400/15 px-1.5 py-0.5 font-mono text-[10px] text-orange-200" title="The warm-start walk exceeded its sub-budget and the problem was retried cold within the frame budget">warm → cold retry</span>}
              {t.approx && !t.cached && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200" title="The wall-clock / iteration budget ended the solve before certification">incumbent</span>}
              {t.degraded && <span className="rounded bg-amber-400/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200" title="Values shown are the block's last good solve, not this frame's (the failure is not cached — next frame re-attempts)">fallback: last good</span>}
              {Number.isFinite(t.objective) && t.engine !== "presolve" && <span className="font-mono text-muted">obj {t.objective.toFixed(3)}</span>}
              {t.maxResid !== undefined && t.maxResid > 1e-9 && <span className="font-mono text-amber-300" title="Largest row violation at the returned point">resid {t.maxResid.toExponential(1)}</span>}
            </div>
            {t.degraded && (
              <div className="border-b border-amber-400/25 bg-amber-400/5 px-3 py-1.5 text-[11px] text-amber-200">
                This frame's solve failed ({t.degraded.status}); the layout is the last good solve.
                {t.degraded.conflicts?.length ? <> Conflicting rows (Farkas certificate): {t.degraded.conflicts.slice(0, 4).map((c) => `'${c.label}'`).join(", ")}</> : null}
              </div>
            )}
            {(t.conflicts?.length ?? 0) > 0 && !t.degraded && (
              <div className="border-b border-line px-3 py-1.5 text-[11px] text-rose-300">
                Proven infeasible — conflicting rows: {t.conflicts!.slice(0, 4).map((c) => `'${c.label}' (λ ${c.lambda.toFixed(2)})`).join(", ")}
              </div>
            )}
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
      <div className="border-t border-line px-4 py-1.5 font-mono text-[10px] text-muted/80" title="Which solver produced these layouts: bridge ABI and the sha256 of the committed wasm blob (rebuild recipe in psolve-src/)">
        psolve ABI {info.abi || "…"} · wasm sha256 {info.sha256.slice(0, 12)}… · pin {info.pin}
      </div>
    </div>
  );
}
