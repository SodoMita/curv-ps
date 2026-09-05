/* wasm32 shim: psolve's error frames are never armed from the browser
 * bridge, so setjmp/longjmp are declared but unreachable. */
#ifndef _SHIM_SETJMP_H
#define _SHIM_SETJMP_H
typedef long jmp_buf[8];
int setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);
#endif
