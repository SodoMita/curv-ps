// Thin TypeScript binding for the psolve wasm build (LP revised simplex +
// convex QP active-set), psolve-owned bridge ABI 3 (tools/psolve_web.c in the
// psolve repo, mirrored in psolve-src/).  The bridge contract:
//   - QP status -1 is "no feasible start", NOT infeasibility: psw_qp_proven()
//     separates a give-up from a Farkas-certified empty row system;
//   - psw_qp_solve2 accepts a warm start x0 and a per-call wall-clock budget,
//     and reports the largest row violation at the returned point;
//   - STOPPED (6) / ITERATION_LIMIT (2) hand back the best incumbent — usable
//     but not a certified optimum (SolveResult.approximate).
import { PSOLVE_WASM_B64 } from "./psolve.wasm.b64";

interface Exports {
  memory: WebAssembly.Memory;
  psw_abi: () => number;
  psw_malloc: (n: number) => number;
  psw_free: (p: number) => void;
  psw_inf: () => number;
  psw_free_scratch: () => void;
  psw_set_time_budget_ms: (ms: number) => void;
  psw_qp_set_phase1_lp_first: (on: number) => void;
  psw_qp_phase1_lp_first: () => number;
  psw_lp_solve: (
    n: number, m: number, c: number, colptr: number, row: number, val: number,
    rel: number, b: number, l: number, u: number, maximize: number,
    x: number, obj: number, iters: number,
  ) => number;
  psw_lp_solve_b: (
    n: number, m: number, c: number, colptr: number, row: number, val: number,
    rel: number, b: number, l: number, u: number, maximize: number, budget: number,
    x: number, obj: number, iters: number,
  ) => number;
  psw_qp_solve: (
    n: number, m: number, Q: number, c: number, A: number, b: number,
    x: number, obj: number, iters: number,
  ) => number;
  psw_qp_solve2: (
    n: number, m: number, Q: number, c: number, A: number, b: number,
    x0: number, budget: number, x: number, obj: number, iters: number, resid: number,
  ) => number;
  psw_qp_proven: () => number;
  psw_qp_farkas: (out: number) => number;
  psw_qp_maxresid: () => number;
  psw_qp_start_feasible: (n: number, m: number, A: number, b: number, x: number) => number;
  psw_qp_status_name: (st: number) => number;
  psw_qp_verdict_name: (st: number, proven: number) => number;
}

/** Bridge ABI the wasm module must report (asserted on load). */
export const PSOLVE_BRIDGE_ABI = 3;
/** Provenance of the committed blob (mirrors the header of psolve.wasm.b64.ts). */
export const PSOLVE_WASM_SHA256 = "bcbe7b1d089417df69e05bc3c29d419c4c20254d5cf39566c49bbc0c420658a8";
export const PSOLVE_UPSTREAM_PIN = "main@05f9411ccc (tools/psolve_web.c, arena/01a07358-psolve merge)";

export const LP_STATUS: Record<number, string> = {
  0: "OPTIMAL", 1: "INFEASIBLE", 2: "UNBOUNDED", 3: "ITERATION_LIMIT",
  4: "STOPPED", 5: "NUMERICAL_FAILURE", 6: "INVALID",
};
// QP names now come from the wasm module itself (psw_qp_status_name /
// psw_qp_verdict_name) so a give-up (NO_FEASIBLE_START) can never be renamed
// "infeasible" by a stale table here.  -1 + proven => INFEASIBLE_PROVEN.

export interface LPProblem {
  n: number; m: number;
  c: number[];
  colptr: number[]; row: number[]; val: number[]; // CSC
  rel: string; // one char per row: '<' '>' '='
  b: number[];
  l: number[]; u: number[]; // use ±Infinity for free
  maximize?: boolean;
}
export interface QPProblem {
  n: number; m: number;
  Q: number[]; // column-major n*n (symmetric PSD)
  c: number[];
  A: number[]; // row-major m*n
  b: number[];
}
export interface SolveOpts {
  /** Warm start (previous frame's solution).  Only handed to the engine when
   *  psw_qp_start_feasible accepts it — a rejected start would still sway the
   *  Phase-I search point, and with it the numerics, so rejected starts fall
   *  back to the plain cold path (determinism, not just speed). */
  x0?: number[];
  /** Wall-clock budget in ms for this call (<= 0 or undefined = none). */
  budgetMs?: number;
  /** Sub-budget for the WARM attempt when x0 is given: a warm start whose active-set walk
   *  exceeds this is abandoned and retried cold within `budgetMs` (see Problem.solve). */
  warmBudgetMs?: number;
}
export interface SolveResult {
  status: number; statusText: string; verdictText: string; ok: boolean;
  /** status says the optimum is certified (QP: 0; LP: 0). */
  certified: boolean;
  /** a feasible-ish incumbent that is NOT a certified optimum (STOPPED / ITERATION_LIMIT). */
  approximate: boolean;
  x: number[]; objective: number; iterations: number; timeMs: number;
  /** "presolve": the front end's own presolve produced the verdict (constant-false proof, zero-var system) */
  engine: "psolve/LP" | "psolve/QP" | "presolve";
  /** QP: the supplied warm start was accepted (Phase-I skipped). */
  warm: boolean;
  /** QP: the warm attempt was STOPPED inside its sub-budget and the problem was retried cold;
   *  `warm` says which attempt produced THIS result (false = the cold retry won). */
  warmRetry?: boolean;
  /** QP status -1 only: infeasibility was PROVEN (Farkas certificate in `farkas`). */
  proven: boolean;
  /** Normalised Farkas multipliers (one per row; > 0 marks a conflicting row). */
  farkas: number[] | null;
  /** Largest row violation at the returned point, caller's units. */
  maxResid: number;
}

let exportsP: Promise<Exports> | null = null;
let ex: Exports | null = null;
let bridgeAbi = 0;

function decodeB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function loadPsolve(): Promise<Exports> {
  if (exportsP) return exportsP;
  exportsP = (async () => {
    const bytes = decodeB64(PSOLVE_WASM_B64);
    let mem: () => WebAssembly.Memory = () => { throw new Error("not instantiated"); };
    const wasi = {
      fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0,
      args_get: () => 0, args_sizes_get: () => 0,
      // monotonic clock for psw_set_time_budget_ms (nanoseconds, little-endian u64)
      clock_time_get: (_id: number, _prec: number, out: number) => {
        const ns = BigInt(Math.round(performance.now() * 1e6));
        const dv = new DataView(mem().buffer);
        dv.setUint32(out, Number(ns & 0xffffffffn), true);
        dv.setUint32(out + 4, Number((ns >> 32n) & 0xffffffffn), true);
        return 0;
      },
      proc_exit: (c: number) => { throw new Error("psolve exited with code " + c); },
    };
    const mod = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
    const e = instance.exports as unknown as Exports;
    mem = () => e.memory;
    bridgeAbi = e.psw_abi();
    if (bridgeAbi !== PSOLVE_BRIDGE_ABI) throw new Error(`psolve bridge ABI mismatch: wasm exports ${bridgeAbi}, JS expects ${PSOLVE_BRIDGE_ABI} (psolve.wasm.b64.ts is stale)`);
    ex = e;
    return e;
  })();
  return exportsP;
}
export function psolveReady(): boolean { return ex !== null; }
/** Provenance for the UI: bridge ABI + committed blob hash + upstream pin. */
export function psolveInfo(): { abi: number; sha256: string; pin: string } {
  return { abi: bridgeAbi, sha256: PSOLVE_WASM_SHA256, pin: PSOLVE_UPSTREAM_PIN };
}

class Arena {
  ptrs: number[] = [];
  constructor(private e: Exports) {}
  f64(a: ArrayLike<number>): number {
    const p = this.e.psw_malloc(8 * Math.max(1, a.length)); this.ptrs.push(p);
    new Float64Array(this.e.memory.buffer, p, a.length).set(a); return p;
  }
  i32(a: ArrayLike<number>): number {
    const p = this.e.psw_malloc(4 * Math.max(1, a.length)); this.ptrs.push(p);
    new Int32Array(this.e.memory.buffer, p, a.length).set(a); return p;
  }
  u8(s: string): number {
    const p = this.e.psw_malloc(Math.max(1, s.length)); this.ptrs.push(p);
    const v = new Uint8Array(this.e.memory.buffer, p, s.length);
    for (let i = 0; i < s.length; i++) v[i] = s.charCodeAt(i); return p;
  }
  raw(bytes: number): number { const p = this.e.psw_malloc(bytes); this.ptrs.push(p); return p; }
  readF64(p: number, n: number): number[] { return Array.from(new Float64Array(this.e.memory.buffer, p, n)); }
  readI32(p: number): number { return new Int32Array(this.e.memory.buffer, p, 1)[0]; }
  free() { for (const p of this.ptrs) this.e.psw_free(p); this.ptrs = []; }
}

function cstr(e: Exports, p: number): string {
  const b8 = new Uint8Array(e.memory.buffer);
  let s = "", i = p;
  while (i < b8.length && b8[i] !== 0) s += String.fromCharCode(b8[i++]);
  return s;
}

function need(): Exports {
  if (!ex) throw new Error("psolve wasm not loaded yet");
  return ex;
}

/** Ask the engine whether x satisfies every row (the exact warm-start acceptance test). */
export function qpStartFeasible(n: number, m: number, A: number[], b: number[], x: number[]): boolean {
  if (x.length !== n) return false;
  const e = need(); const a = new Arena(e);
  try { return e.psw_qp_start_feasible(n, m, a.f64(A), a.f64(b), a.f64(x)) !== 0; }
  finally { a.free(); }
}

export function solveLP(p: LPProblem, opts: SolveOpts = {}): SolveResult {
  const e = need(); const a = new Arena(e); const t0 = performance.now();
  try {
    const INF = e.psw_inf();
    const l = p.l.map((v) => (v === -Infinity ? -INF : v));
    const u = p.u.map((v) => (v === Infinity ? INF : v));
    const x = a.raw(8 * Math.max(1, p.n)), obj = a.raw(8), it = a.raw(4);
    const st = opts.budgetMs && opts.budgetMs > 0
      ? e.psw_lp_solve_b(p.n, p.m, a.f64(p.c), a.i32(p.colptr), a.i32(p.row), a.f64(p.val), a.u8(p.rel), a.f64(p.b), a.f64(l), a.f64(u), p.maximize ? 1 : 0, opts.budgetMs, x, obj, it)
      : e.psw_lp_solve(p.n, p.m, a.f64(p.c), a.i32(p.colptr), a.i32(p.row), a.f64(p.val), a.u8(p.rel), a.f64(p.b), a.f64(l), a.f64(u), p.maximize ? 1 : 0, x, obj, it);
    const ok = st === 0;
    return {
      status: st, statusText: LP_STATUS[st] ?? "UNKNOWN", verdictText: LP_STATUS[st] ?? "UNKNOWN", ok,
      certified: ok, approximate: false,
      x: ok ? a.readF64(x, p.n) : new Array(p.n).fill(0),
      objective: ok ? a.readF64(obj, 1)[0] : NaN, iterations: a.readI32(it),
      timeMs: performance.now() - t0, engine: "psolve/LP",
      warm: false, proven: false, farkas: null, maxResid: 0,
    };
  } finally { a.free(); }
}

export function solveQP(p: QPProblem, opts: SolveOpts = {}): SolveResult {
  const e = need(); const a = new Arena(e); const t0 = performance.now();
  try {
    const x = a.raw(8 * Math.max(1, p.n)), obj = a.raw(8), it = a.raw(4), res = a.raw(8);
    const Ap = a.f64(p.A), bp = a.f64(p.b);
    // Warm start: only if the engine's own test accepts it, so a rejected start
    // follows the exact cold code path (bit-identical to no warm cache at all).
    let x0p = 0, warm = false;
    if (opts.x0 && opts.x0.length === p.n && opts.x0.every((v) => Number.isFinite(v))) {
      const t = a.f64(opts.x0);
      if (e.psw_qp_start_feasible(p.n, p.m, Ap, bp, t) !== 0) { x0p = t; warm = true; }
    }
    const st = e.psw_qp_solve2(p.n, p.m, a.f64(p.Q), a.f64(p.c), Ap, bp, x0p,
      opts.budgetMs ?? -1, x, obj, it, res);
    const proven = e.psw_qp_proven() !== 0;
    let farkas: number[] | null = null;
    if (proven && p.m > 0) {
      const lam = a.raw(8 * p.m);
      if (e.psw_qp_farkas(lam) === p.m) farkas = a.readF64(lam, p.m);
    }
    const maxResid = a.readF64(res, 1)[0];
    // 0 OPTIMAL | 1 unbounded | 2 iter-limit | 3 KKT not verified | 4 non-convex
    // 5 invalid | 6 stopped | -1 no feasible start (proven? infeasible : give-up)
    const ok = st === 0 || st === 2 || st === 6; // 2/6 hand back a usable incumbent
    const t1 = performance.now();
    return {
      status: st, statusText: cstr(e, e.psw_qp_status_name(st)),
      verdictText: cstr(e, e.psw_qp_verdict_name(st, proven ? 1 : 0)),
      ok, certified: st === 0, approximate: st === 2 || st === 6,
      x: ok ? a.readF64(x, p.n) : new Array(p.n).fill(0),
      objective: a.readF64(obj, 1)[0], iterations: a.readI32(it),
      timeMs: t1 - t0, engine: "psolve/QP",
      warm, proven, farkas, maxResid,
    };
  } finally { a.free(); }
}
