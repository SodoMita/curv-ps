/* psolve_web.h -- public surface of the psolve WebAssembly / FFI bridge.
 *
 * Everything here is flat: pointers to caller-owned buffers, int statuses, no
 * structs across the boundary, no callbacks, so it survives the C<->wasm ABI
 * and is equally easy to bind from a JS typed array, a JVM direct buffer or a
 * Rust slice.  A host may ignore this header and dlopen/dlsym the module; the
 * signatures must stay in sync with tools/psolve_web.c, and tools/psw_test.c is
 * the executable statement of what each call owes the caller.
 *
 * Conventions
 *   - QP:   minimize 1/2 x'Qx + c'x  s.t.  A x <= b
 *           Q column-major n*n, A row-major m*n, b length m.
 *   - LP:   optimize c'x  s.t.  A x rel b, l <= x <= u (CSC, rel in "<=>").
 *   - QP statuses (src/qp.h):  0 OPTIMAL, 1 unbounded, 2 iteration limit,
 *           3 KKT not verified, 4 non-convex, 5 invalid model, 6 stopped by
 *           budget, -1 NO FEASIBLE START.
 *           -1 is NOT "infeasible": ask psw_qp_proven().
 *   - LP statuses (src/solver.h): 0 optimal, 1 infeasible, 2 unbounded,
 *           3 iteration limit, 5 numerical, 6 invalid.
 */
#ifndef PSOLVE_WEB_H
#define PSOLVE_WEB_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bridge ABI version; see the header comment in psolve_web.c. */
int psw_abi(void);

void  *psw_malloc(size_t n);
void   psw_free(void *p);
double psw_inf(void);
void   psw_free_scratch(void);

/* Phase-I ordering policy for every later solve: 0 = engine default (dense
 * auxiliary QP first), 1 = sparse LP route first with the dense search as
 * fallback.  Never changes a verdict; changes how many models get an answer
 * inside a budget.  See docs/CURV_PS_PLAN.md 1.10. */
void psw_qp_set_phase1_lp_first(int on);
int  psw_qp_phase1_lp_first(void);

/* Allocation-free solves: arm psolve's arena over a caller buffer. */
void    psw_arena_set(void *buf, size_t cap);   /* cap 0 disables */
size_t  psw_arena_used(void);       /* cumulative since reset, not live bytes */
size_t  psw_arena_highwater(void);  /* per-frame peak; size the buffer from this */
void    psw_arena_reset(void);
size_t  psw_arena_used(void);

/* Cooperative wall-clock budget, ms; <= 0 disarms.  Applies to the next call
 * when passed through psw_lp_solve_b / psw_qp_solve2, or to everything until
 * disarmed when called directly. */
void psw_set_time_budget_ms(double ms);

int psw_lp_solve(int n, int m,
                 double *c, int *colptr, int *row, double *val,
                 char *rel, double *b, double *l, double *u,
                 int maximize, double *x_out, double *obj_out, int *iters_out);
int psw_lp_solve_b(int n, int m,
                   double *c, int *colptr, int *row, double *val,
                   char *rel, double *b, double *l, double *u,
                   int maximize, double budget_ms,
                   double *x_out, double *obj_out, int *iters_out);

/* Back-compatible entry point: no warm start, no budget. */
int psw_qp_solve(int n, int m, double *Q, double *c, double *A, double *b,
                 double *x_out, double *obj_out, int *iters_out);

/* x0 = warm start or NULL; budget_ms <= 0 = none; max_resid_out = largest row
 * violation at the point returned (0 when the point is feasible). */
int psw_qp_solve2(int n, int m, double *Q, double *c, double *A, double *b,
                  const double *x0, double budget_ms,
                  double *x_out, double *obj_out, int *iters_out,
                  double *max_resid_out);

/* 1 when the last psw_qp_solve* PROVED the row system empty. */
int psw_qp_proven(void);
/* Copies the normalised Farkas multiplier vector (one entry per row; entries
 * > 0 mark the conflicting rows).  Returns the count, or 0 with no proof. */
int psw_qp_farkas(double *out);
/* Largest row violation at the point the last call returned. */
double psw_qp_maxresid(void);
/* True when x satisfies every row, i.e. when it is a legal warm start. */
int psw_qp_start_feasible(int n, int m, double *A, double *b, const double *x);

const char *psw_qp_status_name(int st);
const char *psw_qp_verdict_name(int status, int proven);

#ifdef __cplusplus
}
#endif
#endif /* PSOLVE_WEB_H */
