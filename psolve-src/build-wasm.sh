#!/bin/sh
# build-wasm.sh -- rebuild src/psolve/psolve.wasm.b64.ts from a psolve checkout.
# Usage: PSOLVE=/path/to/psolve WASI_SDK_PATH=/path/to/wasi-sdk sh psolve-src/build-wasm.sh
#
# This mirrors upstream's tools/wasm_build.sh (same 6 cores + the same bridge,
# -O2 + --gc-sections + internalised exports) with two deliberate differences:
#   * shim/ is on the include path: err.h includes <setjmp.h> (wasi-sdk 25
#     hard-errors it), kernels.c includes <immintrin.h> (kept empty -> scalar
#     fallbacks), solver.c includes <fenv.h> (wasm is round-to-nearest only,
#     so the directed-rounding certificates run in nearest mode and are
#     re-checked exactly by the verification step).  The psw_* paths never arm
#     a PSolveErrFrame, so setjmp is dead code and sjlj_stub.c only satisfies
#     the linker.
#   * explicit initial memory of 32 MB (the solver mallocs working storage at
#     runtime; growth beyond that stays allowed since no max is set).
set -e
PSOLVE=${PSOLVE:?set PSOLVE to the psolve checkout}
SDK=${WASI_SDK_PATH:?set WASI_SDK_PATH}
OUT=build/psolve-wasm && mkdir -p "$OUT/objs"
CFLAGS="--target=wasm32-wasi -O2 -fvisibility=hidden -fno-stack-protector -std=gnu11 -I psolve-src/shim -I $PSOLVE/src -I $PSOLVE/tools"
for f in $PSOLVE/tools/psolve_web.c psolve-src/sjlj_stub.c \
         $PSOLVE/src/err.c $PSOLVE/src/qp.c $PSOLVE/src/lu.c $PSOLVE/src/splu.c \
         $PSOLVE/src/solver.c $PSOLVE/src/kernels.c; do
  "$SDK/bin/clang" $CFLAGS -c "$f" -o "$OUT/objs/$(basename "$f" .c).o"
done
EXPORTS=""
for s in $("$SDK/bin/llvm-nm" -g --defined-only "$OUT/objs/psolve_web.o" | awk '$3 ~ /^psw_/ {print $3}'); do
  EXPORTS="$EXPORTS -Wl,--export=$s"
done
"$SDK/bin/clang" --target=wasm32-wasi -O2 -fvisibility=hidden "$OUT"/objs/*.o $EXPORTS \
  -Wl,--no-entry -Wl,--gc-sections -Wl,-z,stack-size=1048576 -Wl,--initial-memory=33554432 \
  -o "$OUT/psolve.wasm" -lm
sha256sum "$OUT/psolve.wasm"
{ printf 'export const PSOLVE_WASM_B64 = "'; base64 -w0 "$OUT/psolve.wasm"; echo '";'; } > "$OUT/psolve.wasm.b64.ts"
echo "wrote $OUT/psolve.wasm + .b64.ts tail (header comments: copy from the old file, update sha256/pin)"
