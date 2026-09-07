import { useEffect, useMemo, useRef, useState } from "react";
import { tokenize, braceMatch } from "./highlight";

interface Props { value: string; onChange: (v: string) => void; errorLine?: number }

// character → the partner inserted when it is typed
const PAIR_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const OPENERS = new Set(["(", "[", "{"]);
const QUOTES = new Set(['"', "'"]);

interface Piece { text: string; cls: string }
interface Row { spans: Piece[] }

const PAD_TOP = 12; // py-3 on both layers — keep the caret/error bands in sync with the text
const FALLBACK_LH = 12.5 * 1.55; // text-[12.5px] leading-[1.55]

export function Editor({ value, onChange, errorLine }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const hlText = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [lineH, setLineH] = useState(FALLBACK_LH);

  // measure the real line height once (a webfont swap cannot change it: leading is unitless)
  useEffect(() => {
    const el = hlText.current?.firstElementChild;
    if (el) { const h = el.getBoundingClientRect().height; if (h) setLineH(h); }
  }, []);

  const syncCursor = (el: HTMLTextAreaElement) =>
    setSel((p) => (p.start === el.selectionStart && p.end === el.selectionEnd ? p : { start: el.selectionStart, end: el.selectionEnd }));

  // Tokenize + brace-match + group into lines, all in one pass over the source.
  const { rows, caretLine } = useMemo(() => {
    const spans = tokenize(value);
    const collapsed = sel.start === sel.end;
    const match = collapsed ? braceMatch(value, spans, sel.end) : null;
    const matchCls = new Map<number, string>();
    if (match) {
      const cls = match.ok ? "--match" : "--unmatched";
      matchCls.set(match.at, cls);
      if (match.other >= 0) matchCls.set(match.other, cls);
    }
    const rows: Row[] = [];
    let cur: Row = { spans: [] };
    const push = (text: string, cls: string) => {
      const parts = text.split("\n");
      for (let k = 0; k < parts.length; k++) {
        if (k > 0) { rows.push(cur); cur = { spans: [] }; }
        const p = parts[k];
        if (!p) continue;
        const last = cur.spans[cur.spans.length - 1];
        if (last && last.cls === cls) last.text += p;
        else cur.spans.push({ text: p, cls });
      }
    };
    let i = 0;
    for (const s of spans) {
      if (s.start > i) push(value.slice(i, s.start), "");
      push(value.slice(s.start, s.end), "tok-" + s.type + (matchCls.get(s.start) ?? ""));
      i = s.end;
    }
    if (i < value.length) push(value.slice(i), "");
    rows.push(cur);
    let caretLine = 0;
    for (let k = 0; k < sel.end && k < value.length; k++) if (value[k] === "\n") caretLine++;
    return { rows, caretLine };
  }, [value, sel]);

  // apply a programmatic edit and put the caret back once React has re-rendered
  const apply = (next: string, start: number, end = start) => {
    onChange(next);
    setSel({ start, end });
    requestAnimationFrame(() => {
      const el = ta.current;
      if (el) { el.selectionStart = start; el.selectionEnd = end; }
    });
  };
  const moveCaret = (pos: number) => {
    setSel({ start: pos, end: pos });
    requestAnimationFrame(() => {
      const el = ta.current;
      if (el) { el.selectionStart = el.selectionEnd = pos; }
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const v = el.value, s = el.selectionStart, en = el.selectionEnd;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;

    if (e.key === "Tab") {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      if (!e.shiftKey && s !== en && v.slice(s, en).includes("\n")) {
        // indent every touched line
        const block = v.slice(ls, en).replace(/^/gm, "  ");
        apply(v.slice(0, ls) + block + v.slice(en), ls, ls + block.length);
      } else if (e.shiftKey && s !== en && v.slice(s, en).includes("\n")) {
        const block = v.slice(ls, en).replace(/^ {1,2}/gm, "");
        apply(v.slice(0, ls) + block + v.slice(en), ls, ls + block.length);
      } else if (e.shiftKey) {
        const removed = Math.min(2, (/^ */.exec(v.slice(ls)) ?? [""])[0].length);
        if (removed) apply(v.slice(0, ls) + v.slice(ls + removed), Math.max(ls, s - removed), Math.max(ls, en - removed));
      } else {
        apply(v.slice(0, s) + "  " + v.slice(en), s + 2);
      }
      return;
    }

    if (e.key === "Enter" && plain) {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      const indent = (/^ */.exec(v.slice(ls, s)) ?? [""])[0];
      const before = v[s - 1], after = v[s];
      if (OPENERS.has(before) && PAIR_OF[before] === after) {
        // (|)↵ — open the pair up with the caret on the middle line, indented
        const mid = indent + "  ";
        apply(v.slice(0, s) + "\n" + mid + "\n" + indent + v.slice(en), s + 1 + mid.length);
      } else {
        apply(v.slice(0, s) + "\n" + indent + v.slice(en), s + 1 + indent.length);
      }
      return;
    }

    if (e.key === "Backspace" && plain && s === en && s > 0 && PAIR_OF[v[s - 1]] === v[s] && OPENERS.has(v[s - 1])) {
      e.preventDefault(); // delete an empty pair in one stroke
      apply(v.slice(0, s - 1) + v.slice(s + 1), s - 1);
      return;
    }

    if (plain && e.key.length === 1) {
      const k = e.key;
      if (QUOTES.has(k)) {
        e.preventDefault();
        if (s === en && v[s] === k) moveCaret(s + 1); // step out of an auto-closed quote
        else if (s !== en) apply(v.slice(0, s) + k + v.slice(s, en) + k + v.slice(en), s + 1, en + 1);
        else apply(v.slice(0, s) + k + k + v.slice(s), s + 1);
        return;
      }
      if (OPENERS.has(k)) {
        e.preventDefault();
        if (s !== en) apply(v.slice(0, s) + k + v.slice(s, en) + PAIR_OF[k] + v.slice(en), s + 1, en + 1);
        else apply(v.slice(0, s) + k + PAIR_OF[k] + v.slice(s), s + 1);
        return;
      }
    }
  };

  return (
    <div className="relative flex h-full min-h-0 font-mono text-[12.5px] leading-[1.55]">
      <div ref={gutter} className="w-10 shrink-0 overflow-hidden border-r border-line bg-surface/60 py-3 text-right text-muted/70 select-none">
        {rows.map((_, i) => (
          <div key={i} className={"pr-2" + (errorLine === i + 1 ? " err-line text-rose-300" : "") + (caretLine === i ? " gutter-current" : "")}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        {/* mirrored, coloured copy of the code; the textarea above it carries the caret */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-3 text-fg" aria-hidden="true">
          <div className="ed-band" style={{ top: PAD_TOP + caretLine * lineH - scroll.top, height: lineH }} />
          {errorLine != null && (
            <div className="ed-band-err" style={{ top: PAD_TOP + (errorLine - 1) * lineH - scroll.top, height: lineH }} />
          )}
          <div ref={hlText} className="whitespace-pre" style={{ transform: `translate(${-scroll.left}px, ${-scroll.top}px)` }}>
            {rows.map((r, i) => (
              <div key={i}>
                {r.spans.length
                  ? r.spans.map((p, j) => (p.cls ? <span key={j} className={p.cls}>{p.text}</span> : p.text))
                  : "\u200B"}
              </div>
            ))}
          </div>
        </div>
        <textarea
          ref={ta}
          value={value}
          onChange={(e) => { onChange(e.target.value); syncCursor(e.target); }}
          onKeyDown={onKey}
          onKeyUp={(e) => syncCursor(e.currentTarget)}
          onClick={(e) => syncCursor(e.currentTarget)}
          onSelect={(e) => syncCursor(e.currentTarget)}
          onScroll={(e) => {
            const { scrollTop, scrollLeft } = e.currentTarget;
            setScroll({ top: scrollTop, left: scrollLeft });
            if (gutter.current) gutter.current.scrollTop = scrollTop;
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="editor-textarea absolute inset-0 h-full w-full resize-none bg-transparent px-3 py-3 text-transparent caret-accent-2 outline-none whitespace-pre overflow-auto"
        />
      </div>
    </div>
  );
}
