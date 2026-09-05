// Signed-distance glyph atlas built once with Canvas2D.  Each ASCII glyph
// (32..126) lives in a CELL×CELL cell; the texture stores 0.5 - dist/SPREAD.
export const ATLAS_COLS = 16, ATLAS_ROWS = 6, CELL = 64, FONT_PX = 40, SPREAD = 8;
export const ATLAS_W = ATLAS_COLS * CELL, ATLAS_H = ATLAS_ROWS * CELL;
export const GLYPH_PAD = 10, BASELINE = 44; // glyph origin inside the cell
export const FONT_FAMILY = "Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface Atlas {
  data: Uint8Array<ArrayBuffer>; // ATLAS_W*ATLAS_H single channel (r8unorm)
  advance: Float32Array;     // per char code 0..127, in FONT_PX units
  cell(code: number): [number, number]; // cell column,row
}

let cached: Atlas | null = null;

export function buildAtlas(): Atlas {
  if (cached) return cached;
  const cv = document.createElement("canvas"); cv.width = ATLAS_W; cv.height = ATLAS_H;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
  ctx.fillStyle = "#fff"; ctx.font = `500 ${FONT_PX}px ${FONT_FAMILY}`; ctx.textBaseline = "alphabetic";
  const advance = new Float32Array(128);
  for (let code = 32; code < 127; code++) {
    const i = code - 32, cx = (i % ATLAS_COLS) * CELL, cy = Math.floor(i / ATLAS_COLS) * CELL;
    const ch = String.fromCharCode(code);
    advance[code] = ctx.measureText(ch).width;
    ctx.fillText(ch, cx + GLYPH_PAD, cy + BASELINE);
  }
  const img = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H).data;
  const inside = new Uint8Array(ATLAS_W * ATLAS_H);
  for (let p = 0; p < inside.length; p++) inside[p] = img[p * 4] > 127 ? 1 : 0;
  // exact Euclidean distance transform (Felzenszwalb & Huttenlocher), two passes
  // (outside / inside), clamped to SPREAD.  ~10 ms instead of seconds.
  const dOut = edt(inside, ATLAS_W, ATLAS_H, 0), dIn = edt(inside, ATLAS_W, ATLAS_H, 1);
  const data = new Uint8Array(new ArrayBuffer(ATLAS_W * ATLAS_H));
  const R = SPREAD;
  for (let p = 0; p < data.length; p++) {
    // signed distance to the boundary (negative inside); the half-pixel makes both sides symmetric
    const sd = inside[p] ? -(Math.sqrt(dOut[p]) - 0.5) : Math.sqrt(dIn[p]) - 0.5;
    data[p] = Math.max(0, Math.min(255, Math.round((0.5 - Math.max(-R, Math.min(R, sd)) / (2 * R)) * 255)));
  }
  cached = { data, advance, cell: (code) => { const i = Math.max(0, Math.min(94, code - 32)); return [i % ATLAS_COLS, Math.floor(i / ATLAS_COLS)]; } };
  return cached;
}

export function measureText(atlas: Atlas, text: string, size: number): number {
  let w = 0; for (const ch of text) { const c = ch.charCodeAt(0); w += (advanceOf(atlas, c)) * (size / FONT_PX); }
  return w;
}
export function advanceOf(atlas: Atlas, code: number) { return code >= 32 && code < 127 ? atlas.advance[code] : atlas.advance[32]; }

/** Squared distance from every pixel to the nearest pixel whose `inside` value equals `target`. */
function edt(inside: Uint8Array, W: number, H: number, target: number): Float32Array {
  const INF = 1e20;
  const f = new Float32Array(W * H);
  for (let i = 0; i < f.length; i++) f[i] = inside[i] === target ? 0 : INF;
  const n = Math.max(W, H);
  const v = new Int32Array(n), z = new Float32Array(n + 1), col = new Float32Array(n), out = new Float32Array(n);
  const dt1 = (len: number) => {
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = ((col[q] + q * q) - (col[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((col[q] + q * q) - (col[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + col[v[k]]; }
  };
  for (let x = 0; x < W; x++) { for (let y = 0; y < H; y++) col[y] = f[y * W + x]; dt1(H); for (let y = 0; y < H; y++) f[y * W + x] = out[y]; }
  for (let y = 0; y < H; y++) { for (let x = 0; x < W; x++) col[x] = f[y * W + x]; dt1(W); for (let x = 0; x < W; x++) f[y * W + x] = out[x]; }
  return f;
}
