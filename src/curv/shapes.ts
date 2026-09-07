// F-Rep shape tree (what Curv shape values evaluate to), bounding boxes, and
// compilation of the tree into straight-line shader code (WGSL or JS) through
// the Gen backends.  All numbers that may vary between evaluations are emitted
// as parameters so re-solving / animating never triggers a shader recompile.
import { type Atlas, CELL, FONT_PX, GLYPH_PAD, BASELINE, ATLAS_COLS, ATLAS_ROWS, penAdvance } from "../gpu/atlas";
import { type Gen, type E, GenError, SHADER_FLAGS, flagsKey } from "../gpu/gen";

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
const wpMemo: [WeakMap<SNode, ParamSeg | null>, WeakMap<SNode, ParamSeg | null>] = [new WeakMap(), new WeakMap()];
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
  const memo = wpMemo[cull ? 1 : 0];
  const hit = memo.get(root);
  if (hit !== undefined) return hit;
  const out: number[] = []; const blocks: { at: number; values: number[] }[] = [];
  const P = (v: number) => { out.push(Number.isFinite(v) ? v : v > 0 ? 3e38 : v < 0 ? -3e38 : 0); };
  const block = (values: number[]) => { out.push(0); blocks.push({ at: out.length - 1, values }); };
  let ok = true;
  const walk = (n: SNode, cull: boolean): void => {
    if (n !== root) { // nested subtree: reuse / create its own segment when it is big enough to be worth it
      const m = wpMemo[cull ? 1 : 0];
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
      case "seg": P(n.x1); P(n.y1); P(n.x2); P(n.y2); P(n.th / 2); return;
      case "ellipse": P(n.a / 2); P(n.b / 2); return;
      case "nothing": case "everything": return;
      case "half": P(n.nx); P(n.ny); P(n.d); return;
      case "ngon": { const an = Math.PI / n.n, R = n.r / Math.cos(an); P(Math.cos(an)); P(Math.sin(an)); P(an); P(R); P(R); return; }
      case "poly": if (n.pts.length / 2 < 3) return; block(n.pts); return;
      case "text": { const m = textMetrics(n, atlas); const glyphs = textGlyphs(n, atlas, m); P(m.s); P(m.baseY - (CELL - BASELINE) * m.s); P(CELL * m.s); P(glyphs.length); block(glyphs.flat()); return; }
      case "union": case "inter": for (const k of n.kids) kidC(k); return;
      case "diff": kidC(n.a); kidC(n.b); return;
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
      case "repeat": P(n.a); P(n.b); walk(n.s, false); return;
      case "swirl": P(n.d / 2); P(n.strength); walk(n.s, false); P(1 + Math.abs(n.strength)); return;
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
    case "union": case "inter": case "sunion": case "sinter": return n.kids.reduce((s, k) => s + weight(k), 0);
    case "diff": case "sdiff": case "morph": return weight(n.a) + weight(n.b);
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
  switch (n.k) {
    case "circle": return hashStr("ci" + n.r);
    case "rect": return hashStr("re" + n.w + "," + n.h + "," + n.r);
    case "seg": return hashStr("sg" + n.x1 + "," + n.y1 + "," + n.x2 + "," + n.y2 + "," + n.th);
    case "ellipse": return hashStr("el" + n.a + "," + n.b);
    case "nothing": return hashStr("no"); case "everything": return hashStr("ev");
    case "half": return hashStr("ha" + n.nx + "," + n.ny + "," + n.d);
    case "ngon": return hashStr("ng" + n.n + "," + n.r);
    case "poly": return hashStr("po" + n.pts.length + ":" + n.pts.join(","));
    case "text": return hashStr("tx" + n.align + n.size + ":" + n.text);
    case "union": case "inter": case "sunion": case "sinter": { const s = kids(n.kids); return s === null ? null : hashStr(n.k + ("s" in n ? n.s : "") + "|" + n.kids.length + "|" + s); }
    case "diff": case "sdiff": case "morph": { const a = nodeHash(n.a), b = nodeHash(n.b); return a === null || b === null ? null : hashStr(n.k + ("s" in n ? n.s : "t" in n ? n.t : "") + "|" + a + "|" + b); }
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
    case "repeat": return one(n.s, "rp" + n.kind + n.a + "," + n.b);
    case "swirl": return one(n.s, "sw" + n.strength + "," + n.d);
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
    case "seg": mTag(h, 3); mNum(h, n.x1); mNum(h, n.y1); mNum(h, n.x2); mNum(h, n.y2); mNum(h, n.th); break;
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
    case "repeat": mTag(h, 30); mStr(h, n.kind); mNum(h, n.a); mNum(h, n.b); if (!kid(n.s)) return null; break;
    case "swirl": mTag(h, 31); mNum(h, n.strength); mNum(h, n.d); if (!kid(n.s)) return null; break;
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
      { h1 = Math.imul(h1 ^ (400 + REPEAT_TAGS[n.kind]), 0x01000193);
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
const REPEAT_TAGS: Record<string, number> = { x: 1, y: 2, xy: 3, radial: 4, mirror_x: 5, mirror_y: 6, mirror_xy: 7 };
function skFail(): number { skOut2 = 0; return 0; }
export function structKey(n: SNode, atlas: Atlas, cull = true): string | null {
  const h1 = skNum(n, atlas, cull);
  if (h1 === 0 && skOut2 === 0) return null;
  return flagsKey() + "|" + (h1 >>> 0).toString(36) + "." + (skOut2 >>> 0).toString(36);
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
/**
 * Push a block of per-item parameters and return the (parameterised) index of its first element.
 * The offset itself lives in the buffer, so a variable-length block earlier in the tree (a text
 * label whose length changed) never bakes a different literal into the shader text.
 */
function dynBase(g: Gen, values: number[]): E { return g.dynBlock(values); }
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
    if (!cullable(s, ctx.atlas, ctx.cull)) return kid(s, q);
    const bb = finiteBBox(bboxOf(s, ctx.atlas))!;
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
      const baseE = dynBase(g, n.pts);
      const at = (i: E, off: number) => g.paramAt(g.bin("+", g.bin("+", baseE, g.bin("*", i, g.num(2))), g.num(off)));
      const v0 = g.vec([g.paramAt(baseE), g.paramAt(g.bin("+", baseE, g.num(1)))]);
      const dv = g.var(g.fn("dot", [g.bin("-", p, v0), g.bin("-", p, v0)])); const sv = g.var(g.num(1));
      g.loop(g.num(N), (i) => {
        const j = SHADER_FLAGS.polySelect ? g.let(g.sel(g.cmp("<", i, g.num(1)), g.num(N - 1), g.bin("-", i, g.num(1)))) : g.let(g.bin("%", g.bin("+", i, g.num(N - 1)), g.num(N)));
        const vi = g.let(g.vec([at(i, 0), at(i, 1)])), vj = g.let(g.vec([at(j, 0), at(j, 1)]));
        const e = g.let(g.bin("-", vj, vi)), w = g.let(g.bin("-", p, vi));
        const b = g.let(g.bin("-", w, g.bin("*", e, g.fn("clamp", [g.bin("/", g.fn("dot", [w, e]), g.fn("max", [g.fn("dot", [e, e]), g.num(1e-9)])), g.num(0), g.num(1)]))));
        g.assign(dv, g.fn("min", [dv, g.fn("dot", [b, b])]));
        const c1 = g.cmp(">=", py(), g.idx(vi, 1)), c2 = g.cmp("<", py(), g.idx(vj, 1)), c3 = g.cmp(">", g.bin("-", g.bin("*", g.idx(e, 0), g.idx(w, 1)), g.bin("*", g.idx(e, 1), g.idx(w, 0))), g.num(0));
        const all = g.logic("&&", g.logic("&&", c1, c2), c3), none = g.logic("&&", g.logic("&&", g.not(c1), g.not(c2)), g.not(c3));
        if (SHADER_FLAGS.polySelect) g.assign(sv, g.bin("*", sv, g.sel(g.logic("||", all, none), g.num(-1), g.num(1))));
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
      const pad = g.let(g.bin("/", g.num(1.5), ctx.zoom));
      const half = g.let(g.bin("*", qsE, g.num(0.5)));
      const dv = g.var(g.num(1e30));
      if (SHADER_FLAGS.textWindow && glyphs.length > 6) {
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
          const lp = g.let(g.bin("-", p, g.vec([at(0), qyE])));
          const bd = g.let(sdBox(g, g.bin("-", lp, half), half, half, g.num(0)));
          g.if(g.cmp("<", bd, pad), () => {
            const q = g.fn("clamp", [g.bin("/", lp, qsE), g.num(0), g.num(1)]);
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
        const lp = g.let(g.bin("-", p, g.vec([at(0), qyE])));
        const bd = g.let(sdBox(g, g.bin("-", lp, half), half, half, g.num(0)));
        if (SHADER_FLAGS.textBranchless) {
          // branchless: always sample, select the result — no divergence, more texture traffic
          const q = g.fn("clamp", [g.bin("/", lp, qsE), g.num(0), g.num(1)]);
          const uv = g.fn("mix", [g.vec([at(1), at(2)]), g.vec([at(3), at(4)]), q]);
          const dg = g.bin("*", g.bin("*", g.bin("-", g.num(0.5), g.tex(uv)), g.num(2 * 8)), sE);
          g.assign(dv, g.fn("min", [dv, g.sel(g.cmp("<", bd, pad), g.fn("max", [dg, bd]), g.bin("+", bd, pad))]));
        } else {
          g.if(g.cmp("<", bd, pad), () => {
            const q = g.fn("clamp", [g.bin("/", lp, qsE), g.num(0), g.num(1)]);
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
