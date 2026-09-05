/* wasm32 shim: WebAssembly only offers round-to-nearest.  psolve uses
 * directed rounding solely to tighten its dual-bound certificate; on the web
 * fesetround() is a no-op and the certificate is evaluated in nearest mode. */
#include_next <fenv.h>
#ifndef FE_UPWARD
#define FE_UPWARD 0x800
#endif
#ifndef FE_DOWNWARD
#define FE_DOWNWARD 0x400
#endif
