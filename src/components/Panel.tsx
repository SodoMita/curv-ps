import type { ReactNode } from "react";

/**
 * Folding for the bottom row's panels (parametric / solver trace / shader generation).
 *
 * The panels stack, each at the full width of the row.  Folding one gives the others its height
 * instead of hiding it, and a folded panel stays a labelled bar so nothing has to be remembered.
 * Both bars are thin: every pixel they spend is a pixel the content does not get.
 */

/** A folded panel: a thin bar, titled left to right, clickable anywhere. */
export function CollapsedBar({ title, sub, onOpen }: { title: string; sub?: string; onOpen: () => void }) {
  return (
    <button onClick={onOpen} title={`Show ${title}`}
      className="flex w-full items-center gap-1.5 bg-surface/40 px-2 py-[2px] text-left text-muted transition-colors hover:bg-surface-2 hover:text-fg">
      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 shrink-0 fill-current"><path d="M9 6l6 6-6 6" /></svg>
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em]">{title}</span>
      {sub && <span className="font-mono text-[9.5px] text-fg/50">{sub}</span>}
    </button>
  );
}

/**
 * The header of an open panel: the chevron *and the title* fold it, as one wide button, so the whole
 * left side of the bar is the target — the arrow alone was a 12px target for the most common action.
 * Actions that are not folding (reset, the branched switch, the timings) sit to the right of it.
 */
export function PanelHeader({ title, onToggle, children }: { title: string; onToggle: () => void; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-2 py-[3px]">
      <button onClick={onToggle} title={`Fold ${title}`}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-[9.5px] font-semibold uppercase tracking-[0.14em] text-muted transition-colors hover:text-fg">
        <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 shrink-0 fill-current"><path d="M6 9l6 6 6-6" /></svg>
        <span className="truncate">{title}</span>
      </button>
      {children}
    </div>
  );
}
