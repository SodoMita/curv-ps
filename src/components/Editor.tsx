import { useMemo, useRef } from "react";

interface Props { value: string; onChange: (v: string) => void; errorLine?: number }

export function Editor({ value, onChange, errorLine }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n").length, [value]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget; const s = el.selectionStart, en = el.selectionEnd;
      const v = el.value.slice(0, s) + "  " + el.value.slice(en);
      onChange(v); requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
    }
  };
  return (
    <div className="relative flex h-full min-h-0 font-mono text-[12.5px] leading-[1.55]">
      <div ref={gutter} className="w-10 shrink-0 overflow-hidden border-r border-line bg-surface/60 py-3 text-right text-muted/70 select-none">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={"pr-2 " + (errorLine === i + 1 ? "err-line text-rose-300" : "")}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={ta}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="editor-textarea h-full w-full resize-none bg-transparent px-3 py-3 text-fg outline-none whitespace-pre overflow-auto"
      />
    </div>
  );
}
