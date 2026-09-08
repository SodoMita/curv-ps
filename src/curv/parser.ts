// Lexer + parser for Curv (the subset used by the original curv examples) plus
// the `solve { }` constraint extension.
//
// Curv core:   let/in, where, do/local/:=/for/while/if statements, if (c) a else b,
//              lambdas (x -> e, [a,b] -> e), juxtaposition calls, >> and << pipes,
//              records {a: 1} / {a = 1;} / {... r}, lists, ranges a..b by s / a..<b,
//              comprehensions [for (i in l) if (c) e], parametric { x :: slider[0,1] = .5 } in ...
// Extension:   solve { var a, b : box; a.w == 2*b.w; weak: gap == 10; minimize e^2 }

export type Tok = { t: "num" | "str" | "id" | "op" | "eof"; v: string; pos: number; line: number };

const KEYWORDS = new Set([
  "let", "in", "where", "if", "then", "else", "for", "by", "solve", "var", "do", "local", "while", "until", "parametric", "include",
  "minimize", "maximize", "weak", "medium", "strong", "required", "true", "false", "null",
]);
const OPS = [">>", "<<", "==", "!=", "<=", ">=", "&&", "||", "->", "...", "..<", "..", ".[", ":=", "::",
  "+", "-", "*", "/", "^", "%", "<", ">", "=", "(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "!", "@", "#"];

export class CurvError extends Error {
  constructor(msg: string, public line?: number) { super(msg); }
}

export function lex(src: string): Tok[] {
  const toks: Tok[] = []; let i = 0, line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); const chunk = src.slice(i, e < 0 ? src.length : e + 2); line += (chunk.match(/\n/g) || []).length; i = e < 0 ? src.length : e + 2; continue; }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i.exec(src.slice(i))!;
      // avoid eating "..": "1..5"
      let text = m[0]; if (text.endsWith(".") && src[i + text.length] === ".") text = text.slice(0, -1);
      toks.push({ t: "num", v: text, pos: i, line }); i += text.length; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      toks.push({ t: "id", v: m[0], pos: i, line }); i += m[0].length; continue;
    }
    if (ch === "'") { // quoted identifier 'foo bar'
      const j = src.indexOf("'", i + 1); if (j < 0) throw new CurvError("Unterminated quoted identifier", line);
      toks.push({ t: "id", v: src.slice(i + 1, j), pos: i, line }); i = j + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== '"') { if (src[j] === "\\") { j++; s += src[j] === "n" ? "\n" : src[j]; } else if (src[j] === "$" && src[j + 1] === "$") { s += "$"; j++; } else s += src[j]; j++; }
      toks.push({ t: "str", v: s, pos: i, line }); i = j + 1; continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new CurvError(`Unexpected character '${ch}'`, line);
    toks.push({ t: "op", v: op, pos: i, line }); i += op.length;
  }
  toks.push({ t: "eof", v: "", pos: i, line });
  return toks;
}

// ---------------- AST ----------------
export type Pat = { k: "id"; name: string } | { k: "list"; items: Pat[] } | { k: "rec"; names: string[] } | { k: "any" };
export type Def = { pat: Pat; params: Pat[]; body: Expr; line: number };
export type Param = { name: string; label: string; pred: Expr; init: Expr; line: number };
export type ListItem =
  | { k: "expr"; e: Expr } | { k: "spread"; e: Expr }
  | { k: "for"; pat: Pat; iter: Expr; body: ListItem }
  | { k: "if"; cond: Expr; then: ListItem; else?: ListItem };
export type Stmt =
  | { k: "var"; names: string[]; type: string; count?: Expr; line: number }
  | { k: "def"; def: Def }
  | { k: "local"; def: Def; line: number }
  | { k: "assign"; name: string; e: Expr; line: number }
  | { k: "cons"; strength: string; weight?: Expr; e: Expr; line: number }
  | { k: "obj"; sense: "minimize" | "maximize"; e: Expr; line: number }
  | { k: "for"; pat: Pat; iter: Expr; until?: Expr; body: Stmt[]; line: number }
  | { k: "while"; cond: Expr; body: Stmt[]; line: number }
  | { k: "if"; cond: Expr; body: Stmt[]; else?: Stmt[]; line: number }
  | { k: "expr"; e: Expr; line: number };
export type Expr =
  | { k: "num"; v: number } | { k: "str"; v: string } | { k: "bool"; v: boolean } | { k: "null" }
  | { k: "id"; name: string; line: number }
  | { k: "list"; items: ListItem[] }
  | { k: "rec"; fields: { name: string; e: Expr }[]; defs: Def[]; spreads: Expr[] }
  | { k: "let"; defs: Def[]; body: Expr }
  | { k: "do"; stmts: Stmt[]; body: Expr; line: number }
  | { k: "parametric"; params: Param[]; body: Expr; line: number }
  | { k: "if"; cond: Expr; then: Expr; else: Expr }
  | { k: "lambda"; params: Pat[]; body: Expr }
  | { k: "call"; fn: Expr; arg: Expr; line: number }
  | { k: "field"; e: Expr; name: string; line: number }
  | { k: "index"; e: Expr; idx: Expr; line: number }
  | { k: "bin"; op: string; a: Expr; b: Expr; line: number }
  | { k: "cmp"; ops: string[]; args: Expr[]; line: number }
  | { k: "un"; op: string; e: Expr; line: number }
  | { k: "range"; a: Expr; b: Expr; step?: Expr; open?: boolean }
  | { k: "solve"; stmts: Stmt[]; line: number };

class Parser {
  i = 0;
  constructor(public toks: Tok[]) {}
  peek(o = 0) { return this.toks[Math.min(this.i + o, this.toks.length - 1)]; }
  next() { return this.toks[this.i++]; }
  is(v: string, o = 0) { const t = this.peek(o); return (t.t === "op" || t.t === "id") && t.v === v; }
  accept(v: string) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v: string) { if (!this.accept(v)) { const t = this.peek(); throw new CurvError(`Expected '${v}' but found '${t.v || "end of input"}'`, t.line); } }
  ident(): string { const t = this.next(); if (t.t !== "id" || KEYWORDS.has(t.v)) throw new CurvError(`Expected identifier, found '${t.v}'`, t.line); return t.v; }

  program(): Expr {
    // a top-level program may be a bare definition list (a module) – treat as record
    const e = this.expr();
    if (this.peek().t !== "eof") throw new CurvError(`Unexpected '${this.peek().v}'`, this.peek().line);
    return e;
  }

  expr(): Expr {
    if (this.is("let")) { this.next(); const defs = this.defs("in"); this.expect("in"); return { k: "let", defs, body: this.expr() }; }
    if (this.is("do")) { const line = this.next().line; const stmts = this.stmtsUntil("in"); this.expect("in"); return { k: "do", stmts, body: this.expr(), line }; }
    if (this.is("parametric")) {
      const line = this.next().line; const params: Param[] = [];
      while (!this.is("in") && this.peek().t !== "eof") {
        const pl = this.peek().line;
        let label = ""; let name: string;
        const first = this.ident();
        if (this.accept(":")) { label = first; name = this.ident(); } else name = first;
        this.expect("::"); const pred = this.pipeNoWhere(); this.expect("="); const init = this.expr();
        params.push({ name, label: label || name, pred, init, line: pl });
        if (!this.accept(";")) break;
      }
      this.expect("in"); return { k: "parametric", params, body: this.expr(), line };
    }
    if (this.is("if")) {
      this.next();
      let cond: Expr;
      if (this.is("(")) { cond = this.selectors(this.primary()); this.accept("then"); }
      else { cond = this.expr(); this.expect("then"); }
      const then = this.expr(); this.expect("else"); return { k: "if", cond, then, else: this.expr() };
    }
    // lambda lookahead
    const save = this.i;
    const pat = this.tryPattern();
    if (pat && this.is("->")) { this.next(); return { k: "lambda", params: [pat], body: this.expr() }; }
    this.i = save;
    let e = this.pipe();
    if (this.is("where")) {
      this.next();
      const close = this.accept("{") ? "}" : this.accept("(") ? ")" : null;
      const defs = this.defs(null); if (close) this.expect(close);
      e = { k: "let", defs, body: e };
    }
    return e;
  }
  pipeNoWhere(): Expr { return this.pipe(); }
  tryPattern(): Pat | null {
    const t = this.peek();
    let p: Pat | null = null;
    if (t.t === "id" && !KEYWORDS.has(t.v)) { this.i++; p = t.v === "_" ? { k: "any" } : { k: "id", name: t.v }; }
    else if (this.is("(") || this.is("[")) {
      const close = this.is("(") ? ")" : "]"; this.i++;
      const items: Pat[] = [];
      while (!this.is(close)) { const q = this.tryPattern(); if (!q) return null; items.push(q); if (!this.accept(",")) break; }
      if (!this.accept(close)) return null;
      p = { k: "list", items };
    } else if (this.is("{")) {
      this.i++; const names: string[] = [];
      while (!this.is("}")) { const t2 = this.peek(); if (t2.t !== "id") return null; this.i++; names.push(t2.v); if (this.accept(":")) { const q = this.tryPattern(); if (!q) return null; } if (!this.accept(",") && !this.accept(";")) break; }
      if (!this.accept("}")) return null; p = { k: "rec", names };
    }
    if (p && this.is("::")) { this.next(); this.postfix(); } // type predicate: parsed & ignored
    return p;
  }
  defs(terminator: string | null): Def[] {
    const defs: Def[] = [];
    while (!(terminator ? this.is(terminator) : false) && this.peek().t !== "eof" && !this.is("}") && !this.is(")")) {
      if (this.is("include")) { const t = this.next(); throw new CurvError("'include' is not supported in the playground (the std library is built in)", t.line); }
      defs.push(this.def());
      if (!this.accept(";")) break;
    }
    return defs;
  }
  def(): Def {
    const line = this.peek().line;
    const pat = this.tryPattern(); if (!pat) throw new CurvError("Expected definition", line);
    const params: Pat[] = [];
    while (!this.is("=")) { const p = this.tryPattern(); if (!p) throw new CurvError("Expected '=' in definition", line); params.push(p); }
    this.expect("=");
    return { pat, params, body: this.expr(), line };
  }
  pipe(): Expr {
    let a = this.disj();
    for (;;) {
      if (this.is(">>")) { const line = this.next().line; const f = this.disj(); a = { k: "call", fn: f, arg: a, line }; continue; }
      if (this.is("<<")) { const line = this.next().line; const x = this.pipe(); return { k: "call", fn: a, arg: x, line }; } // right assoc
      return a;
    }
  }
  disj(): Expr { let a = this.conj(); while (this.is("||")) { const line = this.next().line; a = { k: "bin", op: "||", a, b: this.conj(), line }; } return a; }
  conj(): Expr { let a = this.cmp(); while (this.is("&&")) { const line = this.next().line; a = { k: "bin", op: "&&", a, b: this.cmp(), line }; } return a; }
  cmp(): Expr {
    const first = this.range(); const args = [first]; const ops: string[] = []; const line = this.peek().line;
    while (["==", "!=", "<", "<=", ">", ">="].some((o) => this.is(o))) { ops.push(this.next().v); args.push(this.range()); }
    return ops.length ? { k: "cmp", ops, args, line } : first;
  }
  range(): Expr {
    const a = this.add();
    if (this.is("..") || this.is("..<")) { const open = this.next().v === "..<"; const b = this.add(); let step: Expr | undefined; if (this.is("by")) { this.next(); step = this.add(); } return { k: "range", a, b, step, open }; }
    return a;
  }
  add(): Expr { let a = this.mul(); while (this.is("+") || this.is("-")) { const t = this.next(); a = { k: "bin", op: t.v, a, b: this.mul(), line: t.line }; } return a; }
  mul(): Expr { let a = this.unary(); while (this.is("*") || this.is("/") || this.is("%")) { const t = this.next(); a = { k: "bin", op: t.v, a, b: this.unary(), line: t.line }; } return a; }
  unary(): Expr {
    if (this.is("-")) { const t = this.next(); return { k: "un", op: "-", e: this.unary(), line: t.line }; }
    if (this.is("+")) { this.next(); return this.unary(); }
    if (this.is("!")) { const t = this.next(); return { k: "un", op: "!", e: this.unary(), line: t.line }; }
    return this.pow();
  }
  pow(): Expr { const a = this.postfix(); if (this.is("^")) { const t = this.next(); return { k: "bin", op: "^", a, b: this.unary(), line: t.line }; } return a; }
  startsPrimary(): boolean {
    const t = this.peek();
    if (t.t === "num" || t.t === "str") return true;
    if (t.t === "id") return !KEYWORDS.has(t.v) || t.v === "solve" || t.v === "true" || t.v === "false" || t.v === "null";
    return t.t === "op" && (t.v === "(" || t.v === "[" || t.v === "{");
  }
  /** Field/index continuations (`e.f`, `e.[i]`) applied to `e`.  These bind tighter than
   *  juxtaposition, so `f a.b` == `f (a.b)` — a deliberate curv-ps choice that keeps the
   *  existing examples / prelude (written in this style) unambiguous. */
  selectors(e: Expr): Expr {
    for (;;) {
      if (this.is(".[")) { const t = this.next(); const idx = this.expr(); this.expect("]"); e = { k: "index", e, idx, line: t.line }; continue; }
      if (this.is(".") && this.peek(1).t === "id") { const t = this.next(); e = { k: "field", e, name: this.ident(), line: t.line }; continue; }
      return e;
    }
  }
  postfix(): Expr {
    // selectors (.field / .[i]) bind tighter than juxtaposition:  f a.b c  ==  f (a.b) c
    // exception: a number literal has no fields, so `smooth 1 .union` == (smooth 1).union
    let e = this.selectors(this.primary());
    while (this.startsPrimary()) {
      const line = this.peek().line; const isNum = this.peek().t === "num";
      const prim = this.primary();
      const arg = isNum ? prim : this.selectors(prim);
      e = { k: "call", fn: e, arg, line };
      if (isNum) e = this.selectors(e);
    }
    return e;
  }
  primary(): Expr {
    const t = this.next();
    if (t.t === "num") return { k: "num", v: parseFloat(t.v) };
    if (t.t === "str") return { k: "str", v: t.v };
    if (t.t === "id") {
      if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true" };
      if (t.v === "null") return { k: "null" };
      if (t.v === "solve") { this.expect("{"); const stmts = this.stmts(); this.expect("}"); return { k: "solve", stmts, line: t.line }; }
      if (KEYWORDS.has(t.v)) throw new CurvError(`Unexpected keyword '${t.v}'`, t.line);
      return { k: "id", name: t.v, line: t.line };
    }
    if (t.v === "(") {
      if (this.accept(")")) return { k: "list", items: [] };
      const first = this.expr();
      if (this.is(",")) { const items: ListItem[] = [{ k: "expr", e: first }]; while (this.accept(",")) { if (this.is(")")) break; items.push({ k: "expr", e: this.expr() }); } this.expect(")"); return { k: "list", items }; }
      this.expect(")"); return first;
    }
    if (t.v === "[") { const items: ListItem[] = []; while (!this.is("]")) { items.push(this.listItem()); if (!this.accept(",")) break; } this.expect("]"); return { k: "list", items }; }
    if (t.v === "{") return this.record();
    throw new CurvError(`Unexpected '${t.v || "end of input"}'`, t.line);
  }
  listItem(): ListItem {
    if (this.is("for")) { this.next(); this.expect("("); const pat = this.tryPattern(); if (!pat) throw new CurvError("Bad for pattern", this.peek().line); this.expect("in"); const iter = this.expr(); this.expect(")"); return { k: "for", pat, iter, body: this.listItem() }; }
    if (this.is("if")) { this.next(); this.expect("("); const cond = this.expr(); this.expect(")"); const then = this.listItem(); let els: ListItem | undefined; if (this.is("else")) { this.next(); els = this.listItem(); } return { k: "if", cond, then, else: els }; }
    if (this.is("...")) { this.next(); return { k: "spread", e: this.expr() }; }
    return { k: "expr", e: this.expr() };
  }
  record(): Expr {
    const fields: { name: string; e: Expr }[] = []; const defs: Def[] = []; const spreads: Expr[] = [];
    while (!this.is("}")) {
      const t = this.peek();
      if (this.is("...")) { this.next(); spreads.push(this.expr()); }
      else if ((t.t === "id" || t.t === "str") && this.is(":", 1)) { this.next(); this.next(); fields.push({ name: t.v, e: this.expr() }); }
      else if (this.is("include")) { throw new CurvError("'include' is not supported in the playground", t.line); }
      else defs.push(this.def());
      if (!this.accept(",") && !this.accept(";")) break;
    }
    this.expect("}");
    return { k: "rec", fields, defs, spreads };
  }
  // ---- statements (solve blocks and do blocks) ----
  stmts(): Stmt[] { const out: Stmt[] = []; while (!this.is("}") && !this.is(")") && this.peek().t !== "eof") { out.push(this.stmt()); this.accept(";"); } return out; }
  stmtsUntil(kw: string): Stmt[] { const out: Stmt[] = []; while (!this.is(kw) && this.peek().t !== "eof") { out.push(this.stmt()); if (!this.accept(";")) break; } return out; }
  block(): Stmt[] {
    if (this.accept("{")) { const s = this.stmts(); this.expect("}"); return s; }
    if (this.is("(")) { // compound statement (a; b; c) – but could also be an expression statement starting with (
      const save = this.i; this.next();
      try { const s = this.stmts(); this.expect(")"); return s; } catch { this.i = save; }
    }
    return [this.stmt()];
  }
  stmt(): Stmt {
    const t = this.peek(); const line = t.line;
    if (this.is("var")) {
      this.next(); const names = [this.ident()]; while (this.accept(",")) names.push(this.ident());
      let type = "num"; let count: Expr | undefined;
      if (this.accept(":")) { type = this.ident(); if (this.accept("[")) { count = this.expr(); this.expect("]"); } }
      return { k: "var", names, type, count, line };
    }
    if (this.is("local")) { this.next(); return { k: "local", def: this.def(), line }; }
    if (this.is("minimize") || this.is("maximize")) { const s = this.next().v as "minimize" | "maximize"; return { k: "obj", sense: s, e: this.expr(), line }; }
    if (this.is("for")) {
      this.next(); this.expect("("); const pat = this.tryPattern(); if (!pat) throw new CurvError("Bad for pattern", line); this.expect("in"); const iter = this.expr();
      let until: Expr | undefined; if (this.accept("until")) until = this.expr();
      this.expect(")"); return { k: "for", pat, iter, until, body: this.block(), line };
    }
    if (this.is("while")) { this.next(); this.expect("("); const cond = this.expr(); this.expect(")"); return { k: "while", cond, body: this.block(), line }; }
    if (this.is("if")) { this.next(); this.expect("("); const cond = this.expr(); this.expect(")"); const body = this.block(); let els: Stmt[] | undefined; if (this.accept("else")) els = this.block(); return { k: "if", cond, body, else: els, line }; }
    if (["weak", "medium", "strong", "required"].some((s) => this.is(s))) {
      const strength = this.next().v; let weight: Expr | undefined;
      if (!this.is(":")) weight = this.unary();
      this.expect(":"); return { k: "cons", strength, weight, e: this.expr(), line };
    }
    if (this.is("(") ) { // compound statement inside a block
      const save = this.i; this.next();
      try { const s = this.stmts(); this.expect(")"); return { k: "if", cond: { k: "bool", v: true }, body: s, line }; } catch { this.i = save; }
    }
    if (t.t === "id" && this.is(":=", 1)) { this.next(); this.next(); return { k: "assign", name: t.v, e: this.expr(), line }; }
    // local definition:  name = expr   (single '=' not followed by '=')
    if (t.t === "id" && this.is("=", 1)) return { k: "def", def: this.def() };
    const e = this.expr();
    if (e.k === "cmp") return { k: "cons", strength: "required", e, line };
    return { k: "expr", e, line };
  }
}

export function parse(src: string): Expr { return new Parser(lex(src)).program(); }
