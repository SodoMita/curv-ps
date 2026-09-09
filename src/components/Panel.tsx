/**
 * Folding for the bottom row's panels (parametric / solver trace / shader generation).
 *
 * The panels stack: three columns of a wide table were three narrow tables, so they sit one above
 * the other and each takes the full width.  Folding one gives the others its height instead of
 * hiding it — a folded panel stays a labelled bar, so nothing has to be remembered.
 */

/** A folded panel: a thin horizontal bar, titled left to right. */
export function CollapsedBar({ title, sub, onOpen }: { title: string; sub?: string; onOpen: () => void }) {
  return (
    <button onClick={onOpen} title={`Show ${title}`}
      className="flex w-full items-center gap-2 bg-surface/40 px-2 py-1 text-left text-muted transition-colors hover:bg-surface-2 hover:text-fg">
      <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0 fill-current"><path d="M9 6l6 6-6 6" /></svg>
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em]">{title}</span>
      {sub && <span className="font-mono text-[10px] text-fg/50">{sub}</span>}
    </button>
  );
}

/** The chevron that folds a panel — sits at the left of the panel's own header row. */
export function CollapseButton({ onToggle, title }: { onToggle: () => void; title: string }) {
  return (
    <button onClick={onToggle} title={title}
      className="-ml-1 shrink-0 rounded p-0.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
      <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current"><path d="M6 9l6 6 6-6" /></svg>
    </button>
  );
}
