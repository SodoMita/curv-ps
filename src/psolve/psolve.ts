// Thin TypeScript binding for the psolve wasm build (LP revised simplex +
// convex QP active-set).  See psolve-src/psolve_web.c for the C side.
import { PSOLVE_WASM_B64 } from "./psolve.wasm.b64";

interface Exports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  psw_malloc: (n: number) => number;
  psw_free: (p: number) => void;
  psw_inf: () => number;
  psw_lp_solve: (
    n: number, m: number, c: number, colptr: number, row: number, val: number,
    rel: number, b: number, l: number, u: number, maximize: number,
    x: number, obj: number, iters: number,
  ) => number;
  psw_qp_solve: (
    n: number, m: number, Q: number, c: number, A: number, b: number,
    x: number, obj: number, iters: number,
  ) => number;
}

export const LP_STATUS: Record<number, string> = {
  0: "OPTIMAL", 1: "INFEASIBLE", 2: "UNBOUNDED", 3: "ITERATION_LIMIT",
  4: "STOPPED", 5: "NUMERICAL_FAILURE", 6: "INVALID",
};
export const QP_STATUS: Record<number, string> = {
  0: "OPTIMAL", [-1]: "INFEASIBLE", 1: "UNBOUNDED", 2: "ITERATION_LIMIT",
  3: "KKT_FAIL", 4: "NON_CONVEX", 5: "INVALID", 6: "STOPPED",
};

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
export interface SolveResult {
  status: number; statusText: string; ok: boolean;
  x: number[]; objective: number; iterations: number; timeMs: number;
  engine: "psolve/LP" | "psolve/QP";
}

let exportsP: Promise<Exports> | null = null;
let ex: Exports | null = null;

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
    const wasi = {
      fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0,
      args_get: () => 0, args_sizes_get: () => 0,
      proc_exit: (c: number) => { throw new Error("psolve exited with code " + c); },
    };
    const mod = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(mod, { wasi_snapshot_preview1: wasi });
    const e = instance.exports as unknown as Exports;
    e._initialize?.();
    ex = e;
    return e;
  })();
  return exportsP;
}
export function psolveReady(): boolean { return ex !== null; }

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

function need(): Exports {
  if (!ex) throw new Error("psolve wasm not loaded yet");
  return ex;
}

export function solveLP(p: LPProblem): SolveResult {
  const e = need(); const a = new Arena(e); const t0 = performance.now();
  try {
    const INF = e.psw_inf();
    const l = p.l.map((v) => (v === -Infinity ? -INF : v));
    const u = p.u.map((v) => (v === Infinity ? INF : v));
    const x = a.raw(8 * Math.max(1, p.n)), obj = a.raw(8), it = a.raw(4);
    const st = e.psw_lp_solve(
      p.n, p.m, a.f64(p.c), a.i32(p.colptr), a.i32(p.row), a.f64(p.val),
      a.u8(p.rel), a.f64(p.b), a.f64(l), a.f64(u), p.maximize ? 1 : 0, x, obj, it,
    );
    return {
      status: st, statusText: LP_STATUS[st] ?? "UNKNOWN", ok: st === 0,
      x: st === 0 ? a.readF64(x, p.n) : new Array(p.n).fill(0),
      objective: st === 0 ? a.readF64(obj, 1)[0] : NaN, iterations: a.readI32(it),
      timeMs: performance.now() - t0, engine: "psolve/LP",
    };
  } finally { a.free(); }
}

export function solveQP(p: QPProblem): SolveResult {
  const e = need(); const a = new Arena(e); const t0 = performance.now();
  try {
    const x = a.raw(8 * Math.max(1, p.n)), obj = a.raw(8), it = a.raw(4);
    const st = e.psw_qp_solve(p.n, p.m, a.f64(p.Q), a.f64(p.c), a.f64(p.A), a.f64(p.b), x, obj, it);
    return {
      status: st, statusText: QP_STATUS[st] ?? "UNKNOWN", ok: st === 0 || st === 2,
      x: st !== -1 && st !== 5 ? a.readF64(x, p.n) : new Array(p.n).fill(0),
      objective: a.readF64(obj, 1)[0], iterations: a.readI32(it),
      timeMs: performance.now() - t0, engine: "psolve/QP",
    };
  } finally { a.free(); }
}
