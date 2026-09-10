// Static free-variable analysis for `solve { }` blocks (and closure bodies).
//
// A block whose free variables have the same values as last time builds the same problem and
// therefore has the same solution, so the interpreter can skip constraint construction,
// presolve and psolve altogether (see Interp.solve).  The analysis is conservative in the
// safe direction: when in doubt a name is reported as *free* (an extra name is merely hashed,
// or skipped when it does not exist in the enclosing environment).  It mirrors the binding
// order of the evaluator (bindDefs binds function definitions first, then values in order).
import type { Expr, Stmt, Pat, ListItem, Def } from "./parser";

export interface FreeInfo {
  /** names referenced by the block that are not bound inside it (in first-use order) */
  free: string[];
  /** false when the block assigns (`x := …`) to a variable it does not own, or reads `parametric` inputs
   *  (host state that is not in the environment) — effects that must not be skipped */
  pure: boolean;
  /** why `pure` is false */
  why?: string;
}

const isFnDef = (d: Def) => d.params.length > 0 || d.body.k === "lambda";

function patNames(p: Pat, out: Set<string>) {
  switch (p.k) {
    case "id": out.add(p.name); break;
    case "list": for (const q of p.items) patNames(q, out); break;
    case "rec": for (const n of p.names) out.add(n); break;
    case "any": break;
  }
}

class FV {
  free = new Set<string>();
  pure = true; why?: string;
  impure(why: string) { if (this.pure) { this.pure = false; this.why = why; } }
  /** the body of a definition, with its parameters bound */
  defBody(d: Def, scope: Set<string>) {
    if (d.params.length === 0) { this.expr(d.body, scope); return; }
    const s2 = new Set(scope); for (const p of d.params) patNames(p, s2); this.expr(d.body, s2);
  }
  /** let / record definitions: functions are visible everywhere, values only after their own definition */
  defs(defs: Def[], scope: Set<string>) {
    for (const d of defs) if (isFnDef(d)) patNames(d.pat, scope);
    for (const d of defs) if (isFnDef(d)) this.defBody(d, scope);
    for (const d of defs) if (!isFnDef(d)) { this.defBody(d, scope); patNames(d.pat, scope); }
  }
  listItem(it: ListItem, scope: Set<string>) {
    switch (it.k) {
      case "expr": case "spread": this.expr(it.e, scope); break;
      case "for": { this.expr(it.iter, scope); const s2 = new Set(scope); patNames(it.pat, s2); this.listItem(it.body, s2); break; }
      case "if": this.expr(it.cond, scope); this.listItem(it.then, scope); if (it.else) this.listItem(it.else, scope); break;
    }
  }
  /** sequential statements (do / solve): bindings become visible to later statements */
  stmts(ss: Stmt[], scope: Set<string>) {
    for (const s of ss) {
      switch (s.k) {
        case "var": if (s.count) this.expr(s.count, scope); for (const n of s.names) scope.add(n); break;
        case "def": case "local": {
          const d = s.def;
          if (isFnDef(d)) { patNames(d.pat, scope); this.defBody(d, scope); } // recursion: name visible in its own body
          else { this.defBody(d, scope); patNames(d.pat, scope); }          // `local x = x + 1` reads the outer x
          break;
        }
        case "assign": if (!scope.has(s.name)) this.impure("assigns to an outer variable"); this.expr(s.e, scope); break;
        case "cons": if (s.weight) this.expr(s.weight, scope); this.expr(s.e, scope); break;
        case "obj": case "expr": this.expr(s.e, scope); break;
        case "for": { this.expr(s.iter, scope); const s2 = new Set(scope); patNames(s.pat, s2); if (s.until) this.expr(s.until, s2); this.stmts(s.body, s2); break; }
        case "while": this.expr(s.cond, scope); this.stmts(s.body, new Set(scope)); break;
        case "if": this.expr(s.cond, scope); this.stmts(s.body, new Set(scope)); if (s.else) this.stmts(s.else, new Set(scope)); break;
      }
    }
  }
  expr(e: Expr, scope: Set<string>) {
    switch (e.k) {
      case "num": case "str": case "bool": case "null": return;
      case "id": if (!scope.has(e.name)) this.free.add(e.name); return;
      case "list": for (const it of e.items) this.listItem(it, scope); return;
      case "rec": {
        // spreads are evaluated first and their fields become bindings we cannot know statically;
        // treating later uses of those names as free only over-approximates (safe)
        const s2 = new Set(scope);
        for (const s of e.spreads) this.expr(s, scope);
        this.defs(e.defs, s2);
        for (const f of e.fields) this.expr(f.e, s2);
        return;
      }
      case "let": { const s2 = new Set(scope); this.defs(e.defs, s2); this.expr(e.body, s2); return; }
      case "do": { const s2 = new Set(scope); this.stmts(e.stmts, s2); this.expr(e.body, s2); return; }
      case "parametric": { this.impure("reads parametric inputs"); const s2 = new Set(scope); for (const p of e.params) { this.expr(p.pred, scope); this.expr(p.init, scope); s2.add(p.name); } this.expr(e.body, s2); return; }
      case "if": this.expr(e.cond, scope); this.expr(e.then, scope); this.expr(e.else, scope); return;
      case "lambda": { const s2 = new Set(scope); for (const p of e.params) patNames(p, s2); this.expr(e.body, s2); return; }
      case "call": this.expr(e.fn, scope); this.expr(e.arg, scope); return;
      case "field": this.expr(e.e, scope); return;
      case "index": this.expr(e.e, scope); this.expr(e.idx, scope); return;
      case "bin": this.expr(e.a, scope); this.expr(e.b, scope); return;
      case "cmp": for (const a of e.args) this.expr(a, scope); return;
      case "un": this.expr(e.e, scope); return;
      case "range": this.expr(e.a, scope); this.expr(e.b, scope); if (e.step) this.expr(e.step, scope); return;
      case "solve": this.stmts(e.stmts, new Set(scope)); return;
    }
  }
}

const blockMemo = new WeakMap<Stmt[], FreeInfo>();
/** Free variables of a `solve { }` block (memoised on the AST node, which is immutable and cached per source). */
export function freeVarsOfBlock(stmts: Stmt[]): FreeInfo {
  let r = blockMemo.get(stmts);
  if (!r) { const fv = new FV(); fv.stmts(stmts, new Set()); r = { free: [...fv.free], pure: fv.pure, why: fv.why }; blockMemo.set(stmts, r); }
  return r;
}

const exprMemo = new WeakMap<Expr, FreeInfo>();
/** Free variables of an arbitrary expression in an empty scope (round 16: the expression-level memo
 *  keys on these; same analysis, same never-under-approximate guarantee). */
export function freeVarsOfExpr(e: Expr): FreeInfo {
  let r = exprMemo.get(e);
  if (!r) { const fv = new FV(); fv.expr(e, new Set()); r = { free: [...fv.free], pure: fv.pure, why: fv.why }; exprMemo.set(e, r); }
  return r;
}

const fnMemo = new WeakMap<Expr, Map<number, FreeInfo>>();
/** Free variables of a closure body given the parameters that are still unapplied (`params.slice(i)`). */
export function freeVarsOfFn(params: Pat[], body: Expr): FreeInfo {
  let byArity = fnMemo.get(body);
  if (!byArity) { byArity = new Map(); fnMemo.set(body, byArity); }
  let r = byArity.get(params.length);
  if (!r) { const fv = new FV(); const s = new Set<string>(); for (const p of params) patNames(p, s); fv.expr(body, s); r = { free: [...fv.free], pure: fv.pure, why: fv.why }; byArity.set(params.length, r); }
  return r;
}

let nextId = 1;
const ids = new WeakMap<object, number>();
/** A stable small integer for an AST node (identity), so a cache key can name "this block / this function body". */
export function astId(node: object): number {
  let id = ids.get(node);
  if (id === undefined) { id = nextId++; ids.set(node, id); }
  return id;
}
