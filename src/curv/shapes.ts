// F-Rep shape tree (what Curv shape values evaluate to), bounding boxes, and
// compilation of the tree into straight-line shader code (WGSL or JS) through
// the Gen backends.  All numbers that may vary between evaluations are emitted
// as parameters so re-solving / animating never triggers a shader recompile.
import { type Atlas, CELL, FONT_PX, GLYPH_PAD, BASELINE, ATLAS_COLS, ATLAS_ROWS, penAdvance } from "../gpu/atlas";
import { type Gen, type E, GenError, SHADER_FLAGS, flagsKey, branchless } from "../gpu/gen";

export type RGBA = [number, number, number, number];
export type BBox = [number, number, number, number]; // x0 y0 x1 y1 (local coords)
export const EMPTY: BBox = [Infinity, Infinity, -Infinity, -Infinity];

/** A compilable user function (SubCurv closure) – dist / colour of make_shape. */
export interface ShaderFn { name: string; compile(g: Gen, p: E, ctx: GenCtx): E }

export type SNode =
  | { k: "circle"; r: number } | { k: "rect"; w: number; h: number; r: number }
  | { k: "seg"; x1: number; y1: number; x2: number; y2: number; z1?: number; z2?: number; th: number }
  | { k: "ellipse"; a: number; b: number } | { k: "nothing" } | { k: "everything" }
  | { k: "half"; nx: number; ny: number; d: number }
  | { k: "ngon"; n: number; r: number } | { k: "poly"; pts: number[] }
  | { k: "text"; text: string; size: number; align: "center" | "left" }
  | { k: "union"; kids: SNode[] } | { k: "inter"; kids: SNode[] } | { k: "diff"; a: SNode; b: SNode }
  | { k: "sunion"; s: number; kids: SNode[] } | { k: "sinter"; s: number; kids: SNode[] } | { k: "sdiff"; s: number; a: SNode; b: SNode }
  | { k: "cuunion"; s: number; kids: SNode[] } | { k: "cinter"; s: number; kids: SNode[] } | { k: "cdiff"; s: number; a: SNode; b: SNode }
  | { k: "morph"; t: number; a: SNode; b: SNode }
  | { k: "round"; r: number; s: SNode } | { k: "stroke"; w: number; s: SNode } | { k: "complement"; s: SNode } | { k: "lipschitz"; lip: number; s: SNode }
  | { k: "colour"; c: RGBA; s: SNode } | { k: "opacity"; a: number; s: SNode } | { k: "colourfn"; f: ShaderFn; s: SNode }
  | { k: "grad"; c1: RGBA; c2: RGBA; x0: number; y0: number; x1: number; y1: number; s: SNode }
  | { k: "shadow"; dx: number; dy: number; blur: number; a: number; s: SNode }
  | { k: "xform"; tx: number; ty: number; rot: number; sc: number; s: SNode }
  | { k: "stretch"; sx: number; sy: number; s: SNode } | { k: "reflect"; nx: number; ny: number; s: SNode }
  | { k: "repeat"; kind: "x" | "y" | "xy" | "xyz" | "radial" | "mirror_x" | "mirror_y" | "mirror_xy"; a: number; b: number; c?: number; s: SNode }
  | { k: "repeat_finite"; d: number[]; l: number[]; s: SNode }
  | { k: "swirl"; strength: number; d: number; s: SNode }
  // ---- 3D (round 17): primitives + operators.  In the 2D view every node is
  // evaluated at z = 0 (a planar slice), so a 3D program can be sliced too —
  // the same convention as the original Curv's slice_xy.
  | { k: "sphere"; r: number }
  | { k: "box3"; hx: number; hy: number; hz: number; r: number }
  | { k: "half3"; nx: number; ny: number; nz: number; d: number }
  | { k: "cone"; r: number; h: number; m: "exact" | "mitred" }
  | { k: "capped_cone"; hh: number; r1: number; r2: number }
  | { k: "gyroid" }
  | { k: "extrude"; h: number; m: "exact" | "mitred"; s: SNode }
  | { k: "loft"; h: number; a: SNode; b: SNode }
  | { k: "perex"; a: SNode; b: SNode }
  | { k: "twist"; tr: number; s: SNode }
  | { k: "bend"; rx: number; ry: number; ox: number; oy: number; s: SNode }
  | { k: "warp2"; f: ShaderFn; fix: ShaderFn | null; s: SNode }
  | { k: "shear2"; kx: number; s: SNode }
  | { k: "taper2"; y0: number; y1: number; kx0: number; kx1: number; s: SNode }
  | { k: "taper3"; z0: number; z1: number; kx0: number; ky0: number; kx1: number; ky1: number; s: SNode }
  | { k: "slice2"; plane: 0 | 1 | 2; s: SNode }
  | { k: "xform3"; tx: number; ty: number; tz: number; m: number[]; s: SNode }
  | { k: "stretch3"; sx: number; sy: number; sz: number; s: SNode }
  | { k: "reflect3"; nx: number; ny: number; nz: number; s: SNode }
  | { k: "distfield"; s: SNode }
  | { k: "showdist"; s: SNode }
  | { k: "showgrad"; j: number; k2: number; s: SNode }
  | { k: "custom"; dist: ShaderFn | null; colour: ShaderFn | null; bbox: BBox | null; name: string; bbox3?: number[] | null;
    /** is_2d / is_3d as declared by the program (make_shape); derived from the bbox when absent */
    is2d?: boolean; is3d?: boolean };

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

interface TextMetrics { s: number; total: number; x0: number; baseY: number }
// bbox, codegen and the parameter walk all need the metrics of a text node; memoised per node (nodes are immutable)
const tmMemo = new WeakMap<object, TextMetrics>();
export function textMetrics(n: { text: string; size: number; align: "center" | "left" }, atlas: Atlas): TextMetrics {
  let m = tmMemo.get(n);
  if (m) return m;
  const s = n.size / FONT_PX; let total = 0;
  for (let i = 0; i < n.text.length; i++) total += penAdvance(atlas, n.text, i) * s; // advances include kerning
  // y-up world: the baseline sits below the centre for centred text; the origin is the baseline start for left text
  const x0 = n.align === "center" ? -total / 2 : 0; const baseY = n.align === "center" ? -n.size * 0.36 : 0;
  m = { s, total, x0, baseY }; tmMemo.set(n, m);
  return m;
}

// Nodes are immutable and rebuilt on every evaluation, so a WeakMap memo is safe; without it
// the per-subtree culling test makes bbox computation O(n · depth) during codegen.
const bbMemo = new WeakMap<SNode, BBox | null>();
export function bboxOf(n: SNode, atlas: Atlas): BBox | null {
  let b = bbMemo.get(n);
  if (b === undefined) { b = bboxRaw(n, atlas); bbMemo.set(n, b); }
  return b;
}
function bboxRaw(n: SNode, atlas: Atlas): BBox | null {
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
    case "sunion": case "cuunion": return grow(n.kids.reduce<BBox | null>((b, k) => unionB(b, bboxOf(k, atlas)), [...EMPTY] as BBox), n.s);
    case "inter": case "sinter": case "cinter": return n.kids.reduce<BBox | null>((b, k) => interB(b, bboxOf(k, atlas)), null);
    case "diff": case "sdiff": case "cdiff": return bboxOf(n.a, atlas);
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
    case "repeat_finite": {
      const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b;
      const [x0, y0, x1, y1] = b;
      // the field places l copies at 0, d, …, d*(l-1): the span is d*(l-1) (C++ uses d*l, which
      // is one period too generous)
      const ex = n.d[0] * (n.l[0] - 1), ey = n.d[1] * (n.l[1] - 1);
      return [Math.min(x0, x0 + ex), Math.min(y0, y0 + ey), Math.max(x1, x1 + ex), Math.max(y1, y1 + ey)];
    }
    case "swirl": return unionB(bboxOf(n.s, atlas), [-n.d / 2, -n.d / 2, n.d / 2, n.d / 2]);
    case "sphere": return [-n.r, -n.r, n.r, n.r];
    case "box3": return [-n.hx, -n.hy, n.hx, n.hy]; // z = 0 slice: hz must not inflate the footprint
    case "half3": return null;
    case "cone": return [-n.r, -n.r, n.r, n.r];
    case "capped_cone": { const r = Math.max(n.r1, n.r2); return [-r, -r, r, r]; }
    case "gyroid": return null;
    case "extrude": return bboxOf(n.s, atlas);
    case "loft": return unionB(bboxOf(n.a, atlas), bboxOf(n.b, atlas));
    case "perex": {
      const p = bboxOf(n.a, atlas), c = bboxOf(n.b, atlas);
      if (!p || !c || !p.every(Number.isFinite) || !c.every(Number.isFinite)) return null;
      const R = c[2] - c[0] > c[3] - c[1] ? (c[2] - c[0]) / 2 : (c[3] - c[1]) / 2;
      return [p[0] - R, p[1] - R, p[2] + R, p[3] + R];
    }
    case "twist": { const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b; const R = Math.max(...cornersOf(b).map(([x, y]) => Math.hypot(x, y))); return [-R, -R, R, R]; }
    // C++ bend: bbox = ±ymax in x and y, ymax = height + ry (ry = d/2)
    case "bend": { const b = bboxOf(n.s, atlas); if (!b || !b.every(Number.isFinite)) return null; const ymax = (b[3] - b[1]) + n.ry; return [-ymax, -ymax, ymax, ymax]; }
    case "warp2": case "shear2": { const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b; const e = Math.max(b[2] - b[0], b[3] - b[1]) * 0.25; return grow(b, e); }
    case "taper2": case "taper3": { const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b; const k = Math.max((n as { kx0: number }).kx0, (n as { kx1: number }).kx1, "ky1" in n ? (n as { ky1: number }).ky1 : 1, "ky0" in n ? (n as { ky0: number }).ky0 : 1); return [b[0] * Math.max(k, 1), b[1] * Math.max(k, 1), b[2] * Math.max(k, 1), b[3] * Math.max(k, 1)]; }
    case "slice2": {
      // C++ slice_xy / slice_xz / slice_yz: the 2D view shows (x,y) / (x,z) / (y,z) of the
      // child's *3D* box — the old code reordered the 2D box, which produced inverted ranges
      const b = bbox3Of(n.s, atlas); if (!b || !b.every(Number.isFinite)) return null;
      return n.plane === 0 ? [b[0], b[1], b[3], b[4]] : n.plane === 1 ? [b[0], b[2], b[3], b[5]] : [b[1], b[2], b[4], b[5]];
    }
    case "xform3": {
      // the 2D view is the z = 0 slice, so the box has to be cut by the plane: projecting the
      // child's 2D box through the xy block alone loses every z → x / z → y coupling (a box3
      // rotated onto the y axis collapsed to a degenerate x-range)
      const b = bbox3Of(n.s, atlas); if (!b || !b.every(Number.isFinite)) return null;
      return sliceBox3XY(b, mTranspose(n.m), [n.tx, n.ty, n.tz]);
    }
    case "stretch3": { const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b; return [b[0] * n.sx, b[1] * n.sy, b[2] * n.sx, b[3] * n.sy]; }
    case "reflect3": {
      const b = bboxOf(n.s, atlas); if (!b || isEmpty(b)) return b;
      const l = Math.hypot(n.nx, n.ny, n.nz) || 1, nx = n.nx / l, ny = n.ny / l;
      return ptsB(cornersOf(b).map(([x, y]) => { const d = 2 * (x * nx + y * ny); return [x - d * nx, y - d * ny]; }));
    }
    case "distfield": case "showdist": case "showgrad": return null;
    case "custom": return n.bbox;
  }
}

/** 3D axis-aligned bounds [x0,y0,z0,x1,y1,z1] (conservative for bent/warped shapes; null = infinite).  Drives the 3D camera fit and s.bbox of custom shapes. */
export type BBox3 = number[];
const bb3Union = (a: BBox3 | null, b: BBox3 | null): BBox3 | null => (!a || !b ? null : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])]);
const bb3Inter = (a: BBox3 | null, b: BBox3 | null): BBox3 | null => (!a ? b : !b ? a : [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3]), Math.min(a[4], b[4]), Math.min(a[5], b[5])]);
const bb3Grow = (b: BBox3 | null, k: number): BBox3 | null => (!b ? b : [b[0] - k, b[1] - k, b[2] - k, b[3] + k, b[4] + k, b[5] + k]);
const bb3From2 = (b: BBox | null): BBox3 | null => (b && !isEmpty(b) ? [b[0], b[1], 0, b[2], b[3], 0] : null);
const bb3Pts = (pts: [number, number, number][]): BBox3 => pts.reduce<BBox3>((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.min(b[2], p[2]), Math.max(b[3], p[0]), Math.max(b[4], p[1]), Math.max(b[5], p[2])], [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
const bb3Pad = (b: BBox3, k: number): BBox3 => [b[0] - k, b[1] - k, b[2] - k, b[3] + k, b[4] + k, b[5] + k];
/** Transpose of a row-major 3×3.  `xform3` matrices are either the identity (translate / box3)
 *  or a rotation (rotate {angle, axis}), so the transpose is the inverse — and the inverse is
 *  what maps a child box into the parent's frame (the node's matrix is the *domain* transform). */
const mTranspose = (m: number[]): number[] => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
/** AABB of the z = 0 cross-section of the solid box `t + M·box`.  The section of a convex box by
 *  a plane is a convex polygon whose vertices are corners lying on the plane plus the points
 *  where the box's edges cross it, so that enumeration is exact (up to the box's own slack).
 *  Returns EMPTY when the transformed box misses the plane — the shape is then invisible in the
 *  2D slice view. */
const sliceBox3XY = (b: BBox3, m: number[], t: [number, number, number]): BBox => {
  const pt = (c: [number, number, number]): [number, number, number] => [
    t[0] + m[0] * c[0] + m[1] * c[1] + m[2] * c[2],
    t[1] + m[3] * c[0] + m[4] * c[1] + m[5] * c[2],
    t[2] + m[6] * c[0] + m[7] * c[1] + m[8] * c[2],
  ];
  const v = bb3Corners(b).map(pt);
  const eps = 1e-9 * Math.max(1, Math.abs(b[2]), Math.abs(b[5]), Math.abs(t[2]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const p of v) if (Math.abs(p[2]) <= eps) add(p[0], p[1]);
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) {
    const a = v[i], c = v[i | bit];
    if ((a[2] > eps && c[2] < -eps) || (a[2] < -eps && c[2] > eps)) {
      const s = a[2] / (a[2] - c[2]); // lerp parameter where z = 0
      add(a[0] + (c[0] - a[0]) * s, a[1] + (c[1] - a[1]) * s);
    }
  }
  return x0 > x1 || y0 > y1 ? [...EMPTY] as BBox : [x0, y0, x1, y1];
};
const bb3Corners = (b: BBox3): [number, number, number][] => [[b[0], b[1], b[2]], [b[3], b[1], b[2]], [b[0], b[4], b[2]], [b[3], b[4], b[2]], [b[0], b[1], b[5]], [b[3], b[1], b[5]], [b[0], b[4], b[5]], [b[3], b[4], b[5]]];

const bb3Memo = new WeakMap<SNode, BBox3 | null>();
export function bbox3Of(n: SNode, atlas: Atlas): BBox3 | null {
  let b = bb3Memo.get(n);
  if (b === undefined) { b = bbox3Raw(n, atlas); bb3Memo.set(n, b); }
  return b;
}
function bbox3Raw(n: SNode, atlas: Atlas): BBox3 | null {
  const c = (k: SNode) => bbox3Of(k, atlas);
  const flat = (b: BBox3 | null, k: number) => (b && b.every(Number.isFinite) ? bb3Grow(b, k) : b);
  const E3: BBox3 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  // union over 3D boxes; null = infinite (a single infinite child makes the union infinite)
  const u3r = (ks: SNode[]): BBox3 | null => {
    let u: BBox3 | null = null;
    for (const k of ks) { const b = c(k); if (b === null) return null; u = u === null ? b : bb3Union(u, b); }
    return u;
  };
  switch (n.k) {
    case "circle": return [-n.r, -n.r, 0, n.r, n.r, 0];
    case "rect": return bb3From2(bboxRaw(n, atlas));
    case "seg": return bb3Pad(bb3Pts([[n.x1, n.y1, n.z1 ?? 0], [n.x2, n.y2, n.z2 ?? 0]]), n.th / 2);
    case "ellipse": return bb3From2(bboxRaw(n, atlas));
    case "nothing": return [...E3];
    case "everything": return null;
    case "half": return [-Infinity, -Infinity, 0, Infinity, Infinity, 0];
    case "ngon": { const R = n.r / Math.cos(Math.PI / n.n); return [-R, -R, 0, R, R, 0]; }
    case "poly": return bb3From2(bboxRaw(n, atlas));
    case "text": return bb3From2(bboxRaw(n, atlas));
    case "union": case "cuunion": return u3r(n.kids);
    case "sunion": return bb3Grow(u3r(n.kids), n.s);
    case "inter": case "sinter": case "cinter": return n.kids.reduce<BBox3 | null>((b, k) => bb3Inter(b, c(k)), null);
    case "diff": case "sdiff": case "cdiff": return c(n.a);
    case "morph": return bb3Union(c(n.a), c(n.b));
    case "round": return flat(c(n.s), Math.max(0, n.r));
    case "stroke": return flat(c(n.s), n.w / 2);
    case "complement": return null;
    case "shadow": return bb3Union(c(n.s), bb3From2(bboxRaw(n, atlas)));
    case "lipschitz": case "colour": case "opacity": case "colourfn": case "grad": return c(n.s);
    case "xform": {
      const b = c(n.s); if (!b || !b.every(Number.isFinite)) return b;
      const cc = Math.cos(n.rot), s = Math.sin(n.rot), k = n.sc || 1;
      return bb3Pts(bb3Corners(b).map(([x, y, z]) => [n.tx + (cc * x - s * y) * k, n.ty + (s * x + cc * y) * k, z * k]));
    }
    case "stretch": { const b = c(n.s); if (!b) return b; return [b[0] * n.sx, b[1] * n.sy, b[2], b[3] * n.sx, b[4] * n.sy, b[5]]; }
    case "reflect": { const b = c(n.s); if (!b) return b; const l = Math.hypot(n.nx, n.ny) || 1, nx = n.nx / l, ny = n.ny / l; return bb3Pts(bb3Corners(b).map(([x, y, z]) => { const d = 2 * (x * nx + y * ny); return [x - d * nx, y - d * ny, z]; })); }
    case "repeat": {
      const b = c(n.s); if (!b) return b;
      if (n.kind === "x" || n.kind === "y" || n.kind === "xy" || n.kind === "xyz") return null;
      if (n.kind === "radial") { const R = Math.max(...bb3Corners(b).map((p) => Math.hypot(p[0], p[1]))); return [-R, -R, b[2], R, R, b[5]]; }
      return b;
    }
    case "repeat_finite": {
      const b = c(n.s); if (!b || !b.every(Number.isFinite)) return b;
      const out = [...b];
      // l copies at 0, d, …, d*(l-1): grow the max by d*(l-1) (or the min, for d < 0)
      const add = (i: number, dd: number, ll: number) => { if (dd === 0 || ll <= 1) return; const e = dd * (ll - 1); const lo = out[i], hi = out[i + 3]; out[i] = Math.min(lo, lo + e); out[i + 3] = Math.max(hi, hi + e); };
      add(0, n.d[0], n.l[0]); add(1, n.d[1], n.l[1]); add(2, n.d[2] ?? 0, n.l[2] ?? 1);
      return out;
    }
    case "swirl": { const b = c(n.s); if (!b) return b; const R = Math.max(n.d / 2, ...bb3Corners(b).map((p) => Math.hypot(p[0], p[1]))); return [-R, -R, Math.min(b[2], 0), R, R, Math.max(b[5], 0)]; }
    case "sphere": return [-n.r, -n.r, -n.r, n.r, n.r, n.r];
    case "box3": return [-n.hx, -n.hy, -n.hz, n.hx, n.hy, n.hz];
    case "half3": {
      const l = Math.hypot(n.nx, n.ny, n.nz) || 1, nx = n.nx / l, ny = n.ny / l, nz = n.nz / l, d = n.d / l;
      const axis = (na: number): [number, number] => (Math.abs(na) < 1e-9 ? [-Infinity, Infinity] : na > 0 ? [-Infinity, d / na] : [d / na, Infinity]);
      return [...axis(nx), ...axis(ny), ...axis(nz)];
    }
    case "cone": return [-n.r, -n.r, 0, n.r, n.r, n.h];
    case "capped_cone": { const r = Math.max(n.r1, n.r2); return [-r, -r, -n.hh, r, r, n.hh]; }
    case "gyroid": return null;
    // n.h is the half height: C++ `extrude d shape` computes `let h = d/2` and spans ±h
    case "extrude": { const b = c(n.s); if (!b) return b; const bb = b.every(Number.isFinite) ? b : bbox3Of(n.s, atlas) ?? null; if (!bb) return null; return [bb[0], bb[1], -n.h, bb[3], bb[4], n.h]; }
    case "loft": { const a = c(n.a), b = c(n.b); if (!a || !b) return null; return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), -n.h, Math.max(a[3], b[3]), Math.max(a[4], b[4]), n.h]; }
    case "perex": {
      const p = c(n.a), s2 = c(n.b); if (!p || !s2 || !p.every(Number.isFinite) || !s2.every(Number.isFinite)) return null;
      const R = Math.max(s2[3] - s2[0], s2[4] - s2[1]) / 2;
      return [p[0] - R, p[1] - R, s2[2] - R, p[3] + R, p[4] + R, s2[5] + R];
    }
    case "twist": { const b = c(n.s); if (!b || !b.every(Number.isFinite)) return b; const R = Math.max(...bb3Corners(b).map((p) => Math.hypot(p[0], p[1]))); return [-R, -R, b[2], R, R, b[5]]; }
    // C++ bend: bbox = ±ymax in x and y, ymax = height + ry (ry = d/2); z is untouched
    case "bend": { const b = c(n.s); if (!b || !b.every(Number.isFinite)) return null; const ymax = (b[4] - b[1]) + n.ry; return [-ymax, -ymax, b[2], ymax, ymax, b[5]]; }
    case "warp2": case "shear2": return c(n.s);
    case "taper2": { const b = c(n.s); if (!b) return b; const kx = Math.max(n.kx0, n.kx1); return [b[0] * kx, b[1], b[2], b[3] * kx, b[4], b[5]]; }
    case "taper3": { const b = c(n.s); if (!b) return b; const kx = Math.max(n.kx0, n.kx1), ky = Math.max(n.ky0, n.ky1); return [b[0] * kx, b[1] * ky, b[2], b[3] * kx, b[4] * ky, b[5]]; }
    case "slice2": { const b = c(n.s); if (!b || !b.every(Number.isFinite)) return null; if (n.plane === 0) return [b[0], b[1], 0, b[3], b[4], 0]; if (n.plane === 1) return [b[0], b[2], 0, b[3], b[5], 0]; return [b[1], b[2], 0, b[4], b[5], 0]; }
    // the node's matrix is the domain transform (q = M·(p - t)), so the image box is
    // t + M⁻¹·box = t + Mᵀ·box (M is a rotation or the identity)
    case "xform3": { const b = c(n.s); if (!b || !b.every(Number.isFinite)) return b; const m = mTranspose(n.m); return bb3Pts(bb3Corners(b).map(([x, y, z]) => [n.tx + m[0] * x + m[1] * y + m[2] * z, n.ty + m[3] * x + m[4] * y + m[5] * z, n.tz + m[6] * x + m[7] * y + m[8] * z])); }
    case "stretch3": { const b = c(n.s); if (!b) return b; return [b[0] * n.sx, b[1] * n.sy, b[2] * n.sz, b[3] * n.sx, b[4] * n.sy, b[5] * n.sz]; }
    case "reflect3": { const b = c(n.s); if (!b) return b; const l = Math.hypot(n.nx, n.ny, n.nz) || 1, nx = n.nx / l, ny = n.ny / l, nz = n.nz / l; return bb3Pts(bb3Corners(b).map(([x, y, z]) => { const d = 2 * (x * nx + y * ny + z * nz); return [x - d * nx, y - d * ny, z - d * nz]; })); }
    case "distfield": case "showdist": case "showgrad": return null;
    case "custom": return n.bbox3 ?? (n.bbox && !isEmpty(n.bbox) ? bb3From2(n.bbox) : null);
  }
}
/** is_2d / is_3d flags in the original-Curv sense (what s.is_2d / s.is_3d report).  Booleans take the
 * AND over their children (a union of a 2D and a 3D shape is neither, as in Curv); unary operators
 * keep the child's flags; the pure-2D primitives are 2D-only. */
const f3Memo = new WeakMap<SNode, { is2d: boolean; is3d: boolean }>();
export function flags3Of(n: SNode): { is2d: boolean; is3d: boolean } {
  const hit = f3Memo.get(n); if (hit) return hit;
  const f = (k: SNode) => flags3Of(k);
  const AND = (ks: SNode[]): { is2d: boolean; is3d: boolean } => {
    let is2d = true, is3d = true; for (const k of ks) { is2d &&= f(k).is2d; is3d &&= f(k).is3d; } return { is2d, is3d };
  };
  let out: { is2d: boolean; is3d: boolean };
  switch (n.k) {
    case "sphere": case "box3": case "half3": case "cone": case "capped_cone": case "gyroid": case "extrude": case "loft": case "perex": case "taper3": case "twist":
      out = { is2d: false, is3d: true }; break;
    case "slice2": out = { is2d: true, is3d: false }; break;
    case "distfield": case "showgrad": out = { is2d: true, is3d: true }; break;
    case "showdist": out = { is2d: true, is3d: f(n.s).is3d }; break;
    case "nothing": case "everything": out = { is2d: true, is3d: true }; break;
    case "xform3": { const cf = f(n.s); const zOnly = n.m[2] === 0 && n.m[6] === 0 && n.m[7] === 0 && n.m[8] === 1 && n.tz === 0; out = { is2d: zOnly && cf.is2d, is3d: cf.is3d || !zOnly }; break; }
    case "stretch3": { const cf = f(n.s); out = { is2d: n.sz === 1 && cf.is2d, is3d: cf.is3d || n.sz !== 1 }; break; }
    case "reflect3": { const cf = f(n.s); out = { is2d: n.nz === 0 && cf.is2d, is3d: cf.is3d || n.nz !== 0 }; break; }
    case "repeat": { const cf = f(n.s); out = n.kind === "xyz" ? { is2d: cf.is2d, is3d: cf.is3d } : cf; break; }
    case "repeat_finite": { const cf = f(n.s); const dz = n.d[2] !== 0 && (n.l[2] ?? 1) > 1; out = { is2d: !dz && cf.is2d, is3d: cf.is3d || dz }; break; }
    case "custom": {
      // a make_shape record may declare the flags itself (C++ copies them verbatim into the
      // shape record); only when it does not are they derived from the bbox, as before
      if (n.is2d !== undefined || n.is3d !== undefined) { out = { is2d: n.is2d ?? !(n.is3d ?? false), is3d: n.is3d ?? !(n.is2d ?? false) }; break; }
      const b3 = n.bbox3; const flat = !b3 || (b3[2] === 0 && b3[5] === 0); out = { is2d: flat, is3d: !flat }; break;
    }
    case "circle": case "rect": case "ellipse": case "half": case "ngon": case "poly": case "text":
      out = { is2d: true, is3d: false }; break;
    // `stroke {from, to}` has no z coordinates; `capsule` — which shares the node — always sets
    // them, and C++'s capsule is a 3D solid (is_3d = true) even when the segment lies in z = 0
    case "seg": out = n.z1 === undefined && n.z2 === undefined ? { is2d: true, is3d: false } : { is2d: false, is3d: true }; break;
    case "union": case "sunion": case "cuunion": case "inter": case "sinter": case "cinter": out = AND(n.kids); break;
    case "morph": out = AND([n.a, n.b]); break;
    case "diff": case "sdiff": case "cdiff": { const cf = f(n.a); out = { is2d: cf.is2d, is3d: cf.is3d }; break; }
    case "shadow": { const cf = f(n.s); out = { is2d: cf.is2d, is3d: cf.is3d || n.dx !== 0 || n.dy !== 0 }; break; }
    case "round": case "stroke": case "complement": case "lipschitz": case "colour": case "opacity": case "colourfn": case "grad":
    case "xform": case "stretch": case "reflect": case "swirl": case "shear2": case "taper2": case "warp2": case "bend":
      out = f(n.s); break;
    default: out = { is2d: true, is3d: false };
  }
  f3Memo.set(n, out);
  return out;
}
export function finiteBBox(b: BBox | null): BBox | null { return b && !isEmpty(b) && b.every(Number.isFinite) ? b : null; }

/** Per-glyph parameter rows [cell x, u0, v0, u1, v1] of a text node (spaces produce no glyph). Shared by codegen and walkParams. */
export function textGlyphs(n: { text: string; size: number; align: "center" | "left" }, atlas: Atlas, m = textMetrics(n, atlas)): number[][] {
  const glyphs: number[][] = []; let x = m.x0;
  for (let i = 0; i < n.text.length; i++) {
    const code = n.text.charCodeAt(i);
    if (code !== 32 && code !== 160) {
      const [cc, cr] = atlas.cell(code);
      // cell origin = bottom-left corner in y-up world space; atlas rows run top-down so v is flipped
      glyphs.push([x - GLYPH_PAD * m.s, cc / ATLAS_COLS, (cr + 1) / ATLAS_ROWS, (cc + 1) / ATLAS_COLS, cr / ATLAS_ROWS]);
    }
    x += penAdvance(atlas, n.text, i) * m.s;
  }
  return glyphs;
}

// ---------------------------------------------------------------- parameter walk (fast path)
/**
 * The parameter buffer of a tree without generating any code: a direct walk that pushes numbers in
 * exactly the order `genShape`'s `g.param(...)` calls would (scalars first, dynamic blocks appended
 * and base slots patched — the same layout as `Gen.finalParams()`).  ~3–5× cheaper than driving the
 * generic ParamsOnly backend.  Returns null for trees that contain user shader functions (their
 * parameters come from SubCurv compilation), which is exactly when `structKey` is null too.
 *
 * INVARIANT: every `g.param` / `dynBlock` in genShape must have a matching push here, in the same
 * order and with the same cull-flag propagation.  `scripts/paramcheck.ts` compares the two on every
 * example — run it after touching either function.
 */
/** Parameter segment of one subtree: its numbers in order, and the positions (relative to the segment) of deferred-block slots. */
interface ParamSeg { nums: number[]; blocks: { at: number; values: number[] }[] }
// Memo slot per (cull, flags) — the same fingerprint `skSlot` uses.  `cullable()` reads
// SHADER_FLAGS.cullWeight, so a tree walked under one threshold must never be answered from a
// segment built under another: the segments carry the cull bboxes as parameters, and the menu can
// change cullWeight live.  Before this the slots were keyed on `cull` alone, so flipping cullWeight
// left the walk serving the old buffer to a shader compiled for the new one (635 vs 615 params on
// `buttons`) — scripts/flagcheck.ts is the gate for it.
const wpSlots = new Map<string, [WeakMap<SNode, ParamSeg | null>, WeakMap<SNode, ParamSeg | null>]>();
const WP_SLOTS_MAX = 16;
function wpSlot(cull: boolean): WeakMap<SNode, ParamSeg | null> {
  const fk = flagsKey() + (cull ? "/1" : "/0");
  let m = wpSlots.get(fk);
  if (!m) {
    if (wpSlots.size >= WP_SLOTS_MAX) wpSlots.delete(wpSlots.keys().next().value!); // entries are pure caches
    m = [new WeakMap(), new WeakMap()];
    wpSlots.set(fk, m);
  }
  return m[cull ? 1 : 0];
}
export function walkParams(root: SNode, atlas: Atlas, cull = true): number[] | null {
  const seg = walkSeg(root, atlas, cull);
  if (!seg) return null;
  const out = seg.nums.slice();
  for (const b of seg.blocks) { out[b.at] = out.length; for (const v of b.values) out.push(Number.isFinite(v) ? v : 0); }
  return out;
}
/**
 * Memoised per subtree and cull flag: the segment of a subtree only depends on the subtree (its
 * bboxes are memoised too), so shared subtrees and trees that survive across frames through the
 * call memo are walked once.  Subtrees that are small (< 24 numbers) are not memoised individually
 * — copying them out of a parent's segment is cheaper than a WeakMap lookup per node.
 */
function walkSeg(root: SNode, atlas: Atlas, cull: boolean): ParamSeg | null {
  const memo = wpSlot(cull);
  const hit = memo.get(root);
  if (hit !== undefined) return hit;
  const out: number[] = []; const blocks: { at: number; values: number[] }[] = [];
  const P = (v: number) => { out.push(Number.isFinite(v) ? v : v > 0 ? 3e38 : v < 0 ? -3e38 : 0); };
  const block = (values: number[]) => { out.push(0); blocks.push({ at: out.length - 1, values }); };
  let ok = true;
  const walk = (n: SNode, cull: boolean): void => {
    if (n !== root) { // nested subtree: reuse / create its own segment when it is big enough to be worth it
      const m = wpSlot(cull);
      let s = m.get(n);
      if (s === undefined && weight(n) >= 8) { s = walkSeg(n, atlas, cull); }
      if (s !== undefined) {
        if (s === null) { ok = false; return; }
        const base = out.length;
        for (let i = 0; i < s.nums.length; i++) out.push(s.nums[i]);
        for (const b of s.blocks) blocks.push({ at: base + b.at, values: b.values });
        return;
      }
    }
    const kidC = (s: SNode) => {
      if (cullable(s, atlas, cull)) { const bb = finiteBBox(bboxOf(s, atlas))!; P((bb[0] + bb[2]) / 2); P((bb[1] + bb[3]) / 2); P((bb[2] - bb[0]) / 2); P((bb[3] - bb[1]) / 2); }
      walk(s, cull);
    };
    switch (n.k) {
      case "circle": P(n.r); return;
      case "rect": P(n.w / 2); P(n.h / 2); P(Math.min(n.r, n.w / 2, n.h / 2)); return;
      case "seg": P(n.x1); P(n.y1); P(n.z1 ?? 0); P(n.x2); P(n.y2); P(n.z2 ?? 0); P(n.th / 2); return;
      case "ellipse": P(n.a / 2); P(n.b / 2); return;
      case "nothing": case "everything": return;
      case "half": P(n.nx); P(n.ny); P(n.d); return;
      case "ngon": { const an = Math.PI / n.n, R = n.r / Math.cos(an); P(Math.cos(an)); P(Math.sin(an)); P(an); P(R); P(R); return; }
      case "poly": if (n.pts.length / 2 < 3) return; block(n.pts); return;
      case "text": { const m = textMetrics(n, atlas); const glyphs = textGlyphs(n, atlas, m); P(m.s); P(m.baseY - (CELL - BASELINE) * m.s); P(CELL * m.s); P(glyphs.length); block(glyphs.flat()); return; }
      case "union": case "inter": for (const k of n.kids) kidC(k); return;
      case "cuunion": case "cinter": P(n.s); for (const k of n.kids) kidC(k); return;
      case "diff": kidC(n.a); kidC(n.b); return;
      case "cdiff": walk(n.a, false); walk(n.b, false); P(n.s); return;
      case "sunion": case "sinter": if (n.kids.length === 0) return; P(n.s); for (const k of n.kids) walk(k, false); return;
      case "sdiff": P(n.s); walk(n.a, false); walk(n.b, false); return;
      case "morph": P(n.t); walk(n.a, false); walk(n.b, false); return;
      case "round": walk(n.s, false); P(n.r); return;
      case "stroke": walk(n.s, false); P(n.w / 2); return;
      case "complement": walk(n.s, false); return;
      case "lipschitz": walk(n.s, false); P(n.lip); return;
      case "colour": walk(n.s, cull); P(n.c[0]); P(n.c[1]); P(n.c[2]); P(n.c[3]); return;
      case "opacity": walk(n.s, cull); P(n.a); return;
      case "grad": walk(n.s, cull); P(n.x0); P(n.y0); P(n.x1); P(n.y1); P(n.c1[0]); P(n.c1[1]); P(n.c1[2]); P(n.c2[0]); P(n.c2[1]); P(n.c2[2]); P(n.c1[3]); return;
      case "shadow": P(n.dx); P(n.dy); walk(n.s, false); P(Math.max(0.5, n.blur)); P(n.a); walk(n.s, cull); return;
      case "xform": P(n.tx); P(n.ty); P(Math.cos(n.rot)); P(Math.sin(n.rot)); P(n.sc || 1); walk(n.s, cull); return;
      case "stretch": { const m = Math.min(Math.abs(n.sx), Math.abs(n.sy)) || 1; P(n.sx); P(n.sy); P(m); walk(n.s, false); P(m); return; }
      case "reflect": P(n.nx); P(n.ny); walk(n.s, cull); return;
      case "repeat": P(n.a); P(n.b); if (n.kind === "xyz") P(n.c ?? n.a); walk(n.s, false); return;
      case "repeat_finite": P(n.d[0]); P(n.d[1]); P(n.d[2] ?? 0); P(n.l[0]); P(n.l[1]); P(n.l[2] ?? 1); walk(n.s, false); return;
      case "swirl": P(Math.log(2) * n.d / 10); P(n.strength); walk(n.s, false); return;
      case "sphere": P(n.r); return;
      case "box3": P(n.hx); P(n.hy); P(n.hz); P(n.r); return;
      case "half3": P(n.nx); P(n.ny); P(n.nz); P(n.d); return;
      case "cone": P(n.r); P(n.h); return;
      case "capped_cone": P(n.hh); P(n.r1); P(n.r2); return;
      case "gyroid": return;
      case "extrude": P(n.h); walk(n.s, false); return;
      case "loft": P(n.h); walk(n.a, false); walk(n.b, false); return;
      case "perex": walk(n.a, false); walk(n.b, false); return;
      case "twist": P(n.tr); walk(n.s, false); return;
      case "bend": P(n.rx); P(n.ry); P(n.ox); P(n.oy); walk(n.s, false); return;
      case "warp2": ok = false; return;
      case "shear2": P(n.kx); walk(n.s, false); return;
      case "taper2": P(n.y0); P(n.y1); P(n.kx0); P(n.kx1); walk(n.s, false); return;
      case "taper3": P(n.z0); P(n.z1); P(n.kx0); P(n.ky0); P(n.kx1); P(n.ky1); walk(n.s, false); return;
      case "slice2": walk(n.s, cull); return;
      case "xform3": P(n.tx); P(n.ty); P(n.tz); for (const m of n.m) P(m); walk(n.s, cull); return;
      case "stretch3": { const m = Math.min(Math.abs(n.sx), Math.abs(n.sy), Math.abs(n.sz)) || 1; P(n.sx); P(n.sy); P(n.sz); P(m); walk(n.s, false); return; }
      case "reflect3": P(n.nx); P(n.ny); P(n.nz); walk(n.s, cull); return;
      case "distfield": walk(n.s, cull); return;
      case "showdist": for (let i = 0; i < 5; i++) walk(n.s, false); if (flags3Of(n.s).is3d) walk(n.s, false); return;
      case "showgrad": P(n.j); P(n.k2); for (let i = 0; i < 5; i++) walk(n.s, false); if (flags3Of(n.s).is3d) walk(n.s, false); return;
      case "colourfn": case "custom": ok = false; return;
    }
  };
  walk(root, cull);
  const seg: ParamSeg | null = ok ? { nums: out, blocks } : null;
  memo.set(root, seg);
  return seg;
}

/** rough primitive count, used to decide whether bbox culling is worth a branch */
const wMemo = new WeakMap<SNode, number>();
function weight(n: SNode): number {
  let w = wMemo.get(n);
  if (w === undefined) { w = weightRaw(n); wMemo.set(n, w); }
  return w;
}
function weightRaw(n: SNode): number {
  switch (n.k) {
    case "text": return Math.max(4, n.text.length * 2); // always worth culling (texture reads)
    case "union": case "inter": case "sunion": case "sinter": case "cuunion": case "cinter": return n.kids.reduce((s, k) => s + weight(k), 0);
    case "diff": case "sdiff": case "morph": case "loft": case "perex": case "cdiff": return weight(n.a) + weight(n.b);
    case "showdist": case "showgrad": return weight((n as { s: SNode }).s) * (5 + (flags3Of((n as { s: SNode }).s).is3d ? 1 : 0));
    case "custom": return 6; case "poly": return n.pts.length / 2; case "nothing": return 0;
    default: return "s" in n ? weight(n.s) + 0.5 : 1;
  }
}

/** Shared by codegen and the structural key: does `kidCulled` wrap this subtree in a bbox test? */
const cullable = (s: SNode, atlas: Atlas, cull: boolean) => cull && weight(s) >= SHADER_FLAGS.cullWeight && finiteBBox(bboxOf(s, atlas)) !== null;

// ---------------------------------------------------------------- content hash
/** 64-bit FNV-1a style hash of a string, as 16 hex chars (two independent 32-bit lanes). */
export function hashStr(s: string, h1 = 0x811c9dc5, h2 = 0x01000193): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193); h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ (h1 >>> 13); h2 = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35) ^ (h2 >>> 13);
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
const nhMemo = new WeakMap<SNode, string | null>();
/**
 * Content hash of a shape tree: kind, every number / string, children — everything the
 * evaluator can observe about a shape (bbox, distance, colour, generated code).  Two nodes
 * with the same hash are interchangeable.  Memoised per node (nodes are immutable); null when
 * the tree contains user shader functions, whose captured environment is not hashable here.
 * Used by the solve-block / call memo so shape-valued inputs take part in cache keys.
 */
export function nodeHash(n: SNode): string | null {
  let h = nhMemo.get(n);
  if (h === undefined) { h = nodeHashRaw(n); nhMemo.set(n, h); }
  return h;
}
function nodeHashRaw(n: SNode): string | null {
  const kids = (ks: SNode[]): string | null => { let s = ""; for (const k of ks) { const h = nodeHash(k); if (h === null) return null; s += h; } return s; };
  const one = (k: SNode, head: string): string | null => { const h = nodeHash(k); return h === null ? null : hashStr(head + "|" + h); };
  const two = (a: SNode, b: SNode, head: string): string | null => { const ha = nodeHash(a), hb = nodeHash(b); return ha === null || hb === null ? null : hashStr(head + "|" + ha + "|" + hb); };
  switch (n.k) {
    case "circle": return hashStr("ci" + n.r);
    case "rect": return hashStr("re" + n.w + "," + n.h + "," + n.r);
    case "seg": return hashStr("sg" + n.x1 + "," + n.y1 + "," + (n.z1 ?? 0) + "," + n.x2 + "," + n.y2 + "," + (n.z2 ?? 0) + "," + n.th);
    case "ellipse": return hashStr("el" + n.a + "," + n.b);
    case "nothing": return hashStr("no"); case "everything": return hashStr("ev");
    case "half": return hashStr("ha" + n.nx + "," + n.ny + "," + n.d);
    case "ngon": return hashStr("ng" + n.n + "," + n.r);
    case "poly": return hashStr("po" + n.pts.length + ":" + n.pts.join(","));
    case "text": return hashStr("tx" + n.align + n.size + ":" + n.text);
    case "union": case "inter": case "sunion": case "sinter": case "cuunion": case "cinter": { const s = kids(n.kids); return s === null ? null : hashStr(n.k + ("s" in n ? n.s : "") + "|" + n.kids.length + "|" + s); }
    case "diff": case "sdiff": case "morph": case "cdiff": { const a = nodeHash(n.a), b = nodeHash(n.b); return a === null || b === null ? null : hashStr(n.k + ("s" in n ? n.s : "t" in n ? n.t : "") + "|" + a + "|" + b); }
    case "round": return one(n.s, "ro" + n.r);
    case "stroke": return one(n.s, "st" + n.w);
    case "complement": return one(n.s, "co");
    case "lipschitz": return one(n.s, "li" + n.lip);
    case "colour": return one(n.s, "cl" + n.c.join(","));
    case "opacity": return one(n.s, "op" + n.a);
    case "grad": return one(n.s, "gr" + n.c1.join(",") + ";" + n.c2.join(",") + ";" + n.x0 + "," + n.y0 + "," + n.x1 + "," + n.y1);
    case "shadow": return one(n.s, "sh" + n.dx + "," + n.dy + "," + n.blur + "," + n.a);
    case "xform": return one(n.s, "xf" + n.tx + "," + n.ty + "," + n.rot + "," + n.sc);
    case "stretch": return one(n.s, "sx" + n.sx + "," + n.sy);
    case "reflect": return one(n.s, "rf" + n.nx + "," + n.ny);
    case "repeat": return one(n.s, "rp" + n.kind + n.a + "," + n.b + (n.kind === "xyz" ? "," + (n.c ?? 0) : ""));
    case "swirl": return one(n.s, "sw" + n.strength + "," + n.d);
    case "sphere": return hashStr("sp" + n.r);
    case "box3": return hashStr("b3" + n.hx + "," + n.hy + "," + n.hz + "," + n.r);
    case "half3": return hashStr("h3" + n.nx + "," + n.ny + "," + n.nz + "," + n.d);
    case "cone": return hashStr("cn" + n.r + "," + n.h + ":" + n.m);
    case "capped_cone": return hashStr("cc" + n.hh + "," + n.r1 + "," + n.r2);
    case "gyroid": return hashStr("gy");
    case "extrude": return one(n.s, "ex" + n.h + ":" + n.m);
    case "loft": return two(n.a, n.b, "lf" + n.h);
    case "perex": return two(n.a, n.b, "px");
    case "twist": return one(n.s, "tw" + n.tr);
    case "bend": return one(n.s, "bn" + n.rx + "," + n.ry + "," + n.ox + "," + n.oy);
    case "warp2": return null;
    case "shear2": return one(n.s, "sh2" + n.kx);
    case "taper2": return one(n.s, "tp2" + n.y0 + "," + n.y1 + "," + n.kx0 + "," + n.kx1);
    case "taper3": return one(n.s, "tp3" + n.z0 + "," + n.z1 + "," + n.kx0 + "," + n.ky0 + "," + n.kx1 + "," + n.ky1);
    case "slice2": return one(n.s, "sl2" + n.plane);
    case "xform3": return one(n.s, "xf3" + n.tx + "," + n.ty + "," + n.tz + ":" + n.m.join(","));
    case "stretch3": return one(n.s, "st3" + n.sx + "," + n.sy + "," + n.sz);
    case "reflect3": return one(n.s, "rf3" + n.nx + "," + n.ny + "," + n.nz);
    case "distfield": return one(n.s, "df");
    case "showdist": return one(n.s, "sd");
    case "showgrad": return one(n.s, "sg2" + n.j + "," + n.k2);
    case "repeat_finite": return one(n.s, "rf2" + n.d.join(",") + ":" + n.l.join(","));
    case "colourfn": case "custom": return null;
  }
}

// ---------------------------------------------------------------- hash-consing (round 15)
/** Interning statistics (internbench prints the per-example deltas): table hits vs stored nodes, dead refs swept. */
export const internStats = { hits: 0, stores: 0, swept: 0 };
/**
 * Numeric content hash (two u32 lanes) driving the intern table below.  COVERAGE COUPLING:
 * cHashRaw must mix exactly the fields nodeHashRaw mixes — both make "same hash ⇒
 * interchangeable object" true (the same assumption the solve/call memos make with the string
 * hash).  It exists separately from nodeHash because eager hashing must not allocate WeakMap
 * entries: the hash is stored ON the node at creation (`__ch__` — never enumerated by the
 * evaluator; the tree is immutable from then on), doubles are mixed as their u32 bit-pairs
 * through a shared view, and children contribute their stored lanes.  Per-S() hashing is then
 * O(own fields + child count) with no per-node memo traffic (~50 ns/level; WeakMap-keyed
 * hashing measured 2.4× EVAL slower in internbench's first iteration — the round-15 lesson).
 */
interface CHash { h1: number; h2: number }
type HNode = SNode & { __ch__?: CHash | null; __ik__?: string };
const f64v = new Float64Array(1), u32v = new Uint32Array(f64v.buffer);
const M1 = (h: CHash, x: number) => { h.h1 = Math.imul(h.h1 ^ x | 0, 0x01000193); };
const M2 = (h: CHash, x: number) => { h.h2 = Math.imul(h.h2 ^ x | 0, 0x5bd1e995) ^ (h.h2 >>> 15); };
const mNum = (h: CHash, v: number) => { f64v[0] = v; M1(h, u32v[0]); M2(h, u32v[1]); };
const mTag = (h: CHash, t: number) => M1(h, Math.imul(t, 0x9e3779b1));
const mStr = (h: CHash, s: string) => { M2(h, s.length); for (let i = 0; i < s.length; i++) M1(h, s.charCodeAt(i)); };
function cHash(n: HNode): CHash | null {
  let h = n.__ch__;
  if (h === undefined) { h = cHashRaw(n); n.__ch__ = h; }
  return h;
}
function cHashRaw(n: HNode): CHash | null {
  const h: CHash = { h1: 0x811c9dc5, h2: 0x01000193 };
  const kid = (k: SNode): boolean => { const c = cHash(k); if (c === null) return false; M1(h, c.h1 ^ (c.h2 >>> 3)); M2(h, c.h2 ^ ((c.h1 << 5) | (c.h1 >>> 27))); return true; };
  const kids = (ks: SNode[]): boolean => { M2(h, ks.length); for (const k of ks) if (!kid(k)) return false; return true; };
  switch (n.k) {
    case "circle": mTag(h, 1); mNum(h, n.r); break;
    case "rect": mTag(h, 2); mNum(h, n.w); mNum(h, n.h); mNum(h, n.r); break;
    case "seg": mTag(h, 3); mNum(h, n.x1); mNum(h, n.y1); mNum(h, n.z1 ?? 0); mNum(h, n.x2); mNum(h, n.y2); mNum(h, n.z2 ?? 0); mNum(h, n.th); break;
    case "ellipse": mTag(h, 4); mNum(h, n.a); mNum(h, n.b); break;
    case "nothing": mTag(h, 5); break;
    case "everything": mTag(h, 6); break;
    case "half": mTag(h, 7); mNum(h, n.nx); mNum(h, n.ny); mNum(h, n.d); break;
    case "ngon": mTag(h, 8); mNum(h, n.n); mNum(h, n.r); break;
    case "poly": mTag(h, 9); M2(h, n.pts.length); for (const p of n.pts) mNum(h, p); break;
    case "text": mTag(h, 10); mNum(h, n.size); mStr(h, n.align); mStr(h, n.text); break;
    case "union": mTag(h, 11); if (!kids(n.kids)) return null; break;
    case "inter": mTag(h, 12); if (!kids(n.kids)) return null; break;
    case "sunion": mTag(h, 13); mNum(h, n.s); if (!kids(n.kids)) return null; break;
    case "sinter": mTag(h, 14); mNum(h, n.s); if (!kids(n.kids)) return null; break;
    case "diff": mTag(h, 15); if (!kid(n.a) || !kid(n.b)) return null; break;
    case "sdiff": mTag(h, 16); mNum(h, n.s); if (!kid(n.a) || !kid(n.b)) return null; break;
    case "morph": mTag(h, 17); mNum(h, n.t); if (!kid(n.a) || !kid(n.b)) return null; break;
    case "round": mTag(h, 18); mNum(h, n.r); if (!kid(n.s)) return null; break;
    case "stroke": mTag(h, 19); mNum(h, n.w); if (!kid(n.s)) return null; break;
    case "complement": mTag(h, 20); if (!kid(n.s)) return null; break;
    case "lipschitz": mTag(h, 21); mNum(h, n.lip); if (!kid(n.s)) return null; break;
    case "colour": mTag(h, 22); for (const c of n.c) mNum(h, c); if (!kid(n.s)) return null; break;
    case "opacity": mTag(h, 23); mNum(h, n.a); if (!kid(n.s)) return null; break;
    case "colourfn": case "custom": return null;
    case "grad": mTag(h, 25); for (const c of n.c1) mNum(h, c); for (const c of n.c2) mNum(h, c); mNum(h, n.x0); mNum(h, n.y0); mNum(h, n.x1); mNum(h, n.y1); if (!kid(n.s)) return null; break;
    case "shadow": mTag(h, 26); mNum(h, n.dx); mNum(h, n.dy); mNum(h, n.blur); mNum(h, n.a); if (!kid(n.s)) return null; break;
    case "xform": mTag(h, 27); mNum(h, n.tx); mNum(h, n.ty); mNum(h, n.rot); mNum(h, n.sc); if (!kid(n.s)) return null; break;
    case "stretch": mTag(h, 28); mNum(h, n.sx); mNum(h, n.sy); if (!kid(n.s)) return null; break;
    case "reflect": mTag(h, 29); mNum(h, n.nx); mNum(h, n.ny); if (!kid(n.s)) return null; break;
    case "repeat": mTag(h, 30); mStr(h, n.kind); mNum(h, n.a); mNum(h, n.b); if (n.kind === "xyz") mNum(h, n.c ?? 0); if (!kid(n.s)) return null; break;
    case "swirl": mTag(h, 31); mNum(h, n.strength); mNum(h, n.d); if (!kid(n.s)) return null; break;
    case "sphere": mTag(h, 33); mNum(h, n.r); break;
    case "box3": mTag(h, 34); mNum(h, n.hx); mNum(h, n.hy); mNum(h, n.hz); mNum(h, n.r); break;
    case "half3": mTag(h, 35); mNum(h, n.nx); mNum(h, n.ny); mNum(h, n.nz); mNum(h, n.d); break;
    case "cone": mTag(h, 36); mNum(h, n.r); mNum(h, n.h); mStr(h, n.m); break;
    case "capped_cone": mTag(h, 37); mNum(h, n.hh); mNum(h, n.r1); mNum(h, n.r2); break;
    case "gyroid": mTag(h, 38); break;
    case "extrude": mTag(h, 39); mNum(h, n.h); mStr(h, n.m); if (!kid(n.s)) return null; break;
    case "loft": mTag(h, 40); mNum(h, n.h); if (!kid(n.a) || !kid(n.b)) return null; break;
    case "perex": mTag(h, 41); if (!kid(n.a) || !kid(n.b)) return null; break;
    case "twist": mTag(h, 42); mNum(h, n.tr); if (!kid(n.s)) return null; break;
    case "bend": mTag(h, 43); mNum(h, n.rx); mNum(h, n.ry); mNum(h, n.ox); mNum(h, n.oy); if (!kid(n.s)) return null; break;
    case "warp2": return null;
    case "shear2": mTag(h, 45); mNum(h, n.kx); if (!kid(n.s)) return null; break;
    case "taper2": mTag(h, 46); mNum(h, n.y0); mNum(h, n.y1); mNum(h, n.kx0); mNum(h, n.kx1); if (!kid(n.s)) return null; break;
    case "taper3": mTag(h, 47); mNum(h, n.z0); mNum(h, n.z1); mNum(h, n.kx0); mNum(h, n.ky0); mNum(h, n.kx1); mNum(h, n.ky1); if (!kid(n.s)) return null; break;
    case "slice2": mTag(h, 48); M2(h, n.plane); if (!kid(n.s)) return null; break;
    case "xform3": mTag(h, 49); mNum(h, n.tx); mNum(h, n.ty); mNum(h, n.tz); for (const m of n.m) mNum(h, m); if (!kid(n.s)) return null; break;
    case "stretch3": mTag(h, 50); mNum(h, n.sx); mNum(h, n.sy); mNum(h, n.sz); if (!kid(n.s)) return null; break;
    case "reflect3": mTag(h, 51); mNum(h, n.nx); mNum(h, n.ny); mNum(h, n.nz); if (!kid(n.s)) return null; break;
    case "distfield": mTag(h, 52); if (!kid(n.s)) return null; break;
    case "showdist": mTag(h, 53); if (!kid(n.s)) return null; break;
    case "showgrad": mTag(h, 54); mNum(h, n.j); mNum(h, n.k2); if (!kid(n.s)) return null; break;
    case "repeat_finite": mTag(h, 55); mNum(h, n.d[0]); mNum(h, n.d[1]); mNum(h, n.d[2] ?? 0); mNum(h, n.l[0]); mNum(h, n.l[1]); mNum(h, n.l[2] ?? 1); if (!kid(n.s)) return null; break;
    case "cuunion": mTag(h, 56); mNum(h, n.s); if (!kids(n.kids)) return null; break;
    case "cinter": mTag(h, 57); mNum(h, n.s); if (!kids(n.kids)) return null; break;
    case "cdiff": mTag(h, 58); mNum(h, n.s); if (!kid(n.a) || !kid(n.b)) return null; break;
  }
  // final avalanche (same finalizer as hashStr's lanes) so table keys are well spread
  h.h1 = Math.imul(h.h1 ^ (h.h1 >>> 16), 0x85ebca6b) ^ (h.h1 >>> 13);
  h.h2 = Math.imul(h.h2 ^ (h.h2 >>> 16), 0xc2b2ae35) ^ (h.h2 >>> 13);
  if (h.h1 === 0 && h.h2 === 0) h.h1 = 1; // (0,0) is reserved for "unhashable"
  return h;
}
const internTable = new Map<string, WeakRef<SNode>[]>();
const INTERN_SWEEP_EVERY = 4096, INTERN_MAX_BUCKETS = 32768;
let internSinceSweep = 0;
// OFF BY DEFAULT (round-15 study, scripts/internbench.ts): at S()-level the per-call hashing
// machinery (CHash objects, closures, WeakRefs, GC churn) costs ~2.4× EVAL across the corpus while
// saving strictly less in the per-frame key/param walks it amortises (every one of 19 measured
// examples nets negative — the hasher pays per node per frame, the walks it replaces were already
// mostly amortised by the existing WeakMap memos).  Kept, flag-gated, for a future cheaper hasher
// or a genuinely identity-starved workload; re-run internbench before enabling anywhere.
let internOn = false;
let internTableOn = false; // probe: "hash" mode computes cHash + ikey but never touches the table
export function setInterning(on: boolean | "hash") { internOn = on !== false; internTableOn = on === true; }
function internSweep() {
  let removed = 0;
  for (const [h, bucket] of internTable) {
    let w = 0;
    for (let i = 0; i < bucket.length; i++) { const m = bucket[i].deref(); if (m) bucket[w++] = bucket[i]; }
    removed += bucket.length - w;
    bucket.length = w;
    if (w === 0) internTable.delete(h);
  }
  internSinceSweep = 0;
  internStats.swept += removed;
  if (internTable.size > INTERN_MAX_BUCKETS) internTable.clear(); // safety cap; hits rebuild
}
/**
 * Hash-consing: structurally identical nodes (see the coverage note on cHash above) become ONE
 * object.  Nodes are immutable, so sharing is semantics-preserving; it turns every identity-keyed
 * memo (bboxOf, weight, structKey, walkParams segments, nodeHash itself) into a cross-frame hit
 * whenever a subtree reappears — including for programs the call memo skips (time-dependent or
 * impure bodies), whose static subtrees now survive as identical objects even though the frame
 * re-allocates fresh candidates that are then discarded.
 */
export function inode(n: SNode): SNode {
  if (!internOn) return n;
  const hn = n as HNode;
  let key = hn.__ik__;
  if (key === undefined) {
    const h = cHash(hn);
    if (h === null) { hn.__ik__ = ""; return n; }
    key = (h.h1 >>> 0).toString(36) + "." + (h.h2 >>> 0).toString(36);
    hn.__ik__ = key;
  }
  if (key === "") return n;
  if (!internTableOn) return n;
  const bucket = internTable.get(key);
  if (bucket) for (const r of bucket) { const m = r.deref(); if (m !== undefined) { internStats.hits++; return m; } }
  if (++internSinceSweep >= INTERN_SWEEP_EVERY) internSweep();
  let b = bucket;
  if (!b) { b = []; internTable.set(key, b); }
  b.push(new WeakRef(n));
  internStats.stores++;
  return n;
}
/** Test hook: drop all interned identities (value-transparent; only memo hit rates change). Counters are NOT reset (internbench measures deltas). */
export function resetInterning() { internTable.clear(); internSinceSweep = 0; }

/**
 * A string that identifies the *shape* of the generated code: node kinds, tree layout and the
 * few numbers that codegen branches on (text content, polygon size, unit scale, bbox
 * culling).  Two trees with the same key compile to identical shader text and push their
 * parameters in the same order, so the second one can reuse the first one's pipeline and
 * only refill the parameter buffer (see `collectParams`).  Returns null when the tree contains
 * user shader functions (`make_shape`, `colour f`), whose code depends on captured values.
 *
 * Memoised per subtree and cull flag (nodes are immutable), so subtrees shared inside one
 * frame (`shadow` visits its child twice, a shape used in several places) and subtrees that
 * survive across frames through the call memo are keyed once.
 */
// Memo slot per (cull, flags): the cull threshold changes cullable() and thus the key content,
// and the flag fingerprint separates the slots so `codeLru` never mixes variants (round 15: the
// key itself is now two avalanche-mixed u32 lanes, materialised as ONE short string per tree;
// the pre-round-15 string-concatenating version spent its time building one string per NODE —
// measured as the dominant residual on viewport-dirty frames, e.g. 1.86 ms/frame on wrapfit).
// Coverage invariant: the lanes must mix exactly the things codegen branches on (node kinds,
// tree layout and child ORDER, repeat mode, text align, polygon arity, unit-scale xform, and
// per-child cull-bracket state).  A lane collision would swap compiled code; 64 bits, and the
// branch list below is exhaustive over SNode — keep it that way when adding node kinds.
const skSlots = new Map<string, { a: WeakMap<SNode, number>; b: WeakMap<SNode, number> }>();
function skSlot(cull: boolean) {
  const fk = flagsKey() + (cull ? "/1" : "/0");
  let m = skSlots.get(fk);
  if (!m) { m = { a: new WeakMap(), b: new WeakMap() }; skSlots.set(fk, m); }
  return m;
}
let skOut2 = 0; // lane-2 out-param of skNum (read immediately after each call)
const SK_TAGS: Record<SNode["k"], number> = {
  circle: 1, rect: 2, seg: 3, ellipse: 4, nothing: 5, everything: 6, half: 7, ngon: 8, poly: 9,
  text: 10, union: 11, inter: 12, sunion: 13, sinter: 14, diff: 15, sdiff: 16, morph: 17, round: 18,
  stroke: 19, complement: 20, lipschitz: 21, colour: 22, opacity: 23, colourfn: 24, grad: 25, shadow: 26,
  xform: 27, stretch: 28, reflect: 29, repeat: 30, swirl: 31, custom: 32,
  sphere: 33, box3: 34, half3: 35, cone: 36, capped_cone: 37, gyroid: 38, extrude: 39, loft: 40,
  perex: 41, twist: 42, bend: 43, warp2: 44, shear2: 45, taper2: 46, taper3: 47, slice2: 48,
  xform3: 49, stretch3: 50, reflect3: 51, distfield: 52, showdist: 53, showgrad: 54, repeat_finite: 55,
  cuunion: 56, cinter: 57, cdiff: 58,
};
const MK_CULLED = 0x16d3, MK_UNCULLED = 0x2a41, MK_PLAIN = 0x519b, MK_WRAP = 0x72a9; // how the parent consumes a child (mirrors the old " [ ( " brackets)
/** Numeric structural key for one node; returns the stored lane-1 (0 ⇔ unhashable with skOut2==0).  A
 *  legitimate h1==0 is mapped to -0x80000000 UNIFORMLY before memoing, so memo-hits and misses
 *  return identical lanes (parents must see one representation — verified by paramcheck). */
function skNum(n: SNode, atlas: Atlas, cull: boolean): number {
  const m = skSlot(cull);
  const ma = m.a.get(n);
  if (ma !== undefined) { skOut2 = m.b.get(n)!; return ma; }
  const h1 = skRaw(n, atlas, cull);
  const h2 = skOut2;
  const unhashable = h1 === 0 && h2 === 0;
  const stored = unhashable ? 0 : h1 === 0 ? -0x80000000 : h1;
  m.a.set(n, stored); m.b.set(n, unhashable ? 0 : h2);
  return unhashable ? 0 : stored;
}
// Mix markers and child lanes with inline arithmetic — no per-node closures/allocations: this walk
// runs on every fresh node of every dirty frame (the round-15 profiling showed closure churn here
// eats the win on medium trees).
function skRaw(n: SNode, atlas: Atlas, cull: boolean): number {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  // inlined: child lanes a1/a2 consumed as marker, rot(a1), rot(a2) with order-sensitive positions
  let a1 = 0, a2 = 0;
  h1 = Math.imul(h1 ^ SK_TAGS[n.k] | 0, 0x01000193);
  switch (n.k) {
    case "circle": case "rect": case "seg": case "ellipse": case "nothing": case "everything": case "half": case "ngon": break;
    case "poly": h2 = Math.imul(h2 ^ n.pts.length | 0, 0x5bd1e995) ^ (h2 >>> 15); break;
    case "text": h1 = Math.imul(h1 ^ (n.align === "left" ? 2 : 1), 0x01000193); break; // content & length are params
    case "union": case "inter":
      for (const k of n.kids) {
        a1 = skNum(k, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        // kidC: culled/uncullled marker by cullable()
        const m1 = cullable(k, atlas, cull) ? MK_CULLED : MK_UNCULLED;
        h1 = Math.imul(h1 ^ m1, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ m1, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
      }
      break;
    case "sunion": case "sinter":
      for (const k of n.kids) {
        a1 = skNum(k, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
      }
      break;
    case "diff":
      { const m1 = cullable(n.a, atlas, cull) ? MK_CULLED : MK_UNCULLED;
        a1 = skNum(n.a, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ m1, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ m1, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
        const m2 = cullable(n.b, atlas, cull) ? MK_CULLED : MK_UNCULLED;
        a1 = skNum(n.b, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ m2, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ m2, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "sdiff": case "morph":
      { a1 = skNum(n.a, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
        a1 = skNum(n.b, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "repeat":
      { // The generated code omits the modulo on the lanes whose spacing is 0 (mod(x, 0) is NaN),
        // so that mask is part of the *structure* the shader cache keys on — two repeat nodes
        // with the same kind but different zero lanes must not share a shader.
        const lanes = n.kind === "x" ? [1, 0, 0] : n.kind === "y" ? [0, 1, 0] : n.kind === "xy" ? [1, 1, 0] : n.kind === "xyz" ? [1, 1, 1] : [0, 0, 0];
        const sp = [n.a, n.b, n.c ?? n.a];
        let zm = 0;
        for (let i = 0; i < 3; i++) if (lanes[i] && sp[i] === 0) zm |= 1 << i;
        h1 = Math.imul(h1 ^ (400 + REPEAT_TAGS[n.kind] + 16 * zm), 0x01000193);
        a1 = skNum(n.s, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "round": case "stroke": case "complement": case "lipschitz": case "stretch": case "swirl":
      { const nn = n as { s: SNode };
        a1 = skNum(nn.s, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "shadow":
      { const nn = n as { s: SNode };
        a1 = skNum(nn.s, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
        a1 = skNum(nn.s, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_WRAP, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_WRAP, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "xform":
      { h1 = Math.imul(h1 ^ (n.sc === 1 ? 1 : 2), 0x01000193);
        a1 = skNum(n.s, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_WRAP, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_WRAP, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "colour": case "opacity": case "grad": case "reflect":
      { const nn = n as { s: SNode };
        a1 = skNum(nn.s, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_WRAP, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_WRAP, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "sphere": case "box3": case "half3": case "capped_cone": case "gyroid": break;
    case "cone": { h1 = Math.imul(h1 ^ (n.m === "exact" ? 3 : 4), 0x01000193); break; }
    case "cuunion": case "cinter":
      for (const k of n.kids) {
        a1 = skNum(k, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        const m1 = cullable(k, atlas, cull) ? MK_CULLED : MK_UNCULLED;
        h1 = Math.imul(h1 ^ m1, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ m1, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
      }
      break;
    case "cdiff":
      { a1 = skNum(n.a, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
        a1 = skNum(n.b, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "extrude":
      { h1 = Math.imul(h1 ^ (n.m === "exact" ? 3 : 4), 0x01000193);
        a1 = skNum(n.s, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "loft": case "perex":
      { a1 = skNum(n.a, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15);
        a1 = skNum(n.b, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "twist": case "bend": case "shear2": case "taper2": case "taper3": case "repeat_finite":
      { const nn = n as { s: SNode };
        a1 = skNum(nn.s, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "stretch3":
      { const nn = n as { s: SNode };
        a1 = skNum(nn.s, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "slice2":
      { h1 = Math.imul(h1 ^ (n.plane + 1), 0x01000193);
        a1 = skNum(n.s, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_WRAP, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_WRAP, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "xform3":
      { a1 = skNum(n.s, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_WRAP, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_WRAP, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "reflect3": case "distfield":
      { const nn = n as { s: SNode };
        a1 = skNum(nn.s, atlas, cull); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
        h1 = Math.imul(h1 ^ MK_WRAP, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
        h2 = Math.imul(h2 ^ MK_WRAP, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); break; }
    case "showdist": case "showgrad":
      { const ss = (n as { s: SNode }).s;
        const u3 = flags3Of(ss).is3d ? 1 : 0; // the C++ union branch adds a 6th child access
        h1 = Math.imul(h1 ^ (MK_PLAIN + u3) | 0, 0x01000193);
        for (let i = 0; i < 5 + u3; i++) {
          a1 = skNum(ss, atlas, false); a2 = skOut2; if (a1 === 0 && a2 === 0) return skFail();
          h1 = Math.imul(h1 ^ MK_PLAIN, 0x01000193); h1 = Math.imul(h1 ^ (a1 ^ (a2 >>> 3)), 0x01000193);
          h2 = Math.imul(h2 ^ MK_PLAIN, 0x5bd1e995) ^ (h2 >>> 15); h2 = Math.imul(h2 ^ (a2 ^ ((a1 << 5) | (a1 >>> 27))), 0x5bd1e995) ^ (h2 >>> 15); } break; }
    case "warp2": return skFail();
    case "colourfn": case "custom": return skFail();
  }
  {
    const a = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b) ^ (h1 >>> 13);
    const b = Math.imul(h2 ^ (h2 >>> 16), 0xc2b2ae35) ^ (h2 >>> 13);
    if (a === 0 && b === 0) return skFail();
    skOut2 = b;
    return a;
  }
}
const REPEAT_TAGS: Record<string, number> = { x: 1, y: 2, xy: 3, radial: 4, mirror_x: 5, mirror_y: 6, mirror_xy: 7, xyz: 8 };
function skFail(): number { skOut2 = 0; return 0; }
export function structKey(n: SNode, atlas: Atlas, cull = true): string | null {
  const h1 = skNum(n, atlas, cull);
  if (h1 === 0 && skOut2 === 0) return null;
  // The view mode travels in the key: `cull` is `mode === "slice"`, and the two modes do not compile
  // to the same code (slice unions blend with coverage AA and carry cull brackets; solid unions take
  // the exact min and the raymarcher owns early-out).  The trees that expose this are the ones with
  // no cullable child — there `cullable()` is false either way, so the lanes came out equal and the
  // code LRU (and the `prev` fast path) happily served a 2D shader to the 3D view and back.
  return flagsKey() + (cull ? "|1|" : "|0|") + (h1 >>> 0).toString(36) + "." + (skOut2 >>> 0).toString(36);
}

// ---------------------------------------------------------------- codegen
// ROUND 17 (3D): the point `p` threaded through genShape is now a VEC3.  The 2D view renders
// the exact z = 0 slice of every shape (the original Curv's slice_xy semantics), so 2D results
// are bit-identical to before; the 3D view raymarches the same compiled distance field with a
// real z.  `mode` selects union/AA behaviour: "slice" = 2D view (coverage AA + bbox culling),
// "solid" = 3D view (exact-min union, no culling — the raymarcher owns early-out).
export type ViewMode = "slice" | "solid";
export interface GenCtx { atlas: Atlas; zoom: E; time: E; cull: boolean; defaultColour: RGBA; mode: ViewMode; aa: E }
export interface DC { d: E; c: E }

const V = (g: Gen, ...xs: number[]) => g.vec(xs.map((x) => g.param(x)));
/** 3-component vector (z defaults to 0) — for expressions combined with the v3 point. */
const V3 = (g: Gen, x: number, y: number, z = 0): E => g.vec([g.param(x), g.param(y), g.param(z)]);
// 2-component params + constant z=0 (keeps the param buffer in lockstep with walkSeg)
const V2z = (g: Gen, x: number, y: number): E => g.vec([g.param(x), g.param(y), g.num(0)]);
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
/**
 * Push a block of per-item parameters and return the (parameterised) index of its first element.
 * The offset itself lives in the buffer, so a variable-length block earlier in the tree (a text
 * label whose length changed) never bakes a different literal into the shader text.
 */
function dynBase(g: Gen, values: number[]): E { return g.dynBlock(values); }
/** rounded 2D box SDF (p is v3, z ignored) */
function sdBox(g: Gen, p: E, hx: E, hy: E, r: E): E {
  const q = g.let(g.bin("+", g.bin("-", g.fn("abs", [g.swz(p, [0, 1])]), g.vec([hx, hy])), r));
  const qx = g.idx(q, 0), qy = g.idx(q, 1);
  return g.bin("-", g.bin("+", g.fn("length", [g.fn("max", [q, g.num(0)])]), g.fn("min", [g.fn("max", [qx, qy]), g.num(0)])), r);
}
/** C++ chamfer_min: min[a,b] - 0.5 * max[r - |a - b|, 0]  (chamfer_max = -chamfer_min(-a,-b,r)) */
function chamferMin(g: Gen, a: E, b: E, r: E): E {
  return g.bin("-", g.fn("min", [a, b]), g.bin("*", g.fn("max", [g.bin("-", r, g.fn("abs", [g.bin("-", a, b)])), g.num(0)]), g.num(0.5)));
}
/** solid-mode union: exact min distance, C++ colour rule (the shape with the smaller d wins;
 *  ties / the interior of the second go to the second) — no coverage blending (the raymarcher
 *  does no per-pixel AA). */
function overSolid(g: Gen, a: DC, b: DC): DC {
  const d = g.let(g.fn("min", [a.d, b.d]));
  // C++ rule: `if (d2 <= 0 || d2 <= d1) s2.colour else s1.colour`
  const c = g.let(g.sel(g.logic("||", g.cmp("<=", b.d, g.num(0)), g.cmp("<=", b.d, a.d)), b.c, a.c));
  return { d, c };
}

export function genShape(g: Gen, n: SNode, p: E, ctx: GenCtx): DC {
  const white: DC["c"] = g.vec(ctx.defaultColour.map((x) => g.num(x)));
  const prim = (d: E): DC => ({ d: g.let(d), c: white });
  const px = () => g.idx(p, 0), py = () => g.idx(p, 1);
  const kid = (s: SNode, q: E = p, c: Partial<GenCtx> = {}) => genShape(g, s, q, { ...ctx, ...c });
  const kidCulled = (s: SNode, q: E): DC => {
    // in a coverage-only context, skip subtrees whose bbox the pixel is far outside
    if (!cullable(s, ctx.atlas, ctx.cull)) return kid(s, q);
    const bb = finiteBBox(bboxOf(s, ctx.atlas))!;
    const cx = g.param((bb[0] + bb[2]) / 2), cy = g.param((bb[1] + bb[3]) / 2), hx = g.param((bb[2] - bb[0]) / 2), hy = g.param((bb[3] - bb[1]) / 2);
    const bd = g.let(sdBox(g, g.bin("-", q, g.vec([cx, cy, g.num(0)])), hx, hy, g.num(0)));
    const pad = ctx.aa;
    if (SHADER_FLAGS.cullSelect || branchless()) {
      // branchless: the child is evaluated for every pixel and discarded by a select — the
      // opposite of what culling is for, which is exactly why it is not the default
      const r = kid(s, q);
      const inside = g.cmp("<", bd, pad);
      return { d: g.let(g.sel(inside, r.d, g.bin("+", bd, pad))), c: g.let(g.sel(inside, r.c, g.vec([g.num(0), g.num(0), g.num(0), g.num(0)]))) };
    }
    const dv = g.var(g.bin("+", bd, pad)); const cv = g.var(g.vec([g.num(0), g.num(0), g.num(0), g.num(0)]));
    g.if(g.cmp("<", bd, pad), () => { const r = kid(s, q); g.assign(dv, r.d); g.assign(cv, r.c); });
    return { d: dv, c: cv };
  };
  const pz = () => g.idx(p, 2);
  switch (n.k) {
    case "circle": return prim(g.bin("-", g.fn("length", [p]), g.param(n.r)));
    case "rect": return prim(sdBox(g, p, g.param(n.w / 2), g.param(n.h / 2), g.param(Math.min(n.r, n.w / 2, n.h / 2))));
    case "seg": {
      const a = V3(g, n.x1, n.y1, n.z1 ?? 0), b = V3(g, n.x2, n.y2, n.z2 ?? 0);
      const pa = g.let(g.bin("-", p, a)), ba = g.let(g.bin("-", b, a));
      const h = g.let(g.fn("clamp", [g.bin("/", g.fn("dot", [pa, ba]), g.fn("max", [g.fn("dot", [ba, ba]), g.num(1e-6)])), g.num(0), g.num(1)]));
      return prim(g.bin("-", g.fn("length", [g.bin("-", pa, g.bin("*", ba, h))]), g.param(n.th / 2)));
    }
    case "ellipse": {
      const ab = g.let(V(g, n.a / 2, n.b / 2));
      const pw = g.swz(p, [0, 1]);
      const k0 = g.let(g.fn("length", [g.bin("/", pw, ab)])), k1 = g.let(g.fn("length", [g.bin("/", pw, g.bin("*", ab, ab))]));
      return prim(g.bin("/", g.bin("*", k0, g.bin("-", k0, g.num(1))), g.fn("max", [k1, g.num(1e-6)])));
    }
    case "nothing": return prim(g.num(1e30));
    case "everything": return prim(g.num(-1e30));
    case "half": return prim(g.bin("-", g.fn("dot", [g.swz(p, [0, 1]), g.fn("normalize", [V(g, n.nx, n.ny)])]), g.param(n.d)));
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
      const baseE = dynBase(g, n.pts);
      const at = (i: E, off: number) => g.paramAt(g.bin("+", g.bin("+", baseE, g.bin("*", i, g.num(2))), g.num(off)));
      const v0 = g.vec([g.paramAt(baseE), g.paramAt(g.bin("+", baseE, g.num(1))), g.num(0)]);
      const dv = g.var(g.fn("dot", [g.bin("-", p, v0), g.bin("-", p, v0)])); const sv = g.var(g.num(1));
      g.loop(g.num(N), (i) => {
        const j = SHADER_FLAGS.polySelect ? g.let(g.sel(g.cmp("<", i, g.num(1)), g.num(N - 1), g.bin("-", i, g.num(1)))) : g.let(g.bin("%", g.bin("+", i, g.num(N - 1)), g.num(N)));
        const vi = g.let(g.vec([at(i, 0), at(i, 1), g.num(0)])), vj = g.let(g.vec([at(j, 0), at(j, 1), g.num(0)]));
        const e = g.let(g.bin("-", vj, vi)), w = g.let(g.bin("-", p, vi));
        const b = g.let(g.bin("-", w, g.bin("*", e, g.fn("clamp", [g.bin("/", g.fn("dot", [w, e]), g.fn("max", [g.fn("dot", [e, e]), g.num(1e-9)])), g.num(0), g.num(1)]))));
        g.assign(dv, g.fn("min", [dv, g.fn("dot", [b, b])]));
        const c1 = g.cmp(">=", py(), g.idx(vi, 1)), c2 = g.cmp("<", py(), g.idx(vj, 1)), c3 = g.cmp(">", g.bin("-", g.bin("*", g.idx(e, 0), g.idx(w, 1)), g.bin("*", g.idx(e, 1), g.idx(w, 0))), g.num(0));
        const all = g.logic("&&", g.logic("&&", c1, c2), c3), none = g.logic("&&", g.logic("&&", g.not(c1), g.not(c2)), g.not(c3));
        if (SHADER_FLAGS.polySelect || branchless()) g.assign(sv, g.bin("*", sv, g.sel(g.logic("||", all, none), g.num(-1), g.num(1))));
        else g.if(g.logic("||", all, none), () => g.assign(sv, g.neg(sv)));
      });
      return prim(g.bin("*", sv, g.fn("sqrt", [dv])));
    }
    case "text": {
      // One shader loop over the glyphs.  Glyph count, cell origins and atlas UVs are all
      // parameters (5 per glyph, after a dynamic base offset), so the generated code does not
      // depend on the label's content or length: animated / solved labels never recompile.
      const m = textMetrics(n, ctx.atlas);
      const glyphs = textGlyphs(n, ctx.atlas, m);
      const sE = g.param(m.s), qyE = g.param(m.baseY - (CELL - BASELINE) * m.s), qsE = g.let(g.fn("max", [g.param(CELL * m.s), g.num(1e-6)]));
      const nE = g.param(glyphs.length), baseE = dynBase(g, glyphs.flat());
      const pad = ctx.aa;
      const half = g.let(g.bin("*", qsE, g.num(0.5)));
      const dv = g.var(g.num(1e30));
      // the window is a *shortcut*: it skips glyphs by picking a different loop, which is a branch.
      // Branchless mode walks every glyph (the window's own argument — cells outside it are farther
      // than the ones inside, so the min() is the same) and pays for it in texture traffic.
      if (SHADER_FLAGS.textWindow && !branchless() && glyphs.length > 6) {
        // Long label: binary-search the first cell whose x0 is right of px.v (cells are sorted along
        // the row), then apply the same per-glyph body to a 6-glyph window around the hit.  Cell box
        // distances rise monotonically away from the hit and within-pad cells are always in the
        // window, so the min() is unchanged; reads the same parameters, no extra ones.
        const lo = g.var(g.num(0)), hi = g.var(g.fn("max", [nE, g.num(1)]));
        for (let step = 0; step < 6; step++) { // 6 steps cover N ≤ 64
          const mid = g.let(g.fn("floor", [g.bin("*", g.bin("+", lo, hi), g.num(0.5))]));
          const xm = g.let(g.paramAt(g.bin("+", baseE, g.bin("*", mid, g.num(5)))));
          const k = g.cmp("<", g.idx(p, 0), xm);
          g.assign(lo, g.sel(k, lo, g.bin("+", mid, g.num(1))));
          g.assign(hi, g.sel(k, mid, hi));
        }
        const idxAt = (i: E) => {
          const at = (off: number) => g.paramAt(g.bin("+", g.bin("+", baseE, g.bin("*", i, g.num(5))), g.num(off)));
          const lp = g.let(g.bin("-", p, g.vec([at(0), qyE, g.num(0)])));
          const bd = g.let(sdBox(g, g.bin("-", lp, half), half, half, g.num(0)));
          g.if(g.cmp("<", bd, pad), () => {
            // clamp the 2-slice: lp is a vec3 (the point is 3D now), and mix(v2, v2, v3) would
            // broadcast the third lane into every component (NaN glyphs on the JS backend)
            const q = g.fn("clamp", [g.bin("/", g.swz(lp, [0, 1]), qsE), g.num(0), g.num(1)]);
            const uv = g.fn("mix", [g.vec([at(1), at(2)]), g.vec([at(3), at(4)]), q]);
            const dg = g.bin("*", g.bin("*", g.bin("-", g.num(0.5), g.tex(uv)), g.num(2 * 8)), sE);
            g.assign(dv, g.fn("min", [dv, g.fn("max", [dg, bd])]));
          }, () => g.assign(dv, g.fn("min", [dv, g.bin("+", bd, pad)])));
        };
        const W = 2; // window [lo-1-W+1 .. lo+W], clamped — 2W+2 glyphs
        // … except when the AA pad is bigger than half a cell (deep zoom-out): cells outside the
        // window can then be within pad, so every glyph must be considered (baseline loop)
        g.if(g.cmp("<=", pad, g.bin("*", qsE, g.num(0.5))), () => {
          g.loop(g.num(2 * W + 2), (j) => idxAt(g.let(g.fn("max", [g.num(0), g.fn("min", [g.bin("-", nE, g.num(1)), g.bin("-", g.bin("+", lo, j), g.num(W + 1))])]))));
        }, () => { g.loop(nE, (i) => idxAt(i)); });
        return { d: dv, c: white };
      }
      g.loop(nE, (i) => {
        const at = (off: number) => g.paramAt(g.bin("+", g.bin("+", baseE, g.bin("*", i, g.num(5))), g.num(off)));
        const lp = g.let(g.bin("-", p, g.vec([at(0), qyE, g.num(0)])));
        const bd = g.let(sdBox(g, g.bin("-", lp, half), half, half, g.num(0)));
        if (SHADER_FLAGS.textBranchless || branchless()) {
          // branchless: always sample, select the result — no divergence, more texture traffic
          // clamp the 2-slice: lp is a vec3 (the point is 3D now), and mix(v2, v2, v3) would
            // broadcast the third lane into every component (NaN glyphs on the JS backend)
            const q = g.fn("clamp", [g.bin("/", g.swz(lp, [0, 1]), qsE), g.num(0), g.num(1)]);
          const uv = g.fn("mix", [g.vec([at(1), at(2)]), g.vec([at(3), at(4)]), q]);
          const dg = g.bin("*", g.bin("*", g.bin("-", g.num(0.5), g.tex(uv)), g.num(2 * 8)), sE);
          g.assign(dv, g.fn("min", [dv, g.sel(g.cmp("<", bd, pad), g.fn("max", [dg, bd]), g.bin("+", bd, pad))]));
        } else {
          g.if(g.cmp("<", bd, pad), () => {
            // clamp the 2-slice: lp is a vec3 (the point is 3D now), and mix(v2, v2, v3) would
            // broadcast the third lane into every component (NaN glyphs on the JS backend)
            const q = g.fn("clamp", [g.bin("/", g.swz(lp, [0, 1]), qsE), g.num(0), g.num(1)]);
            const uv = g.fn("mix", [g.vec([at(1), at(2)]), g.vec([at(3), at(4)]), q]);
            const dg = g.bin("*", g.bin("*", g.bin("-", g.num(0.5), g.tex(uv)), g.num(2 * 8)), sE);
            g.assign(dv, g.fn("min", [dv, g.fn("max", [dg, bd])]));
          }, () => g.assign(dv, g.fn("min", [dv, g.bin("+", bd, pad)])));
        }
      });
      return { d: dv, c: white };
    }
    case "union": {
      if (n.kids.length === 0) return prim(g.num(1e30));
      let acc = kidCulled(n.kids[0], p);
      for (let i = 1; i < n.kids.length; i++) acc = ctx.mode === "solid" ? overSolid(g, acc, kidCulled(n.kids[i], p)) : over(g, acc, kidCulled(n.kids[i], p), ctx.zoom);
      return acc;
    }
    case "inter": {
      if (n.kids.length === 0) return prim(g.num(-1e30));
      let acc = kidCulled(n.kids[0], p);
      for (let i = 1; i < n.kids.length; i++) {
        const b = kidCulled(n.kids[i], p);
        const d = g.let(g.fn("max", [acc.d, b.d]));
        // C++ rule: intersection takes the first child's colour (incl. diff = inter(s1, comp s2))
        acc = ctx.mode === "solid" ? { d, c: acc.c } : { d, c: g.let(g.sel(g.cmp(">", b.d, acc.d), b.c, acc.c)) };
      }
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
      const p4 = g.let(g.vec([p, ctx.time]));
      let c = n.f.compile(g, p4, ctx);
      if (c.t === "f") c = g.vec([c, c, c]);
      if (c.t !== "v3" && c.t !== "v4") throw new GenError(`colour function must return an RGB triple`);
      return { d: a.d, c: g.let(c.t === "v3" ? g.vec([c, g.idx(a.c, 3)]) : c) };
    }
    case "grad": {
      const a = kid(n.s, p);
      const p0 = V(g, n.x0, n.y0), dv = g.let(g.bin("-", V(g, n.x1, n.y1), p0));
      const t = g.let(g.fn("clamp", [g.bin("/", g.fn("dot", [g.bin("-", g.swz(p, [0, 1]), p0), dv]), g.fn("max", [g.fn("dot", [dv, dv]), g.num(1e-6)])), g.num(0), g.num(1)]));
      return { d: a.d, c: g.let(g.vec([g.fn("mix", [V(g, n.c1[0], n.c1[1], n.c1[2]), V(g, n.c2[0], n.c2[1], n.c2[2]), t]), g.param(n.c1[3])])) };
    }
    case "shadow": {
      const sh = kid(n.s, g.let(g.bin("-", p, V2z(g, n.dx, n.dy))), { cull: false });
      const bl = g.param(Math.max(0.5, n.blur));
      const s = g.let(g.bin("-", g.num(1), g.fn("smoothstep", [g.neg(bl), bl, sh.d])));
      const shadow: DC = { d: g.let(g.bin("-", g.bin("-", sh.d, bl), g.bin("/", ctx.aa, g.num(3)))), c: g.let(g.vec([g.num(0), g.num(0), g.num(0), g.bin("*", g.param(n.a), s)])) };
      const top = kid(n.s, p);
      return ctx.mode === "solid" ? overSolid(g, shadow, top) : over(g, shadow, top, ctx.zoom);
    }
    case "xform": {
      const q0 = g.let(g.bin("-", p, V2z(g, n.tx, n.ty)));
      const cs = g.param(Math.cos(n.rot)), sn = g.param(Math.sin(n.rot)), sc = g.param(n.sc || 1);
      const qx = g.bin("+", g.bin("*", cs, g.idx(q0, 0)), g.bin("*", sn, g.idx(q0, 1)));
      const qy = g.bin("-", g.bin("*", cs, g.idx(q0, 1)), g.bin("*", sn, g.idx(q0, 0)));
      const q = g.let(g.bin("/", g.vec([qx, qy, g.idx(q0, 2)]), sc));
      const inner = genShape(g, n.s, q, { ...ctx, zoom: n.sc === 1 ? ctx.zoom : g.let(g.bin("*", ctx.zoom, sc)) });
      return { d: g.let(g.bin("*", inner.d, sc)), c: inner.c };
    }
    case "stretch": {
      const m = Math.min(Math.abs(n.sx), Math.abs(n.sy)) || 1;
      // per-component divide: z passes through (a 3D vec with z=0 would divide by zero)
      const q = g.let(g.vec([g.bin("/", g.idx(p, 0), g.param(n.sx)), g.bin("/", g.idx(p, 1), g.param(n.sy)), g.idx(p, 2)]));
      const a = kid(n.s, q, { cull: false, zoom: g.let(g.bin("*", ctx.zoom, g.param(m))) });
      return { d: g.let(g.bin("*", a.d, g.param(m))), c: a.c };
    }
    case "reflect": {
      const nn = g.let(g.fn("normalize", [V2z(g, n.nx, n.ny)]));
      const q = g.let(g.bin("-", p, g.bin("*", g.bin("*", g.num(2), g.fn("dot", [p, nn])), nn)));
      return kid(n.s, q);
    }
    case "repeat": {
      const a = g.param(n.a), b = g.param(n.b);
      // C++ repeats one axis at a time (repeat_xy / repeat_xyz are per-component modulos).
      // A shared vec3 spacing would take mod(z, 0) on the lanes that are not being repeated,
      // and one NaN lane poisons length()/min() for the whole pixel.
      const lane = (pi: E, d: E, sp: number): E => {
        if (sp === 0) return pi; // spacing 0 = that axis is not repeated (C++ would divide by 0)
        const h = g.let(g.bin("*", d, g.num(0.5)));
        return g.bin("-", g.bin("%", g.bin("+", pi, h), d), h);
      };
      let q: E;
      switch (n.kind) {
        case "x": q = g.vec([lane(px(), a, n.a), py(), pz()]); break;
        case "y": q = g.vec([px(), lane(py(), b, n.b), pz()]); break;
        case "xy": q = g.vec([lane(px(), a, n.a), lane(py(), b, n.b), pz()]); break;
        case "xyz": { const c = g.param(n.c ?? n.a); q = g.vec([lane(px(), a, n.a), lane(py(), b, n.b), lane(pz(), c, n.c ?? n.a)]); break; }
        case "mirror_x": q = g.vec([g.fn("abs", [px()]), py(), pz()]); break;
        case "mirror_y": q = g.vec([px(), g.fn("abs", [py()]), pz()]); break;
        case "mirror_xy": q = g.fn("abs", [p]); break;
        case "radial": {
          // C++ repeat_radial: a = phase + ashift; a2 = mod[a, angle] - ashift; xy = cis(a2) * r
          const ang = g.let(g.bin("/", g.num(2 * Math.PI), a));
          const ashift = g.let(g.bin("+", g.num(Math.PI / 2), g.bin("*", ang, g.num(0.5))));
          const r = g.let(g.fn("length", [g.vec([px(), py()])]));
          const a2 = g.let(g.bin("-", g.bin("%", g.bin("+", g.fn("atan2", [py(), px()]), ashift), ang), ashift));
          q = g.vec([g.bin("*", g.fn("cos", [a2]), r), g.bin("*", g.fn("sin", [a2]), r), pz()]); break;
        }
      }
      return kid(n.s, g.let(q), { cull: false });
    }
    case "swirl": {
      // C++ skimage-style swirl: phi = strength * e^(-m/r) + phase,  r = log2 * d / 10
      const rr = g.param(Math.log(2) * n.d / 10);
      const m = g.let(g.fn("length", [g.vec([px(), py()])]));
      const phi = g.let(g.bin("+", g.bin("*", g.param(n.strength), g.fn("exp", [g.neg(g.bin("/", m, g.fn("max", [rr, g.num(1e-6)])))])), g.fn("atan2", [py(), px()])));
      const q = g.let(g.vec([g.bin("*", m, g.fn("cos", [phi])), g.bin("*", m, g.fn("sin", [phi])), pz()]));
      const a = kid(n.s, q, { cull: false });
      return { d: a.d, c: a.c };
    }
    // ---------------------------------------------------------------- 3D round 17
    case "sphere": return prim(g.bin("-", g.fn("length", [p]), g.param(n.r)));
    case "box3": {
      const qx = g.param(n.hx), qy = g.param(n.hy), qz = g.param(n.hz), rr = g.param(n.r);
      // Rounded box SDF, scalar form: b = |p| - h; d = length(max(b, 0)) + min(max(b.x, max(b.y, b.z)), 0) - r
      const b = g.let(g.bin("-", g.fn("abs", [p]), g.vec([qx, qy, qz])));
      const outer = g.fn("length", [g.fn("max", [b, g.num(0)])]);
      const inner = g.fn("min", [g.fn("max", [g.idx(b, 0), g.fn("max", [g.idx(b, 1), g.idx(b, 2)])]), g.num(0)]);
      return prim(g.bin("-", g.bin("+", outer, inner), rr));
    }
    case "half3": return prim(g.bin("-", g.fn("dot", [p, g.fn("normalize", [V3(g, n.nx, n.ny, n.nz)])]), g.param(n.d)));
    case "cone": {
      // C++ cone: base at z = 0, apex at z = h.  q = (radial, z) in the 2D (rho, z) plane —
      // all of C++'s cone math is 2D there.  `exact` is the Euclidean field (MERCURY / hg_sdf),
      // which is what C++'s `cone` calls; `mitred` is the cheaper mitred cone.
      const r = g.param(n.r), h = g.param(n.h);
      const q = g.let(g.vec([g.fn("length", [g.vec([px(), py()])]), pz()]));
      const apex = g.let(g.bin("-", q, g.vec([g.num(0), h])));
      const md = g.let(g.fn("normalize", [g.vec([h, r])]));
      const mantle = g.let(g.fn("dot", [apex, md]));
      let d = g.let(g.fn("max", [mantle, g.neg(g.idx(q, 1))]));
      if (n.m === "exact") {
        // apex correction (above the tip, on the far side of the apex plane) …
        const proj = g.let(g.fn("dot", [apex, g.vec([g.idx(md, 1), g.neg(g.idx(md, 0))])]));
        const apexD = g.let(g.fn("length", [apex]));
        d = g.let(g.sel(g.logic("&&", g.cmp(">", g.idx(q, 1), h), g.cmp("<", proj, g.num(0))), g.fn("max", [d, apexD]), d));
        // … and base-ring correction (outside the base circle, past the mantle's foot)
        const ringD = g.let(g.fn("length", [g.bin("-", q, g.vec([r, g.num(0)]))]));
        const hyp = g.let(g.fn("length", [g.vec([h, r])]));
        d = g.let(g.sel(g.logic("&&", g.cmp(">", g.idx(q, 0), r), g.cmp(">", proj, hyp)), g.fn("max", [d, ringD]), d));
      }
      return prim(d);
    }
    case "capped_cone": {
      // exact C++ port (sdCappedCone after Inigo Quilez); r1 at z = -hh (bottom), r2 at z = +hh (top)
      const hh = g.param(n.hh), r1 = g.param(n.r1), r2 = g.param(n.r2);
      const q = g.let(g.vec([g.fn("length", [g.vec([px(), py()])]), pz()]));
      const ca = g.let(g.vec([
        g.bin("-", g.idx(q, 0), g.fn("min", [g.idx(q, 0), g.sel(g.cmp("<", pz(), g.num(0)), r1, r2)])),
        g.bin("-", g.fn("abs", [pz()]), hh)]));
      const k1 = g.let(g.vec([r2, hh])), k2 = g.let(g.vec([g.bin("-", r2, r1), g.bin("*", hh, g.num(2))]));
      const t = g.let(g.fn("clamp", [g.bin("/", g.fn("dot", [g.bin("-", k1, q), k2]), g.fn("dot", [k2, k2])), g.num(0), g.num(1)]));
      const cb = g.let(g.bin("+", g.bin("-", q, k1), g.bin("*", k2, t)));
      const s = g.sel(g.logic("&&", g.cmp("<", g.idx(cb, 0), g.num(0)), g.cmp("<", g.idx(ca, 1), g.num(0))), g.neg(g.num(1)), g.num(1));
      const mnd = g.fn("min", [g.fn("dot", [ca, ca]), g.fn("dot", [cb, cb])]);
      return prim(g.bin("*", s, g.fn("sqrt", [mnd])));
    }
    case "gyroid":
      return prim(g.bin("+", g.bin("+",
        g.bin("*", g.fn("cos", [px()]), g.fn("sin", [py()])),
        g.bin("*", g.fn("cos", [py()]), g.fn("sin", [pz()]))),
        g.bin("*", g.fn("cos", [pz()]), g.fn("sin", [px()]))));
    case "extrude": {
      // h is the HALF height (total = 2h), centred on z = 0 — the 2D shape is sliced at z = 0
      const h = g.param(n.h);
      const a = kid(n.s, g.vec([px(), py(), g.num(0)]), { cull: false });
      if (n.m === "mitred") return { d: g.let(g.fn("max", [g.bin("-", g.fn("abs", [pz()]), h), a.d])), c: a.c };
      const dz = g.let(g.bin("-", g.fn("abs", [pz()]), h));
      const out = g.let(g.fn("max", [g.vec([dz, a.d]), g.num(0)]));
      return { d: g.let(g.bin("+", g.fn("length", [out]), g.fn("min", [g.fn("max", [dz, a.d]), g.num(0)]))), c: a.c };
    }
    case "loft": {
      const h = g.param(n.h);
      const a = kid(n.a, g.vec([px(), py(), g.num(0)]), { cull: false });
      const b = kid(n.b, g.vec([px(), py(), g.num(0)]), { cull: false });
      const t = g.let(g.bin("/", g.bin("+", g.fn("clamp", [pz(), g.neg(h), h]), h), g.bin("*", h, g.num(2))));
      return { d: g.let(g.fn("max", [g.bin("-", g.fn("abs", [pz()]), h), g.fn("mix", [a.d, b.d, t])])), c: g.let(g.fn("mix", [a.c, b.c, t])) };
    }
    case "perex": {
      // perimeter_extrude: sweep the 2D section along the 2D perimeter (torus, revolve…)
      const per = kid(n.a, g.vec([px(), py(), g.num(0)]), { cull: false }).d;
      const b = kid(n.b, g.vec([per, pz(), g.num(0)]), { cull: false });
      return { d: g.let(b.d), c: b.c };
    }
    case "twist": {
      // xy rotated by -tr*z (C++: cmul[xy, cis(z*-tr)])
      const tr = g.param(n.tr);
      const ang = g.let(g.bin("*", g.neg(tr), pz()));
      const c = g.let(g.fn("cos", [ang])), s = g.let(g.fn("sin", [ang]));
      const a = kid(n.s, g.vec([
        g.bin("-", g.bin("*", c, px()), g.bin("*", s, py())),
        g.bin("+", g.bin("*", s, px()), g.bin("*", c, py())),
        pz()]), { cull: false });
      return { d: a.d, c: a.c };
    }
    case "bend": {
      // C++ bend: f[x,y,z,t] = [(mod[phase[x,y]/pi+1.5, 2]-1)*rx + offset.X, offset.Y - mag[x,y], z, t]
      // n.ry is not used by the field (it only sets offset.Y, computed at bind time) but the
      // parameter slot is still emitted: walkSeg pushes it and the two must stay in lockstep.
      const rx = g.param(n.rx); void g.param(n.ry); const ox = g.param(n.ox), oy = g.param(n.oy);
      const m = g.let(g.fn("length", [g.vec([px(), py()])]));
      const nx = g.let(g.bin("+", g.bin("*", g.bin("-", g.bin("%", g.bin("+", g.bin("/", g.fn("atan2", [py(), px()]), g.num(Math.PI)), g.num(1.5)), g.num(2)), g.num(1)), rx), ox));
      const a = kid(n.s, g.vec([nx, g.bin("-", oy, m), pz()]), { cull: false });
      return { d: a.d, c: a.c };
    }
    case "warp2": {
      // C++ warp_domain_xy: dist = fix_distance[x, y, shape.dist[inverse[x, y], z]]
      const q2 = g.let(n.f.compile(g, g.vec([px(), py()]), ctx)); // inverse[x, y] as in C++
      const a = kid(n.s, g.vec([g.idx(q2, 0), g.idx(q2, 1), pz()]), { cull: false });
      let d: E = a.d;
      if (n.fix) { const fx = n.fix.compile(g, g.vec([px(), py(), a.d]), ctx); if (fx.t === "f") d = fx; }
      return { d: g.let(d), c: a.c };
    }
    case "shear2": {
      const kx = g.param(n.kx);
      const a = kid(n.s, g.vec([g.bin("-", px(), g.bin("*", kx, py())), py(), pz()]), { cull: false });
      return { d: a.d, c: a.c }; // C++: fix_distance = d (no compensation)
    }
    case "taper2": {
      const y0 = g.param(n.y0), y1 = g.param(n.y1), kx0 = g.param(n.kx0), kx1 = g.param(n.kx1);
      const tt = g.let(g.bin("/", g.bin("-", py(), y0), g.bin("-", y1, y0)));
      const kx = g.let(g.sel(g.cmp("<=", py(), y0), kx0, g.sel(g.cmp(">=", py(), y1), kx1, g.fn("mix", [kx0, kx1, tt]))));
      const a = kid(n.s, g.vec([g.bin("/", px(), g.fn("max", [kx, g.num(1e-6)])), py(), pz()]), { cull: false });
      return { d: g.let(g.bin("*", a.d, g.bin("*", kx, g.fn("min", [kx0, kx1])))), c: a.c };
    }
    case "taper3": {
      const z0 = g.param(n.z0), z1 = g.param(n.z1), kx0 = g.param(n.kx0), ky0 = g.param(n.ky0), kx1 = g.param(n.kx1), ky1 = g.param(n.ky1);
      const t = g.let(g.bin("/", g.bin("-", pz(), z0), g.bin("-", z1, z0)));
      const kx = g.let(g.sel(g.cmp("<=", pz(), z0), kx0, g.sel(g.cmp(">=", pz(), z1), kx1, g.fn("mix", [kx0, kx1, t]))));
      const ky = g.let(g.sel(g.cmp("<=", pz(), z0), ky0, g.sel(g.cmp(">=", pz(), z1), ky1, g.fn("mix", [ky0, ky1, t]))));
      const a = kid(n.s, g.vec([g.bin("/", px(), g.fn("max", [kx, g.num(1e-6)])), g.bin("/", py(), g.fn("max", [ky, g.num(1e-6)])), pz()]), { cull: false });
      return { d: g.let(g.bin("*", a.d, g.bin("*", g.fn("min", [kx, ky]), g.fn("min", [g.fn("min", [kx0, kx1]), g.fn("min", [ky0, ky1])])))), c: a.c };
    }
    case "slice2": {
      // planar cross section of any shape (z = 0 result, like C++ slice_xy / xz / yz)
      const q = n.plane === 0 ? g.vec([px(), py(), g.num(0)]) : n.plane === 1 ? g.vec([px(), g.num(0), py()]) : g.vec([g.num(0), px(), py()]);
      return kid(n.s, g.let(q));
    }
    case "xform3": {
      // pure 3D rotation + translation (orthonormal m, row-major): distance preserved, no scale
      const tx = g.param(n.tx), ty = g.param(n.ty), tz = g.param(n.tz);
      const m = n.m.map((v) => g.param(v));
      const q0 = g.let(g.bin("-", p, g.vec([tx, ty, tz])));
      const dot3 = (i: number) => g.let(g.bin("+", g.bin("+",
        g.bin("*", m[i * 3], g.idx(q0, 0)), g.bin("*", m[i * 3 + 1], g.idx(q0, 1))), g.bin("*", m[i * 3 + 2], g.idx(q0, 2))));
      const a = kid(n.s, g.vec([dot3(0), dot3(1), dot3(2)]));
      return { d: a.d, c: a.c };
    }
    case "stretch3": {
      const sx = g.param(n.sx), sy = g.param(n.sy), sz = g.param(n.sz);
      const m = g.param(Math.min(Math.abs(n.sx), Math.abs(n.sy), Math.abs(n.sz)) || 1);
      const a = kid(n.s, g.let(g.bin("/", p, g.vec([sx, sy, sz]))), { cull: false, zoom: g.let(g.bin("*", ctx.zoom, m)) });
      return { d: g.let(g.bin("*", a.d, m)), c: a.c };
    }
    case "reflect3": {
      const nn = g.let(g.fn("normalize", [V3(g, n.nx, n.ny, n.nz)]));
      const q = g.let(g.bin("-", p, g.bin("*", g.bin("*", g.num(2), g.fn("dot", [p, nn])), nn)));
      return kid(n.s, q);
    }
    case "repeat_finite": {
      const d0 = g.param(n.d[0]), d1 = g.param(n.d[1]), d2 = g.param(n.d[2] ?? 0);
      const l0 = g.param(n.l[0]), l1 = g.param(n.l[1]), l2 = g.param(n.l[2] ?? 1);
      const fx = (pi: E, di: E, li: E): E => {
        const q = g.fn("round", [g.bin("/", pi, g.fn("max", [di, g.num(1e-6)]))]);
        const cl = g.fn("clamp", [q, g.num(0), g.bin("-", li, g.num(1))]);
        return g.bin("-", pi, g.bin("*", di, cl));
      };
      return kid(n.s, g.let(g.vec([fx(px(), d0, l0), fx(py(), d1, l1), fx(pz(), d2, l2)])), { cull: false });
    }
    case "distfield": {
      const a = kid(n.s, p);
      const cc = g.let(g.sel(g.cmp(">=", a.d, g.num(0)), g.bin("-", g.fn("ceil", [a.d]), a.d), g.bin("-", g.fn("floor", [a.d]), a.d)));
      return { d: g.num(-1e30), c: g.let(g.vec([g.fn("max", [g.neg(cc), g.num(0)]), g.num(0), g.fn("max", [cc, g.num(0)]), g.num(1)])) };
    }
    case "showdist": {
      // the shape's distance field visualised on the z = 0 plane (contour = |d|, hue = gradient)
      const E0 = g.num(0.01);
      const d0 = kid(n.s, g.vec([px(), py(), g.num(0)]), { cull: false }).d;
      const du = kid(n.s, g.vec([px(), g.bin("+", py(), E0), g.num(0)]), { cull: false }).d;
      const dd = kid(n.s, g.vec([px(), g.bin("-", py(), E0), g.num(0)]), { cull: false }).d;
      const dl = kid(n.s, g.vec([g.bin("+", px(), E0), py(), g.num(0)]), { cull: false }).d;
      const dr = kid(n.s, g.vec([g.bin("-", px(), E0), py(), g.num(0)]), { cull: false }).d;
      const gm = g.let(g.bin("/", g.fn("max", [
        g.fn("abs", [g.bin("-", d0, du)]), g.fn("abs", [g.bin("-", d0, dd)]),
        g.fn("abs", [g.bin("-", d0, dl)]), g.fn("abs", [g.bin("-", d0, dr)])]), E0));
      const cc = g.let(g.sel(g.cmp(">=", d0, g.num(0)), g.bin("-", g.fn("ceil", [d0]), d0), g.bin("-", g.fn("floor", [d0]), d0)));
      const c = g.let(g.vec([
        g.bin("^", g.fn("clamp", [g.bin("-", gm, g.num(1)), g.num(0), g.num(1)]), g.num(2.2)),
        g.bin("^", g.fn("max", [g.neg(cc), g.num(0)]), g.num(2.2)),
        g.bin("^", g.fn("max", [cc, g.num(0)]), g.num(2.2)),
        g.num(1)]));
      // C++: (if (shape.is_2d) xy else union[shape, xy]) — the z = 0 diagnostic sheet
      // unioned over 3D shapes (plain min, C++ colour rule: sheet wins where d_sheet <= 0
      // || d_sheet <= d_shape).  Never culled, like C++'s _union2.
      const planeD = g.let(g.fn("abs", [pz()]));
      if (!flags3Of(n.s).is3d) return { d: planeD, c };
      const a = kid(n.s, p, { cull: false });
      return { d: g.let(g.fn("min", [a.d, planeD])), c: g.let(g.sel(g.logic("||", g.cmp("<=", planeD, g.num(0)), g.cmp("<=", planeD, a.d)), c, a.c)) };
    }
    case "showgrad": {
      // Lipschitz diagnostic: rainbow where the field's gradient is in (j, k], white above k
      const j = g.param(n.j), kE = g.param(n.k2);
      const E0 = g.num(0.01);
      const d0 = kid(n.s, g.vec([px(), py(), g.num(0)]), { cull: false }).d;
      const du = kid(n.s, g.vec([px(), g.bin("+", py(), E0), g.num(0)]), { cull: false }).d;
      const dd = kid(n.s, g.vec([px(), g.bin("-", py(), E0), g.num(0)]), { cull: false }).d;
      const dl = kid(n.s, g.vec([g.bin("+", px(), E0), py(), g.num(0)]), { cull: false }).d;
      const dr = kid(n.s, g.vec([g.bin("-", px(), E0), py(), g.num(0)]), { cull: false }).d;
      const gm = g.let(g.bin("/", g.fn("max", [
        g.fn("abs", [g.bin("-", d0, du)]), g.fn("abs", [g.bin("-", d0, dd)]),
        g.fn("abs", [g.bin("-", d0, dl)]), g.fn("abs", [g.bin("-", d0, dr)])]), E0));
      // C++ sRGB.hue h = HSV[h, 1, 1]: full-saturation rainbow; the backends' hsv takes [h, s, v]
      const hueE = g.let(g.fn("clamp", [g.bin("/", g.bin("-", gm, j), g.bin("-", kE, j)), g.num(0), g.num(1)]));
      const hc = g.fn("hsv", [g.vec([hueE, g.num(1), g.num(1)])]);
      const c = g.let(g.sel(g.cmp("<=", gm, j),
        g.vec([g.num(0), g.num(0), g.num(0), g.num(1)]),
        g.sel(g.cmp(">", gm, kE), g.vec([g.num(1), g.num(1), g.num(1), g.num(1)]),
          g.vec([g.idx(hc, 0), g.idx(hc, 1), g.idx(hc, 2), g.num(1)]))));
      // C++: (if (shape.is_2d) xy else union[shape, xy]) — see showdist above
      const planeD = g.let(g.fn("abs", [pz()]));
      if (!flags3Of(n.s).is3d) return { d: planeD, c };
      const a = kid(n.s, p, { cull: false });
      return { d: g.let(g.fn("min", [a.d, planeD])), c: g.let(g.sel(g.logic("||", g.cmp("<=", planeD, g.num(0)), g.cmp("<=", planeD, a.d)), c, a.c)) };
    }
    case "cuunion": {
      if (n.kids.length === 0) return prim(g.num(1e30));
      const r = g.param(n.s);
      let acc = kidCulled(n.kids[0], p);
      for (let i = 1; i < n.kids.length; i++) {
        const b = kidCulled(n.kids[i], p);
        const d = g.let(chamferMin(g, acc.d, b.d, r));
        const ov = ctx.mode === "solid"
          ? { c: g.sel(g.logic("||", g.cmp("<=", b.d, g.num(0)), g.cmp("<=", b.d, acc.d)), b.c, acc.c) }
          : over(g, acc, b, ctx.zoom);
        acc = { d, c: g.let(ov.c) };
      }
      return acc;
    }
    case "cinter": {
      if (n.kids.length === 0) return prim(g.num(-1e30));
      const r = g.param(n.s);
      let acc = kidCulled(n.kids[0], p);
      for (let i = 1; i < n.kids.length; i++) {
        const b = kidCulled(n.kids[i], p);
        const d = g.let(g.neg(chamferMin(g, g.neg(acc.d), g.neg(b.d), r)));
        acc = { d, c: g.let(g.sel(g.cmp(">", b.d, acc.d), b.c, acc.c)) };
      }
      return acc;
    }
    case "cdiff": {
      const a = kid(n.a, p, { cull: false }), b = kid(n.b, p, { cull: false });
      const r = g.param(n.s);
      return { d: g.let(g.neg(chamferMin(g, g.neg(a.d), b.d, r))), c: a.c };
    }
    case "custom": {
      const p4 = g.let(g.vec([p, ctx.time]));
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
