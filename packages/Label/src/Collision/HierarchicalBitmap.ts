/**
 * Two-level packed-bit occupancy grid.
 *
 * Coordinates are given in "fine cells" (the finest layer's units).
 * The coarse layer is `coarseScale`× coarser per axis; queries on it use
 * `>> coarseShift` from fine cell coords.
 *
 * The coarse layer is a write-only summary used to accelerate the fast-pass
 * "is this region completely empty?" check.
 */
export class HierarchicalBitmap {
  private fine   = new Uint32Array(1);
  private coarse = new Uint32Array(1);
  private fineW = 0;   private fineH = 0;   private fineWPR = 0;
  private coarseW = 0; private coarseH = 0; private coarseWPR = 0;

  private readonly coarseShift: number;

  /**
   * @param coarseScale Fine cells per coarse cell. Must be a power of 2.
   */
  constructor(coarseScale = 32) {
    this.coarseShift = log2OfPow2(coarseScale, "coarseScale");
  }

  /** Resize and clear both layers. */
  resize(fineW: number, fineH: number): void {
    this.fineW = Math.max(1, fineW);
    this.fineH = Math.max(1, fineH);
    this.fineWPR = (this.fineW + 31) >> 5;
    this.fine = new Uint32Array(this.fineWPR * this.fineH);

    const ceilMask = (1 << this.coarseShift) - 1; 

    this.coarseW = Math.max(1, this.fineW + ceilMask >> this.coarseShift);
    this.coarseH = Math.max(1, this.fineH + ceilMask >> this.coarseShift);
    this.coarseWPR = (this.coarseW + 31) >> 5;
    this.coarse = new Uint32Array(this.coarseWPR * this.coarseH);
  }

  /** Clear both layers. Does not reallocate. */
  clear(): void {
    this.fine.fill(0);
    this.coarse.fill(0);
  }

  get width():  number { return this.fineW; }
  get height(): number { return this.fineH; }

  /** True if no bit is set anywhere in [x0,y0]-[x1,y1] (checks coarse only). */
  isCoarseEmpty(x0: number, y0: number, x1: number, y1: number): boolean {
    const s = this.coarseShift;
    return regionEmpty(this.coarse, this.coarseWPR, x0 >> s, y0 >> s, x1 >> s, y1 >> s);
  }

  /** Number of set bits in [x0,y0]-[x1,y1] (precise, on fine layer). */
  countFine(x0: number, y0: number, x1: number, y1: number): number {
    return regionCount(this.fine, this.fineWPR, x0, y0, x1, y1);
  }

  /** OR-set bits in [x0,y0]-[x1,y1] on both layers. */
  setRegion(x0: number, y0: number, x1: number, y1: number): void {
    regionSet(this.fine, this.fineWPR, x0, y0, x1, y1);
    const s = this.coarseShift;
    regionSet(this.coarse, this.coarseWPR, x0 >> s, y0 >> s, x1 >> s, y1 >> s);
  }
}

// Utils

function log2OfPow2(n: number, name: string): number {
  if (n < 1 || (n & (n - 1)) !== 0) {
    throw new Error(`${name} must be a power of 2, got ${n}`);
  }
  let s = 0;
  while ((1 << s) < n) s++;
  return s;
}

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function regionEmpty(
  bm: Uint32Array, wpr: number,
  x0: number, y0: number, x1: number, y1: number,
): boolean {
  const wA = x0 >> 5, wB = x1 >> 5;
  const maskA = (0xffffffff << (x0 & 31)) >>> 0;
  const maskB = (0xffffffff >>> (31 - (x1 & 31)));
  for (let y = y0; y <= y1; y++) {
    const row = y * wpr;
    if (wA === wB) {
      if ((bm[row + wA] & maskA & maskB) !== 0) return false;
    } else {
      if ((bm[row + wA] & maskA) !== 0) return false;
      for (let w = wA + 1; w < wB; w++) if (bm[row + w] !== 0) return false;
      if ((bm[row + wB] & maskB) !== 0) return false;
    }
  }
  return true;
}

function regionCount(
  bm: Uint32Array, wpr: number,
  x0: number, y0: number, x1: number, y1: number,
): number {
  const wA = x0 >> 5, wB = x1 >> 5;
  const maskA = (0xffffffff << (x0 & 31)) >>> 0;
  const maskB = (0xffffffff >>> (31 - (x1 & 31)));
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * wpr;
    if (wA === wB) {
      n += popcount32(bm[row + wA] & maskA & maskB);
    } else {
      n += popcount32(bm[row + wA] & maskA);
      for (let w = wA + 1; w < wB; w++) n += popcount32(bm[row + w]);
      n += popcount32(bm[row + wB] & maskB);
    }
  }
  return n;
}

function regionSet(
  bm: Uint32Array, wpr: number,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const wA = x0 >> 5, wB = x1 >> 5;
  const maskA = (0xffffffff << (x0 & 31)) >>> 0;
  const maskB = (0xffffffff >>> (31 - (x1 & 31)));
  for (let y = y0; y <= y1; y++) {
    const row = y * wpr;
    if (wA === wB) {
      bm[row + wA] |= maskA & maskB;
    } else {
      bm[row + wA] |= maskA;
      for (let w = wA + 1; w < wB; w++) bm[row + w] = 0xffffffff;
      bm[row + wB] |= maskB;
    }
  }
}