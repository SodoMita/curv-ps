import { useEffect, useMemo, useRef, useState } from "react";
import { tokenize, braceMatch } from "./highlight";

interface Props { value: string; onChange: (v: string) => void; errorLine?: number }

const PAIR_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const OPENERS = new Set(["(", "[", "{"]);
const QUOTES = new Set(['"', "'"]);
const canPairBefore = (ch: string | undefined) => !ch || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

interface Piece { text: string; cls: string }
interface Row { spans: Piece[] }

const PAD_TOP = 12;
const FALLBACK_LH = 12.5 * 1.55;

export function Editor({ value, onChange, errorLine }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const hlText = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [lineH, setLineH] = useState(FALLBACK_LH);

  useEffect(() => {
    const el = hlText.current?.firstElementChild;
    if (el) { const h = el.getBoundingClientRect().height; if (h) setLineH(h); }
  }, []);

  const syncCursor = (el: HTMLTextAreaElement) =>
    setSel((p) => (p.start === el.selectionStart && p.end === el.selectionEnd ? p : { start: el.selectionStart, end: el.selectionEnd }));

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

  // Prefer insertText so the browser undo stack stays intact. Fall back to a
  // whole-value replace only when the command is refused (some browsers).
  const typeText = (text: string) => {
    const el = ta.current; if (!el) return;
    el.focus();
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      const s = el.selectionStart, en = el.selectionEnd, v = el.value;
      const next = v.slice(0, s) + text + v.slice(en);
      onChange(next);
      const pos = s + text.length;
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = pos; });
    }
  };
  const replaceRange = (from: number, to: number, text: string, caret = from + text.length, end = caret) => {
    const el = ta.current; if (!el) return;
    el.focus();
    el.selectionStart = from; el.selectionEnd = to;
    const ok = document.execCommand("insertText", false, text);
    if (!ok) {
      const v = el.value;
      onChange(v.slice(0, from) + text + v.slice(to));
    }
    requestAnimationFrame(() => {
      el.selectionStart = caret; el.selectionEnd = end; syncCursor(el);
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const v = el.value, s = el.selectionStart, en = el.selectionEnd;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === "Tab") {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      if (s !== en && v.slice(s, en).includes("\n")) {
        const block = e.shiftKey
          ? v.slice(ls, en).replace(/^ {1,2}/gm, "")
          : v.slice(ls, en).replace(/^/gm, "  ");
        replaceRange(ls, en, block, ls, ls + block.length);
      } else if (e.shiftKey) {
        const removed = Math.min(2, (/^ */.exec(v.slice(ls)) ?? [""])[0].length);
        if (removed) replaceRange(ls, ls + removed, "", Math.max(ls, s - removed), Math.max(ls, en - removed));
      } else {
        typeText("  ");
      }
      return;
    }

    // Ctrl/Cmd+/ — toggle // on every touched line
    if (mod && e.key === "/") {
      e.preventDefault();
      const from = v.lastIndexOf("\n", s - 1) + 1;
      const selEnd = s !== en && en > 0 && v[en - 1] === "\n" ? en - 1 : Math.max(en, s);
      const nl = v.indexOf("\n", selEnd);
      const to = nl < 0 ? v.length : nl;
      const block = v.slice(from, to);
      const lines = block.split("\n");
      const allCommented = lines.every((ln) => /^\s*\/\//.test(ln) || ln.trim() === "");
      const next = lines.map((ln) => {
        if (ln.trim() === "") return ln;
        if (allCommented) return ln.replace(/^(\s*)\/\/ ?/, "$1");
        const m = /^(\s*)/.exec(ln)!;
        return m[1] + "// " + ln.slice(m[1].length);
      }).join("\n");
      replaceRange(from, to, next, from, from + next.length);
      return;
    }

    // Ctrl/Cmd+Shift+D — duplicate line(s)
    if (mod && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      const le = v.indexOf("\n", en);
      const to = le < 0 ? v.length : le;
      const chunk = v.slice(ls, to);
      replaceRange(to, to, "\n" + chunk, s + 1 + chunk.length, en + 1 + chunk.length);
      return;
    }

    // Alt+↑/↓ — move line
    if (e.altKey && !mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      const le = v.indexOf("\n", en);
      const to = le < 0 ? v.length : le;
      const block = v.slice(ls, to);
      if (e.key === "ArrowUp") {
        if (ls === 0) return;
        const pls = v.lastIndexOf("\n", ls - 2) + 1;
        const prev = v.slice(pls, ls - 1);
        replaceRange(pls, to, block + "\n" + prev, s - (ls - pls), en - (ls - pls));
      } else {
        if (to === v.length) return;
        const nle = v.indexOf("\n", to + 1);
        const nto = nle < 0 ? v.length : nle;
        const next = v.slice(to + 1, nto);
        replaceRange(ls, nto, next + "\n" + block, s + next.length + 1, en + next.length + 1);
      }
      return;
    }

    // Ctrl/Cmd+M — jump to matching brace
    if (mod && !e.shiftKey && (e.key === "m" || e.key === "M")) {
      const match = braceMatch(v, tokenize(v), s);
      if (match?.ok && match.other >= 0) {
        e.preventDefault();
        el.selectionStart = el.selectionEnd = match.other + (match.other >= match.at ? 1 : 0);
        syncCursor(el);
      }
      return;
    }

    if (e.key === "Enter" && plain) {
      e.preventDefault();
      const ls = v.lastIndexOf("\n", s - 1) + 1;
      const indent = (/^ */.exec(v.slice(ls, s)) ?? [""])[0];
      const before = v[s - 1], after = v[s];
      if (OPENERS.has(before) && PAIR_OF[before] === after) {
        const mid = indent + "  ";
        typeText("\n" + mid + "\n" + indent);
        // caret should sit on the middle line — insertText leaves it after the whole insert
        const pos = s + 1 + mid.length;
        requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = pos; syncCursor(el); });
      } else {
        typeText("\n" + indent);
      }
      return;
    }

    if (e.key === "Backspace" && plain && s === en && s > 0 && PAIR_OF[v[s - 1]] === v[s] && OPENERS.has(v[s - 1])) {
      e.preventDefault();
      replaceRange(s - 1, s + 1, "");
      return;
    }

    if (plain && e.key.length === 1) {
      const k = e.key;
      if (QUOTES.has(k)) {
        if (s === en && v[s] === k) { e.preventDefault(); el.selectionStart = el.selectionEnd = s + 1; syncCursor(el); return; }
        if (s !== en) { e.preventDefault(); typeText(k + v.slice(s, en) + k); requestAnimationFrame(() => { el.selectionStart = s + 1; el.selectionEnd = en + 1; syncCursor(el); }); return; }
        if (!canPairBefore(v[s])) return;
        e.preventDefault();
        typeText(k + k);
        requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1; syncCursor(el); });
        return;
      }
      if (OPENERS.has(k)) {
        if (s !== en) {
          e.preventDefault();
          typeText(k + v.slice(s, en) + PAIR_OF[k]);
          requestAnimationFrame(() => { el.selectionStart = s + 1; el.selectionEnd = en + 1; syncCursor(el); });
          return;
        }
        if (!canPairBefore(v[s]) || !canPairBefore(v[s - 1])) return;
        e.preventDefault();
        typeText(k + PAIR_OF[k]);
        requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 1; syncCursor(el); });
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
