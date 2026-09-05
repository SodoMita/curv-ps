// Tree-walking evaluator for Curv (+ the solve extension).  Shape values build
// an F-Rep tree (shapes.ts); user functions inside make_shape are compiled to
// shader code by subcurv.ts; `solve { ... }` blocks compile to a psolve problem.
import { parse, CurvError, type Expr, type Def, type Pat, type ListItem, type Stmt } from "./parser";
import { Lin, Quad, Problem, STRENGTH, type Rel } from "../psolve/constraints";
import { Shape, type SNode, type RGBA, type BBox, type ShaderFn, type GenCtx, genShape, bboxOf } from "./shapes";
import { measureText, type Atlas } from "../gpu/atlas";
import { PRELUDE } from "./prelude";
import { JS, WGSL, makeJSRuntime, type Gen, type E } from "../gpu/gen";
import { SC, compileFnAt, type CV } from "./subcurv";

export class Rec { constructor(public f: Map<string, Value> = new Map()) {} get(k: string) { return this.f.get(k); } }
export class Fn {
  closure?: { params: Pat[]; body: Expr; env: Env };
  sc?: (sc: SC, arg: CV, line?: number) => CV;
  fields?: Map<string, Value>;
  constructor(public name: string, public call: (arg: Value, line?: number) => Value) {}
}
export type Value = number | string | boolean | null | Value[] | Rec | Fn | Shape | Lin | Quad;

export interface SolveTrace {
  line: number; engine: string; status: string; ok: boolean; timeMs: number; iterations: number;
  nVars: number; nCons: number; eliminated: number; objective: number; violations: { label: string; amount: number }[];
  values: { name: string; value: string }[];
  boxes: { x: number; y: number; w: number; h: number }[];
}
export interface ParamDesc { name: string; label: string; kind: "slider" | "int_slider" | "checkbox" | "scale_picker" | "colour_picker"; lo: number; hi: number; value: number | boolean | number[] }
export interface EvalResult { shape: SNode | null; traces: SolveTrace[]; usesTime: boolean; usesMouse: boolean; usesViewport: boolean; value: Value; params: ParamDesc[] }
/** Live inputs.  Everything is in Curv world units (y up, origin at the centre of the default view). */
export interface Inputs { viewport: { x: number; y: number; w: number; h: number }; time: number; mouse: { x: number; y: number; down: boolean }; params?: Record<string, number | boolean | number[]> }

export class Env {
  constructor(public vars: Map<string, Value> = new Map(), public parent: Env | null = null) {}
  lookup(n: string): Value | undefined { let e: Env | null = this; while (e) { if (e.vars.has(n)) return e.vars.get(n); e = e.parent; } return undefined; }
  owner(n: string): Env | null { let e: Env | null = this; while (e) { if (e.vars.has(n)) return e; e = e.parent; } return null; }
  child() { return new Env(new Map(), this); }
}

// ---------- helpers ----------
const err = (m: string, line?: number) => new CurvError(m, line);
const isNum = (v: Value): v is number => typeof v === "number";
const isList = (v: Value): v is Value[] => Array.isArray(v);
const isAff = (v: Value): v is number | Lin => typeof v === "number" || v instanceof Lin;
const toLin = (v: number | Lin) => (typeof v === "number" ? Lin.const(v) : v);
const toQuad = (v: number | Lin | Quad) => (v instanceof Quad ? v : Quad.fromLin(toLin(v)));

export function typeName(v: Value): string {
  if (v === null) return "null"; if (isNum(v)) return "number"; if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool"; if (isList(v)) return "list"; if (v instanceof Rec) return "record";
  if (v instanceof Fn) return "function"; if (v instanceof Shape) return "shape"; if (v instanceof Lin) return "linear expression";
  return "quadratic expression";
}
export function show(v: Value, depth = 0): string {
  if (v === null) return "null"; if (isNum(v)) return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, "");
  if (typeof v === "string") return JSON.stringify(v); if (typeof v === "boolean") return String(v);
  if (isList(v)) return depth > 2 ? "[…]" : "[" + v.map((x) => show(x, depth + 1)).join(", ") + "]";
  if (v instanceof Rec) return depth > 2 ? "{…}" : "{" + [...v.f].map(([k, x]) => `${k}: ${show(x, depth + 1)}`).join(", ") + "}";
  if (v instanceof Fn) return `<function ${v.name}>`; if (v instanceof Shape) return "<shape>";
  if (v instanceof Lin) return "<linear expr>"; return "<quadratic expr>";
}

export function arith(op: string, a: Value, b: Value, line?: number): Value {
  if (isList(a) && isList(b)) { if (a.length !== b.length) throw err(`Vector length mismatch (${a.length} vs ${b.length})`, line); return a.map((x, i) => arith(op, x, b[i], line)); }
  if (isList(a)) return a.map((x) => arith(op, x, b, line));
  if (isList(b)) return b.map((x) => arith(op, a, x, line));
  if (isNum(a) && isNum(b)) {
    switch (op) { case "+": return a + b; case "-": return a - b; case "*": return a * b; case "/": return a / b; case "^": return Math.pow(a, b); case "%": return a - b * Math.floor(a / b); }
  }
  if (op === "+" && typeof a === "string" && typeof b === "string") return a + b;
  if ((isAff(a) || a instanceof Quad) && (isAff(b) || b instanceof Quad)) {
    if (a instanceof Quad || b instanceof Quad) {
      const qa = toQuad(a), qb = toQuad(b);
      if (op === "+") return qa.add(qb); if (op === "-") return qa.add(qb.scale(-1));
      if (op === "*" && isNum(b)) return qa.scale(b); if (op === "*" && isNum(a)) return qb.scale(a);
      if (op === "/" && isNum(b)) return qa.scale(1 / b);
      throw err(`Operator '${op}' would make the objective non-quadratic`, line);
    }
    const la = toLin(a as number | Lin), lb = toLin(b as number | Lin);
    switch (op) {
      case "+": return la.add(lb); case "-": return la.sub(lb);
      case "*": if (isNum(b)) return la.scale(b); if (isNum(a)) return lb.scale(a); return Quad.mul(la, lb);
      case "/": if (isNum(b)) return la.scale(1 / b); throw err("Cannot divide by a solver variable (non-linear)", line);
      case "^": if (b === 2) return Quad.mul(la, la); throw err("Only ^2 is allowed on solver variables (convex quadratic)", line);
    }
  }
  throw err(`Cannot apply '${op}' to ${typeName(a)} and ${typeName(b)}`, line);
}
function truthy(v: Value, line?: number): boolean { if (typeof v === "boolean") return v; throw err(`Expected a boolean, got ${typeName(v)}`, line); }
function equalV(a: Value, b: Value): boolean {
  if (isList(a) && isList(b)) return a.length === b.length && a.every((x, i) => equalV(x, b[i]));
  return a === b;
}
export function num(v: Value, what = "number", line?: number): number { if (isNum(v)) return v; throw err(`Expected ${what}, got ${typeName(v)}`, line); }
function vec2(v: Value, what = "a point (x,y)", line?: number): [number, number] { if (isList(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1])) return [v[0], v[1]]; if (isNum(v)) return [v, v]; throw err(`Expected ${what}, got ${show(v)}`, line); }
function shape(v: Value, line?: number): SNode { if (v instanceof Shape) return v.node; throw err(`Expected a shape, got ${typeName(v)}`, line); }
function shapes(v: Value, line?: number): SNode[] { if (isList(v)) return v.map((x) => shape(x, line)); return [shape(v, line)]; }
function rec(v: Value, line?: number): Rec { if (v instanceof Rec) return v; throw err(`Expected a record, got ${typeName(v)}`, line); }
function nums(v: Value, line?: number): number[] { if (!isList(v)) throw err(`Expected a list of numbers, got ${typeName(v)}`, line); return v.map((x) => num(x, "number", line)); }
const NAMED: Record<string, string> = { white: "#ffffff", black: "#000000", red: "#ff0000", green: "#00ff00", blue: "#0000ff", yellow: "#ffff00", orange: "#ff8000", magenta: "#ff00ff", purple: "#a855f7", pink: "#ec4899", cyan: "#00ffff", gray: "#808080", grey: "#808080", brown: "#8b4513", transparent: "#00000000" };
export function colour(v: Value, line?: number): RGBA {
  if (typeof v === "string") {
    const s = NAMED[v] ?? v; const m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (!m) throw err(`Unknown colour '${v}'`, line);
    let h = m[1]; if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h, 16);
    if (h.length === 6) return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    return [((n >>> 24) & 255) / 255, ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  if (isList(v) && (v.length === 3 || v.length === 4) && v.every(isNum)) return [v[0], v[1], v[2], v.length === 4 ? v[3] : 1] as RGBA;
  throw err(`Expected a colour ("#rrggbb", (r,g,b) or a named colour), got ${show(v)}`, line);
}
function boxOf(v: Value, line?: number): { x: number; y: number; w: number; h: number } {
  const r = rec(v, line); const g = (k: string) => num(r.get(k) ?? 0, `box field ${k}`, line);
  return { x: g("x"), y: g("y"), w: g("w"), h: g("h") };
}
const S = (n: SNode) => new Shape(n);
const fn1 = (name: string, f: (a: Value, line?: number) => Value) => new Fn(name, f);
const fn2 = (name: string, f: (a: Value, b: Value, line?: number) => Value) => new Fn(name, (a, l) => new Fn(name + "'", (b, l2) => f(a, b, l2 ?? l)));
const fn3 = (name: string, f: (a: Value, b: Value, c: Value, line?: number) => Value) => new Fn(name, (a) => new Fn(name, (b) => new Fn(name, (c, l) => f(a, b, c, l))));
const mapNum = (f: (x: number) => number, a: Value, l?: number): Value => (isList(a) ? a.map((x) => mapNum(f, x, l)) : f(num(a, "number", l)));
const hsv2rgb = (h: number, s: number, v: number): number[] => { const f = (n: number) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)]; };
const DEFAULT_COLOUR: RGBA = [0.86, 0.82, 0.55, 1];

export function makeBoxRec(x: number | Lin, y: number | Lin, w: number | Lin, h: number | Lin): Rec {
  const add = (a: number | Lin, b: number | Lin) => arith("+", a, b) as number | Lin;
  const half = (a: number | Lin) => arith("*", a, 0.5) as number | Lin;
  return new Rec(new Map<string, Value>([
    // y-up: (x, y) is the bottom-left corner, like a Curv bbox [[xmin, ymin], [xmax, ymax]]
    ["x", x], ["y", y], ["w", w], ["h", h], ["left", x], ["bottom", y],
    ["right", add(x, w)], ["top", add(y, h)], ["cx", add(x, half(w))], ["cy", add(y, half(h))],
    ["center", [add(x, half(w)), add(y, half(h))]], ["size", [w, h]], ["pos", [x, y]],
  ]));
}

// ---------- parse cache (the AST is immutable, so re-evaluating the same source every frame never re-parses)
let preludeAst: Expr | null = null;
let lastSrc = "", lastAst: Expr | null = null;
function parseCached(src: string): Expr {
  if (lastAst && src === lastSrc) return lastAst;
  const ast = parse(src); lastSrc = src; lastAst = ast; return ast;
}

// ---------- interpreter ----------
export class Interp {
  traces: SolveTrace[] = []; usesTime = false; usesMouse = false; usesViewport = false; params: ParamDesc[] = [];
  private cpuFns = new WeakMap<SNode, { dist: (x: number, y: number, t: number) => number; colour: (x: number, y: number, t: number) => number[] }>();
  constructor(public atlas: Atlas, public inputs: Inputs) {}

  // ---- shader-side helpers -------------------------------------------------
  /** Fn value that evaluates (CPU) / compiles (GPU) the distance or colour of a shape node. */
  shapeFn(node: SNode, which: "dist" | "colour"): Fn {
    const f = new Fn(`shape.${which}`, (p, l) => {
      const [x, y] = vec2(p, "a point", l); const t = isList(p) && p.length >= 4 && isNum(p[3]) ? p[3] : this.inputs.time;
      const c = this.cpuCompile(node);
      return which === "dist" ? c.dist(x, y, t) : c.colour(x, y, t);
    });
    f.sc = (sc, arg, line) => {
      const p4 = sc.g.let(sc.toE(arg, line));
      const p2 = p4.t === "v2" ? p4 : sc.g.vec([sc.g.idx(p4, 0), sc.g.idx(p4, 1)]);
      const r = genShape(sc.g, node, sc.g.let(p2), { ...sc.ctx, cull: false });
      return sc.dyn(which === "dist" ? r.d : sc.g.swz(r.c, [0, 1, 2]));
    };
    return f;
  }
  cpuCompile(node: SNode) {
    let c = this.cpuFns.get(node);
    if (!c) {
      const g = new JS();
      const ctx: GenCtx = { atlas: this.atlas, zoom: { t: "f", s: "1" }, time: { t: "f", s: "T" }, cull: false, defaultColour: DEFAULT_COLOUR };
      const r = genShape(g, node, { t: "v2", s: "p0" }, ctx);
      const body = `const p0 = [x, y];\n${g.code()}\nreturn [${r.d.s}, ${r.c.s}];`;
      const fn = new Function("P", "R", "x", "y", "T", body) as (P: number[], R: unknown, x: number, y: number, T: number) => [number, number[]];
      const R = makeJSRuntime(() => 0.5); const P = g.params;
      c = { dist: (x, y, t) => fn(P, R, x, y, t)[0], colour: (x, y, t) => fn(P, R, x, y, t)[1].slice(0, 3) };
      this.cpuFns.set(node, c);
    }
    return c;
  }
  shaderFn(f: Value, name: string, line?: number): ShaderFn {
    if (!(f instanceof Fn)) throw err(`${name} must be a function, got ${typeName(f)}`, line);
    return { name, compile: (g: Gen, p: E, ctx: GenCtx) => compileFnAt(this, g, f, p, ctx, line) };
  }
  shapeRec(s: Shape): Rec {
    const b = bboxOf(s.node, this.atlas);
    const bb: Value = b ? [[b[0], b[1], 0], [b[2], b[3], 0]] : [[-Infinity, -Infinity, 0], [Infinity, Infinity, 0]];
    return new Rec(new Map<string, Value>([["dist", this.shapeFn(s.node, "dist")], ["colour", this.shapeFn(s.node, "colour")], ["bbox", bb], ["is_2d", true], ["is_3d", false]]));
  }
  makeShape(r: Rec, line?: number): Shape {
    if (r.get("is_3d") === true && r.get("is_2d") !== true) throw err("3D shapes are not supported in this 2D playground (only is_2d shapes)", line);
    const d = r.get("dist"), c = r.get("colour");
    let bbox: BBox | null = null;
    const bv = r.get("bbox") ?? null;
    if (isList(bv) && bv.length === 2 && isList(bv[0]) && isList(bv[1])) { const lo = nums(bv[0], line), hi = nums(bv[1], line); bbox = [lo[0], lo[1], hi[0], hi[1]]; if (!bbox.every(Number.isFinite)) bbox = null; }
    return S({ k: "custom", dist: d === undefined ? null : this.shaderFn(d, "dist", line), colour: c === undefined ? null : this.shaderFn(c, "colour", line), bbox, name: "make_shape" });
  }

  // ---- builtins -------------------------------------------------------------
  builtins(): Env {
    const env = new Env();
    const b = (name: string, v: Value) => { env.vars.set(name, v); return v; };
    const scUnary = (f: Fn, gname: string) => { f.sc = (sc, a, l) => { if (sc.allStatic([a])) return sc.static(f.call(sc.staticValue(a, l), l)); return sc.dyn(sc.g.fn(gname, [sc.toE(a, l)])); }; return f; };
    const scList = (f: Fn, n: number, build: (sc: SC, xs: E[]) => E) => {
      f.sc = (sc, a, l) => { if (sc.allStatic([a])) return sc.static(f.call(sc.staticValue(a, l), l)); const items = sc.items(a, l); if (!items || items.length !== n) throw err(`${f.name} expects a list of ${n}`, l); return sc.dyn(build(sc, items.map((x) => sc.toE(x, l)))); }; return f;
    };
    // --- math
    b("pi", Math.PI); b("tau", Math.PI * 2); b("e", Math.E); b("deg", Math.PI / 180); b("inf", Infinity);
    b("X", 0); b("Y", 1); b("Z", 2); b("T", 3);
    const M: Record<string, [(x: number) => number, string]> = {
      sin: [Math.sin, "sin"], cos: [Math.cos, "cos"], tan: [Math.tan, "tan"], asin: [Math.asin, "asin"], acos: [Math.acos, "acos"], atan: [Math.atan, "atan"],
      sinh: [Math.sinh, "sinh"], cosh: [Math.cosh, "cosh"], tanh: [Math.tanh, "tanh"], sqrt: [Math.sqrt, "sqrt"], abs: [Math.abs, "abs"], floor: [Math.floor, "floor"],
      ceil: [Math.ceil, "ceil"], round: [(x) => Math.floor(x + 0.5), "round"], trunc: [Math.trunc, "trunc"], exp: [Math.exp, "exp"], log: [Math.log, "log"], sign: [Math.sign, "sign"],
      frac: [(x) => x - Math.floor(x), "fract"],
    };
    for (const [n, [f, gname]] of Object.entries(M)) b(n, scUnary(fn1(n, (a, l) => mapNum(f, a, l)), gname));
    const reduceF = (name: string, f: (a: number, c: number) => number, init: number, gname: string) => {
      const fn = fn1(name, (a, l) => { const xs = isList(a) ? a : [a]; if (xs.some(isList)) return xs.reduce<Value>((acc, x) => (isList(acc) ? acc.map((v, i) => f(num(v), num((x as Value[])[i]))) : x), xs[0]); return xs.map((x) => num(x, "number", l)).reduce(f, init); });
      fn.sc = (sc, a, l) => { if (sc.allStatic([a])) return sc.static(fn.call(sc.staticValue(a, l), l)); const items = sc.items(a, l); if (!items) return a; let acc = sc.toE(items[0], l); for (let i = 1; i < items.length; i++) acc = gname === "+" ? sc.g.bin("+", acc, sc.toE(items[i], l)) : sc.g.fn(gname, [acc, sc.toE(items[i], l)]); return sc.dyn(acc); };
      return b(name, fn);
    };
    reduceF("min", Math.min, Infinity, "min"); reduceF("max", Math.max, -Infinity, "max"); reduceF("sum", (a, c) => a + c, 0, "+");
    b("clamp", scList(fn1("clamp", (a, l) => { const [x, lo, hi] = isList(a) && a.length === 3 ? a : (() => { throw err("clamp expects [x, lo, hi]", l); })(); return arith("+", 0, mapNum((v) => v, isList(x) ? x.map((xi) => Math.min(num(hi), Math.max(num(lo), num(xi)))) : Math.min(num(hi), Math.max(num(lo), num(x))))); }), 3, (sc, [x, lo, hi]) => sc.g.fn("clamp", [x, lo, hi])));
    b("lerp", scList(fn1("lerp", (a, l) => { if (!isList(a) || a.length !== 3) throw err("lerp expects [a, b, t]", l); const [x, y, t] = a; return arith("+", x, arith("*", arith("-", y, x, l), t, l), l); }), 3, (sc, [x, y, t]) => sc.g.fn("mix", [x, y, t])));
    b("smoothstep", scList(fn1("smoothstep", (a, l) => { const [lo, hi, x] = nums(a, l); const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); }), 3, (sc, [lo, hi, x]) => sc.g.fn("smoothstep", [lo, hi, x])));
    b("mod", scList(fn1("mod", (a, l) => { if (!isList(a) || a.length !== 2) throw err("mod expects [a, b]", l); return arith("%", a[0], a[1], l); }), 2, (sc, [x, y]) => sc.g.bin("%", x, y)));
    b("dot", scList(fn1("dot", (a, l) => { if (!isList(a) || a.length !== 2) throw err("dot expects [a, b]", l); const x = nums(a[0], l), y = nums(a[1], l); return x.reduce((s, v, i) => s + v * y[i], 0); }), 2, (sc, [x, y]) => sc.g.fn("dot", [x, y])));
    b("cross", scList(fn1("cross", (a, l) => { const [x, y] = (a as Value[]).map((v) => nums(v, l)); return [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]; }), 2, (sc, [x, y]) => sc.g.fn("cross", [x, y])));
    b("mag", scUnary(fn1("mag", (a, l) => Math.hypot(...nums(a, l))), "length"));
    b("normalize", scUnary(fn1("normalize", (a, l) => { const v = nums(a, l); const m = Math.hypot(...v) || 1; return v.map((x) => x / m); }), "normalize"));
    b("atan2", scList(fn1("atan2", (a, l) => { const [y, x] = nums(a, l); return Math.atan2(y, x); }), 2, (sc, [y, x]) => sc.g.fn("atan2", [y, x])));
    b("phase", scList(fn1("phase", (a, l) => { const [x, y] = nums(a, l); return Math.atan2(y, x); }), 2, (sc, [x, y]) => sc.g.fn("atan2", [y, x])));
    { const f = fn1("cis", (a, l) => [Math.cos(num(a, "angle", l)), Math.sin(num(a, "angle", l))]); f.sc = (sc, a, l) => { if (sc.allStatic([a])) return sc.static(f.call(sc.staticValue(a, l), l)); const t = sc.g.let(sc.toE(a, l)); return sc.dyn(sc.g.vec([sc.g.fn("cos", [t]), sc.g.fn("sin", [t])])); }; b("cis", f); }
    b("cmul", scList(fn1("cmul", (a, l) => { const [x, y] = (a as Value[]).map((v) => nums(v, l)); return [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]]; }), 2, (sc, [x, y]) => { const g = sc.g; const a = g.let(x), c = g.let(y); return g.vec([g.bin("-", g.bin("*", g.idx(a, 0), g.idx(c, 0)), g.bin("*", g.idx(a, 1), g.idx(c, 1))), g.bin("+", g.bin("*", g.idx(a, 0), g.idx(c, 1)), g.bin("*", g.idx(a, 1), g.idx(c, 0)))]); }));
    { const f = fn1("csqr", (a, l) => { const z = nums(a, l); return [z[0] * z[0] - z[1] * z[1], 2 * z[0] * z[1]]; }); f.sc = (sc, a, l) => { if (sc.allStatic([a])) return sc.static(f.call(sc.staticValue(a, l), l)); const g = sc.g; const z = g.let(sc.toE(a, l)); const x = g.idx(z, 0), y = g.idx(z, 1); return sc.dyn(g.vec([g.bin("-", g.bin("*", x, x), g.bin("*", y, y)), g.bin("*", g.bin("*", g.num(2), x), y)])); }; b("csqr", f); }
    { const f = fn1("bit", (a, l) => (truthy(a, l) ? 1 : 0)); f.sc = (sc, a, l) => (sc.allStatic([a]) ? sc.static(f.call(sc.staticValue(a, l), l)) : sc.dyn(sc.g.sel(sc.toE(a, l), sc.g.num(1), sc.g.num(0)))); b("bit", f); }
    b("is_num", fn1("is_num", (a) => isNum(a))); b("is_list", fn1("is_list", (a) => isList(a))); b("is_bool", fn1("is_bool", (a) => typeof a === "boolean"));
    b("is_string", fn1("is_string", (a) => typeof a === "string")); b("is_fun", fn1("is_fun", (a) => a instanceof Fn)); b("is_shape", fn1("is_shape", (a) => a instanceof Shape));
    b("is_vec2", fn1("is_vec2", (a) => isList(a) && a.length === 2 && a.every(isNum))); b("is_vec3", fn1("is_vec3", (a) => isList(a) && a.length === 3 && a.every(isNum)));
    // --- lists / strings
    b("count", fn1("count", (a, l) => (isList(a) ? a.length : typeof a === "string" ? a.length : (() => { throw err("count expects a list", l); })())));
    b("map", fn2("map", (f, a, l) => { if (!(f instanceof Fn) || !isList(a)) throw err("map expects a function and a list", l); return a.map((x) => f.call(x, l)); }));
    b("filter", fn2("filter", (f, a, l) => { if (!(f instanceof Fn) || !isList(a)) throw err("filter expects a function and a list", l); return a.filter((x) => truthy(f.call(x, l), l)); }));
    b("reduce", fn2("reduce", (zf, a, l) => { if (!isList(zf) || zf.length !== 2 || !(zf[1] instanceof Fn) || !isList(a)) throw err("reduce expects [zero, f] and a list", l); const f = zf[1] as Fn; return a.reduce<Value>((acc, x) => f.call([acc, x], l), zf[0]); }));
    b("reverse", fn1("reverse", (a, l) => { if (!isList(a)) throw err("reverse expects a list", l); return [...a].reverse(); }));
    b("concat", fn1("concat", (a, l) => { if (!isList(a)) throw err("concat expects a list of lists", l); return a.flatMap((x) => (isList(x) ? x : [x])); }));
    b("indices", fn1("indices", (a, l) => { if (!isList(a)) throw err("indices expects a list", l); return a.map((_, i) => i); }));
    b("str", fn1("str", (a) => (typeof a === "string" ? a : show(a))));
    b("strcat", fn1("strcat", (a) => (isList(a) ? a : [a]).map((x) => (typeof x === "string" ? x : show(x))).join("")));
    b("repr", fn1("repr", (a) => show(a)));
    b("fields", fn1("fields", (a, l) => [...rec(a, l).f.keys()]));
    b("text_width", fn2("text_width", (t, s, l) => measureText(this.atlas, typeof t === "string" ? t : show(t), num(s, "font size", l))));
    b("print", fn1("print", (a) => { console.log("[curv]", show(a)); return null; }));
    b("error", fn1("error", (a, l) => { throw err(typeof a === "string" ? a : show(a), l); }));
    // --- colours
    for (const [n, hex] of Object.entries(NAMED)) b(n, colour(hex).slice(0, 3));
    const sRGB = fn1("sRGB", (a, l) => nums(a, l).slice(0, 3)); sRGB.sc = (_sc, a) => a;
    const hsvF = fn1("sRGB.HSV", (a, l) => { const [h, s, v] = nums(a, l); return hsv2rgb(h, s, v); }); hsvF.sc = (sc, a, l) => (sc.allStatic([a]) ? sc.static(hsvF.call(sc.staticValue(a, l), l)) : sc.dyn(sc.g.fn("hsv", [sc.toE(a, l)])));
    const hueF = fn1("sRGB.hue", (a, l) => hsv2rgb(num(a, "hue", l), 1, 1)); hueF.sc = (sc, a, l) => (sc.allStatic([a]) ? sc.static(hueF.call(sc.staticValue(a, l), l)) : sc.dyn(sc.g.fn("hsv", [sc.g.vec([sc.toE(a, l), sc.g.num(1), sc.g.num(1)])])));
    const greyF = fn1("sRGB.grey", (a, l) => { const g = num(a, "grey level", l); return [g, g, g]; }); greyF.sc = (sc, a, l) => (sc.allStatic([a]) ? sc.static(greyF.call(sc.staticValue(a, l), l)) : sc.dyn(sc.g.vec([sc.toE(a, l), sc.toE(a, l), sc.toE(a, l)])));
    sRGB.fields = new Map<string, Value>([["HSV", hsvF], ["hue", hueF], ["grey", greyF], ["gray", greyF]]);
    b("sRGB", sRGB);
    const webRGB = fn1("webRGB", (a, l) => nums(a, l).map((x) => x / 255)); webRGB.sc = (sc, a, l) => sc.dyn(sc.g.bin("/", sc.toE(a, l), sc.g.num(255))); b("webRGB", webRGB);
    const linRGB = fn1("linRGB", (a, l) => nums(a, l).map((x) => Math.pow(Math.max(0, x), 1 / 2.2))); linRGB.sc = (sc, a, l) => sc.dyn(sc.g.fn("pow", [sc.g.fn("max", [sc.toE(a, l), sc.g.num(0)]), sc.g.num(1 / 2.2)])); b("linRGB", linRGB);
    // --- pickers (parametric)
    const picker = (kind: ParamDesc["kind"]) => new Rec(new Map<string, Value>([["picker", kind]]));
    b("slider", fn1("slider", (a, l) => { const [lo, hi] = nums(a, l); const r = picker("slider"); r.f.set("lo", lo); r.f.set("hi", hi); return r; }));
    b("int_slider", fn1("int_slider", (a, l) => { const [lo, hi] = nums(a, l); const r = picker("int_slider"); r.f.set("lo", lo); r.f.set("hi", hi); return r; }));
    b("checkbox", picker("checkbox")); b("scale_picker", picker("scale_picker")); b("colour_picker", picker("colour_picker"));
    // --- shapes: primitives (centred; UI mode: px, y down · Curv mode: units, y up)
    b("nothing", S({ k: "nothing" })); b("everything", S({ k: "everything" }));
    b("circle", fn1("circle", (d, l) => S({ k: "circle", r: num(d, "diameter", l) / 2 })));
    b("disc", fn1("disc", (d, l) => S({ k: "circle", r: num(d, "diameter", l) / 2 })));
    b("ellipse", fn1("ellipse", (v, l) => { const [w, h] = vec2(v, "(w,h)", l); return S({ k: "ellipse", a: w, b: h }); }));
    const rectOf = (v: Value | undefined, l?: number): SNode => {
      if (v === undefined) throw err("rect expects a size", l);
      if (v instanceof Rec) {
        const g = (k: string, d: number) => (v.f.has(k) ? num(v.get(k)!, k, l) : d);
        const x0 = g("xmin", -Infinity), x1 = g("xmax", Infinity), y0 = g("ymin", -Infinity), y1 = g("ymax", Infinity);
        const kids: SNode[] = [];
        if (Number.isFinite(x0)) kids.push({ k: "half", nx: -1, ny: 0, d: -x0 }); if (Number.isFinite(x1)) kids.push({ k: "half", nx: 1, ny: 0, d: x1 });
        if (Number.isFinite(y0)) kids.push({ k: "half", nx: 0, ny: -1, d: -y0 }); if (Number.isFinite(y1)) kids.push({ k: "half", nx: 0, ny: 1, d: y1 });
        if ([x0, x1, y0, y1].every(Number.isFinite)) return { k: "xform", tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, rot: 0, sc: 1, s: { k: "rect", w: x1 - x0, h: y1 - y0, r: 0 } };
        return kids.length === 0 ? { k: "everything" } : { k: "inter", kids };
      }
      if (isList(v) && v.length === 2 && isList(v[0])) { const [x0, y0] = vec2(v[0], "corner", l), [x1, y1] = vec2(v[1], "corner", l); return { k: "xform", tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, rot: 0, sc: 1, s: { k: "rect", w: x1 - x0, h: y1 - y0, r: 0 } }; }
      const [w, h] = vec2(v, "(w,h)", l); return { k: "rect", w, h, r: 0 };
    };
    b("rect", fn1("rect", (v, l) => S(rectOf(v, l))));
    b("square", fn1("square", (v, l) => S(rectOf(isNum(v) ? [v, v] : v, l))));
    b("rrect", fn2("rrect", (v, r, l) => { const [w, h] = vec2(v, "(w,h)", l); return S({ k: "rect", w, h, r: num(r, "corner radius", l) }); }));
    // regular_polygon n  (circumradius 1, as in current Curv)  ·  regular_polygon {n, d}  ·  regular_polygon_d n d (inscribed diameter)
    b("regular_polygon", fn1("regular_polygon", (a, l) => { if (a instanceof Rec) { const n = Math.max(3, Math.round(num(a.get("n") ?? 3, "n", l))); return S({ k: "ngon", n, r: num(a.get("d") ?? 2, "d", l) / 2 }); } const n = Math.max(3, Math.round(num(a, "sides", l))); return S({ k: "ngon", n, r: Math.cos(Math.PI / n) }); }));
    b("regular_polygon_d", fn2("regular_polygon_d", (n, d, l) => S({ k: "ngon", n: Math.max(3, Math.round(num(n, "sides", l))), r: num(d, "diameter", l) / 2 })));
    b("polygon", fn1("polygon", (v, l) => { if (!isList(v)) throw err("polygon expects a list of points", l); const pts: number[] = []; for (const p of v) { const [x, y] = vec2(p, "point", l); pts.push(x, y); } return S({ k: "poly", pts }); }));
    b("line", fn2("line", (pts, th, l) => { if (!isList(pts) || pts.length !== 2) throw err("line expects (p1,p2)", l); const [x1, y1] = vec2(pts[0], "point", l), [x2, y2] = vec2(pts[1], "point", l); return S({ k: "seg", x1, y1, x2, y2, th: num(th, "thickness", l) }); }));
    b("half_plane", fn1("half_plane", (v, l) => {
      if (v instanceof Rec) {
        const [nx, ny] = vec2(v.get("normal") ?? [0, 1], "normal", l);
        if (v.f.has("at")) { const [ax, ay] = vec2(v.get("at")!, "point", l); const m = Math.hypot(nx, ny) || 1; return S({ k: "half", nx, ny, d: (ax * nx + ay * ny) / m }); }
        return S({ k: "half", nx, ny, d: num(v.get("d") ?? 0, "d", l) });
      }
      if (isList(v) && v.length === 2 && isList(v[0])) { const [x1, y1] = vec2(v[0], "point", l), [x2, y2] = vec2(v[1], "point", l); const nx = y2 - y1, ny = x1 - x2; const m = Math.hypot(nx, ny) || 1; return S({ k: "half", nx: nx / m, ny: ny / m, d: (x1 * nx + y1 * ny) / m }); }
      const [nx, ny] = vec2(v, "normal", l); return S({ k: "half", nx, ny, d: 0 });
    }));
    b("text", fn2("text", (t, s, l) => S({ k: "text", text: typeof t === "string" ? t : show(t), size: num(s, "font size", l), align: "center" })));
    b("text_left", fn2("text_left", (t, s, l) => S({ k: "text", text: typeof t === "string" ? t : show(t), size: num(s, "font size", l), align: "left" })));
    b("make_shape", fn1("make_shape", (r, l) => this.makeShape(rec(r, l), l)));
    b("make_texture", fn1("make_texture", (f, l) => S({ k: "custom", dist: null, colour: this.shaderFn(f, "texture", l), bbox: null, name: "make_texture" })));
    for (const n of ["cube", "sphere", "cylinder", "cone", "torus", "box", "extrude", "revolve", "rotate_extrude", "perimeter_extrude", "twist", "bend", "capsule", "half_space", "gyroid", "tetrahedron", "octahedron", "dodecahedron", "icosahedron", "prism", "pyramid", "ellipsoid", "lathe", "stretch3"])
      if (!env.vars.has(n)) b(n, fn1(n, (_a, l) => { throw err(`'${n}' is a 3D operation – this playground renders 2D shapes only (is_2d)`, l); }));
    // box helpers (a box is a record {x,y,w,h}, e.g. a solved layout variable); Curv's 3D box is rejected above
    b("frame", fn1("frame", (v, l) => { const bx = boxOf(v, l); return S({ k: "xform", tx: bx.x + bx.w / 2, ty: bx.y + bx.h / 2, rot: 0, sc: 1, s: { k: "rect", w: bx.w, h: bx.h, r: 0 } }); }));
    b("frame_r", fn2("frame_r", (r, v, l) => { const bx = boxOf(v, l); return S({ k: "xform", tx: bx.x + bx.w / 2, ty: bx.y + bx.h / 2, rot: 0, sc: 1, s: { k: "rect", w: bx.w, h: bx.h, r: num(r, "corner radius", l) } }); }));
    b("at", fn2("at", (v, s, l) => { const bx = boxOf(v, l); return S({ k: "xform", tx: bx.x + bx.w / 2, ty: bx.y + bx.h / 2, rot: 0, sc: 1, s: shape(s, l) }); }));
    b("box", fn1("box", (v, l) => { if (isList(v) && v.length === 3) throw err("'box [w,h,d]' is a 3D shape – use rect [w,h] in 2D", l); if (isList(v) && v.length === 2) return S(rectOf(v, l)); if (!isList(v) || v.length !== 4) throw err("box expects (x,y,w,h)", l); const [x, y, w, h] = v.map((n) => num(n, "number", l)); return makeBoxRec(x, y, w, h); }));
    b("inset", fn2("inset", (d, v, l) => { const bx = boxOf(v, l); const k = num(d, "inset", l); return makeBoxRec(bx.x + k, bx.y + k, bx.w - 2 * k, bx.h - 2 * k); }));
    // --- shape operators
    b("union", fn1("union", (v, l) => S({ k: "union", kids: shapes(v, l) })));
    b("intersection", fn1("intersection", (v, l) => S({ k: "inter", kids: shapes(v, l) })));
    b("difference", fn1("difference", (v, l) => { const k = shapes(v, l); if (k.length < 2) throw err("difference expects [a, b]", l); return S({ k: "diff", a: k[0], b: k.length === 2 ? k[1] : { k: "union", kids: k.slice(1) } }); }));
    b("complement", fn1("complement", (s, l) => S({ k: "complement", s: shape(s, l) })));
    b("smooth_union", fn2("smooth_union", (k, v, l) => S({ k: "sunion", s: num(k, "blend radius", l), kids: shapes(v, l) })));
    b("smooth_intersection", fn2("smooth_intersection", (k, v, l) => S({ k: "sinter", s: num(k, "blend radius", l), kids: shapes(v, l) })));
    b("smooth", fn1("smooth", (k, l) => { const s = num(k, "blend radius", l); return new Rec(new Map<string, Value>([
      ["union", fn1("smooth.union", (v, l2) => S({ k: "sunion", s, kids: shapes(v, l2) }))],
      ["intersection", fn1("smooth.intersection", (v, l2) => S({ k: "sinter", s, kids: shapes(v, l2) }))],
      ["difference", fn1("smooth.difference", (v, l2) => { const ks = shapes(v, l2); if (ks.length < 2) throw err("difference expects [a, b]", l2); return S({ k: "sdiff", s, a: ks[0], b: ks.length === 2 ? ks[1] : { k: "union", kids: ks.slice(1) } }); })],
    ])); }));
    b("morph", fn2("morph", (t, v, l) => { const ks = shapes(v, l); if (ks.length !== 2) throw err("morph expects [a, b]", l); return S({ k: "morph", t: num(t, "morph factor", l), a: ks[0], b: ks[1] }); }));
    b("offset", fn2("offset", (r, s, l) => S({ k: "round", r: num(r, "offset", l), s: shape(s, l) })));
    b("inflate", env.vars.get("offset")!);
    b("shell", fn2("shell", (w, s, l) => S({ k: "stroke", w: num(w, "shell thickness", l), s: shape(s, l) })));
    b("stroke", fn1("stroke", (a, l) => {
      if (a instanceof Rec) { const [x1, y1] = vec2(a.get("from") ?? [0, 0], "from", l), [x2, y2] = vec2(a.get("to") ?? [0, 0], "to", l); return S({ k: "seg", x1, y1, x2, y2, th: num(a.get("d") ?? 1, "d", l) }); }
      const w = num(a, "stroke width", l); return fn1("stroke'", (s, l2) => S({ k: "stroke", w, s: shape(s, l2) }));
    }));
    b("lipschitz", fn2("lipschitz", (k, s, l) => S({ k: "lipschitz", lip: num(k, "lipschitz bound", l), s: shape(s, l) })));
    const col = fn2("colour", (c, s, l) => {
      if (c instanceof Fn) return S({ k: "colourfn", f: this.shaderFn(c, "colour", l), s: shape(s, l) });
      if (isList(c) && c.length === 2 && c[0] instanceof Fn && c[1] instanceof Fn) { const [ifield, cmap] = c as Fn[]; const f = new Fn("colour", (p, l2) => cmap.call(ifield.call(p, l2), l2)); f.closure = undefined; f.sc = (sc, a, l2) => sc.call(sc.static(cmap), sc.call(sc.static(ifield), a, l2), l2); return S({ k: "colourfn", f: this.shaderFn(f, "colour", l), s: shape(s, l) }); }
      return S({ k: "colour", c: colour(c, l), s: shape(s, l) });
    });
    b("colour", col); b("color", col); b("texture", fn2("texture", (c, s, l) => (col.call(c, l) as Fn).call(s, l)));
    b("opacity", fn2("opacity", (a, s, l) => S({ k: "opacity", a: num(a, "opacity", l), s: shape(s, l) })));
    b("gradient", fn3("gradient", (cs, pts, s, l) => { if (!isList(cs) || cs.length !== 2 || !isList(pts) || pts.length !== 2) throw err("gradient expects (c1,c2) (p0,p1) shape", l); const [x0, y0] = vec2(pts[0], "point", l), [x1, y1] = vec2(pts[1], "point", l); return S({ k: "grad", c1: colour(cs[0], l), c2: colour(cs[1], l), x0, y0, x1, y1, s: shape(s, l) }); }));
    b("shadow", fn3("shadow", (o, bl, s, l) => { const [dx, dy] = vec2(o, "offset", l); return S({ k: "shadow", dx, dy, blur: num(bl, "blur", l), a: 0.45, s: shape(s, l) }); }));
    b("translate", fn2("translate", (v, s, l) => { const [tx, ty] = vec2(v, "offset", l); return S({ k: "xform", tx, ty, rot: 0, sc: 1, s: shape(s, l) }); }));
    b("move", env.vars.get("translate")!);
    b("rotate", fn2("rotate", (a, s, l) => { if (a instanceof Rec) { if (a.f.has("axis")) throw err("rotate {angle, axis} is 3D – use rotate angle", l); a = a.get("angle") ?? 0; } return S({ k: "xform", tx: 0, ty: 0, rot: num(a, "angle", l), sc: 1, s: shape(s, l) }); }));
    b("scale", fn2("scale", (k, s, l) => { if (isList(k)) { const [sx, sy] = vec2(k, "scale", l); return S({ k: "stretch", sx, sy, s: shape(s, l) }); } return S({ k: "xform", tx: 0, ty: 0, rot: 0, sc: num(k, "scale factor", l), s: shape(s, l) }); }));
    b("stretch", fn2("stretch", (k, s, l) => { const [sx, sy] = vec2(k, "scale", l); return S({ k: "stretch", sx, sy, s: shape(s, l) }); }));
    b("reflect", fn2("reflect", (v, s, l) => { const [nx, ny] = vec2(v, "axis", l); return S({ k: "reflect", nx, ny, s: shape(s, l) }); }));
    b("repeat_x", fn2("repeat_x", (d, s, l) => S({ k: "repeat", kind: "x", a: num(d, "spacing", l), b: 0, s: shape(s, l) })));
    b("repeat_y", fn2("repeat_y", (d, s, l) => S({ k: "repeat", kind: "y", a: 0, b: num(d, "spacing", l), s: shape(s, l) })));
    b("repeat_xy", fn2("repeat_xy", (d, s, l) => { const [a, bb] = vec2(d, "spacing", l); return S({ k: "repeat", kind: "xy", a, b: bb, s: shape(s, l) }); }));
    b("repeat_radial", fn2("repeat_radial", (n, s, l) => S({ k: "repeat", kind: "radial", a: num(n instanceof Rec ? n.get("n") ?? 1 : n, "count", l), b: 0, s: shape(s, l) })));
    b("repeat_mirror_x", fn1("repeat_mirror_x", (s, l) => S({ k: "repeat", kind: "mirror_x", a: 0, b: 0, s: shape(s, l) })));
    b("repeat_mirror_y", fn1("repeat_mirror_y", (s, l) => S({ k: "repeat", kind: "mirror_y", a: 0, b: 0, s: shape(s, l) })));
    b("repeat_mirror_xy", fn1("repeat_mirror_xy", (s, l) => S({ k: "repeat", kind: "mirror_xy", a: 0, b: 0, s: shape(s, l) })));
    b("swirl", fn2("swirl", (r, s, l) => { const q = rec(r, l); return S({ k: "swirl", strength: num(q.get("strength") ?? 1, "strength", l), d: num(q.get("d") ?? 1, "d", l), s: shape(s, l) }); }));
    b("pancake", fn2("pancake", (_d, s, l) => S(shape(s, l))));
    b("into", fn2("into", (f, l1, l) => { if (!(f instanceof Fn) || !isList(l1)) throw err("into expects a function and a list", l); return fn1("into'", (s, l2) => f.call([s, ...l1], l2)); }));
    const rowF = (gap: number, v: Value, l?: number): Value => {
      const ks = shapes(v, l); let x = 0; const kids: SNode[] = [];
      for (const k of ks) { const bb = bboxOf(k, this.atlas); const w = bb && Number.isFinite(bb[0]) && Number.isFinite(bb[2]) ? bb[2] - bb[0] : 2; const x0 = bb && Number.isFinite(bb[0]) ? bb[0] : -w / 2; kids.push({ k: "xform", tx: x - x0, ty: 0, rot: 0, sc: 1, s: k }); x += w + gap; }
      const total = x - gap; return S({ k: "xform", tx: -total / 2, ty: 0, rot: 0, sc: 1, s: { k: "union", kids } });
    };
    b("row", fn1("row", (a, l) => (isNum(a) ? fn1("row'", (v, l2) => rowF(a, v, l2)) : rowF(0.5, a, l))));
    b("show_axes", fn1("show_axes", (s, l) => {
      const n = shape(s, l); const bb = bboxOf(n, this.atlas); const ext = bb && bb.every(Number.isFinite) ? Math.max(bb[2] - bb[0], bb[3] - bb[1], 1) : 20; const th = ext / 250;
      const axis = (c: RGBA, x1: number, y1: number, x2: number, y2: number): SNode => ({ k: "colour", c, s: { k: "seg", x1, y1, x2, y2, th } });
      return S({ k: "union", kids: [n, axis([1, 0.3, 0.3, 1], -1e5, 0, 1e5, 0), axis([0.3, 1, 0.3, 1], 0, -1e5, 0, 1e5)] });
    }));
    b("show_bbox", fn1("show_bbox", (s, l) => { const n = shape(s, l); const bb = bboxOf(n, this.atlas); if (!bb || !bb.every(Number.isFinite)) return s; return S({ k: "union", kids: [n, { k: "colour", c: [1, 0.4, 0.8, 1], s: { k: "stroke", w: Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 200, s: { k: "xform", tx: (bb[0] + bb[2]) / 2, ty: (bb[1] + bb[3]) / 2, rot: 0, sc: 1, s: { k: "rect", w: bb[2] - bb[0], h: bb[3] - bb[1], r: 0 } } } }] }); }));
    // --- environment
    // viewport: the visible world rectangle (a box record, y up).  Programs that use it are
    // "responsive": they are re-solved whenever the camera or canvas changes.
    const vp = this.inputs.viewport;
    const viewport = makeBoxRec(vp.x, vp.y, vp.w, vp.h);
    viewport.f.set("width", vp.w); viewport.f.set("height", vp.h);
    b("viewport", viewport); b("parent", viewport); // `parent` kept as an alias for older programs
    b("time", this.inputs.time);
    b("mouse", new Rec(new Map<string, Value>([["x", this.inputs.mouse.x], ["y", this.inputs.mouse.y], ["down", this.inputs.mouse.down], ["pos", [this.inputs.mouse.x, this.inputs.mouse.y]]])));
    return env;
  }

  run(src: string): EvalResult {
    const base = this.builtins();
    const preludeEnv = base.child();
    const pre = (preludeAst ??= parse("{" + PRELUDE + "}"));
    if (pre.k === "rec") this.bindDefs(pre.defs, preludeEnv);
    const ast = parseCached(src);
    const value = this.eval(ast, preludeEnv.child());
    let node: SNode | null = null;
    if (value instanceof Shape) node = value.node;
    else if (isList(value) && value.length > 0 && value.every((v) => v instanceof Shape)) node = { k: "union", kids: value.map((v) => (v as Shape).node) };
    else if (value instanceof Rec && value.f.has("dist")) node = this.makeShape(value).node;
    return { shape: node, traces: this.traces, usesTime: this.usesTime, usesMouse: this.usesMouse, usesViewport: this.usesViewport, value, params: this.params };
  }

  bindPat(p: Pat, v: Value, env: Env, line?: number) {
    if (p.k === "any") return;
    if (p.k === "id") { env.vars.set(p.name, v); return; }
    if (p.k === "list") { if (!isList(v) || v.length !== p.items.length) throw err(`Pattern expects a list of ${p.items.length}, got ${show(v)}`, line); p.items.forEach((q, i) => this.bindPat(q, v[i], env, line)); return; }
    const r = v instanceof Shape ? this.shapeRec(v) : rec(v, line); for (const n of p.names) { if (!r.f.has(n)) throw err(`Record has no field '${n}'`, line); env.vars.set(n, r.f.get(n)!); }
  }
  makeClosure(params: Pat[], body: Expr, env: Env, name: string): Fn {
    const mk = (i: number, e: Env): Fn => {
      const f = new Fn(name, (arg, line) => { const e2 = e.child(); this.bindPat(params[i], arg, e2, line); return i + 1 < params.length ? mk(i + 1, e2) : this.eval(body, e2); });
      f.closure = { params: params.slice(i), body, env: e };
      return f;
    };
    return mk(0, env);
  }
  bindDefs(defs: Def[], env: Env) {
    // functions first (recursion-friendly), then values in order
    for (const d of defs) if (d.params.length > 0 || d.body.k === "lambda") {
      const v = d.params.length > 0 ? this.makeClosure(d.params, d.body, env, d.pat.k === "id" ? d.pat.name : "fn") : this.eval(d.body, env);
      this.bindPat(d.pat, v, env, d.line);
    }
    for (const d of defs) if (!(d.params.length > 0 || d.body.k === "lambda")) this.bindPat(d.pat, this.eval(d.body, env), env, d.line);
  }
  listItems(items: ListItem[], env: Env, out: Value[]) { for (const it of items) this.listItem(it, env, out); }
  listItem(it: ListItem, env: Env, out: Value[]) {
    switch (it.k) {
      case "expr": out.push(this.eval(it.e, env)); break;
      case "spread": { const v = this.eval(it.e, env); if (!isList(v)) throw err("Can only spread a list"); out.push(...v); break; }
      case "for": { const l = this.eval(it.iter, env); if (!isList(l)) throw err("for expects a list"); for (const x of l) { const e2 = env.child(); this.bindPat(it.pat, x, e2); this.listItem(it.body, e2, out); } break; }
      case "if": if (truthy(this.eval(it.cond, env))) this.listItem(it.then, env, out); else if (it.else) this.listItem(it.else, env, out); break;
    }
  }
  field(v: Value, name: string, line?: number): Value {
    if (v instanceof Rec) { const f = v.get(name); if (f === undefined) throw err(`Record has no field '${name}' (fields: ${[...v.f.keys()].join(", ")})`, line); return f; }
    if (v instanceof Shape) { const r = this.shapeRec(v); const f = r.get(name); if (f === undefined) throw err(`Shape has no field '${name}' (dist, colour, bbox, is_2d, is_3d)`, line); return f; }
    if (v instanceof Fn && v.fields) { const f = v.fields.get(name); if (f === undefined) throw err(`'${v.name}' has no field '${name}'`, line); return f; }
    throw err(`Cannot take field '.${name}' of a ${typeName(v)}`, line);
  }

  eval(e: Expr, env: Env): Value {
    switch (e.k) {
      case "num": return e.v; case "str": return e.v; case "bool": return e.v; case "null": return null;
      case "id": {
        if (e.name === "time") this.usesTime = true; else if (e.name === "mouse") this.usesMouse = true; else if (e.name === "viewport" || e.name === "parent") this.usesViewport = true;
        const v = env.lookup(e.name); if (v === undefined) throw err(`Unknown identifier '${e.name}'`, e.line); return v;
      }
      case "list": { const out: Value[] = []; this.listItems(e.items, env, out); return out; }
      case "rec": {
        const e2 = env.child(); const r = new Rec();
        for (const s of e.spreads) { const v = this.eval(s, e2); const src = v instanceof Shape ? this.shapeRec(v) : rec(v); for (const [k, x] of src.f) { r.f.set(k, x); e2.vars.set(k, x); } }
        this.bindDefs(e.defs, e2);
        for (const [k, v] of e2.vars) r.f.set(k, v);
        for (const f of e.fields) r.f.set(f.name, this.eval(f.e, e2)); return r;
      }
      case "let": { const e2 = env.child(); this.bindDefs(e.defs, e2); return this.eval(e.body, e2); }
      case "do": { const e2 = env.child(); this.execDo(e.stmts, e2); return this.eval(e.body, e2); }
      case "parametric": {
        const e2 = env.child();
        for (const p of e.params) {
          const pred = this.eval(p.pred, env); const init = this.eval(p.init, env);
          const kind = (pred instanceof Rec && typeof pred.get("picker") === "string" ? pred.get("picker") : "slider") as ParamDesc["kind"];
          const lo = pred instanceof Rec && isNum(pred.get("lo") ?? null) ? (pred.get("lo") as number) : 0, hi = pred instanceof Rec && isNum(pred.get("hi") ?? null) ? (pred.get("hi") as number) : 1;
          const given = this.inputs.params?.[p.name];
          let value: Value = init;
          if (given !== undefined) {
            if (kind === "checkbox") value = typeof given === "boolean" ? given : init;
            else if (kind === "colour_picker") value = isList(given) ? given : init;
            else value = typeof given === "number" ? (kind === "int_slider" ? Math.round(given) : given) : init;
          }
          this.params.push({ name: p.name, label: p.label, kind, lo, hi, value: value as number | boolean | number[] });
          e2.vars.set(p.name, value);
        }
        return this.eval(e.body, e2);
      }
      case "if": return truthy(this.eval(e.cond, env)) ? this.eval(e.then, env) : this.eval(e.else, env);
      case "lambda": return this.makeClosure(e.params, e.body, env, "λ");
      case "call": {
        const f = this.eval(e.fn, env); const a = this.eval(e.arg, env);
        if (f instanceof Fn) return f.call(a, e.line);
        if (isList(f) || f instanceof Rec) return this.index(f, a, e.line);
        throw err(`Cannot call a ${typeName(f)}`, e.line);
      }
      case "index": return this.index(this.eval(e.e, env), this.eval(e.idx, env), e.line);
      case "field": return this.field(this.eval(e.e, env), e.name, e.line);
      case "un": { const v = this.eval(e.e, env); if (e.op === "!") return !truthy(v, e.line); return arith("*", v, -1, e.line); }
      case "bin": {
        if (e.op === "&&") return truthy(this.eval(e.a, env), e.line) && truthy(this.eval(e.b, env), e.line);
        if (e.op === "||") return truthy(this.eval(e.a, env), e.line) || truthy(this.eval(e.b, env), e.line);
        return arith(e.op, this.eval(e.a, env), this.eval(e.b, env), e.line);
      }
      case "cmp": {
        const vals = e.args.map((a) => this.eval(a, env));
        for (let i = 0; i < e.ops.length; i++) {
          const a = vals[i], b = vals[i + 1], op = e.ops[i];
          if (a instanceof Lin || b instanceof Lin) throw err("Constraints on solver variables are only allowed as statements inside solve { }", e.line);
          let r: boolean;
          if (op === "==") r = equalV(a, b); else if (op === "!=") r = !equalV(a, b);
          else { const x = num(a, "number", e.line), y = num(b, "number", e.line); r = op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y; }
          if (!r) return false;
        }
        return true;
      }
      case "range": {
        const a = num(this.eval(e.a, env), "range start"), b = num(this.eval(e.b, env), "range end"), s = e.step ? num(this.eval(e.step, env), "range step") : 1;
        const out: number[] = []; if (s === 0) throw err("range step cannot be 0");
        const end = e.open ? b - s * 1e-9 : b;
        for (let x = a; s > 0 ? (e.open ? x < end : x <= b + 1e-9) : (e.open ? x > end : x >= b - 1e-9); x += s) { out.push(x); if (out.length > 100000) throw err("range too large"); }
        return out;
      }
      case "solve": return this.solve(e.stmts, env, e.line);
    }
  }
  index(c: Value, i: Value, line?: number): Value {
    if (isList(i) && i.length === 1) i = i[0];
    if (isList(c)) {
      if (isList(i)) return i.map((x) => this.index(c, x, line));
      const k = num(i, "index", line); if (k < 0 || k >= c.length || !Number.isInteger(k)) throw err(`Index ${k} out of range (list has ${c.length})`, line); return c[k];
    }
    if (c instanceof Rec) { if (typeof i !== "string") throw err("Record index must be a string", line); const v = c.get(i); if (v === undefined) throw err(`Record has no field '${i}'`, line); return v; }
    throw err(`Cannot index a ${typeName(c)}`, line);
  }

  // ---------- do { } statements (CPU) ----------
  execDo(ss: Stmt[], env: Env) {
    for (const s of ss) {
      switch (s.k) {
        case "local": case "def": { const d = s.k === "local" ? s.def : s.def; if (d.params.length > 0) this.bindDefs([d], env); else this.bindPat(d.pat, this.eval(d.body, env), env, d.line); break; }
        case "assign": { const o = env.owner(s.name); if (!o) throw err(`Unknown variable '${s.name}'`, s.line); o.vars.set(s.name, this.eval(s.e, env)); break; }
        case "if": if (truthy(this.eval(s.cond, env), s.line)) this.execDo(s.body, env.child()); else if (s.else) this.execDo(s.else, env.child()); break;
        case "for": { const l = this.eval(s.iter, env); if (!isList(l)) throw err("for expects a list", s.line); for (const x of l) { const e2 = env.child(); this.bindPat(s.pat, x, e2, s.line); if (s.until && truthy(this.eval(s.until, e2), s.line)) break; this.execDo(s.body, e2); } break; }
        case "while": { let n = 0; while (truthy(this.eval(s.cond, env), s.line)) { this.execDo(s.body, env.child()); if (++n > 1e6) throw err("while loop did not terminate", s.line); } break; }
        case "expr": this.eval(s.e, env); break;
        default: throw err("This statement is only allowed inside solve { }", (s as { line?: number }).line);
      }
    }
  }

  // ---------- solve { } ----------
  solve(stmts: Stmt[], outer: Env, line: number): Value {
    const prob = new Problem(); const env = outer.child();
    const declared: { name: string; value: Value }[] = [];
    let nCons = 0;
    const mkVar = (name: string, type: string): Value => {
      if (type === "num") return Lin.v(prob.newVar(name));
      if (type === "point") return [Lin.v(prob.newVar(name + ".x")), Lin.v(prob.newVar(name + ".y"))];
      if (type === "box") return makeBoxRec(Lin.v(prob.newVar(name + ".x")), Lin.v(prob.newVar(name + ".y")), Lin.v(prob.newVar(name + ".w")), Lin.v(prob.newVar(name + ".h")));
      throw err(`Unknown variable type '${type}' (use num, point, box, or type[n])`, line);
    };
    const addCons = (a: Value, b: Value, op: string, weight: number, label: string, ln: number) => {
      if (isList(a) && isList(b)) { if (a.length !== b.length) throw err("Constraint vector length mismatch", ln); a.forEach((x, i) => addCons(x, b[i], op, weight, label, ln)); return; }
      if (isList(a)) { a.forEach((x) => addCons(x, b, op, weight, label, ln)); return; }
      if (isList(b)) { b.forEach((x) => addCons(a, x, op, weight, label, ln)); return; }
      if (a instanceof Rec && b instanceof Rec) { for (const k of ["x", "y", "w", "h"]) if (a.f.has(k) && b.f.has(k)) addCons(a.get(k)!, b.get(k)!, op, weight, label + "." + k, ln); return; }
      if (!isAff(a) || !isAff(b)) throw err(`Constraints must be linear in solver variables (got ${typeName(a)} ${op} ${typeName(b)})`, ln);
      const lin = toLin(a).sub(toLin(b));
      const rel: Rel = op === "==" ? "=" : op === "<=" || op === "<" ? "<" : op === ">=" || op === ">" ? ">" : (() => { throw err("'!=' is not a convex constraint", ln); })();
      if (lin.isConst()) { const v = lin.c; const ok = rel === "=" ? Math.abs(v) < 1e-9 : rel === "<" ? v <= 1e-9 : v >= -1e-9; if (!ok && weight === Infinity) throw err(`Constraint on line ${ln} is constant and false`, ln); return; }
      prob.addConstraint({ lin, rel, weight, label }); nCons++;
    };
    const exec = (ss: Stmt[], env: Env) => {
      for (const s of ss) {
        switch (s.k) {
          case "var": {
            const cnt = s.count ? num(this.eval(s.count, env), "count", s.line) : undefined;
            for (const n of s.names) { const v: Value = cnt === undefined ? mkVar(n, s.type) : Array.from({ length: cnt }, (_, i) => mkVar(`${n}[${i}]`, s.type)); env.vars.set(n, v); declared.push({ name: n, value: v }); }
            break;
          }
          case "def": case "local": this.bindDefs([s.def], env); break;
          case "assign": { const o = env.owner(s.name); if (!o) throw err(`Unknown variable '${s.name}'`, s.line); o.vars.set(s.name, this.eval(s.e, env)); break; }
          case "cons": {
            if (s.e.k !== "cmp") throw err("Expected a constraint like a == b, a <= b or a >= b", s.line);
            const w = s.weight ? num(this.eval(s.weight, env), "weight", s.line) : 1;
            const weight = s.strength === "required" ? Infinity : STRENGTH[s.strength] * w;
            const vals = s.e.args.map((a) => this.eval(a, env));
            for (let i = 0; i < s.e.ops.length; i++) addCons(vals[i], vals[i + 1], s.e.ops[i], weight, `${s.strength} line ${s.line}`, s.line);
            break;
          }
          case "obj": {
            const v = this.eval(s.e, env);
            if (!(isAff(v) || v instanceof Quad)) throw err("Objective must be a linear or quadratic expression", s.line);
            prob.minimize(s.sense === "minimize" ? toQuad(v) : toQuad(v).scale(-1)); break;
          }
          case "for": { const l = this.eval(s.iter, env); if (!isList(l)) throw err("for expects a list", s.line); for (const x of l) { const e2 = env.child(); this.bindPat(s.pat, x, e2, s.line); exec(s.body, e2); } break; }
          case "while": throw err("while is not allowed inside solve { }", s.line);
          case "if": if (truthy(this.eval(s.cond, env), s.line)) exec(s.body, env.child()); else if (s.else) exec(s.else, env.child()); break;
          case "expr": this.eval(s.e, env); break;
        }
      }
    };
    exec(stmts, env);
    const res = prob.solve();
    const subst = (v: Value): Value => {
      if (v instanceof Lin) return res.ok ? v.eval(res.values) : 0;
      if (isList(v)) return v.map(subst);
      if (v instanceof Rec) { const r = new Rec(); for (const [k, x] of v.f) r.f.set(k, subst(x)); return r; }
      return v;
    };
    const out = new Rec();
    const shown: { name: string; value: string }[] = [];
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const collect = (v: Value) => {
      if (isList(v)) v.forEach(collect);
      else if (v instanceof Rec && ["x", "y", "w", "h"].every((k) => isNum(v.get(k) ?? null))) boxes.push({ x: v.get("x") as number, y: v.get("y") as number, w: v.get("w") as number, h: v.get("h") as number });
    };
    for (const d of declared) {
      const v = subst(d.value); out.f.set(d.name, v); collect(v);
      if (isList(v) && v.length > 0 && (v[0] instanceof Rec || isList(v[0]))) v.slice(0, 16).forEach((x, i) => shown.push({ name: `${d.name}[${i}]`, value: showSolved(x) }));
      else shown.push({ name: d.name, value: showSolved(v) });
    }
    out.f.set("solver", new Rec(new Map<string, Value>([["status", res.statusText], ["ok", res.ok], ["engine", res.engine], ["objective", res.objective], ["iterations", res.iterations], ["time_ms", res.timeMs]])));
    this.traces.push({ line, engine: res.reducedVars === 0 ? "presolve" : res.engine, status: res.statusText, ok: res.ok, timeMs: res.timeMs, iterations: res.iterations, nVars: prob.names.length, nCons, eliminated: res.eliminated ?? 0, objective: res.objective, violations: res.violations, values: shown, boxes });
    if (!res.ok) throw err(`solve on line ${line} failed: ${res.statusText} (${res.engine})`, line);
    return out;
  }
}
function showSolved(v: Value): string {
  const f = (n: number) => (Math.abs(n) < 5e-4 ? "0" : Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));
  if (isNum(v)) return f(v);
  if (v instanceof Rec) { const g = (k: string) => f(v.get(k) as number); return v.f.has("w") ? `x ${g("x")}  y ${g("y")}  w ${g("w")}  h ${g("h")}` : [...v.f].map(([k, x]) => `${k} ${showSolved(x)}`).join("  "); }
  if (isList(v)) return v.length <= 4 && v.every(isNum) ? "(" + v.map(f).join(", ") + ")" : `[${v.length} items]`;
  return show(v);
}

/** Compile a whole program (shape tree) for a backend. */
export function compileTree(node: SNode, atlas: Atlas, target: "wgsl" | "js", defaultColour: RGBA = DEFAULT_COLOUR) {
  const g: Gen = target === "wgsl" ? new WGSL() : new JS();
  const ctx: GenCtx = { atlas, zoom: { t: "f", s: target === "wgsl" ? "u.cam.z" : "zoom" }, time: { t: "f", s: target === "wgsl" ? "u.time" : "T" }, cull: true, defaultColour };
  const r = genShape(g, node, { t: "v2", s: "p0" }, ctx);
  return { code: g.code(), d: r.d.s, c: r.c.s, params: new Float32Array(g.params) };
}
export { Shape, DEFAULT_COLOUR };
