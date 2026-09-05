// SubCurv: compiles Curv functions (closures over interpreter values) into
// shader code via a Gen backend.  Sub-expressions whose operands are all known
// at compile time are evaluated by the interpreter; everything that depends on
// the pixel position (or on a loop variable / mutable local) becomes shader
// code.  Function calls are inlined.
import { CurvError, type Expr, type Pat, type Stmt } from "./parser";
import { type Gen, type E, GenError } from "../gpu/gen";
import { Fn, Rec, Env, Interp, arith, show, typeName, type Value } from "./interp";
import type { GenCtx } from "./shapes";

export type CV =
  | { kind: "static"; v: Value; lit?: boolean }
  | { kind: "dyn"; e: E }
  | { kind: "var"; ref: E }
  | { kind: "list"; items: CV[] }
  | { kind: "cfn"; params: Pat[]; body: Expr; env: CEnv; name: string };

export class CEnv {
  vars = new Map<string, CV>();
  constructor(public parent: CEnv | null, public fallback: Env | null) {}
  lookup(n: string): CV | undefined {
    let e: CEnv | null = this;
    while (e) { if (e.vars.has(n)) return e.vars.get(n); if (e.fallback) { const v = e.fallback.lookup(n); if (v !== undefined) return { kind: "static", v }; } e = e.parent; }
    return undefined;
  }
  child() { return new CEnv(this, null); }
}

const isNum = (v: Value): v is number => typeof v === "number";

/** names assigned with := anywhere inside an expression (conservative, ignores scoping) */
function assignedNames(e: Expr, out = new Set<string>()): Set<string> {
  const stmts = (ss: Stmt[]) => { for (const s of ss) {
    if (s.k === "assign") { out.add(s.name); assignedNames(s.e, out); }
    else if (s.k === "for") { assignedNames(s.iter, out); if (s.until) assignedNames(s.until, out); stmts(s.body); }
    else if (s.k === "while") { assignedNames(s.cond, out); stmts(s.body); }
    else if (s.k === "if") { assignedNames(s.cond, out); stmts(s.body); if (s.else) stmts(s.else); }
    else if (s.k === "local" || s.k === "def") assignedNames(s.def.body, out);
    else if (s.k === "expr" || s.k === "cons" || s.k === "obj") assignedNames(s.e, out);
  } };
  switch (e.k) {
    case "do": stmts(e.stmts); assignedNames(e.body, out); break;
    case "let": for (const d of e.defs) assignedNames(d.body, out); assignedNames(e.body, out); break;
    case "if": assignedNames(e.cond, out); assignedNames(e.then, out); assignedNames(e.else, out); break;
    case "call": assignedNames(e.fn, out); assignedNames(e.arg, out); break;
    case "bin": assignedNames(e.a, out); assignedNames(e.b, out); break;
    case "cmp": e.args.forEach((a) => assignedNames(a, out)); break;
    case "un": case "field": assignedNames(e.e, out); break;
    case "index": assignedNames(e.e, out); assignedNames(e.idx, out); break;
    case "lambda": assignedNames(e.body, out); break;
    case "list": for (const it of e.items) if (it.k === "expr" || it.k === "spread") assignedNames(it.e, out); break;
    case "parametric": assignedNames(e.body, out); break;
    default: break;
  }
  return out;
}
const err = (m: string, line?: number) => new CurvError(m, line);

export class SC {
  constructor(public g: Gen, public it: Interp, public ctx: GenCtx) {}

  static(v: Value, lit = false): CV { return { kind: "static", v, lit }; }
  isStatic(c: CV): c is { kind: "static"; v: Value; lit?: boolean } { return c.kind === "static"; }

  /** Convert a compile-time value into a shader expression. */
  toE(c: CV, line?: number): E {
    const g = this.g;
    switch (c.kind) {
      case "dyn": return c.e;
      case "var": return c.ref;
      case "list": return g.vec(c.items.map((x) => this.toE(x, line)));
      case "cfn": throw err(`Function '${c.name}' used as a value in shader code`, line);
      case "static": {
        const v = c.v;
        if (isNum(v)) return c.lit ? g.num(v) : g.param(v);
        if (typeof v === "boolean") return g.bool(v);
        if (Array.isArray(v)) { if (v.length < 2 || v.length > 4) throw err(`Only vectors of 2..4 numbers can be used in shader code (got ${v.length} items)`, line); return g.vec(v.map((x) => this.toE({ kind: "static", v: x, lit: c.lit }, line))); }
        throw err(`A ${typeName(v)} cannot be used in shader code`, line);
      }
    }
  }
  /** items of a list-like value (list literal, static list or dynamic vector) */
  items(c: CV, line?: number): CV[] | null {
    if (c.kind === "list") return c.items;
    if (c.kind === "static") return Array.isArray(c.v) ? c.v.map((x) => ({ kind: "static", v: x, lit: c.lit })) : null;
    const e = this.toE(c, line); if (e.t === "f" || e.t === "b") return null;
    const t = this.g.let(e); const n = e.t === "v2" ? 2 : e.t === "v3" ? 3 : 4;
    return Array.from({ length: n }, (_, i) => ({ kind: "dyn", e: this.g.idx(t, i) }));
  }
  allStatic(cs: CV[]): boolean { return cs.every((c) => c.kind === "static" || (c.kind === "list" && this.allStatic(c.items))); }
  staticValue(c: CV, line?: number): Value {
    if (c.kind === "static") return c.v;
    if (c.kind === "list") return c.items.map((x) => this.staticValue(x, line));
    throw err("Expected a compile-time constant", line);
  }
  dyn(e: E): CV { return { kind: "dyn", e }; }

  // ---------------- entry point: apply a function value to arguments
  call(f: CV, arg: CV, line?: number): CV {
    if (f.kind === "cfn") return this.inline(f.params, f.body, f.env, arg, f.name, line);
    if (f.kind === "static") {
      const fv = f.v;
      if (fv instanceof Fn) {
        if (fv.sc) return fv.sc(this, arg, line);
        if (fv.closure) { const env = new CEnv(null, fv.closure.env); return this.inline(fv.closure.params, fv.closure.body, env, arg, fv.name, line); }
        if (this.allStatic([arg])) return this.static(fv.call(this.staticValue(arg), line));
        throw err(`'${fv.name}' cannot be used in shader code (its argument depends on the pixel position)`, line);
      }
      if (Array.isArray(fv) || fv instanceof Rec) return this.index(f, arg, line);
      throw err(`Cannot call a ${typeName(fv)}`, line);
    }
    throw err("Cannot call a shader value", line);
  }
  inline(params: Pat[], body: Expr, env: CEnv, arg: CV, name: string, line?: number): CV {
    const e2 = env.child(); this.bind(params[0], arg, e2, line);
    if (params.length > 1) return { kind: "cfn", params: params.slice(1), body, env: e2, name };
    return this.expr(body, e2);
  }
  bind(p: Pat, v: CV, env: CEnv, line?: number) {
    if (p.k === "any") return;
    if (p.k === "id") { env.vars.set(p.name, v); return; }
    if (p.k === "list") {
      const items = this.items(v, line); if (!items || items.length !== p.items.length) throw err(`Pattern expects a list of ${p.items.length}`, line);
      p.items.forEach((q, i) => this.bind(q, items[i], env, line)); return;
    }
    if (v.kind !== "static" || !(v.v instanceof Rec)) throw err("Record patterns need a compile-time record", line);
    for (const n of p.names) { const f = v.v.get(n); if (f === undefined) throw err(`Record has no field '${n}'`, line); env.vars.set(n, this.static(f)); }
  }
  index(c: CV, i: CV, line?: number): CV {
    if (i.kind === "list" && i.items.length === 1) i = i.items[0];
    if (c.kind === "static" && (i.kind === "static")) return this.static(this.it.index(c.v, i.v, line));
    const idxs = i.kind === "static" && Array.isArray(i.v) ? i.v : i.kind === "list" ? i.items.map((x) => this.staticValue(x, line)) : null;
    if (idxs) { const t = this.g.let(this.toE(c, line)); return this.dyn(this.g.swz(t, idxs.map((k) => { if (!isNum(k)) throw err("Index must be a number", line); return k; }))); }
    if (i.kind === "static" && isNum(i.v)) {
      if (c.kind === "list") return c.items[i.v] ?? (() => { throw err(`Index ${i.v} out of range`, line); })();
      return this.dyn(this.g.idx(this.g.let(this.toE(c, line)), i.v));
    }
    // dynamic index into a small static list: select chain
    const items = this.items(c, line); if (!items) throw err("Cannot index this value in shader code", line);
    const ie = this.g.let(this.toE(i, line)); let acc = this.toE(items[items.length - 1], line);
    for (let k = items.length - 2; k >= 0; k--) acc = this.g.sel(this.g.cmp("<", ie, this.g.num(k + 0.5)), this.toE(items[k], line), acc);
    return this.dyn(acc);
  }

  // ---------------- expressions
  expr(e: Expr, env: CEnv): CV {
    const g = this.g;
    switch (e.k) {
      case "num": return this.static(e.v, true);
      case "str": case "bool": return this.static(e.v, true);
      case "null": return this.static(null, true);
      case "id": {
        if (e.name === "time") this.it.usesTime = true;
        const v = env.lookup(e.name); if (v === undefined) throw err(`Unknown identifier '${e.name}'`, e.line);
        if (v.kind === "static" && (e.name === "pi" || e.name === "tau" || e.name === "e" || e.name === "inf" || e.name === "deg")) return { ...v, lit: true };
        return v;
      }
      case "list": {
        const items: CV[] = [];
        for (const it of e.items) {
          if (it.k === "expr") items.push(this.expr(it.e, env));
          else if (it.k === "spread") { const s = this.items(this.expr(it.e, env), undefined); if (!s) throw err("Can only spread a list"); items.push(...s); }
          else { const out: Value[] = []; this.it.listItem(it, this.staticEnv(env), out); items.push(...out.map((v) => this.static(v))); }
        }
        if (items.every((c) => c.kind === "static")) return this.static(items.map((c) => (c as { v: Value }).v), items.every((c) => (c as { lit?: boolean }).lit));
        return { kind: "list", items };
      }
      case "rec": return this.static(this.it.eval(e, this.staticEnv(env)));
      case "let": { const e2 = env.child(); this.bindDefs(e.defs, e2, assignedNames(e.body)); return this.expr(e.body, e2); }
      case "do": { const e2 = env.child(); this.exec(e.stmts, e2); return this.expr(e.body, e2); }
      case "parametric": throw err("parametric is only allowed at the top level of a program", e.line);
      case "if": {
        const c = this.expr(e.cond, env);
        if (c.kind === "static") { if (typeof c.v !== "boolean") throw err("Expected a boolean condition"); return c.v ? this.expr(e.then, env) : this.expr(e.else, env); }
        const ce = g.let(this.toE(c));
        const a = this.expr(e.then, env), b = this.expr(e.else, env);
        if (a.kind === "static" && b.kind === "static" && !isNum(a.v) && !Array.isArray(a.v)) throw err("Both branches of a shader 'if' must be numbers or vectors");
        return this.dyn(g.sel(ce, this.toE(a), this.toE(b)));
      }
      case "lambda": return { kind: "cfn", params: e.params, body: e.body, env, name: "λ" };
      case "call": return this.call(this.expr(e.fn, env), this.expr(e.arg, env), e.line);
      case "index": return this.index(this.expr(e.e, env), this.expr(e.idx, env), e.line);
      case "field": {
        const v = this.expr(e.e, env);
        if (v.kind === "static") return this.static(this.it.field(v.v, e.name, e.line));
        if (["x", "y", "z", "w"].includes(e.name)) return this.dyn(g.idx(g.let(this.toE(v)), "xyzw".indexOf(e.name)));
        throw err(`Cannot take field '.${e.name}' of a shader value`, e.line);
      }
      case "un": {
        const v = this.expr(e.e, env);
        if (v.kind === "static") return this.static(e.op === "!" ? !v.v : arith("*", v.v, -1, e.line), v.lit);
        return this.dyn(e.op === "!" ? g.not(this.toE(v)) : g.neg(this.toE(v)));
      }
      case "bin": {
        const a = this.expr(e.a, env), b = this.expr(e.b, env);
        if (e.op === "&&" || e.op === "||") {
          if (a.kind === "static" && b.kind === "static") return this.static(e.op === "&&" ? (a.v as boolean) && (b.v as boolean) : (a.v as boolean) || (b.v as boolean));
          return this.dyn(g.logic(e.op, this.toE(a), this.toE(b)));
        }
        if (a.kind === "static" && b.kind === "static") return this.static(arith(e.op, a.v, b.v, e.line), a.lit && b.lit);
        if ((a.kind === "list" || b.kind === "list") && this.allStatic([a, b])) return this.static(arith(e.op, this.staticValue(a), this.staticValue(b), e.line));
        try { return this.dyn(g.bin(e.op, this.toE(a, e.line), this.toE(b, e.line))); }
        catch (x) { if (x instanceof GenError) throw err(x.message, e.line); throw x; }
      }
      case "cmp": {
        const vals = e.args.map((a) => this.expr(a, env));
        if (vals.every((v) => v.kind === "static")) return this.static(this.it.eval(e, this.staticEnv(env)));
        let acc: E | null = null;
        for (let i = 0; i < e.ops.length; i++) {
          const c = g.cmp(e.ops[i], this.toE(vals[i], e.line), this.toE(vals[i + 1], e.line));
          acc = acc ? g.logic("&&", acc, c) : c;
        }
        return this.dyn(acc!);
      }
      case "range": {
        const a = this.expr(e.a, env), b = this.expr(e.b, env), s = e.step ? this.expr(e.step, env) : this.static(1, true);
        if (this.allStatic([a, b, s])) return this.static(this.it.eval(e, this.staticEnv(env)));
        throw err("A range with shader-dependent bounds can only be used in a for loop", undefined);
      }
      case "solve": return this.static(this.it.eval(e, this.staticEnv(env)));
    }
  }
  /** interpreter Env view of a compile-time env (static bindings only) */
  staticEnv(env: CEnv): Env {
    const chain: CEnv[] = []; for (let e: CEnv | null = env; e; e = e.parent) chain.push(e);
    let out: Env | null = null;
    for (const ce of chain.reverse()) {
      out = new Env(new Map(), ce.fallback ?? out);
      for (const [k, v] of ce.vars) if (v.kind === "static") out.vars.set(k, v.v); else if (v.kind === "cfn") out.vars.set(k, this.it.makeClosure(v.params, v.body, this.staticEnv(v.env), v.name));
    }
    return out ?? new Env();
  }
  bindDefs(defs: { pat: Pat; params: Pat[]; body: Expr; line: number }[], env: CEnv, mutable?: Set<string>) {
    for (const d of defs) {
      if (d.params.length > 0) { env.vars.set(d.pat.k === "id" ? d.pat.name : "_", { kind: "cfn", params: d.params, body: d.body, env, name: d.pat.k === "id" ? d.pat.name : "fn" }); continue; }
      const v = this.expr(d.body, env);
      if (d.pat.k === "id" && mutable?.has(d.pat.name) && v.kind !== "cfn") { env.vars.set(d.pat.name, { kind: "var", ref: this.g.var(this.toE(v, d.line)) }); continue; }
      this.bind(d.pat, v, env, d.line);
    }
  }

  // ---------------- statements (do blocks)
  exec(ss: Stmt[], env: CEnv) {
    const g = this.g;
    for (const s of ss) {
      switch (s.k) {
        case "local": case "def": {
          const d = s.k === "local" ? s.def : s.def;
          if (d.params.length > 0) { this.bindDefs([d], env); break; }
          const v = this.expr(d.body, env);
          if (d.pat.k === "id" && (v.kind !== "cfn") && !(v.kind === "static" && !(isNum(v.v) || typeof v.v === "boolean" || Array.isArray(v.v)))) {
            env.vars.set(d.pat.name, { kind: "var", ref: g.var(this.toE(v, d.line)) });
          } else this.bind(d.pat, v, env, d.line);
          break;
        }
        case "assign": {
          const cur = env.lookup(s.name); if (!cur) throw err(`Unknown variable '${s.name}'`, s.line);
          if (cur.kind !== "var") throw err(`'${s.name}' is not a local variable (declare it with 'local')`, s.line);
          const v = this.toE(this.expr(s.e, env), s.line);
          if (v.t !== cur.ref.t) throw err(`Cannot assign a ${v.t} to '${s.name}' (a ${cur.ref.t})`, s.line);
          g.assign(cur.ref, v); break;
        }
        case "if": {
          const c = this.expr(s.cond, env);
          if (c.kind === "static") { if (c.v === true) this.exec(s.body, env.child()); else if (s.else) this.exec(s.else, env.child()); break; }
          g.if(this.toE(c, s.line), () => this.exec(s.body, env.child()), s.else ? () => this.exec(s.else!, env.child()) : undefined);
          break;
        }
        case "for": {
          const it = s.iter; let start: CV, count: E, step: CV;
          if (it.k === "range") {
            const a = this.expr(it.a, env), b = this.expr(it.b, env); step = it.step ? this.expr(it.step, env) : this.static(1, true);
            start = a;
            const n = g.bin("/", g.bin("-", this.toE(b), this.toE(a)), this.toE(step));
            count = g.let(it.open ? g.fn("ceil", [g.bin("-", n, g.num(1e-9))]) : g.fn("floor", [g.bin("+", n, g.num(1 + 1e-9))]));
          } else {
            const l = this.expr(it, env); const items = this.items(l, s.line); if (!items) throw err("for expects a list or range", s.line);
            if (items.every((x) => x.kind === "static" && isNum(x.v)) && items.length > 0) {
              // iterate a static numeric list by index
              const vals = items.map((x) => (x as { v: number }).v);
              g.loop(g.num(vals.length), (i) => { const e2 = env.child(); const iv = this.index({ kind: "list", items }, this.dyn(i), s.line); this.bind(s.pat, iv, e2, s.line); this.forBody(s, e2); void vals; });
              break;
            }
            // unroll
            for (const x of items) { const e2 = env.child(); this.bind(s.pat, x, e2, s.line); this.exec(s.body, e2); }
            break;
          }
          const st = this.toE(start), sp = this.toE(step);
          g.loop(count, (i) => {
            const e2 = env.child();
            const iv = g.let(g.bin("+", st, g.bin("*", i, sp)));
            this.bind(s.pat, this.dyn(iv), e2, s.line);
            this.forBody(s, e2);
          });
          break;
        }
        case "while": {
          g.loop(g.num(100000), () => { g.if(g.not(this.toE(this.expr(s.cond, env), s.line)), () => g.brk()); this.exec(s.body, env.child()); });
          break;
        }
        case "expr": this.expr(s.e, env); break;
        default: throw err("This statement is not allowed in a do block", (s as { line?: number }).line);
      }
    }
  }
  private forBody(s: Extract<Stmt, { k: "for" }>, env: CEnv) {
    if (s.until) this.g.if(this.toE(this.expr(s.until, env), s.line), () => this.g.brk());
    this.exec(s.body, env);
  }
}

/** Compile a Fn value applied to a shader vec4 point; used for make_shape dist/colour. */
export function compileFnAt(it: Interp, g: Gen, f: Value, p: E, ctx: GenCtx, line?: number): E {
  if (!(f instanceof Fn)) throw err(`Expected a function, got ${typeName(f)}`, line);
  const sc = new SC(g, it, ctx);
  try {
    const r = sc.call(sc.static(f), sc.dyn(p), line);
    return sc.toE(r, line);
  } catch (e) {
    if (e instanceof GenError) throw err(`${f.name}: ${e.message}`, line);
    throw e;
  }
}

// helper for interp: describe a static value for errors
export const describe = (v: Value) => show(v);
