// Tiny typed code generator with two backends (WGSL for WebGPU, JS for the CPU
// fallback).  Shape trees and SubCurv (user distance / colour functions) are
// compiled through this interface into straight-line shader code.  Numeric
// values that may change between frames go into a parameter buffer `P`, so an
// animated or re-solved program only re-uploads numbers and never recompiles.

export type Ty = "f" | "v2" | "v3" | "v4" | "b";
export interface E { t: Ty; s: string }
export const DIM: Record<Ty, number> = { f: 1, v2: 2, v3: 3, v4: 4, b: 1 };
export const vecTy = (n: number): Ty => (n === 1 ? "f" : n === 2 ? "v2" : n === 3 ? "v3" : "v4");

export class GenError extends Error {}

const UNARY = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "exp", "log", "log2", "sqrt", "abs", "floor", "ceil", "round", "trunc", "fract", "sign", "normalize", "length", "exp2"]);

export abstract class Gen {
  abstract target: "wgsl" | "js";
  params: number[] = [];
  protected lines: string[] = [];
  protected indent = "  ";
  private n = 0;
  tmp(prefix = "t") { return `${prefix}${this.n++}`; }
  emit(s: string) { this.lines.push(this.indent + s); }
  code() { return this.lines.join("\n"); }

  param(v: number): E { const i = this.params.length; this.params.push(Number.isFinite(v) ? v : v > 0 ? 3e38 : v < 0 ? -3e38 : 0); return { t: "f", s: `P[${i}]` }; }
  paramVec(vs: number[]): E { return this.vec(vs.map((v) => this.param(v))); }
  abstract paramAt(i: E): E;
  abstract num(v: number): E;
  abstract bool(v: boolean): E;
  abstract bin(op: string, a: E, b: E): E;
  abstract neg(a: E): E;
  abstract cmp(op: string, a: E, b: E): E;
  abstract logic(op: "&&" | "||", a: E, b: E): E;
  abstract not(a: E): E;
  abstract fn(name: string, args: E[]): E;
  abstract vec(comps: E[]): E;
  abstract idx(a: E, i: number): E;
  abstract sel(c: E, a: E, b: E): E;
  abstract tex(uv: E): E;
  abstract let(e: E): E;
  abstract var(e: E): E;
  abstract assign(ref: E, e: E): void;
  abstract if(c: E, then: () => void, els?: () => void): void;
  abstract loop(count: E, body: (i: E) => void): void;
  abstract brk(): void;
  swz(a: E, ids: number[]): E { const t = this.let(a); return this.vec(ids.map((i) => this.idx(t, i))); }
  // broadcast a scalar to a vector type
  abstract bcast(e: E, t: Ty): E;
  unify(a: E, b: E): [E, E] {
    if (a.t === b.t) return [a, b];
    if (a.t === "f") return [this.bcast(a, b.t), b];
    if (b.t === "f") return [a, this.bcast(b, a.t)];
    throw new GenError(`Vector size mismatch (${DIM[a.t]} vs ${DIM[b.t]})`);
  }
  isUnary(name: string) { return UNARY.has(name); }
}

const fmtW = (v: number) => {
  if (!Number.isFinite(v)) return v > 0 ? "3.0e38" : v < 0 ? "-3.0e38" : "0.0";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v.toFixed(1);
  let s = String(v); if (!/[.e]/.test(s)) s += ".0"; if (/e/.test(s) && !/\./.test(s.split("e")[0])) s = s.replace("e", ".0e"); return s;
};
const WTY: Record<Ty, string> = { f: "f32", v2: "vec2f", v3: "vec3f", v4: "vec4f", b: "bool" };

export class WGSL extends Gen {
  target = "wgsl" as const;
  num(v: number): E { return { t: "f", s: fmtW(v) }; }
  paramAt(i: E): E { return { t: "f", s: `P[u32(${i.s})]` }; }
  bool(v: boolean): E { return { t: "b", s: v ? "true" : "false" }; }
  bcast(e: E, t: Ty): E { return e.t === t ? e : { t, s: `${WTY[t]}(${e.s})` }; }
  bin(op: string, a: E, b: E): E {
    if (a.t === "b" || b.t === "b") throw new GenError(`Cannot apply '${op}' to a boolean`);
    const t = a.t === "f" ? b.t : a.t;
    if (a.t !== "f" && b.t !== "f" && a.t !== b.t) throw new GenError(`Vector size mismatch (${DIM[a.t]} vs ${DIM[b.t]})`);
    switch (op) {
      case "+": case "-": case "*": case "/": return { t, s: `(${a.s} ${op} ${b.s})` };
      case "%": return { t, s: `(${a.s} - ${b.s} * floor(${a.s} / ${b.s}))` };
      case "^": {
        if (b.s === "2.0") { const x = this.let(a); return { t, s: `(${x.s} * ${x.s})` }; }
        const [x, y] = this.unify(a, b); return { t, s: `pow(${x.s}, ${y.s})` };
      }
    }
    throw new GenError(`Unknown operator ${op}`);
  }
  neg(a: E): E { return { t: a.t, s: `(-${a.s})` }; }
  cmp(op: string, a: E, b: E): E {
    if (a.t === "b" && b.t === "b") return { t: "b", s: `(${a.s} ${op} ${b.s})` };
    if (a.t !== b.t) { if (a.t === "f" || b.t === "f") [a, b] = this.unify(a, b); else throw new GenError("Cannot compare vectors of different sizes"); }
    if (a.t === "f") return { t: "b", s: `(${a.s} ${op} ${b.s})` };
    if (op === "==") return { t: "b", s: `all(${a.s} == ${b.s})` };
    if (op === "!=") return { t: "b", s: `any(${a.s} != ${b.s})` };
    throw new GenError("Ordered comparison of vectors is not supported in shader code");
  }
  logic(op: "&&" | "||", a: E, b: E): E { return { t: "b", s: `(${a.s} ${op} ${b.s})` }; }
  not(a: E): E { return { t: "b", s: `(!${a.s})` }; }
  fn(name: string, args: E[]): E {
    if (this.isUnary(name)) {
      const a = args[0];
      if (name === "length") return { t: "f", s: a.t === "f" ? `abs(${a.s})` : `length(${a.s})` };
      if (name === "normalize") return { t: a.t, s: a.t === "f" ? `sign(${a.s})` : `normalize(${a.s})` };
      if (name === "round") return { t: a.t, s: `floor(${a.s} + 0.5)` };
      return { t: a.t, s: `${name}(${a.s})` };
    }
    switch (name) {
      case "min": case "max": case "step": case "atan2": case "pow": { const [a, b] = this.unify(args[0], args[1]); return { t: a.t, s: `${name}(${a.s}, ${b.s})` }; }
      case "clamp": { const t = args.find((a) => a.t !== "f")?.t ?? "f"; const [x, lo, hi] = args.map((a) => this.bcast(a, t)); return { t, s: `clamp(${x.s}, ${lo.s}, ${hi.s})` }; }
      case "mix": { const [a, b] = this.unify(args[0], args[1]); const t = args[2].t === "f" ? args[2] : this.bcast(args[2], a.t); return { t: a.t, s: `mix(${a.s}, ${b.s}, ${t.s})` }; }
      case "smoothstep": { const t = args[2].t; const [e0, e1] = [this.bcast(args[0], t), this.bcast(args[1], t)]; return { t, s: `smoothstep(${e0.s}, ${e1.s}, ${args[2].s})` }; }
      case "dot": { const [a, b] = this.unify(args[0], args[1]); return { t: "f", s: a.t === "f" ? `(${a.s} * ${b.s})` : `dot(${a.s}, ${b.s})` }; }
      case "cross": return { t: "v3", s: `cross(${args[0].s}, ${args[1].s})` };
      case "hsv": return { t: "v3", s: `hsv2rgb(${args[0].s})` };
    }
    throw new GenError(`Unknown shader function ${name}`);
  }
  vec(comps: E[]): E {
    const n = comps.reduce((s, c) => s + DIM[c.t], 0);
    if (n < 2 || n > 4) throw new GenError(`Vectors must have 2..4 components in shader code (got ${n})`);
    return { t: vecTy(n), s: `${WTY[vecTy(n)]}(${comps.map((c) => c.s).join(", ")})` };
  }
  idx(a: E, i: number): E { if (a.t === "f") { if (i !== 0) throw new GenError("Index out of range"); return a; } if (i < 0 || i >= DIM[a.t]) throw new GenError(`Index ${i} out of range`); return { t: "f", s: `${a.s}.${"xyzw"[i]}` }; }
  sel(c: E, a: E, b: E): E { const [x, y] = a.t === b.t ? [a, b] : this.unify(a, b); return { t: x.t, s: `select(${y.s}, ${x.s}, ${c.s})` }; }
  tex(uv: E): E { return { t: "f", s: `textureSampleLevel(atlasTex, atlasSamp, ${uv.s}, 0.0).r` }; }
  let(e: E): E { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.s) || /^P\[\d+\]$/.test(e.s)) return e; const n = this.tmp(); this.emit(`let ${n}: ${WTY[e.t]} = ${e.s};`); return { t: e.t, s: n }; }
  var(e: E): E { const n = this.tmp("v"); this.emit(`var ${n}: ${WTY[e.t]} = ${e.s};`); return { t: e.t, s: n }; }
  assign(ref: E, e: E) { this.emit(`${ref.s} = ${this.bcast(e, ref.t).s};`); }
  if(c: E, then: () => void, els?: () => void) {
    this.emit(`if (${c.s}) {`); this.indent += "  "; then(); this.indent = this.indent.slice(2);
    if (els) { this.emit("} else {"); this.indent += "  "; els(); this.indent = this.indent.slice(2); }
    this.emit("}");
  }
  loop(count: E, body: (i: E) => void) {
    const i = this.tmp("i"); this.emit(`for (var ${i}: f32 = 0.0; ${i} < ${count.s}; ${i} += 1.0) {`); this.indent += "  "; body({ t: "f", s: i }); this.indent = this.indent.slice(2); this.emit("}");
  }
  brk() { this.emit("break;"); }
}

const fmtJ = (v: number) => (Number.isFinite(v) ? (Object.is(v, -0) ? "0" : String(v)) : v > 0 ? "Infinity" : v < 0 ? "-Infinity" : "0");

export class JS extends Gen {
  target = "js" as const;
  num(v: number): E { return { t: "f", s: fmtJ(v) }; }
  paramAt(i: E): E { return { t: "f", s: `P[${i.s}]` }; }
  bool(v: boolean): E { return { t: "b", s: v ? "true" : "false" }; }
  bcast(e: E, t: Ty): E { return e.t === t ? e : { t, s: `R.bc(${e.s}, ${DIM[t]})` }; }
  bin(op: string, a: E, b: E): E {
    if (a.t === "b" || b.t === "b") throw new GenError(`Cannot apply '${op}' to a boolean`);
    const t = a.t === "f" ? b.t : a.t;
    if (a.t !== "f" && b.t !== "f" && a.t !== b.t) throw new GenError(`Vector size mismatch (${DIM[a.t]} vs ${DIM[b.t]})`);
    if (t === "f") {
      switch (op) {
        case "+": case "-": case "*": case "/": return { t, s: `(${a.s} ${op} ${b.s})` };
        case "%": return { t, s: `R.mod(${a.s}, ${b.s})` };
        case "^": return { t, s: `Math.pow(${a.s}, ${b.s})` };
      }
    }
    const names: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod", "^": "pow" };
    return { t, s: `R.${names[op]}(${a.s}, ${b.s})` };
  }
  neg(a: E): E { return { t: a.t, s: a.t === "f" ? `(-${a.s})` : `R.neg(${a.s})` }; }
  cmp(op: string, a: E, b: E): E {
    if (a.t === "b" && b.t === "b") return { t: "b", s: `(${a.s} ${op === "==" ? "===" : op === "!=" ? "!==" : op} ${b.s})` };
    if (a.t !== b.t) { if (a.t === "f" || b.t === "f") [a, b] = this.unify(a, b); else throw new GenError("Cannot compare vectors of different sizes"); }
    if (a.t === "f") return { t: "b", s: `(${a.s} ${op === "==" ? "===" : op === "!=" ? "!==" : op} ${b.s})` };
    if (op === "==") return { t: "b", s: `R.eq(${a.s}, ${b.s})` };
    if (op === "!=") return { t: "b", s: `(!R.eq(${a.s}, ${b.s}))` };
    throw new GenError("Ordered comparison of vectors is not supported in shader code");
  }
  logic(op: "&&" | "||", a: E, b: E): E { return { t: "b", s: `(${a.s} ${op} ${b.s})` }; }
  not(a: E): E { return { t: "b", s: `(!${a.s})` }; }
  fn(name: string, args: E[]): E {
    if (this.isUnary(name)) {
      const a = args[0];
      if (name === "length") return { t: "f", s: `R.length(${a.s})` };
      if (name === "normalize") return { t: a.t, s: `R.normalize(${a.s})` };
      return { t: a.t, s: a.t === "f" ? `R.${name}(${a.s})` : `R.map(R.${name}, ${a.s})` };
    }
    switch (name) {
      case "min": case "max": case "step": case "atan2": case "pow": { const [a, b] = this.unify(args[0], args[1]); return { t: a.t, s: `R.${name}(${a.s}, ${b.s})` }; }
      case "clamp": { const t = args.find((a) => a.t !== "f")?.t ?? "f"; const [x, lo, hi] = args.map((a) => this.bcast(a, t)); return { t, s: `R.clamp(${x.s}, ${lo.s}, ${hi.s})` }; }
      case "mix": { const [a, b] = this.unify(args[0], args[1]); const t = args[2].t === "f" ? args[2] : this.bcast(args[2], a.t); return { t: a.t, s: `R.mix(${a.s}, ${b.s}, ${t.s})` }; }
      case "smoothstep": { const t = args[2].t; const [e0, e1] = [this.bcast(args[0], t), this.bcast(args[1], t)]; return { t, s: `R.smoothstep(${e0.s}, ${e1.s}, ${args[2].s})` }; }
      case "dot": { const [a, b] = this.unify(args[0], args[1]); return { t: "f", s: `R.dot(${a.s}, ${b.s})` }; }
      case "cross": return { t: "v3", s: `R.cross(${args[0].s}, ${args[1].s})` };
      case "hsv": return { t: "v3", s: `R.hsv(${args[0].s})` };
    }
    throw new GenError(`Unknown shader function ${name}`);
  }
  vec(comps: E[]): E {
    const n = comps.reduce((s, c) => s + DIM[c.t], 0);
    if (n < 2 || n > 4) throw new GenError(`Vectors must have 2..4 components in shader code (got ${n})`);
    if (comps.every((c) => c.t === "f")) return { t: vecTy(n), s: `[${comps.map((c) => c.s).join(", ")}]` };
    return { t: vecTy(n), s: `R.cat(${comps.map((c) => c.s).join(", ")})` };
  }
  idx(a: E, i: number): E { if (a.t === "f") { if (i !== 0) throw new GenError("Index out of range"); return a; } if (i < 0 || i >= DIM[a.t]) throw new GenError(`Index ${i} out of range`); return { t: "f", s: `${a.s}[${i}]` }; }
  sel(c: E, a: E, b: E): E { const [x, y] = a.t === b.t ? [a, b] : this.unify(a, b); return { t: x.t, s: `(${c.s} ? ${x.s} : ${y.s})` }; }
  tex(uv: E): E { return { t: "f", s: `R.tex(${uv.s})` }; }
  let(e: E): E { if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.s) || /^P\[\d+\]$/.test(e.s)) return e; const n = this.tmp(); this.emit(`const ${n} = ${e.s};`); return { t: e.t, s: n }; }
  var(e: E): E { const n = this.tmp("v"); this.emit(`let ${n} = ${e.s};`); return { t: e.t, s: n }; }
  assign(ref: E, e: E) { this.emit(`${ref.s} = ${this.bcast(e, ref.t).s};`); }
  if(c: E, then: () => void, els?: () => void) {
    this.emit(`if (${c.s}) {`); this.indent += "  "; then(); this.indent = this.indent.slice(2);
    if (els) { this.emit("} else {"); this.indent += "  "; els(); this.indent = this.indent.slice(2); }
    this.emit("}");
  }
  loop(count: E, body: (i: E) => void) {
    const i = this.tmp("i"); this.emit(`for (let ${i} = 0; ${i} < ${count.s}; ${i}++) {`); this.indent += "  "; body({ t: "f", s: i }); this.indent = this.indent.slice(2); this.emit("}");
  }
  brk() { this.emit("break;"); }
}

// Runtime helpers for generated JS (vectors are plain arrays).
export function makeJSRuntime(tex: (u: number, v: number) => number) {
  const isA = Array.isArray;
  const z = (a: any, b: any, f: (x: number, y: number) => number): any => {
    if (isA(a)) return isA(b) ? a.map((x: number, i: number) => f(x, b[i])) : a.map((x: number) => f(x, b));
    if (isA(b)) return b.map((y: number) => f(a, y));
    return f(a, b);
  };
  const map = (f: (x: number) => number, a: any) => (isA(a) ? a.map(f) : f(a));
  const R = {
    bc: (x: number, n: number) => Array.from({ length: n }, () => x),
    add: (a: any, b: any) => z(a, b, (x, y) => x + y), sub: (a: any, b: any) => z(a, b, (x, y) => x - y),
    mul: (a: any, b: any) => z(a, b, (x, y) => x * y), div: (a: any, b: any) => z(a, b, (x, y) => x / y),
    mod: (a: any, b: any) => z(a, b, (x, y) => x - y * Math.floor(x / y)), pow: (a: any, b: any) => z(a, b, Math.pow),
    neg: (a: any) => map((x) => -x, a), map,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    exp: Math.exp, log: Math.log, log2: Math.log2, exp2: (x: number) => Math.pow(2, x), sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
    round: (x: number) => Math.floor(x + 0.5), trunc: Math.trunc, fract: (x: number) => x - Math.floor(x), sign: Math.sign,
    min: (a: any, b: any) => z(a, b, Math.min), max: (a: any, b: any) => z(a, b, Math.max),
    step: (e: any, x: any) => z(e, x, (a, b) => (b < a ? 0 : 1)), atan2: (a: any, b: any) => z(a, b, Math.atan2),
    clamp: (x: any, lo: any, hi: any) => R.min(R.max(x, lo), hi),
    mix: (a: any, b: any, t: any) => R.add(a, R.mul(R.sub(b, a), t)),
    smoothstep: (e0: any, e1: any, x: any) => { const t = R.clamp(R.div(R.sub(x, e0), R.sub(e1, e0)), 0, 1); return R.mul(R.mul(t, t), R.sub(3, R.mul(2, t))); },
    length: (a: any) => (isA(a) ? Math.hypot(...a) : Math.abs(a)),
    normalize: (a: any) => { if (!isA(a)) return Math.sign(a); const l = Math.hypot(...a) || 1; return a.map((x: number) => x / l); },
    dot: (a: any, b: any) => (isA(a) ? a.reduce((s: number, x: number, i: number) => s + x * b[i], 0) : a * b),
    cross: (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    cat: (...xs: any[]) => xs.flat(),
    eq: (a: any, b: any) => (isA(a) ? a.every((x: number, i: number) => x === b[i]) : a === b),
    tex: (uv: number[]) => tex(uv[0], uv[1]),
    hsv: (c: number[]) => { const [h, s, v] = c; const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)]; },
  };
  return R;
}
