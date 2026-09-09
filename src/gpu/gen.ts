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

/**
 * Code-generation variants, all preserving the parameter layout (so `walkParams` and the memoised
 * caches stay valid).  `scripts/shaderbench.ts` measures them individually; the defaults are the
 * winners of that benchmark.  A change of any flag changes the generated text, so it is part of
 * the structural key (see `flagsKey`) — `codeLru`/`structKey` results are never confused across them.
 */
export interface ShaderFlags {
  /** polygon loop: conditional index instead of `%`, sign via `select` instead of `if` (branchless) */
  polySelect: boolean;
  /** text loop: always sample the atlas and `select` instead of `if (inside) {…} else {…}` (branchless) */
  textBranchless: boolean;
  /** minimum subtree weight for a bbox-cull branch in unions/intersections (Infinity = never cull) */
  cullWeight: number;
  /** SubCurv: flatten a dynamic `if` with tiny branch bodies into `select`s (compute both, pick) */
  flattenIf: boolean;
  /** SubCurv: unroll loops whose trip count is a compile-time constant ≤ this */
  unrollMax: number;
  /** text loop: binary-search the glyph window under the pixel (cells are sorted along the row) and
   *  evaluate only ~6 glyphs instead of all N — same parameters, different code */
  textWindow: boolean;
  /**
   * Master switch: emit **no control flow at all** — no `if`, no `else`, no `break`, no
   * short-circuit `&&`/`||`.  Every conditional becomes a masked assignment
   * (`x = select(x, v, cond)`) and every `break` becomes a `live` flag that stops further updates,
   * so both arms of a branch are always computed and every loop runs all of its iterations.
   * Uniform (parameter-counted) `for` loops stay: they are loops, not divergent branches.
   * Costs work, buys divergence-free warps; `scripts/branchbench.ts` measures which wins.
   */
  branchless: boolean;
  /**
   * `&&`/`||` short-circuit, and a short-circuit is a branch.  This flag alone (no masking of
   * `if`s) swaps them for the non-short-circuiting `&`/`|` that WGSL also defines for `bool`.
   * It is the cheap half of `branchless`: both operands are already-computed values in
   * straight-line code, so nothing extra is evaluated.  Implied by `branchless`.
   */
  noShortCircuit: boolean;
  /** bbox-cull bracket of a union/intersection child as a `select` instead of an `if` (the child is
   *  then always evaluated — that is the whole cost of removing the branch).  Implied by
   *  `branchless`, which masks *every* conditional the same way. */
  cullSelect: boolean;
  /** the hand-written 3D raymarch wrapper (src/gpu/renderer.ts): no `if`, no `break` — every ray
   *  runs all 128 steps and is shaded even when it hits nothing.  Measured separately because it
   *  is by far the most expensive of the four. */
  branchless3D: boolean;
}
/**
 * Defaults, as measured by `scripts/branchbench.ts` (CPU fallback, best-of-N, pinned resolution):
 *   • `noShortCircuit` is free (1.00× slice / 1.02× solid) and removes every short-circuiting
 *     `&&`/`||` from the generated code, so it is on;
 *   • `branchless` costs 3.0× in the 2D view (it is mostly the loss of bbox culling) and 9.7× in
 *     the 3D view (the raymarch loses its early-out), so it is off.  Flip it here or from the
 *     console (`SHADER_FLAGS.branchless = true`) to build the branchless variant.
 */
export const SHADER_FLAGS: ShaderFlags = { polySelect: false, textBranchless: false, cullWeight: 4, flattenIf: false, unrollMax: 0, textWindow: false, branchless: false, noShortCircuit: true, cullSelect: false, branchless3D: false };
export const flagsKey = () => (SHADER_FLAGS.polySelect ? "p" : "") + (SHADER_FLAGS.textBranchless ? "T" : "") + "w" + SHADER_FLAGS.cullWeight + (SHADER_FLAGS.flattenIf ? "f" : "") + "u" + SHADER_FLAGS.unrollMax + (SHADER_FLAGS.textWindow ? "G" : "") + (SHADER_FLAGS.branchless ? "B" : "") + (SHADER_FLAGS.noShortCircuit ? "L" : "") + (SHADER_FLAGS.cullSelect ? "C" : "") + (SHADER_FLAGS.branchless3D ? "3" : "");
/** A branch is worth removing only when the flag says so; the individual flags remain for A/B. */
export const branchless = () => SHADER_FLAGS.branchless;
/** `&&`/`||` → `&`/`|`: on its own (no masked `if`s) or as part of the branchless build. */
export const bitLogic = () => SHADER_FLAGS.branchless || SHADER_FLAGS.noShortCircuit;

export abstract class Gen {
  /** set by SubCurv when compiled user code reads the time (the `t` of `[x,y,z,t]`, or `time`): the program animates through the time uniform */
  usesTime = false;
  abstract target: "wgsl" | "js";
  params: number[] = [];
  protected lines: string[] = [];
  protected indent = "  ";
  private n = 0;
  tmp(prefix = "t") { return `${prefix}${this.n++}`; }
  emit(s: string) { this.lines.push(this.indent + s); }
  code() { return this.lines.join("\n"); }
  /** statement count for speculative emission (SubCurv's if-flattening); `cut` returns and removes everything after the mark */
  mark(): number { return this.lines.length; }
  cut(m: number): string[] { return this.lines.splice(m); }

  param(v: number): E { const i = this.params.length; this.params.push(Number.isFinite(v) ? v : v > 0 ? 3e38 : v < 0 ? -3e38 : 0); return { t: "f", s: `P[${i}]` }; }
  /** Variable-length blocks (glyphs, polygon vertices) are appended *after* all scalar parameters by
   *  `finalParams()`, so a label that changes length never shifts the index of anything else; the
   *  block's start offset is itself a scalar parameter (the returned E). */
  private blocks: { slot: number; values: number[] }[] = [];
  dynBlock(values: number[]): E { const e = this.param(0); this.blocks.push({ slot: this.params.length - 1, values }); return e; }
  /** The complete parameter buffer: scalars first, then every dynamic block, with base slots patched. */
  finalParams(): number[] {
    const out = this.params.slice();
    for (const b of this.blocks) { out[b.slot] = out.length; for (const v of b.values) out.push(Number.isFinite(v) ? v : 0); }
    return out;
  }
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

  // ---- branchless lowering (SHADER_FLAGS.branchless) -------------------------------------------
  /** Conditions that currently guard every assignment (`if` arms and the `live` flag of a loop). */
  protected conds: E[] = [];
  /** Per-enclosing-loop `live` / break-requested flag pair; `brk()` sets the innermost one and
   *  clears `live` at the same moment — a break skips the rest of *this* iteration, not just the
   *  following ones. */
  protected brks: { live: E; brk: E }[] = [];
  /** AND of the active conditions, or null when nothing is guarded (so `assign` stays plain). */
  protected condNow(): E | null {
    if (!this.conds.length) return null;
    return this.conds.reduce((a, b) => ({ t: "b" as Ty, s: `(${a.s} & ${b.s})` }));
  }
  protected pushCond(c: E) { this.conds.push(c); }
  protected popCond() { this.conds.pop(); }
  swz(a: E, ids: number[]): E { const t = this.let(a); return this.vec(ids.map((i) => this.idx(t, i))); }
  // broadcast a scalar to a vector type
  abstract bcast(e: E, t: Ty): E;
  /** Scalar → vector only.  A vector → vector call is always a bug in the caller: WGSL silently
   *  truncated (vec2f(vec3f…)) while the JS `R.bc` is scalar-only and built a nested array,
   *  i.e. NaN.  Throw loudly instead — see the `text` glyph clamp (round 17). */
  protected bcastGuard(e: E, t: Ty): void {
    if (e.t !== "f" && e.t !== t) throw new GenError(`Cannot broadcast a ${DIM[e.t]}-component vector to ${DIM[t]} components`);
  }
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
  bcast(e: E, t: Ty): E { if (e.t === t) return e; this.bcastGuard(e, t); return { t, s: `${WTY[t]}(${e.s})` }; }
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
  /** `&&`/`||` short-circuit, i.e. they branch; branchless mode uses the non-short-circuiting
   *  `&`/`|`, which WGSL defines for `bool` too (both operands always evaluated). */
  logic(op: "&&" | "||", a: E, b: E): E { return { t: "b", s: bitLogic() ? `(${a.s} ${op === "&&" ? "&" : "|"} ${b.s})` : `(${a.s} ${op} ${b.s})` }; }
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
  /** Under a condition the store becomes `ref = select(ref, v, cond)` — the value is computed
   *  either way, but the update only lands where the branch would have taken it. */
  assign(ref: E, e: E) {
    const v = this.bcast(e, ref.t).s, c = branchless() ? this.condNow() : null;
    this.emit(c ? `${ref.s} = select(${ref.s}, ${v}, ${c.s});` : `${ref.s} = ${v};`);
  }
  if(c: E, then: () => void, els?: () => void) {
    if (branchless()) { // both arms emitted, guarded by the condition: no control flow at all
      this.pushCond(c); then(); this.popCond();
      if (els) { this.pushCond(this.not(c)); els(); this.popCond(); }
      return;
    }
    this.emit(`if (${c.s}) {`); this.indent += "  "; then(); this.indent = this.indent.slice(2);
    if (els) { this.emit("} else {"); this.indent += "  "; els(); this.indent = this.indent.slice(2); }
    this.emit("}");
  }
  loop(count: E, body: (i: E) => void) {
    const i = this.tmp("i");
    this.emit(`for (var ${i}: f32 = 0.0; ${i} < ${count.s}; ${i} += 1.0) {`); this.indent += "  ";
    if (branchless()) {
      // a `break` no longer leaves the loop: it clears `live`, so every later iteration is a no-op
      const live = this.tmp("l"), b = this.tmp("k");
      this.emit(`var ${live}: bool = true;`);
      this.emit(`var ${b}: bool = false;`);
      this.pushCond({ t: "b", s: live }); this.brks.push({ live: { t: "b", s: live }, brk: { t: "b", s: b } });
      body({ t: "f", s: i });
      this.brks.pop(); this.popCond();
      this.emit(`${live} = ${live} & !${b};`);
    } else body({ t: "f", s: i });
    this.indent = this.indent.slice(2); this.emit("}");
  }
  brk() {
    const f = branchless() ? this.brks[this.brks.length - 1] : undefined;
    if (!f) { this.emit("break;"); return; }
    this.assign(f.brk, this.bool(true));                 // masked by the active conditions
    this.emit(`${f.live.s} = ${f.live.s} & !${f.brk.s};`); // and retire *now*, not at the next iteration
  }
}

const fmtJ = (v: number) => (Number.isFinite(v) ? (Object.is(v, -0) ? "0" : String(v)) : v > 0 ? "Infinity" : v < 0 ? "-Infinity" : "0");

export class JS extends Gen {
  target = "js" as const;
  num(v: number): E { return { t: "f", s: fmtJ(v) }; }
  paramAt(i: E): E { return { t: "f", s: `P[${i.s}]` }; }
  bool(v: boolean): E { return { t: "b", s: v ? "true" : "false" }; }
  bcast(e: E, t: Ty): E { if (e.t === t) return e; this.bcastGuard(e, t); return { t, s: `R.bc(${e.s}, ${DIM[t]})` }; }
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
  logic(op: "&&" | "||", a: E, b: E): E { return { t: "b", s: bitLogic() ? `(${a.s} ${op === "&&" ? "&" : "|"} ${b.s})` : `(${a.s} ${op} ${b.s})` }; }
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
  /** see the WGSL backend: `select` becomes a ternary, `&`/`|` on booleans yield 0/1 numbers,
   *  which every consumer here (`? :`, `!`, further `&`) reads by truthiness. */
  assign(ref: E, e: E) {
    const v = this.bcast(e, ref.t).s, c = branchless() ? this.condNow() : null;
    this.emit(c ? `${ref.s} = (${c.s} ? ${v} : ${ref.s});` : `${ref.s} = ${v};`);
  }
  if(c: E, then: () => void, els?: () => void) {
    if (branchless()) {
      this.pushCond(c); then(); this.popCond();
      if (els) { this.pushCond(this.not(c)); els(); this.popCond(); }
      return;
    }
    this.emit(`if (${c.s}) {`); this.indent += "  "; then(); this.indent = this.indent.slice(2);
    if (els) { this.emit("} else {"); this.indent += "  "; els(); this.indent = this.indent.slice(2); }
    this.emit("}");
  }
  loop(count: E, body: (i: E) => void) {
    const i = this.tmp("i");
    this.emit(`for (let ${i} = 0; ${i} < ${count.s}; ${i}++) {`); this.indent += "  ";
    if (branchless()) {
      const live = this.tmp("l"), b = this.tmp("k");
      this.emit(`let ${live} = true;`);
      this.emit(`let ${b} = false;`);
      this.pushCond({ t: "b", s: live }); this.brks.push({ live: { t: "b", s: live }, brk: { t: "b", s: b } });
      body({ t: "f", s: i });
      this.brks.pop(); this.popCond();
      this.emit(`${live} = ${live} & !${b};`);
    } else body({ t: "f", s: i });
    this.indent = this.indent.slice(2); this.emit("}");
  }
  brk() {
    const f = branchless() ? this.brks[this.brks.length - 1] : undefined;
    if (!f) { this.emit("break;"); return; }
    this.assign(f.brk, this.bool(true));
    this.emit(`${f.live.s} = ${f.live.s} & !${f.brk.s};`);
  }
}

// Parameter-only backend: walks the very same codegen path as WGSL / JS but
// emits no text at all — it only records the parameter buffer.  Used when the
// structural key of a shape tree is unchanged between frames (animation,
// re-solving, sliders): the cached shader is reused and only `P` is refilled.
// Every method must consume its callbacks exactly like the real backends do so
// that parameters are pushed in the same order.
export class ParamsOnly extends Gen {
  target = "wgsl" as const;
  private static E: Record<Ty, E> = { f: { t: "f", s: "" }, v2: { t: "v2", s: "" }, v3: { t: "v3", s: "" }, v4: { t: "v4", s: "" }, b: { t: "b", s: "" } };
  private e(t: Ty): E { return ParamsOnly.E[t]; }
  private vt(comps: E[]): Ty { const n = comps.reduce((s, c) => s + DIM[c.t], 0); return vecTy(Math.min(4, Math.max(2, n))); }
  emit() { /* nothing */ }
  code() { return ""; }
  num(): E { return this.e("f"); }
  paramAt(): E { return this.e("f"); }
  bool(): E { return this.e("b"); }
  bcast(_e: E, t: Ty): E { return this.e(t); }
  bin(_op: string, a: E, b: E): E { return this.e(a.t === "f" ? b.t : a.t); }
  neg(a: E): E { return a; }
  cmp(): E { return this.e("b"); }
  logic(): E { return this.e("b"); }
  not(): E { return this.e("b"); }
  fn(name: string, args: E[]): E {
    if (name === "length" || name === "dot") return this.e("f");
    if (name === "cross" || name === "hsv") return this.e("v3");
    if (name === "clamp") return this.e(args.find((a) => a.t !== "f")?.t ?? "f");
    if (name === "smoothstep") return this.e(args[2].t);
    if (name === "mix") return this.e(args[0].t === "f" ? args[1].t : args[0].t);
    if (this.isUnary(name)) return this.e(args[0].t);
    return this.e(args[0].t === "f" ? args[1]?.t ?? "f" : args[0].t);
  }
  vec(comps: E[]): E { return this.e(this.vt(comps)); }
  idx(): E { return this.e("f"); }
  sel(_c: E, a: E, b: E): E { return this.e(a.t === "f" ? b.t : a.t); }
  tex(): E { return this.e("f"); }
  let(e: E): E { return e; }
  var(e: E): E { return e; }
  assign() { /* nothing */ }
  if(_c: E, then: () => void, els?: () => void) { then(); els?.(); }
  loop(_count: E, body: (i: E) => void) { body(this.e("f")); }
  brk() { /* nothing */ }
  swz(_a: E, ids: number[]): E { return this.e(ids.length === 1 ? "f" : vecTy(ids.length)); }
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
