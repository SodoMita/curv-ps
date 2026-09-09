import { useRef } from "react";
import { cn } from "../utils/cn";

/**
 * A draggable edge between two regions.
 *
 * Two shapes:
 *  - `bar`     — owns a grid/flex track of its own (the 5px seam between the editor column and the
 *                preview column, or between the canvas and the panel row).  Always visible.
 *  - `overlay` — floats on the seam between two stacked panels.  It costs zero layout height,
 *                which is the point: every pixel of chrome is a pixel the content does not get.
 *
 * The splitter knows nothing about geometry.  It reports a signed pixel delta from where the drag
 * started (positive = down for `row`, right for `col`) and the caller decides what that means;
 * it measures whatever it needs in `onBegin`.  Double-click — or Enter/Space — hands the edge back
 * to the layout, and the arrow keys nudge it for anyone not using a pointer.
 */
export function Splitter({ dir, onBegin, onMove, onReset, variant = "bar", title, step = 16, className }: {
  dir: "row" | "col";
  onBegin: () => void;
  onMove: (delta: number) => void;
  onReset?: () => void;
  variant?: "bar" | "overlay";
  title?: string;
  step?: number;
  className?: string;
}) {
  const st = useRef<{ id: number; x: number; y: number } | null>(null);
  const row = dir === "row";
  const delta = (e: { clientX: number; clientY: number }) =>
    (row ? e.clientY : e.clientX) - (row ? st.current!.y : st.current!.x);

  const down = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    st.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onBegin();
    e.preventDefault();
  };
  const move = (e: React.PointerEvent) => { if (st.current?.id === e.pointerId) onMove(delta(e)); };
  const up = (e: React.PointerEvent) => {
    if (st.current?.id !== e.pointerId) return;
    st.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const key = (e: React.KeyboardEvent) => {
    const d = (row ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key];
    if (d) { e.preventDefault(); onBegin(); onMove(d * step); }
    else if (onReset && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onReset(); }
  };

  return (
    <div role="separator" aria-orientation={row ? "horizontal" : "vertical"} tabIndex={0} title={title}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={onReset} onKeyDown={key}
      className={cn("group relative touch-none outline-none", row ? "cursor-row-resize" : "cursor-col-resize",
        variant === "bar"
          ? "bg-line/50 transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
          : "z-20 hover:bg-accent/25 focus-visible:bg-accent/25",
        variant === "overlay" && "absolute",
        className)}>
      <span className={cn("pointer-events-none absolute left-1/2 top-1/2 rounded-full bg-fg/25 transition-colors group-hover:bg-fg/70 group-focus-visible:bg-fg/70",
        row ? "h-[2px] w-10 -translate-x-1/2 -translate-y-1/2" : "h-10 w-[2px] -translate-x-1/2 -translate-y-1/2")} />
    </div>
  );
}
