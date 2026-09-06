/* fenv stub for wasm: WebAssembly has round-to-nearest only, so the directed-
 * rounding certificates (LP boxcert/presolve windows) run in nearest mode --
 * windows computed this way are conservative requests that the verification
 * step then re-checks exactly; identical documented behaviour as the
 * previously shipped shim. */
#ifndef PSOLVE_SHIM_FENV_H
#define PSOLVE_SHIM_FENV_H
#define FE_TONEAREST 0
#define FE_UPWARD 1
#define FE_DOWNWARD 2
static inline int fesetround(int __r) { (void)__r; return 0; }
static inline int fegetround(void) { return 0; }
#endif
