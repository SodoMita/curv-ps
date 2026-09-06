/* psolve_web.c -- canonical WebAssembly / FFI bridge over psolve's LP and QP
 * cores: flat buffers in, flat buffers out, no callbacks, no libc exceptions,
 * one int status per call.
 *
 * Why this file lives in psolve rather than in each consumer's tree: the bridge
 * is where the solver's semantics have to be restated, and every consumer that
 * re-derives them gets them slightly wrong.  The one this replaces called QP
 * status -1 "INFEASIBLE" and passed `x0 = NULL` unconditionally -- which is the
 * pair of mistakes that made a browser layout engine show a white screen on a
 * model it could actually solve (docs/CURV_PS_PLAN.md P0.1/P0.2).  Here:
 *
 *   - status -1 is reported as "no feasible start", and separately as
 *     PROVEN infeasible when (and only when) the solver has a Farkas
 *     certificate; a front end can therefore fall back instead of lying;
 *   - a warm start (x0) is accepted and the returned `max_resid` lets the
 *     caller decide whether its cached point is still usable;
 *   - a wall-clock budget is available per call, because a real-time consumer
 *     needs "the best point so far" more than it needs "the exact answer in
 *     400 ms";
 *   - the arena is exposed, so a solve can be made allocation-free.
 *
 * Build: tools/wasm_build.sh (Emscripten or wasi-sdk, auto-detected).  The file
 * is plain C11 and also compiles against glibc, which is how it is syntax- and
 * link-checked by `make web-bridge-check` in the absence of a wasm toolchain.
 *
 * Memory model: the caller owns every buffer it passes in and everything the
 * bridge writes out; the bridge allocates only the certificate copy, which it
 * owns and reuses across calls (psw_free_scratch to release).  The bridge never
 * frees a caller pointer.
 */
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "psolve_web.h"
#include "solver.h"
#include "qp.h"
#include "err.h"

#define EXPORT __attribute__((visibility("default"), used))

/* ABI of this bridge, not of the library.  Bumped whenever an export changes
 * meaning (as opposed to being added), so a host can assert compatibility:
 *   1  LP + QP over flat buffers, QP status -1 named "infeasible"
 *   2  psw_qp_solve2: x0 in, max_resid out
 *   3  psw_qp_proven / psw_qp_farkas: certified infeasibility + conflict rows
 *      psw_set_time_budget_ms: per-call wall-clock budget with incumbent
 *      psw_arena_*: allocation-free solves
 *      psw_qp_status_name: status text that does not confuse a give-up with a
 *      proof, so hosts that print it stop mislabelling results */
EXPORT int psw_abi(void) { return 3; }

/* ------------------------------------------------------------------ allocator */

EXPORT void *psw_malloc(size_t n) { return malloc(n); }
EXPORT void  psw_free(void *p)    { free(p); }
EXPORT double psw_inf(void)       { return LP_INF; }

/* ----------------------------------------------------------------- arena path */
/* Arm a caller-owned buffer as psolve's arena: every allocation the solver
 * makes from then on comes out of it, so a frame does zero libc heap work (no
 * allocator growth, no GC, bounded and deterministic cost).  Call once at
 * startup, then psw_arena_reset() between frames.  cap=0 turns it off. */

static PSolveArena g_arena;
static int    g_arena_armed = 0;
static size_t g_arena_peak = 0;

EXPORT void psw_arena_set(void *buf, size_t cap)
{
    if (g_arena_armed) { psolve_arena_end(); g_arena_armed = 0; }
    psolve_arena_init(&g_arena, buf, cap);
    if (cap > 0) { psolve_arena_use(&g_arena); g_arena_armed = 1; }
}
EXPORT void psw_arena_reset(void)
{
    if (g_arena_armed) { psolve_arena_reset(&g_arena); g_arena_peak = 0; }
}
/* ----------------------------------------------------------------- time budget
 * psolve's solvers poll psolve_stop() once per iteration, so a budget is both
 * how a real-time host stays inside a frame and how it keeps the incumbent
 * rather than losing the solve.  Set to <= 0 to disarm. */

static double  g_deadline = 0.0;             /* absolute seconds, monotonic */
static int    g_stop_mine = 0;                /* bridge owns the thread's stop slot */

static double now_sec(void)
{
    struct timespec ts;
#if defined(CLOCK_MONOTONIC)
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0.0;
#else
    if (clock_gettime(CLOCK_REALTIME, &ts) != 0) return 0.0;
#endif
    return (double)ts.tv_sec + 1e-9 * (double)ts.tv_nsec;
}

static int budget_exhausted(void) { return g_deadline > 0.0 && now_sec() > g_deadline; }

EXPORT void psw_set_time_budget_ms(double ms)
{
    /* The stop slot is per-thread and write-only (Phase 6.3 replaced the old
     * `psolve_stop_fn` global with psolve_stop_set()), so the bridge cannot save
     * and restore a host callback around its own budget the way it once did --
     * it owns the slot while a budget is armed and clears it afterwards.  A host
     * that also wants to stop a solve on wasm has to combine both conditions in
     * its own callback and simply not call this function. */
    if (ms > 0.0) {
        g_deadline = now_sec() + ms * 1e-3;
        psolve_stop_set(budget_exhausted);
        g_stop_mine = 1;
    } else {
        g_deadline = 0.0;
        if (g_stop_mine) { psolve_stop_set(NULL); g_stop_mine = 0; }
    }
}

/* A one-shot budget per solve is friendlier than an arm/disarm pair: the
 * wrappers below call this, and disarm when the solve returns. */
static void arm_budget(double ms) { psw_set_time_budget_ms(ms); }
static void disarm_budget(void)   { psw_set_time_budget_ms(-1.0); }

/* ------------------------------------------------------------------------ LP */

/* Returns the solver status (0 OPTIMAL, 1 INFEASIBLE, 2 UNBOUNDED,
 * 3 iteration limit, 5 numerical, 6 invalid).  x_out may be NULL. */
EXPORT int psw_lp_solve(int n, int m,
                        double *c, int *colptr, int *row, double *val,
                        char *rel, double *b, double *l, double *u,
                        int maximize, double *x_out, double *obj_out,
                        int *iters_out)
{
    LP lp;
    memset(&lp, 0, sizeof lp);
    lp.n = n; lp.m = m; lp.c = c; lp.Acolptr = colptr; lp.Arow = row;
    lp.Aval = val; lp.rel = rel; lp.b = b; lp.l = l; lp.u = u;
    lp.maximize = maximize;
    Solver *s = solver_create(&lp);
    if (!s) return 6;
    int st = solver_solve(s);
    if (st == 0) solver_optimum(s, x_out, obj_out);
    if (iters_out) *iters_out = (int)s->iters;
    solver_destroy(s);
    if (g_arena_armed && g_arena.used > g_arena_peak) g_arena_peak = g_arena.used;
    return st;
}

/* Same, with a wall-clock budget in ms (<= 0 for none).  On status 6
 * (QP/LP stopped) the returned point is the best incumbent, not a certified
 * optimum: LP_STOPPED keeps whatever the simplex had when it was cut off. */
EXPORT int psw_lp_solve_b(int n, int m,
                          double *c, int *colptr, int *row, double *val,
                          char *rel, double *b, double *l, double *u,
                          int maximize, double budget_ms,
                          double *x_out, double *obj_out, int *iters_out)
{
    arm_budget(budget_ms);
    int st = psw_lp_solve(n, m, c, colptr, row, val, rel, b, l, u, maximize,
                          x_out, obj_out, iters_out);
    disarm_budget();
    return st;
}

/* ------------------------------------------------------------------------ QP
 *
 * minimize    1/2 x'Qx + c'x   subject to   A x <= b
 *
 * Q is column-major n*n (Q[j*n+i]), A is row-major m*n (A[i*n+j]).
 *
 * Status codes are the library's (src/qp.h): 0 OPTIMAL, 1 unbounded,
 * 2 iteration limit, 3 KKT not verified, 4 non-convex Q, 5 invalid model,
 * 6 stopped by the budget, and -1 "no feasible start".
 *
 * -1 is the one a host must not rename.  It means the feasibility search did
 * not produce a start -- which is NOT "no solution exists" unless
 * psw_qp_proven() says so.  A front end that treats -1 as infeasibility will
 * report unsolvable models that solve in a few hundred microseconds, and (for
 * a layout engine) blank the page; a front end that treats a proof as a
 * give-up will retry a model that can never succeed.  Read both.
 */

static int    g_proven = 0;
/* Phase-I ordering policy for every solve the bridge runs; 0 keeps the engine
 * default (dense auxiliary QP first).  See QP.phase1_order in src/qp.h and the
 * measured trade-off in docs/CURV_PS_PLAN.md 1.10: the LP-first route is 3-12x
 * cheaper and stops on time, and it answers fewer models -- so it is a host
 * choice, armed once, never a verdict change on a model either route answers. */
static int g_lp_first = 0;
static double g_resid = 0.0;        /* last solve's max row violation */
static double *g_lam = NULL;        /* bridge-owned copy of the certificate */
static int    g_lam_n = 0;


/* x0: warm start, or NULL.  A start is accepted when it satisfies every row
 * within the solver's relative feasibility tolerance (qp_start_feasible), so
 * the unit of measure of the model cannot decide the outcome; passing last
 * frame's solution is what makes a dragged UI cost a few iterations instead of
 * a full Phase-I.  A start that is slightly off is still used as the search
 * point, it just does not skip Phase-I.
 *
 * budget_ms: wall-clock limit for this call (<= 0 for none).  If it fires the
 * status is 6 and x_out holds the best point found so far (which may violate a
 * constraint -- that is why max_resid_out exists).
 *
 * max_resid_out: max_i (a_i'x - b_i) at the returned point, in the caller's
 * units.  Cache x_out together with this number; re-feed x_out as x0 next
 * frame only while it stays small. */
/* Defined before psw_qp_solve, which is the back-compatible wrapper. */
EXPORT int psw_qp_solve2(int n, int m, double *Q, double *c, double *A, double *b,
                         const double *x0, double budget_ms,
                         double *x_out, double *obj_out, int *iters_out,
                         double *max_resid_out)
{
    QP qp; QPResult res;
    memset(&qp, 0, sizeof qp);
    memset(&res, 0, sizeof res);
    qp.n = n; qp.m = m; qp.Q = Q; qp.c = c; qp.A = A; qp.b = b; qp.x0 = x0;
    qp.phase1_order = g_lp_first ? QP_PHASE1_LP_FIRST : QP_PHASE1_DENSE_FIRST;
    g_proven = 0;
    g_resid = 0.0;
    arm_budget(budget_ms);
    qp_solve(&qp, &res);
    disarm_budget();
    if (g_arena_armed && g_arena.used > g_arena_peak) g_arena_peak = g_arena.used;
    if (res.x && x_out) memcpy(x_out, res.x, sizeof(double) * (size_t)n);
    if (obj_out)       *obj_out = res.obj;
    if (iters_out)     *iters_out = res.iterations;
    if (max_resid_out) *max_resid_out = res.max_resid;
    g_resid = res.max_resid;
    if (res.status == -1 && res.infeasible_proven && m > 0) {
        double *lam = (double*)realloc(g_lam, sizeof(double) * (size_t)m);
        if (lam) {
            g_lam = lam; g_lam_n = m;
            memcpy(g_lam, res.farkas, sizeof(double) * (size_t)m);
            g_proven = 1;
        }
    }
    int st = res.status;
    qp_result_free(&res);        /* zeroes the struct: read everything first */
    return st;
}

/* Back-compatible entry point: no warm start, no budget. */
EXPORT int psw_qp_solve(int n, int m, double *Q, double *c, double *A, double *b,
                        double *x_out, double *obj_out, int *iters_out)
{
    return psw_qp_solve2(n, m, Q, c, A, b, NULL, -1.0, x_out, obj_out, iters_out, NULL);
}



/* 1 => the last QP call PROVED {x : Ax <= b} is empty (Farkas certificate
 * available), 0 => the last call merely failed to find a feasible start, or
 * found a solution.  Call after every psw_qp_solve*. */
EXPORT int psw_qp_proven(void) { return g_proven; }

/* Copy the normalised certificate of the last solve into out[m]: lambda with
 * max|lambda|=1, lambda >= 0, A'lambda ~ 0, b'lambda < 0.  The rows with
 * lambda_i > 0 are the conflicting subset -- the "why" a UI needs to show
 * instead of a shrug.  Returns the number of entries written, or 0 when there
 * is no certificate. */
EXPORT int psw_qp_farkas(double *out)
{
    if (!g_proven || !g_lam || !out) return 0;
    memcpy(out, g_lam, sizeof(double) * (size_t)g_lam_n);
    return g_lam_n;
}

/* Largest row violation at the point the last call returned (0 when feasible):
 * > 0 means the call ended without a point that satisfies Ax <= b, so a host
 * that only draws feasible layouts must ignore x_out and keep its last good
 * frame.  Also returned in max_resid_out of psw_qp_solve2. */
EXPORT double psw_qp_maxresid(void) { return g_resid; }

/* Note: arena use is CUMULATIVE, not live -- freeing inside an arena scope is a
 * no-op and nothing is reused until reset, so a solve's whole allocation
 * traffic (every per-iteration working array of the active set and of the
 * Phase-I search it calls) adds up here. */
/* Bytes consumed so far by the active arena (cumulative, see the note below). */
EXPORT size_t psw_arena_used(void) { return g_arena_armed ? g_arena.used : 0; }

/* High-water mark of psw_arena_used() across the solves made since the last
 * psw_arena_reset() -- i.e. what one frame actually cost.
 *
 * Why there is no formula here for how big to make the buffer: the traffic above
 * is proportional to the ITERATION COUNT, which depends on the model, so any
 * closed-form bound in n and m is wrong by an order of magnitude at the sizes a
 * layout engine uses (measured, this problem family: 1.9 MB at 16 vars / 25
 * rows, 14 MB at 32 / 49 -- and an exhausted arena is a hard failure, since
 * psolve signals PSOLVE_ERR_OOM and a wasm module has no longjmp handler to
 * catch it, so the page dies).  Size the arena from a measured frame instead:
 * solve frame 1 with no arena, read this after arming a generous buffer once,
 * and give the real buffer 4x that.  A host that cannot afford that margin should
 * leave the arena off (libc malloc) -- psolve's arena is a determinism feature,
 * not a speed feature for the QP; it measured slower on this workload. */
EXPORT size_t psw_arena_highwater(void) { return g_arena_peak; }

/* Decide whether a cached point is a legal warm start, without solving: the
 * exact test qp_solve applies to qp->x0.  Q/c may be NULL here -- feasibility
 * only involves A, b. */
EXPORT int psw_qp_start_feasible(int n, int m, double *A, double *b, const double *x)
{
    QP qp;
    memset(&qp, 0, sizeof qp);
    qp.n = n; qp.m = m; qp.A = A; qp.b = b;
    return qp_start_feasible(&qp, x);
}

/* Status text that keeps a give-up apart from a proof. */
EXPORT const char *psw_qp_status_name(int st)
{
    switch (st) {
        case 0:  return "OPTIMAL";
        case 1:  return "UNBOUNDED";
        case 2:  return "ITERATION_LIMIT";
        case 3:  return "KKT_NOT_VERIFIED";
        case 4:  return "NON_CONVEX";
        case 5:  return "INVALID_MODEL";
        case 6:  return "STOPPED";
        case -1: return "NO_FEASIBLE_START";
        default: return "UNKNOWN";
    }
}
EXPORT const char *psw_qp_verdict_name(int status, int proven)
{
    if (status == -1) return proven ? "INFEASIBLE_PROVEN" : "NO_FEASIBLE_START";
    return psw_qp_status_name(status);
}

/* Phase-I ordering policy (QP.phase1_order): 0 keeps the engine default
 * (dense auxiliary QP first, the LP route as fallback), 1 asks for the sparse LP
 * route first with the dense search as fallback.  A host that solves inside a
 * frame budget wants 1 -- it is 3-12x cheaper on the layout family and its
 * "no feasible start" answer arrives on time; a host building a batch that must
 * answer as many models as possible wants 0.  Set once at start-up: it is applied
 * to every solve from then on, and it can never change a verdict, only how many
 * models get one. */
EXPORT void psw_qp_set_phase1_lp_first(int on) { g_lp_first = on ? 1 : 0; }
EXPORT int psw_qp_phase1_lp_first(void) { return g_lp_first; }

/* Release the bridge's own scratch (certificate copy).  Safe to call twice. */
EXPORT void psw_free_scratch(void) { free(g_lam); g_lam = NULL; g_lam_n = 0; g_proven = 0; }

