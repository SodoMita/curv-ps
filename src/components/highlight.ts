// A small, permissive tokenizer for Curv (plus the `solve { }` extension) used
// purely for syntax highlighting — it never throws, it just colours what it can.
// It mirrors the real lexer's token shapes (see src/curv/parser.ts: lex): the same
// keywords, comment forms, number guard against `..`, strings and quoted
// identifiers. Brackets () [] {} get their own span type so the editor can also
// use the token stream for pair matching (brackets inside strings and comments
// are part of those spans and therefore never counted).

export type SpanType =
  | "com" // // line and /* block */ comments
  | "str" // "…" strings
  | "qid" // 'quoted identifier'
  | "num" // 1  2.5  .5  1e-3
  | "kw" // let in solve var if then else …
  | "strength" // minimize maximize weak medium strong required
  | "lit" // true false null
  | "field" // .x field access
  | "op" // other operators & punctuation
  | "brace" // ( ) [ ] { }
  | "id";

export interface Span {
  start: number;
  end: number;
  type: SpanType;
}

const KEYWORDS = new Set([
  "let", "in", "where", "if", "then", "else", "for", "by", "solve", "var",
  "do", "local", "while", "until", "parametric", "include",
]);
const STRENGTHS = new Set(["minimize", "maximize", "weak", "medium", "strong", "required"]);
const LITERALS = new Set(["true", "false", "null"]);

// Multi-char operators, longest first (same list as the lexer).
const OPS = [">>", "<<", "==", "!=", "<=", ">=", "&&", "||", "->", "...", "..<", "..", ".[", ":=", "::",
  "+", "-", "*", "/", "^", "%", "<", ">", "=", ",", ";", ":", ".", "!", "@", "#"];

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdStart = (c: string) => /[A-Za-z_]/.test(c);

export function tokenize(src: string): Span[] {
  const spans: Span[] = [];
  const n = src.length;
  let i = 0;
  let expectField = false; // a bare '.' was just seen → next identifier is a field name
  const push = (start: number, end: number, type: SpanType) => { if (end > start) spans.push({ start, end, type }); };

  while (i < n) {
    const ch = src[i];
    if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
      if (ch === "\n") expectField = false;
      i++;
      continue;
    }
    // comments
    if (ch === "/" && src[i + 1] === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      push(i, j, "com"); i = j; expectField = false; continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const j = e < 0 ? n : e + 2;
      push(i, j, "com"); i = j; expectField = false; continue;
    }
    // string
    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') { if (src[j] === "\\") j++; j++; }
      j = Math.min(j + 1, n);
      push(i, j, "str"); i = j; expectField = false; continue;
    }
    // quoted identifier 'foo bar' — be forgiving about a missing close quote
    if (ch === "'") {
      const e = src.indexOf("'", i + 1);
      const nl = src.indexOf("\n", i + 1);
      const end = e < 0 ? n : nl >= 0 && nl < e ? nl : e + 1; // never swallow a whole file
      push(i, end, "qid"); i = end; expectField = false; continue;
    }
    // number (with the lexer's guard against eating the dot of a range `1..5`)
    if (isDigit(ch) || (ch === "." && isDigit(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(src.slice(i))!;
      let len = m[0].length;
      if (src[i + len - 1] === "." && src[i + len] === ".") len--;
      push(i, i + len, "num"); i += len; expectField = false; continue;
    }
    // identifier / keyword
    if (isIdStart(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const type: SpanType = expectField ? "field"
        : KEYWORDS.has(word) ? "kw"
        : STRENGTHS.has(word) ? "strength"
        : LITERALS.has(word) ? "lit" : "id";
      push(i, j, type); i = j; expectField = false; continue;
    }
    // a dot that starts a field access (not .. / ... / .[ — those are operators)
    if (ch === "." && isIdStart(src[i + 1] ?? "")) {
      push(i, i + 1, "op"); i++; expectField = true; continue;
    }
    // brackets — their own kind so the pair-matcher can see them
    if (ch === "(" || ch === ")" || ch === "[" || ch === "]" || ch === "{" || ch === "}") {
      push(i, i + 1, "brace"); i++; expectField = false; continue;
    }
    // operators (".[" emits an op '.' plus a brace '[' so pairs work there too)
    if (ch === "." && src[i + 1] === "[") {
      push(i, i + 1, "op"); push(i + 1, i + 2, "brace"); i += 2; expectField = false; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { push(i, i + op.length, "op"); i += op.length; expectField = false; continue; }
    // anything unexpected: paint as plain text and move on
    push(i, i + 1, "op"); i++; expectField = false;
  }
  return spans;
}

// ---------- brace matching ----------

const CLOSER_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const OPENER_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

export interface BraceMatch {
  at: number;    // offset of the bracket the cursor is on
  other: number; // offset of its partner, or -1 when unmatched
  ok: boolean;
}

// `pos` is the caret offset. Like most editors we look at the character just
// before the caret first, then the character just after it.
export function braceMatch(src: string, spans: Span[], pos: number): BraceMatch | null {
  const bs = spans.filter((s) => s.type === "brace");
  if (!bs.length) return null;
  let idx = bs.findIndex((b) => b.start === pos - 1);
  if (idx < 0) idx = bs.findIndex((b) => b.start === pos);
  if (idx < 0) return null;
  const ch = src[bs[idx].start];
  const at = bs[idx].start;
  if (CLOSER_OF[ch]) {
    let depth = 1;
    for (let j = idx + 1; j < bs.length; j++) {
      const c = src[bs[j].start];
      if (c === ch) depth++;
      else if (c === CLOSER_OF[ch] && --depth === 0) return { at, other: bs[j].start, ok: true };
    }
    return { at, other: -1, ok: false };
  }
  let depth = 1;
  for (let j = idx - 1; j >= 0; j--) {
    const c = src[bs[j].start];
    if (c === ch) depth++;
    else if (c === OPENER_OF[ch] && --depth === 0) return { at, other: bs[j].start, ok: true };
  }
  return { at, other: -1, ok: false };
}
