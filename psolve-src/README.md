# psolve → WebAssembly

`src/psolve/psolve.wasm.b64.ts` is a wasm32-wasi (reactor) build of the **unmodified**
LP (revised simplex) and convex QP (active-set) cores of
https://github.com/SodoMita/psolve/tree/arena/cp-engine-correctness
(`src/err.c kernels.c lu.c splu.c solver.c qp.c`), plus the bridge in this folder.

    clang --target=wasm32-wasi -mexec-model=reactor -O2 -std=gnu11 -Ishim -I<psolve>/src \
      -fvisibility=hidden -Wl,--export-dynamic -Wl,--export=malloc -Wl,--export=free \
      -Wl,-z,stack-size=1048576 -Wl,--initial-memory=33554432 -Wl,--max-memory=268435456 \
      -o psolve.wasm psolve_web.c sjlj_stub.c <psolve>/src/{err,kernels,lu,splu,solver,qp}.c

`shim/` provides `setjmp.h` (error frames are never armed from the browser bridge),
an empty `immintrin.h` (kernels.c falls back to its scalar path) and `fenv.h`
(WebAssembly only has round-to-nearest, so the directed-rounding dual certificate
runs in nearest mode).  psolve is AGPL-3.0 — see LICENSE-psolve.
