// F-Rep shape tree (what Curv shape values evaluate to), bounding boxes, and
// compilation of the tree into straight-line shader code (WGSL or JS) through
// the Gen backends.  All numbers that may vary between evaluations are emitted
// as parameters so re-solving / animating never triggers a shader recompile.
import { type Atlas, CELL, FONT_PX, GLYPH_PAD, BASELINE, ATLAS_COLS, ATLAS_ROWS, advanceOf } from "../gpu/atlas";
import { type Gen, type E, GenError } from "../gpu/gen";

export type RGBA = [number, number, number, number];
export type BBox = [number, number, number, number]; // x0 y0 x1 y1 (local coords)
export const EMPTY: BBox = [Infinity, Infinity, -Infinity, -Infinity];

/** A compilable user function (SubCurv closure) – dist / colour of make_shape. */
export interface ShaderFn { name: string; compile(g: Gen, p: E, ctx: GenCtx): E }

export type SNode =
  | { k: "circle"; r: number } | { k: "rect"; w: number; h: number; r: number }
  | { k: "seg"; x1: number; y1: number; x2: number; y2: number; th: number }
  | { k: "ellipse"; a: number; b: number } | { k: "nothing" } | { k: "everything" }
  | { k: "half"; nx: number; ny: number; d: number }
  | { k: "ngon"; n: number; r: number } | { k: "poly"; pts: number[] }
  | { k: "text"; text: string; size: number; align: "center" | "left" }
  | { k: "union"; kids: SNode[] } | { k: "inter"; kids: SNode[] } | { k: "diff"; a: SNode; b: SNode }
  | { k: "sunion"; s: number; kids: SNode[] } | { k: "sinter"; s: number; kids: SNode[] } | { k: "sdiff"; s: number; a: SNode; b: SNode }
  | { k: "morph"; t: number; a: SNode; b: SNode }
  | { k: "round"; r: number; s: SNode } | { k: "stroke"; w: number; s: SNode } | { k: "complement"; s: SNode } | { k: "lipschitz"; lip: number; s: SNode }
  | { k: "colour"; c: RGBA; s: SNode } | { k: "opacity"; a: number; s: SNode } | { k: "colourfn"; f: ShaderFn; s: SNode }
  | { k: "grad"; c1: RGBA; c2: RGBA; x0: number; y0: number; x1: number; y1: number; s: SNode }
  | { k: "shadow"; dx: number; dy: number; blur: number; a: number; s: SNode }
  | { k: "xform"; tx: number; ty: number; rot: number; sc: number; s: SNode }
  | { k: "stretch"; sx: number; sy: number; s: SNode } | { k: "reflect"; nx: number; ny: number; s: SNode }
  | { k: "repeat"; kind: "x" | "y" | "xy" | "radial" | "mirror_x" | "mirror_y" | "mirror_xy"; a: number; b: number; s: SNode }
  | { k: "swirl"; strength: number; d: number; s: SNode }
  | { k: "custom"; dist: ShaderFn | null; colour: ShaderFn | null; bbox: BBox | null; name: string };

export class Shape {
  constructor(public node: SNode, public bbox3?: number[][] | null) {}
}

// ---------------------------------------------------------------- bbox
const isEmpty = (b: BBox) => b[0] > b[2] || b[1] > b[3];
const grow = (b: BBox | null, k: number): BBox | null => (!b || isEmpty(b) ? b : [b[0] - k, b[1] - k, b[2] + k, b[3] + k]);
const unionB = (a: BBox | null, b: BBox | null): BBox | null => (!a || !b ? null : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
const interB = (a: BBox | null, b: BBox | null): BBox | null => (!a ? b : !b ? a : [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
const ptsB = (pts: [number, number][]): BBox => pts.reduce<BBox>((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [...EMPTY] as BBox);
const cornersOf = (b: BBox): [number, number][] => [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]];

export function textMetrics(n: { text: string; size: number; align: "center" | "left" }, atlas: Atlas) {
  const s = n.size / FONT_PX; let total = 0;
  for (const ch of n.text) total += advanceOf(atlas, ch.charCodeAt(0)) * s;
  // y-up world: the baseline sits below the centre for centred text; the origin is the baseline start for left text
  const x0 = n.align === "center" ? -total / 2 : 0; const baseY = n.align === "center" ? -n.size * 0.36 : 0;
  return { s, total, x0, baseY };
}

export function bboxOf(n: SNode, atlas: Atlas): BBox | null {
  switch (n.k) {
    case "circle": return [-n.r, -n.r, n.r, n.r];
    case "rect": return [-n.w / 2, -n.h / 2, n.w / 2, n.h / 2];
    case "seg": return grow(ptsB([[n.x1, n.y1], [n.x2, n.y2]]), n.th / 2);
    case "ellipse": return [-n.a / 2, -n.b / 2, n.a / 2, n.b / 2];
    case "nothing": return [...EMPTY] as BBox;
    case "everything": case "half": return null;
    case "ngon": { const R = n.r / Math.cos(Math.PI / n.n); return [-R, -R, R, R]; }
    case "poly": { const pts: [number, number][] = []; for (let i = 0; i < n.pts.length; i += 2) pts.push([n.pts[i], n.pts[i + 1]]); return ptsB(pts); }
    case "text": { const m = textMetrics(n, atlas); return [m.x0 - GLYPH_PAD * m.s, m.baseY - (CELL - BASELINE) * m.s, m.x0 + m.total + GLYPH_PAD * m.s, m.baseY + BASELINE * m.s]; }
    case "union": return n.kids.reduce<BBox | null>((b, k) => unionB(b, bboxOf(k, atlas)), [...EMPTY] as BBox);
    case "sunion": return grow(n.kids.reduce<BBox | null>((b, k) => unionB(b, bboxOf(k, atlas)), [...EMPTY] as BBox), n.s);
    case "inter": case "sinter": return n.kids.reduce<BBox | null>((b, k) => interB(b, bboxOf(k, atlas)), null);
    case "diff": case "sdiff": return bboxOf(n.a, atlas);
    case "morph": return unionB(bboxOf(n.a, atlas), bboxOf(n.b, atlas));
    case "round": return grow(bboxOf(n.s, atlas), Math.max(0, n.r));
    case "stroke": return grow(bboxOf(n.s, atlas), n.w / 2);
    case "complement": return null;
    case "shadow": { const b = bboxOf(n.s, atlas); return unionB(b, grow(b ? [b[0] + n.dx, b[1] + n.dy, b[2] + n.dx, b[3] + n.dy] : null, n.blur)); }
    case "lipschitz": case "colour": case "opacity": case "colourfn": case "grad": return bboxOf(n.s, atlas);
    case "xform": {
      const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b;
      const c = Math.cos(n.rot), s = Math.sin(n.rot), k = n.sc || 1;
      return ptsB(cornersOf(b).map(([x, y]) => [n.tx + (c * x - s * y) * k, n.ty + (s * x + c * y) * k]));
    }
    case "stretch": { const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b; return ptsB(cornersOf(b).map(([x, y]) => [x * n.sx, y * n.sy])); }
    case "reflect": { const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b; const l = Math.hypot(n.nx, n.ny) || 1, nx = n.nx / l, ny = n.ny / l; return ptsB(cornersOf(b).map(([x, y]) => { const d = 2 * (x * nx + y * ny); return [x - d * nx, y - d * ny]; })); }
    case "repeat": {
      const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b;
      if (n.kind === "mirror_x") return [Math.min(b[0], -b[2]), b[1], Math.max(b[2], -b[0]), b[3]];
      if (n.kind === "mirror_y") return [b[0], Math.min(b[1], -b[3]), b[2], Math.max(b[3], -b[1])];
      if (n.kind === "mirror_xy") return [Math.min(b[0], -b[2]), Math.min(b[1], -b[3]), Math.max(b[2], -b[0]), Math.max(b[3], -b[1])];
      if (n.kind === "radial") { const R = Math.max(...cornersOf(b).map(([x, y]) => Math.hypot(x, y))); return [-R, -R, R, R]; }
      if (n.kind === "x") return [-Infinity, b[1], Infinity, b[3]];
      if (n.kind === "y") return [b[0], -Infinity, b[2], Infinity];
      return null;
    }
    case "swirl": return unionB(bboxOf(n.s, atlas), [-n.d / 2, -n.d / 2, n.d / 2, n.d / 2]);
    case "custom": return n.bbox;
  }
}
export function finiteBBox(b: BBox | null): BBox | null { return b && !isEmpty(b) && b.every(Number.isFinite) ? b : null; }

/** rough primitive count, used to decide whether bbox culling is worth a branch */
function weight(n: SNode): number {
  switch (n.k) {
    case "text": return n.text.length * 2;
    case "union": case "inter": case "sunion": case "sinter": return n.kids.reduce((s, k) => s + weight(k), 0);
    case "diff": case "sdiff": case "morph": return weight(n.a) + weight(n.b);
    case "custom": return 6; case "poly": return n.pts.length / 2; case "nothing": return 0;
    default: return "s" in n ? weight(n.s) + 0.5 : 1;
  }
}

// ---------------------------------------------------------------- codegen
export interface GenCtx { atlas: Atlas; zoom: E; time: E; cull: boolean; defaultColour: RGBA }
export interface DC { d: E; c: E }

const V = (g: Gen, ...xs: number[]) => g.vec(xs.map((x) => g.param(x)));
const rgba = (g: Gen, c: RGBA) => g.vec(c.map((x) => g.param(x)));
function cov(g: Gen, d: E, zoom: E): E { return g.fn("clamp", [g.bin("-", g.num(0.5), g.bin("*", d, zoom)), g.num(0), g.num(1)]); }
function smin(g: Gen, a: E, b: E, k: E): E {
  const h = g.let(g.fn("clamp", [g.bin("+", g.num(0.5), g.bin("/", g.bin("*", g.num(0.5), g.bin("-", b, a)), g.fn("max", [k, g.num(1e-4)]))), g.num(0), g.num(1)]));
  return g.bin("-", g.fn("mix", [b, a, h]), g.bin("*", g.bin("*", k, h), g.bin("-", g.num(1), h)));
}
function over(g: Gen, a: DC, b: DC, zoom: E): DC {
  // union with painter's-order colour ("b over a")
  const d = g.let(g.fn("min", [a.d, b.d]));
  const wa = g.let(g.bin("*", cov(g, a.d, zoom), g.idx(a.c, 3))), wb = g.let(g.bin("*", cov(g, b.d, zoom), g.idx(b.c, 3)));
  const at = g.let(g.bin("+", wb, g.bin("*", wa, g.bin("-", g.num(1), wb))));
  const rgb = g.bin("/", g.bin("+", g.bin("*", g.swz(b.c, [0, 1, 2]), wb), g.bin("*", g.bin("*", g.swz(a.c, [0, 1, 2]), wa), g.bin("-", g.num(1), wb))), g.fn("max", [at, g.num(1e-5)]));
  const rgbSel = g.sel(g.cmp("<", at, g.num(1e-5)), g.swz(a.c, [0, 1, 2]), rgb);
  const alpha = g.fn("min", [g.num(1), g.bin("/", at, g.fn("max", [cov(g, d, zoom), g.num(1e-5)]))]);
  return { d, c: g.let(g.vec([rgbSel, alpha])) };
}
function sdBox(g: Gen, p: E, hx: E, hy: E, r: E): E {
  const q = g.let(g.bin("+", g.bin("-", g.fn("abs", [p]), g.vec([hx, hy])), r));
  const qx = g.idx(q, 0), qy = g.idx(q, 1);
  return g.bin("-", g.bin("+", g.fn("length", [g.fn("max", [q, g.num(0)])]), g.fn("min", [g.fn("max", [qx, qy]), g.num(0)])), r);
}

export function genShape(g: Gen, n: SNode, p: E, ctx: GenCtx): DC {
  const white: DC["c"] = g.vec(ctx.defaultColour.map((x) => g.num(x)));
  const prim = (d: E): DC => ({ d: g.let(d), c: white });
  const px = () => g.idx(p, 0), py = () => g.idx(p, 1);
  const kid = (s: SNode, q: E = p, c: Partial<GenCtx> = {}) => genShape(g, s, q, { ...ctx, ...c });
  const kidCulled = (s: SNode, q: E): DC => {
    // in a coverage-only context, skip subtrees whose bbox the pixel is far outside
    const bb = ctx.cull ? finiteBBox(bboxOf(s, ctx.atlas)) : null;
    if (!bb || weight(s) < 4) return kid(s, q);
    const cx = g.param((bb[0] + bb[2]) / 2), cy = g.param((bb[1] + bb[3]) / 2), hx = g.param((bb[2] - bb[0]) / 2), hy = g.param((bb[3] - bb[1]) / 2);
    const bd = g.let(sdBox(g, g.bin("-", q, g.vec([cx, cy])), hx, hy, g.num(0)));
    const pad = g.bin("/", g.num(1.5), ctx.zoom);
    const dv = g.var(g.bin("+", bd, pad)); const cv = g.var(g.vec([g.num(0), g.num(0), g.num(0), g.num(0)]));
    g.if(g.cmp("<", bd, pad), () => { const r = kid(s, q); g.assign(dv, r.d); g.assign(cv, r.c); });
    return { d: dv, c: cv };
  };
  switch (n.k) {
    case "circle": return prim(g.bin("-", g.fn("length", [p]), g.param(n.r)));
    case "rect": return prim(sdBox(g, p, g.param(n.w / 2), g.param(n.h / 2), g.param(Math.min(n.r, n.w / 2, n.h / 2))));
    case "seg": {
      const a = V(g, n.x1, n.y1), b = V(g, n.x2, n.y2);
      const pa = g.let(g.bin("-", p, a)), ba = g.let(g.bin("-", b, a));
      const h = g.let(g.fn("clamp", [g.bin("/", g.fn("dot", [pa, ba]), g.fn("max", [g.fn("dot", [ba, ba]), g.num(1e-6)])), g.num(0), g.num(1)]));
      return prim(g.bin("-", g.fn("length", [g.bin("-", pa, g.bin("*", ba, h))]), g.param(n.th / 2)));
    }
    case "ellipse": {
      const ab = g.let(V(g, n.a / 2, n.b / 2));
      const k0 = g.let(g.fn("length", [g.bin("/", p, ab)])), k1 = g.let(g.fn("length", [g.bin("/", p, g.bin("*", ab, ab))]));
      return prim(g.bin("/", g.bin("*", k0, g.bin("-", k0, g.num(1))), g.fn("max", [k1, g.num(1e-6)])));
    }
    case "nothing": return prim(g.num(1e30));
    case "everything": return prim(g.num(-1e30));
    case "half": return prim(g.bin("-", g.fn("dot", [p, g.fn("normalize", [V(g, n.nx, n.ny)])]), g.param(n.d)));
    case "ngon": {
      const an = Math.PI / n.n, R = n.r / Math.cos(an);
      const acs = V(g, Math.cos(an), Math.sin(an)); const anE = g.param(an);
      const bn = g.let(g.bin("-", g.bin("%", g.fn("atan2", [px(), py()]), g.bin("*", g.num(2), anE)), anE));
      const q = g.let(g.bin("-", g.bin("*", g.fn("length", [p]), g.vec([g.fn("cos", [bn]), g.fn("abs", [g.fn("sin", [bn])])])), g.bin("*", g.param(R), acs)));
      const qy = g.bin("+", g.idx(q, 1), g.fn("clamp", [g.neg(g.idx(q, 1)), g.num(0), g.bin("*", g.param(R), g.idx(acs, 1))]));
      const q2 = g.let(g.vec([g.idx(q, 0), qy]));
      return prim(g.bin("*", g.fn("length", [q2]), g.fn("sign", [g.idx(q2, 0)])));
    }
    case "poly": {
      const N = n.pts.length / 2; if (N < 3) return prim(g.num(1e30));
      const base = g.params.length; for (const v of n.pts) g.param(v);
      const at = (i: E, off: number) => g.paramAt(g.bin("+", g.bin("*", i, g.num(2)), g.num(base + off)));
      const v0 = g.vec([g.paramAt(g.num(base)), g.paramAt(g.num(base + 1))]);
      const dv = g.var(g.fn("dot", [g.bin("-", p, v0), g.bin("-", p, v0)])); const sv = g.var(g.num(1));
      g.loop(g.num(N), (i) => {
        const j = g.let(g.bin("%", g.bin("+", i, g.num(N - 1)), g.num(N)));
        const vi = g.let(g.vec([at(i, 0), at(i, 1)])), vj = g.let(g.vec([at(j, 0), at(j, 1)]));
        const e = g.let(g.bin("-", vj, vi)), w = g.let(g.bin("-", p, vi));
        const b = g.let(g.bin("-", w, g.bin("*", e, g.fn("clamp", [g.bin("/", g.fn("dot", [w, e]), g.fn("max", [g.fn("dot", [e, e]), g.num(1e-9)])), g.num(0), g.num(1)]))));
        g.assign(dv, g.fn("min", [dv, g.fn("dot", [b, b])]));
        const c1 = g.cmp(">=", py(), g.idx(vi, 1)), c2 = g.cmp("<", py(), g.idx(vj, 1)), c3 = g.cmp(">", g.bin("-", g.bin("*", g.idx(e, 0), g.idx(w, 1)), g.bin("*", g.idx(e, 1), g.idx(w, 0))), g.num(0));
        const all = g.logic("&&", g.logic("&&", c1, c2), c3), none = g.logic("&&", g.logic("&&", g.not(c1), g.not(c2)), g.not(c3));
        g.if(g.logic("||", all, none), () => g.assign(sv, g.neg(sv)));
      });
      return prim(g.bin("*", sv, g.fn("sqrt", [dv])));
    }
    case "text": {
      const m = textMetrics(n, ctx.atlas);
      const sE = g.param(m.s); let x = m.x0; let acc: DC | null = null;
      const pad = g.let(g.bin("/", g.num(1.5), ctx.zoom));
      for (const ch of n.text) {
        const code = ch.charCodeAt(0); const adv = advanceOf(ctx.atlas, code) * m.s;
        if (code !== 32) {
          const [cc, cr] = ctx.atlas.cell(code);
          const u0 = cc / ATLAS_COLS, v0 = cr / ATLAS_ROWS, u1 = (cc + 1) / ATLAS_COLS, v1 = (cr + 1) / ATLAS_ROWS;
          // cell origin = bottom-left corner in y-up world space; atlas rows run top-down so v is flipped below
          const qx = x - GLYPH_PAD * m.s, qy = m.baseY - (CELL - BASELINE) * m.s, qs = CELL * m.s;
          const org = V(g, qx, qy); const qsE = g.param(qs);
          const lp = g.let(g.bin("-", p, org));
          const bd = g.let(sdBox(g, g.bin("-", lp, g.bin("*", qsE, g.num(0.5))), g.bin("*", qsE, g.num(0.5)), g.bin("*", qsE, g.num(0.5)), g.num(0)));
          const dv = g.var(g.bin("+", bd, pad));
          g.if(g.cmp("<", bd, pad), () => {
            const q = g.fn("clamp", [g.bin("/", lp, g.fn("max", [qsE, g.num(1e-6)])), g.num(0), g.num(1)]);
            const uv = g.fn("mix", [g.vec([g.num(u0), g.num(v1)]), g.vec([g.num(u1), g.num(v0)]), q]);
            const t = g.tex(uv);
            const dg = g.bin("*", g.bin("*", g.bin("-", g.num(0.5), t), g.num(2 * 8)), sE);
            g.assign(dv, g.fn("max", [dg, bd]));
          });
          const dc: DC = { d: dv, c: white };
          acc = acc ? { d: g.let(g.fn("min", [acc.d, dc.d])), c: white } : dc;
        }
        x += adv;
      }
      return acc ?? prim(g.num(1e30));
    }
    case "union": {
      if (n.kids.length === 0) return prim(g.num(1e30));
      let acc = kidCulled(n.kids[0], p);
      for (let i = 1; i < n.kids.length; i++) acc = over(g, acc, kidCulled(n.kids[i], p), ctx.zoom);
      return acc;
    }
    case "inter": {
      if (n.kids.length === 0) return prim(g.num(-1e30));
      let acc = kidCulled(n.kids[0], p);
      for (let i = 1; i < n.kids.length; i++) { const b = kidCulled(n.kids[i], p); const d = g.let(g.fn("max", [acc.d, b.d])); acc = { d, c: g.let(g.sel(g.cmp(">", b.d, acc.d), b.c, acc.c)) }; }
      return acc;
    }
    case "diff": { const a = kidCulled(n.a, p), b = kidCulled(n.b, p); return { d: g.let(g.fn("max", [a.d, g.neg(b.d)])), c: a.c }; }
    case "sunion": {
      if (n.kids.length === 0) return prim(g.num(1e30));
      const k = g.param(n.s); let acc = kid(n.kids[0], p, { cull: false });
      for (let i = 1; i < n.kids.length; i++) {
        const b = kid(n.kids[i], p, { cull: false });
        const h = g.let(g.fn("clamp", [g.bin("+", g.num(0.5), g.bin("/", g.bin("*", g.num(0.5), g.bin("-", acc.d, b.d)), g.fn("max", [k, g.num(1e-4)]))), g.num(0), g.num(1)]));
        acc = { d: g.let(smin(g, acc.d, b.d, k)), c: g.let(g.fn("mix", [acc.c, b.c, h])) };
      }
      return acc;
    }
    case "sinter": {
      if (n.kids.length === 0) return prim(g.num(-1e30));
      const k = g.param(n.s); let acc = kid(n.kids[0], p, { cull: false });
      for (let i = 1; i < n.kids.length; i++) { const b = kid(n.kids[i], p, { cull: false }); acc = { d: g.let(g.neg(smin(g, g.neg(acc.d), g.neg(b.d), k))), c: g.let(g.sel(g.cmp(">", b.d, acc.d), b.c, acc.c)) }; }
      return acc;
    }
    case "sdiff": { const k = g.param(n.s); const a = kid(n.a, p, { cull: false }), b = kid(n.b, p, { cull: false }); return { d: g.let(g.neg(smin(g, g.neg(a.d), b.d, k))), c: a.c }; }
    case "morph": { const t = g.param(n.t); const a = kid(n.a, p, { cull: false }), b = kid(n.b, p, { cull: false }); return { d: g.let(g.fn("mix", [a.d, b.d, t])), c: g.let(g.fn("mix", [a.c, b.c, g.fn("clamp", [t, g.num(0), g.num(1)])])) }; }
    case "round": { const a = kid(n.s, p, { cull: false }); return { d: g.let(g.bin("-", a.d, g.param(n.r))), c: a.c }; }
    case "stroke": { const a = kid(n.s, p, { cull: false }); return { d: g.let(g.bin("-", g.fn("abs", [a.d]), g.param(n.w / 2))), c: a.c }; }
    case "complement": { const a = kid(n.s, p, { cull: false }); return { d: g.let(g.neg(a.d)), c: a.c }; }
    case "lipschitz": { const a = kid(n.s, p, { cull: false }); return { d: g.let(g.bin("/", a.d, g.param(n.lip))), c: a.c }; }
    case "colour": { const a = kid(n.s, p); return { d: a.d, c: g.let(rgba(g, n.c)) }; }
    case "opacity": { const a = kid(n.s, p); return { d: a.d, c: g.let(g.vec([g.swz(a.c, [0, 1, 2]), g.bin("*", g.idx(a.c, 3), g.param(n.a))])) }; }
    case "colourfn": {
      const a = kid(n.s, p);
      const p4 = g.let(g.vec([p, g.num(0), ctx.time]));
      let c = n.f.compile(g, p4, ctx);
      if (c.t === "f") c = g.vec([c, c, c]);
      if (c.t !== "v3" && c.t !== "v4") throw new GenError(`colour function must return an RGB triple`);
      return { d: a.d, c: g.let(c.t === "v3" ? g.vec([c, g.idx(a.c, 3)]) : c) };
    }
    case "grad": {
      const a = kid(n.s, p);
      const p0 = V(g, n.x0, n.y0), dv = g.let(g.bin("-", V(g, n.x1, n.y1), p0));
      const t = g.let(g.fn("clamp", [g.bin("/", g.fn("dot", [g.bin("-", p, p0), dv]), g.fn("max", [g.fn("dot", [dv, dv]), g.num(1e-6)])), g.num(0), g.num(1)]));
      return { d: a.d, c: g.let(g.vec([g.fn("mix", [V(g, n.c1[0], n.c1[1], n.c1[2]), V(g, n.c2[0], n.c2[1], n.c2[2]), t]), g.param(n.c1[3])])) };
    }
    case "shadow": {
      const sh = kid(n.s, g.let(g.bin("-", p, V(g, n.dx, n.dy))), { cull: false });
      const bl = g.param(Math.max(0.5, n.blur));
      const s = g.let(g.bin("-", g.num(1), g.fn("smoothstep", [g.neg(bl), bl, sh.d])));
      const shadow: DC = { d: g.let(g.bin("-", g.bin("-", sh.d, bl), g.bin("/", g.num(0.5), ctx.zoom))), c: g.let(g.vec([g.num(0), g.num(0), g.num(0), g.bin("*", g.param(n.a), s)])) };
      return over(g, shadow, kid(n.s, p), ctx.zoom);
    }
    case "xform": {
      const q0 = g.let(g.bin("-", p, V(g, n.tx, n.ty)));
      const cs = g.param(Math.cos(n.rot)), sn = g.param(Math.sin(n.rot)), sc = g.param(n.sc || 1);
      const qx = g.bin("+", g.bin("*", cs, g.idx(q0, 0)), g.bin("*", sn, g.idx(q0, 1)));
      const qy = g.bin("-", g.bin("*", cs, g.idx(q0, 1)), g.bin("*", sn, g.idx(q0, 0)));
      const q = g.let(g.bin("/", g.vec([qx, qy]), sc));
      const inner = genShape(g, n.s, q, { ...ctx, zoom: n.sc === 1 ? ctx.zoom : g.let(g.bin("*", ctx.zoom, sc)) });
      return { d: g.let(g.bin("*", inner.d, sc)), c: inner.c };
    }
    case "stretch": {
      const sv = g.let(V(g, n.sx, n.sy)); const m = Math.min(Math.abs(n.sx), Math.abs(n.sy)) || 1;
      const a = kid(n.s, g.let(g.bin("/", p, sv)), { cull: false, zoom: g.let(g.bin("*", ctx.zoom, g.param(m))) });
      return { d: g.let(g.bin("*", a.d, g.param(m))), c: a.c };
    }
    case "reflect": {
      const nn = g.let(g.fn("normalize", [V(g, n.nx, n.ny)]));
      const q = g.let(g.bin("-", p, g.bin("*", g.bin("*", g.num(2), g.fn("dot", [p, nn])), nn)));
      return kid(n.s, q);
    }
    case "repeat": {
      const a = g.param(n.a), b = g.param(n.b);
      let q: E;
      switch (n.kind) {
        case "x": q = g.vec([g.bin("-", g.bin("%", g.bin("+", px(), g.bin("*", a, g.num(0.5))), a), g.bin("*", a, g.num(0.5))), py()]); break;
        case "y": q = g.vec([px(), g.bin("-", g.bin("%", g.bin("+", py(), g.bin("*", b, g.num(0.5))), b), g.bin("*", b, g.num(0.5)))]); break;
        case "xy": { const c = g.let(g.vec([a, b])); q = g.bin("-", g.bin("%", g.bin("+", p, g.bin("*", c, g.num(0.5))), c), g.bin("*", c, g.num(0.5))); break; }
        case "mirror_x": q = g.vec([g.fn("abs", [px()]), py()]); break;
        case "mirror_y": q = g.vec([px(), g.fn("abs", [py()])]); break;
        case "mirror_xy": q = g.fn("abs", [p]); break;
        case "radial": {
          const ang = g.let(g.bin("/", g.num(2 * Math.PI), a));
          const r = g.let(g.fn("length", [p]));
          // sector centred on +y (Curv convention), so a shape straddling x = 0 repeats symmetrically
          const th = g.let(g.bin("+", g.bin("-", g.bin("%", g.bin("+", g.fn("atan2", [py(), px()]), g.bin("-", g.bin("*", ang, g.num(0.5)), g.num(Math.PI / 2))), ang), g.bin("*", ang, g.num(0.5))), g.num(Math.PI / 2)));
          q = g.bin("*", g.vec([g.fn("cos", [th]), g.fn("sin", [th])]), r); break;
        }
      }
      return kid(n.s, g.let(q), { cull: false });
    }
    case "swirl": {
      const r = g.let(g.fn("length", [p])); const rad = g.param(n.d / 2);
      const k = g.let(g.bin("*", g.param(n.strength), g.fn("max", [g.num(0), g.bin("-", g.num(1), g.bin("/", r, rad))])));
      const c = g.let(g.fn("cos", [k])), s = g.let(g.fn("sin", [k]));
      const q = g.let(g.vec([g.bin("-", g.bin("*", c, px()), g.bin("*", s, py())), g.bin("+", g.bin("*", s, px()), g.bin("*", c, py()))]));
      const a = kid(n.s, q, { cull: false });
      return { d: g.let(g.bin("/", a.d, g.param(1 + Math.abs(n.strength)))), c: a.c };
    }
    case "custom": {
      const p4 = g.let(g.vec([p, g.num(0), ctx.time]));
      let d: E = g.num(-1e30);
      if (n.dist) { d = n.dist.compile(g, p4, ctx); if (d.t !== "f") throw new GenError(`${n.name}: dist must return a number`); }
      let c: E = white;
      if (n.colour) {
        let cc = n.colour.compile(g, p4, ctx);
        if (cc.t === "f") cc = g.vec([cc, cc, cc]);
        if (cc.t === "v3") cc = g.vec([cc, g.num(1)]);
        if (cc.t !== "v4") throw new GenError(`${n.name}: colour must return an RGB triple`);
        c = cc;
      }
      return { d: g.let(d), c: g.let(c) };
    }
  }
}
