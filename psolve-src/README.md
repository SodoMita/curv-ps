# psolve → WebAssembly

`src/psolve/psolve.wasm.b64.ts` is a wasm32-wasi build of the **unmodified**
LP (revised simplex) and convex QP (active-set) cores of psolve
(`src/err.c kernels.c lu.c splu.c solver.c qp.c`) plus psolve's own bridge
`tools/psolve_web.c` (bridge ABI 3) — all files verbatim, both vendored here
for inspection.  Exact upstream commit, blob sha256 and toolchain: **PIN**.
The JS side asserts the ABI and prints the hash: `psolveInfo()` in
`src/psolve/psolve.ts`, displayed in the SolverPanel footer.

Rebuild (needs a psolve checkout and wasi-sdk ≥ 20):

    PSOLVE=/path/to/psolve WASI_SDK_PATH=/path/to/wasi-sdk sh psolve-src/build-wasm.sh

`build-wasm.sh` mirrors upstream's `tools/wasm_build.sh`; `shim/` provides
`setjmp.h` (the psw_* paths never arm a `PSolveErrFrame`, so error frames are
dead code), an empty `immintrin.h` (kernels.c falls back to its scalar path)
and `fenv.h` (WebAssembly only has round-to-nearest, so the directed-rounding
dual certificates run in nearest mode).  Upgrade checklist: bump PIN +
`PSOLVE_WASM_SHA256` / `PSOLVE_UPSTREAM_PIN` in `src/psolve/psolve.ts`, keep
`psw_abi()` == `PSOLVE_BRIDGE_ABI`, run `scripts/warmcheck.ts` +
`scripts/paramcheck.ts`.  psolve is AGPL-3.0 — see LICENSE-psolve.

This bridge upgrade (psolve `arena/01a07358-psolve`, merged to main) is what
the JS side of this repo uses for: warm starts (`psw_qp_solve2` x0 ↔
`warmCache` in `src/curv/interp.ts`), certified infeasibility
(`psw_qp_proven`/`psw_qp_farkas` → conflict rows in the SolverPanel), and a
per-solve wall-clock budget (`SOLVE_BUDGET_MS`) that keeps a pathological
model inside a frame.  The upstream write-up of this contract (measured
against this repo) is `docs/CURV_PS_PLAN.md` in the psolve repository.
