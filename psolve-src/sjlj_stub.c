#include <stdlib.h>
#include "setjmp.h"
int setjmp(jmp_buf env) { (void)env; return 0; }
void longjmp(jmp_buf env, int v) { (void)env; (void)v; abort(); }
