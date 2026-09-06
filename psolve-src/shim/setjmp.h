/* setjmp/longjmp stub for wasm: the psw_* bridge never arms a PSolveErrFrame,
 * so setjmp is only ever called by code paths that are never reached (a frame
 * must be armed first for longjmp to run, and psolve_fail exit()s otherwise). */
#ifndef PSOLVE_SHIM_SETJMP_H
#define PSOLVE_SHIM_SETJMP_H
typedef struct { int __r; } jmp_buf[1];
int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int v);
#endif
