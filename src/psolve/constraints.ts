// Linear / quadratic constraint modelling layer on top of psolve.
// Affine expressions over solver variables are compiled to a convex QP
// (soft constraints & quadratic objectives) or a plain LP (pure linear).
import { solveLP, solveQP, qpStartFeasible, type SolveResult, type SolveOpts } from "./psolve";

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
  /** Row labels of psolve's Farkas certificate: the conflicting subset (set only when infeasibility is PROVEN). */
  conflicts?: { label: string; lambda: number }[];
  /** The equality presolve declined (inconsistent equalities, found relative to row scale); the
   *  problem was handed to psolve UNREDUCED instead of being declared infeasible up front. */
  presolveDeclined?: boolean;
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
   *
   * Thresholds are RELATIVE to each row's own scale (|a_ij| max), not
   * absolute: an absolute 1e-6 inconsistency test on pixel-scale data turns a
   * merely ill-conditioned layout into a front-end false "INFEASIBLE".
   */
  private eliminate(hardEq: Constraint[]) {
    const nv = this.names.length;
    const rows = hardEq.map((c) => { const r = new Float64Array(nv + 1); for (const [k, v] of c.lin.t) r[k] += v; r[nv] = -c.lin.c; return r; });
    const rowMax = rows.map((r) => { let m = 0; for (let j = 0; j < nv; j++) m = Math.max(m, Math.abs(r[j])); return m; });
    const pivotOf: number[] = []; let rank = 0;
    for (let col = 0; col < nv && rank < rows.length; col++) {
      let best = -1, bv = 0;
      for (let r = rank; r < rows.length; r++) if (Math.abs(rows[r][col]) > Math.max(bv, 1e-11 * rowMax[r])) { bv = Math.abs(rows[r][col]); best = r; }
      if (best < 0) continue;
      [rows[rank], rows[best]] = [rows[best], rows[rank]];
      const pr = rows[rank], pv = pr[col]; for (let j = 0; j <= nv; j++) pr[j] /= pv;
      for (let r = 0; r < rows.length; r++) if (r !== rank && rows[r][col] !== 0) { const f = rows[r][col]; const rr = rows[r]; for (let j = 0; j <= nv; j++) rr[j] -= f * pr[j]; }
      pivotOf[rank] = col; rank++;
    }
    // residual zero rows: 0 = rhs.  Inconsistent when |rhs| is large relative to the row's own scale.
    for (let r = rank; r < rows.length; r++) if (Math.abs(rows[r][nv]) > 1e-9 * (1 + rowMax[r])) return null;
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

  /** Identity "elimination": used when the equality presolve declines — psolve decides (its
   *  certified infeasibility is authoritative; the front end's Gaussian test is not). */
  private identity() {
    const nv = this.names.length;
    const free: VarId[] = Array.from({ length: nv }, (_, i) => i);
    const subst = new Map<VarId, Lin>();
    const sLin = (lin: Lin): Lin => lin.clone().prune();
    const sQuad = (q: Quad): Quad => Quad.fromLin(q.lin.clone()).add(new Quad(new Lin(), new Map(q.q)));
    return { free, subst, sLin, sQuad };
  }

  /**
   * @param opts.x0  warm start in FULL user-var space (the previous solve's `values`; a nearby
   *                 problem's optimum).  Only used when the engine's own feasibility test accepts
   *                 it (`warm` in the result); otherwise the exact cold path runs, so results are
   *                 reproducible regardless of warm-cache state.
   */
  solve(opts: SolveOpts & { x0?: number[] } = {}): ConstraintResult {
    const nvFull = this.names.length;
    const hardEq = this.constraints.filter((c) => c.weight === Infinity && c.rel === "=");
    const elim = this.eliminate(hardEq);
    const presolveDeclined = elim === null && hardEq.length > 0;
    const pre = elim ?? this.identity();
    const nv = pre.free.length;
    const reduced = (c: Constraint): Constraint => ({ ...c, lin: pre.sLin(c.lin) });
    // A required constraint that propagated to a constant is a *proof*: the model is infeasible
    // and the constraint's label IS the conflict.  Never throw for it — return the certified
    // verdict so the caller can degrade to its last good layout (only a first-ever frame errors).
    let constProof: string | null = null;
    const all = this.constraints.filter((c) => !(c.weight === Infinity && c.rel === "=" && !presolveDeclined)).map(reduced)
      .filter((c) => {
        if (!c.lin.isConst()) return true;
        const v = c.lin.c; const ok = c.rel === "=" ? Math.abs(v) < 1e-7 : c.rel === "<" ? v <= 1e-7 : v >= -1e-7;
        if (!ok && c.weight === Infinity && constProof === null) constProof = c.label ?? "constraint";
        return false;
      });
    if (constProof !== null) {
      return {
        status: 1, statusText: "INFEASIBLE", verdictText: "INFEASIBLE_PROVEN", ok: false, certified: false, approximate: false,
        x: [], objective: NaN, iterations: 0, timeMs: 0, engine: "presolve",
        warm: false, proven: true, farkas: null, maxResid: Infinity,
        values: new Array(nvFull).fill(0),
        violations: [], conflicts: [{ label: constProof, lambda: 1 }],
        reducedVars: nv, eliminated: nvFull - nv, presolveDeclined: presolveDeclined || undefined,
      };
    }
    const soft = all.filter((c) => c.weight !== Infinity);
    const hard = all.filter((c) => c.weight === Infinity);
    const objective = pre.sQuad(this.objective);
    const isQP = soft.length > 0 || objective.q.size > 0;
    // warm start (reduced coordinates): keep only the free vars; eliminated ones are implied
    const x0red = opts.x0 && opts.x0.length === nvFull ? pre.free.map((orig) => opts.x0![orig]) : undefined;
    let res: SolveResult; let x: number[]; let rowLabels: string[] = [];
    if (nv === 0 && !presolveDeclined) {
      res = {
        status: 0, statusText: "OPTIMAL", verdictText: "OPTIMAL", ok: true, certified: true, approximate: false,
        x: [], objective: objective.eval([]), iterations: 0, timeMs: 0, engine: isQP ? "psolve/QP" : "psolve/LP",
        warm: false, proven: false, farkas: null, maxResid: 0,
      };
      x = [];
    } else if (!isQP) {
      // ---- LP path: free variables, rows lin REL 0  =>  Σ t x REL -c
      // Rows are scaled to unit max-coefficient before marshalling: psolve's working-set
      // tolerances are absolute, our variables are pixels (docs/CURV_PS_PLAN.md §6.1).
      const cols: Map<number, number>[] = Array.from({ length: nv }, () => new Map());
      const b: number[] = []; let rel = "";
      hard.forEach((h, i) => {
        let mx = 0; for (const [, v] of h.lin.t) mx = Math.max(mx, Math.abs(v));
        const s = mx > 0 ? 1 / mx : 1;
        for (const [k, v] of h.lin.t) cols[k].set(i, v * s);
        b.push(-h.lin.c * s); rel += h.rel; rowLabels.push(h.label ?? `row ${i}`);
      });
      const colptr = [0], row: number[] = [], val: number[] = [];
      for (let j = 0; j < nv; j++) { for (const [r, v] of cols[j]) { row.push(r); val.push(v); } colptr.push(row.length); }
      const c = new Array(nv).fill(0); for (const [k, v] of objective.lin.t) c[k] = v;
      // Unreferenced / unbounded directions: box them loosely so a costless LP still has a vertex.
      const l = new Array(nv).fill(-1e6), u = new Array(nv).fill(1e6);
      res = solveLP({ n: nv, m: hard.length, c, colptr, row, val, rel, b, l, u, maximize: false }, { budgetMs: opts.budgetMs });
      x = res.x;
    } else {
      // ---- QP path: variables = user vars + one error var per soft *inequality*.
      // Soft equalities need no rows at all: w·(lin)² goes straight into the objective.  (Modelling
      // them as two inequality rows with an error variable made the active set degenerate whenever the
      // target coincided with an active hard bound, and psolve's active-set QP then reported INFEASIBLE.
      // Upstream psolve ≥ arena/01a07358-psolve handles the pair encoding correctly now — the presolve-
      // declined fallback below relies on it — but the folded form is still the smaller model.)
      const softEq = soft.filter((s) => s.rel === "="), softIneq = soft.filter((s) => s.rel !== "=");
      const n = nv + softIneq.length;
      const Q = new Array(n * n).fill(0), c = new Array(n).fill(0);
      const A: number[] = [], b: number[] = [];
      const pushRow = (lin: Lin, label: string, extra?: [number, number]) => {
        const r = new Array(n).fill(0); for (const [k, v] of lin.t) r[k] += v;
        if (extra) r[extra[0]] += extra[1];
        let mx = 0; for (const v of r) mx = Math.max(mx, Math.abs(v));
        const s = mx > 0 ? 1 / mx : 1;
        for (let j = 0; j < n; j++) r[j] *= s;
        A.push(...r); b.push(-lin.c * s); rowLabels.push(label);
      };
      for (const [, [i, j, k]] of objective.q) { if (i === j) Q[i * n + i] += 2 * k; else { Q[j * n + i] += k; Q[i * n + j] += k; } }
      for (const [k, v] of objective.lin.t) c[k] += v;
      for (const s of softEq) { // + w·(c + Σ t_i x_i)²  =  ½ xᵀ(2w t tᵀ)x + (2w c t)ᵀx + const
        const t = [...s.lin.t]; const w = s.weight;
        for (const [i, ti] of t) { c[i] += 2 * w * s.lin.c * ti; for (const [j, tj] of t) Q[i * n + j] += 2 * w * ti * tj; }
      }
      for (const h of hard) {
        if (h.rel === "<" || h.rel === "=") pushRow(h.lin, h.label ?? "constraint");
        if (h.rel === ">" || h.rel === "=") pushRow(h.lin.scale(-1), (h.label ?? "constraint") + " (≥)");
      }
      softIneq.forEach((s, si) => { // one-sided penalty: lin REL 0 relaxed by e ≥ 0, cost w·e²
        const e = nv + si; Q[e * n + e] += 2 * s.weight;
        pushRow(s.rel === "<" ? s.lin : s.lin.scale(-1), (s.label ?? "soft") + " (slack)", [e, -1]); pushRow(new Lin(0), (s.label ?? "soft") + " (slack ≥ 0)", [e, -1]);
      });
      // tiny ridge on user vars keeps under-determined layouts unique and well-conditioned
      for (let i = 0; i < nv; i++) Q[i * n + i] += 1e-7;
      const attempt = (x0?: number[], ms?: number) => solveQP({ n, m: b.length, Q, c, A, b }, { x0, budgetMs: ms });
      if (x0red) {
        // Warm start with its own small budget (default 4 ms): an accepted-but-wandering warm
        // walk (measured on jump-resizes of discrete layouts: up to 6 slower than cold) is
        // abandoned and retried cold inside the frame budget.  Wins stay 18-35x on continuous
        // drags; the regression class is capped at warmBudget + cold.
        const w = attempt(x0red, opts.warmBudgetMs ?? 4);
        if (w.status === 6) {
          const c0 = attempt(undefined, opts.budgetMs);
          const pick = c0.ok || !w.ok ? c0 : w; // a certified/feasible answer beats an incumbent
          res = { ...pick, warmRetry: true, warm: pick === c0 ? false : pick.warm, iterations: w.iterations + pick.iterations, timeMs: w.timeMs + pick.timeMs };
        } else res = w;
      } else res = attempt(undefined, opts.budgetMs);
      x = res.x.slice(0, nv);
    }
    // back-substitute eliminated variables
    const full = new Array(nvFull).fill(0);
    pre.free.forEach((orig, i) => { full[orig] = x[i] ?? 0; });
    for (const [p, l] of pre.subst) full[p] = l.c + [...l.t].reduce((s, [k, v]) => s + v * full[k], 0);
    const violations: { label: string; amount: number }[] = [];
    if (res.ok) for (const cst of this.constraints) {
      if (cst.weight !== Infinity) continue; // soft constraints are allowed to yield
      const v = cst.lin.eval(full);
      const viol = cst.rel === "=" ? Math.abs(v) : cst.rel === "<" ? Math.max(0, v) : Math.max(0, -v);
      if (viol > 1e-3) violations.push({ label: cst.label ?? "constraint", amount: viol });
    }
    let conflicts: { label: string; lambda: number }[] | undefined;
    if (res.proven && res.farkas) {
      conflicts = [];
      const seen = new Set<string>();
      res.farkas.forEach((lam, i) => {
        if (lam <= 0) return;
        const label = rowLabels[i] ?? `row ${i}`;
        if (!seen.has(label)) { seen.add(label); conflicts!.push({ label, lambda: lam }); }
      });
    }
    return { ...res, values: full, violations, reducedVars: nv, eliminated: nvFull - nv, conflicts, presolveDeclined: presolveDeclined || undefined };
  }
}

/** Re-exported for callers that want the engine's warm-start acceptance test directly. */
export { qpStartFeasible };
