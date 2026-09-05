/* psolve_web.c -- thin WebAssembly bridge over psolve's LP (revised simplex)
 * and convex QP (active-set) cores.  The C sources are the unmodified psolve
 * arena/cp-engine-correctness branch; this file only marshals flat buffers. */
#include <stdlib.h>
#include <string.h>
#include "solver.h"
#include "qp.h"
#include "err.h"

#define EXPORT __attribute__((visibility("default"), used))

EXPORT void *psw_malloc(size_t n) { return malloc(n); }
EXPORT void  psw_free(void *p) { free(p); }
EXPORT double psw_inf(void) { return LP_INF; }

/* LP: returns solver status (0 OPTIMAL, 1 INFEASIBLE, 2 UNBOUNDED, 3 ITER LIMIT,
 * 5 NUMERICAL, 6 INVALID).  x_out[n], obj_out[1], iters_out[1]. */
EXPORT int psw_lp_solve(int n, int m,
                        double *c, int *colptr, int *row, double *val,
                        char *rel, double *b, double *l, double *u,
                        int maximize, double *x_out, double *obj_out,
                        int *iters_out)
{
    LP lp;
    lp.n = n; lp.m = m; lp.c = c; lp.Acolptr = colptr; lp.Arow = row;
    lp.Aval = val; lp.rel = rel; lp.b = b; lp.l = l; lp.u = u;
    lp.maximize = maximize;
    Solver *s = solver_create(&lp);
    if (!s) return 6;
    int st = solver_solve(s);
    if (st == 0) solver_optimum(s, x_out, obj_out);
    if (iters_out) *iters_out = (int)s->iters;
    solver_destroy(s);
    return st;
}

/* QP: minimize 1/2 x'Qx + c'x  s.t. A x <= b.  Q column-major n*n, A row-major m*n.
 * Returns QP status (0 solved, -1 infeasible, 1 unbounded, 2 iter-limit,
 * 3 kkt-fail, 4 non-convex, 5 invalid).  x_out[n], obj_out[1], iters_out[1]. */
EXPORT int psw_qp_solve(int n, int m, double *Q, double *c, double *A, double *b,
                        double *x_out, double *obj_out, int *iters_out)
{
    QP qp; QPResult res;
    memset(&res, 0, sizeof res);
    qp.n = n; qp.m = m; qp.Q = Q; qp.c = c; qp.A = A; qp.b = b; qp.x0 = NULL;
    qp_solve(&qp, &res);
    if (res.x) memcpy(x_out, res.x, sizeof(double) * n);
    if (obj_out) *obj_out = res.obj;
    if (iters_out) *iters_out = res.iterations;
    int st = res.status;
    qp_result_free(&res);
    return st;
}
