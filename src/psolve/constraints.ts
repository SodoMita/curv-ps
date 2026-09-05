// Linear / quadratic constraint modelling layer on top of psolve.
// Affine expressions over solver variables are compiled to a convex QP
// (soft constraints & quadratic objectives) or a plain LP (pure linear).
import { solveLP, solveQP, type SolveResult } from "./psolve";

export type VarId = number;

/** Affine expression: c + Σ t[i]·x_i */
export class Lin {
  constructor(public c = 0, public t: Map<VarId, number> = new Map()) {}
  static const(v: number) { return new Lin(v); }
  static v(id: VarId) { return new Lin(0, new Map([[id, 1]])); }
  isConst() { return this.t.size === 0; }
  clone() { return new Lin(this.c, new Map(this.t)); }
  add(o: Lin): Lin {
    const r = this.clone(); r.c += o.c;
    for (const [k, v] of o.t) r.t.set(k, (r.t.get(k) ?? 0) + v);
    return r.prune();
  }
  sub(o: Lin) { return this.add(o.scale(-1)); }
  scale(s: number): Lin {
    const r = new Lin(this.c * s); for (const [k, v] of this.t) r.t.set(k, v * s); return r.prune();
  }
  prune() { for (const [k, v] of this.t) if (Math.abs(v) < 1e-14) this.t.delete(k); return this; }
  eval(x: number[]) { let s = this.c; for (const [k, v] of this.t) s += v * x[k]; return s; }
}

/** Quadratic expression (objective only): lin + Σ q[i,j]·x_i·x_j */
export class Quad {
  constructor(public lin = new Lin(), public q: Map<string, [VarId, VarId, number]> = new Map()) {}
  static fromLin(l: Lin) { return new Quad(l.clone()); }
  add(o: Quad): Quad {
    const r = new Quad(this.lin.add(o.lin), new Map(this.q));
    for (const [k, [i, j, c]] of o.q) { const e = r.q.get(k); r.q.set(k, [i, j, (e ? e[2] : 0) + c]); }
    return r;
  }
  scale(s: number): Quad {
    const r = new Quad(this.lin.scale(s));
    for (const [k, [i, j, c]] of this.q) r.q.set(k, [i, j, c * s]);
    return r;
  }
  static mul(a: Lin, b: Lin): Quad {
    // (a.c + Σ a_i x_i)(b.c + Σ b_j x_j)
    const r = new Quad(a.scale(b.c).add(b.scale(a.c)).sub(Lin.const(a.c * b.c)));
    for (const [i, ai] of a.t) for (const [j, bj] of b.t) {
      const [p, q] = i <= j ? [i, j] : [j, i]; const k = p + "," + q;
      const e = r.q.get(k); r.q.set(k, [p, q, (e ? e[2] : 0) + ai * bj]);
    }
    return r;
  }
  eval(x: number[]) { let s = this.lin.eval(x); for (const [, [i, j, c]] of this.q) s += c * x[i] * x[j]; return s; }
}

export type Rel = "=" | "<" | ">";
export interface Constraint { lin: Lin; rel: Rel; weight: number; label?: string } // lin REL 0 ; weight=Infinity => hard
export const STRENGTH: Record<string, number> = { required: Infinity, strong: 1e4, medium: 1e2, weak: 1 };
/** A first-class constraint value: `a == b` evaluated on solver variables (outside a statement) yields one of these. */
export class Cons {
  /** `weight` is an explicit strength attached with `strength "weak" c` / `weight w c`; undefined = inherit the statement's. */
  constructor(public lin: Lin, public rel: Rel, public line?: number, public weight?: number) {}
  withWeight(w: number) { return new Cons(this.lin, this.rel, this.line, w); }
}

export interface ConstraintResult extends SolveResult {
  values: number[]; // per user variable
  reducedVars?: number; eliminated?: number;
  violations: { label: string; amount: number }[];
}

export class Problem {
  names: string[] = [];
  constraints: Constraint[] = [];
  objective = new Quad();
  newVar(name: string): VarId { this.names.push(name); return this.names.length - 1; }
  addConstraint(c: Constraint) { this.constraints.push(c); }
  minimize(q: Quad) { this.objective = this.objective.add(q); }

  /**
   * A string that identifies the numeric problem exactly (variables, every coefficient, relation,
   * weight and the objective).  Two problems with the same fingerprint have the same solution, so
   * the interpreter can skip presolve + psolve when a re-evaluated `solve { }` block is unchanged.
   */
  fingerprint(): string {
    const parts: (string | number)[] = [this.names.length];
    for (const c of this.constraints) {
      parts.push(c.rel, c.weight, c.lin.c);
      for (const [k, v] of c.lin.t) parts.push(k, v);
      parts.push("|");
    }
    parts.push("#", this.objective.lin.c);
    for (const [k, v] of this.objective.lin.t) parts.push(k, v);
    for (const [, [i, j, c]] of this.objective.q) parts.push(i, j, c);
    return parts.join(",");
  }

  /**
   * Presolve: eliminate hard equalities by Gaussian elimination so psolve
   * only sees the genuinely free directions (UI layouts are ~90% equalities).
   * Returns null when the equality system is inconsistent.
   */
  private eliminate(hardEq: Constraint[]) {
    const nv = this.names.length;
    const rows = hardEq.map((c) => { const r = new Float64Array(nv + 1); for (const [k, v] of c.lin.t) r[k] += v; r[nv] = -c.lin.c; return r; });
    const pivotOf: number[] = []; let rank = 0;
    for (let col = 0; col < nv && rank < rows.length; col++) {
      let best = -1, bv = 1e-9;
      for (let r = rank; r < rows.length; r++) if (Math.abs(rows[r][col]) > bv) { bv = Math.abs(rows[r][col]); best = r; }
      if (best < 0) continue;
      [rows[rank], rows[best]] = [rows[best], rows[rank]];
      const pr = rows[rank], pv = pr[col]; for (let j = 0; j <= nv; j++) pr[j] /= pv;
      for (let r = 0; r < rows.length; r++) if (r !== rank && rows[r][col] !== 0) { const f = rows[r][col]; const rr = rows[r]; for (let j = 0; j <= nv; j++) rr[j] -= f * pr[j]; }
      pivotOf[rank] = col; rank++;
    }
    for (let r = rank; r < rows.length; r++) if (Math.abs(rows[r][nv]) > 1e-6) return null; // 0 = nonzero
    const subst = new Map<VarId, Lin>();
    for (let r = 0; r < rank; r++) {
      const p = pivotOf[r], row = rows[r]; const l = new Lin(row[nv]);
      for (let j = 0; j < nv; j++) if (j !== p && Math.abs(row[j]) > 1e-12) l.t.set(j, -row[j]);
      subst.set(p, l);
    }
    const free: VarId[] = []; const newIdx = new Map<VarId, number>();
    for (let j = 0; j < nv; j++) if (!subst.has(j)) { newIdx.set(j, free.length); free.push(j); }
    const sLin = (lin: Lin): Lin => {
      const out = new Lin(lin.c);
      for (const [k, v] of lin.t) {
        const s = subst.get(k);
        if (!s) out.t.set(newIdx.get(k)!, (out.t.get(newIdx.get(k)!) ?? 0) + v);
        else { out.c += v * s.c; for (const [k2, v2] of s.t) { const ni = newIdx.get(k2)!; out.t.set(ni, (out.t.get(ni) ?? 0) + v * v2); } }
      }
      return out.prune();
    };
    const sQuad = (q: Quad): Quad => {
      let out = Quad.fromLin(sLin(q.lin));
      for (const [, [i, j, c]] of q.q) { const li = sLin(Lin.v(i)), lj = sLin(Lin.v(j)); out = out.add(Quad.mul(li, lj).scale(c)); }
      return out;
    };
    return { free, subst, sLin, sQuad };
  }

  solve(): ConstraintResult {
    const nvFull = this.names.length;
    const hardEq = this.constraints.filter((c) => c.weight === Infinity && c.rel === "=");
    const pre = this.eliminate(hardEq);
    if (!pre) {
      return { status: 1, statusText: "INFEASIBLE", ok: false, x: [], objective: NaN, iterations: 0, timeMs: 0, engine: "psolve/LP", values: new Array(nvFull).fill(0), violations: [{ label: "equality system", amount: Infinity }] };
    }
    const nv = pre.free.length;
    const reduced = (c: Constraint): Constraint => ({ ...c, lin: pre.sLin(c.lin) });
    const all = this.constraints.filter((c) => !(c.weight === Infinity && c.rel === "=")).map(reduced)
      .filter((c) => {
        if (!c.lin.isConst()) return true;
        const v = c.lin.c; const ok = c.rel === "=" ? Math.abs(v) < 1e-7 : c.rel === "<" ? v <= 1e-7 : v >= -1e-7;
        if (!ok && c.weight === Infinity) throw new Error(`Constraint '${c.label ?? ""}' is unsatisfiable after propagation`);
        return false;
      });
    const soft = all.filter((c) => c.weight !== Infinity);
    const hard = all.filter((c) => c.weight === Infinity);
    const objective = pre.sQuad(this.objective);
    const isQP = soft.length > 0 || objective.q.size > 0;
    let res: SolveResult; let x: number[];
    if (nv === 0) {
      res = { status: 0, statusText: "OPTIMAL", ok: true, x: [], objective: objective.eval([]), iterations: 0, timeMs: 0, engine: isQP ? "psolve/QP" : "psolve/LP" };
      x = [];
    } else if (!isQP) {
      // ---- LP path: free variables, rows lin REL 0  =>  Σ t x REL -c
      const cols: Map<number, number>[] = Array.from({ length: nv }, () => new Map());
      const b: number[] = []; let rel = "";
      hard.forEach((h, i) => { for (const [k, v] of h.lin.t) cols[k].set(i, v); b.push(-h.lin.c); rel += h.rel; });
      const colptr = [0], row: number[] = [], val: number[] = [];
      for (let j = 0; j < nv; j++) { for (const [r, v] of cols[j]) { row.push(r); val.push(v); } colptr.push(row.length); }
      const c = new Array(nv).fill(0); for (const [k, v] of objective.lin.t) c[k] = v;
      // Unreferenced / unbounded directions: box them loosely so a costless LP still has a vertex.
      const l = new Array(nv).fill(-1e6), u = new Array(nv).fill(1e6);
      res = solveLP({ n: nv, m: hard.length, c, colptr, row, val, rel, b, l, u, maximize: false });
      x = res.x;
    } else {
      // ---- QP path: variables = user vars + one error var per soft *inequality*.
      // Soft equalities need no rows at all: w·(lin)² goes straight into the objective.  (Modelling
      // them as two inequality rows with an error variable made the active set degenerate whenever the
      // target coincided with an active hard bound, and psolve's active-set QP then reported INFEASIBLE.)
      const softEq = soft.filter((s) => s.rel === "="), softIneq = soft.filter((s) => s.rel !== "=");
      const n = nv + softIneq.length;
      const Q = new Array(n * n).fill(0), c = new Array(n).fill(0);
      const A: number[] = [], b: number[] = [];
      const pushRow = (lin: Lin, extra?: [number, number]) => {
        const r = new Array(n).fill(0); for (const [k, v] of lin.t) r[k] += v;
        if (extra) r[extra[0]] += extra[1]; A.push(...r); b.push(-lin.c);
      };
      for (const [, [i, j, k]] of objective.q) { if (i === j) Q[i * n + i] += 2 * k; else { Q[j * n + i] += k; Q[i * n + j] += k; } }
      for (const [k, v] of objective.lin.t) c[k] += v;
      for (const s of softEq) { // + w·(c + Σ t_i x_i)²  =  ½ xᵀ(2w t tᵀ)x + (2w c t)ᵀx + const
        const t = [...s.lin.t]; const w = s.weight;
        for (const [i, ti] of t) { c[i] += 2 * w * s.lin.c * ti; for (const [j, tj] of t) Q[i * n + j] += 2 * w * ti * tj; }
      }
      for (const h of hard) {
        if (h.rel === "<" || h.rel === "=") pushRow(h.lin);
        if (h.rel === ">" || h.rel === "=") pushRow(h.lin.scale(-1));
      }
      softIneq.forEach((s, si) => { // one-sided penalty: lin REL 0 relaxed by e ≥ 0, cost w·e²
        const e = nv + si; Q[e * n + e] += 2 * s.weight;
        pushRow(s.rel === "<" ? s.lin : s.lin.scale(-1), [e, -1]); pushRow(new Lin(0), [e, -1]);
      });
      // tiny ridge on user vars keeps under-determined layouts unique and well-conditioned
      for (let i = 0; i < nv; i++) Q[i * n + i] += 1e-7;
      res = solveQP({ n, m: b.length, Q, c, A, b });
      x = res.x.slice(0, nv);
    }
    // back-substitute eliminated variables
    const full = new Array(nvFull).fill(0);
    pre.free.forEach((orig, i) => { full[orig] = x[i]; });
    for (const [p, l] of pre.subst) full[p] = l.c + [...l.t].reduce((s, [k, v]) => s + v * full[k], 0);
    const violations: { label: string; amount: number }[] = [];
    if (res.ok) for (const cst of this.constraints) {
      if (cst.weight !== Infinity) continue; // soft constraints are allowed to yield
      const v = cst.lin.eval(full);
      const viol = cst.rel === "=" ? Math.abs(v) : cst.rel === "<" ? Math.max(0, v) : Math.max(0, -v);
      if (viol > 1e-3) violations.push({ label: cst.label ?? "constraint", amount: viol });
    }
    return { ...res, values: full, violations, reducedVars: nv, eliminated: nvFull - nv };
  }
}
