/**
 * Folding for the bottom row's panels (parametric / solver trace / shader generation).
 *
 * Three panels side by side are three narrow panels, and the solver trace and the shader options are
 * both wide tables.  Folding one gives the others its width and keeps it a click away: the collapsed
 * panel becomes a vertical strip instead of disappearing, so nothing has to be remembered.
 */

/** A collapsed panel: a clickable strip, titled down the side. */
export function CollapsedStrip({ title, sub, onOpen }: { title: string; sub?: string; onOpen: () => void }) {
  return (
    <button onClick={onOpen} title={`Show ${title}`}
      className="flex h-full w-full flex-col items-center gap-2 bg-surface/40 py-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
      <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 fill-current"><path d="M15 6l-6 6 6 6" /></svg>
      <span className="text-[10px] uppercase tracking-[0.14em]" style={{ writingMode: "vertical-rl" }}>{title}</span>
      {sub && <span className="font-mono text-[9.5px] text-fg/50" style={{ writingMode: "vertical-rl" }}>{sub}</span>}
    </button>
  );
}

/** The chevron that folds a panel — sits at the left of the panel's own header row. */
export function CollapseButton({ onToggle, title }: { onToggle: () => void; title: string }) {
  return (
    <button onClick={onToggle} title={title}
      className="-ml-1 shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
      <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current"><path d="M9 6l6 6-6 6" /></svg>
    </button>
  );
}
