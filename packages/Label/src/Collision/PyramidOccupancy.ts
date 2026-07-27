/**
 * Binary screen-occupancy as a quadtree pyramid of packed bits.
 *
 * Coordinates are given in finest-layer ("level 0") cells. Each higher level is
 * half the resolution per axis, and a cell is set iff ANY of its four children is.
 *
 * This is a *binary* occupancy grid — a cell is either free or taken, there is no
 * partial-occlusion ratio. Two things make it fast:
 *   • {@link isEmpty} descends from the coarsest level and only recurses into cells
 *     that are set, so a large empty region is confirmed empty near the top of the
 *     pyramid instead of scanning every fine cell (the cost of the old flat
 *     count-based bitmap grew with label *area*).
 *   • it early-exits on the first set cell it finds inside the query box.
 *
 * `maxLevels` caps the pyramid depth: 1 is a flat early-exit bitmap (no pruning),
 * deeper prunes large empties better but adds descent overhead on tiny boxes — so
 * the sweet spot depends on the collision resolution and typical label size.
 */
export class PyramidOccupancy {
    private levels: { wpr: number; bits: Uint32Array }[] = [];
    private _levelCount = 0;
    private readonly _maxLevels: number;
    private _w = 1;
    private _h = 1;

    /** @param maxLevels Maximum pyramid depth (>= 1). */
    constructor(maxLevels = 4) {
        this._maxLevels = Math.max(1, maxLevels | 0);
    }

    get width():  number { return this._w; }
    get height(): number { return this._h; }

    /** Resize and clear the pyramid. Level 0 is `w`×`h` cells. */
    resize(w: number, h: number): void {
        this._w = Math.max(1, w);
        this._h = Math.max(1, h);
        this.levels = [];
        let lw = this._w, lh = this._h;
        for (let k = 0; ; k++) {
            const wpr = (lw + 31) >> 5;
            this.levels.push({ wpr, bits: new Uint32Array(wpr * lh) });
            if ((lw <= 1 && lh <= 1) || k + 1 >= this._maxLevels) { break; }
            lw = (lw + 1) >> 1;
            lh = (lh + 1) >> 1;
        }
        this._levelCount = this.levels.length;
    }

    /** Clear every level. Does not reallocate. */
    clear(): void {
        for (let k = 0; k < this._levelCount; k++) { this.levels[k].bits.fill(0); }
    }

    /** True if no bit is set anywhere in [x0,y0]-[x1,y1]. Early-exits. */
    isEmpty(x0: number, y0: number, x1: number, y1: number): boolean {
        return this._descend(this._levelCount - 1, x0, y0, x1, y1);
    }

    /** OR-set every bit in [x0,y0]-[x1,y1] on all levels. */
    set(x0: number, y0: number, x1: number, y1: number): void {
        for (let k = 0; k < this._levelCount; k++) {
            const lv = this.levels[k];
            regionSet(lv.bits, lv.wpr, x0 >> k, y0 >> k, x1 >> k, y1 >> k);
        }
    }

    private _descend(k: number, x0: number, y0: number, x1: number, y1: number): boolean {
        // At the leaf, scan word-parallel instead of one bit per cell: testing
        // individual bits throws away the 32× parallelism a flat packed bitmap
        // gets, and that costs far more than the coarse pruning above saves.
        // (It also makes maxLevels=1 degenerate to exactly a flat bitmap.)
        if (k === 0) {
            const lv = this.levels[0];
            return regionEmpty(lv.bits, lv.wpr, x0, y0, x1, y1);
        }
        const lv = this.levels[k], bits = lv.bits, wpr = lv.wpr;
        const cx0 = x0 >> k, cx1 = x1 >> k, cy0 = y0 >> k, cy1 = y1 >> k;
        for (let cy = cy0; cy <= cy1; cy++) {
            const row = cy * wpr;
            for (let cx = cx0; cx <= cx1; cx++) {
                if ((bits[row + (cx >> 5)] & (1 << (cx & 31))) === 0) { continue; } // subtree empty
                const chx0 = Math.max(x0, cx << k),       chy0 = Math.max(y0, cy << k);
                const chx1 = Math.min(x1, ((cx + 1) << k) - 1), chy1 = Math.min(y1, ((cy + 1) << k) - 1);
                if (!this._descend(k - 1, chx0, chy0, chx1, chy1)) { return false; }
            }
        }
        return true;
    }
}

/** True if no bit is set in a packed-bit region of one level. Early-exits. */
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
            if ((bm[row + wA] & maskA & maskB) !== 0) { return false; }
        } else {
            if ((bm[row + wA] & maskA) !== 0) { return false; }
            for (let w = wA + 1; w < wB; w++) { if (bm[row + w] !== 0) { return false; } }
            if ((bm[row + wB] & maskB) !== 0) { return false; }
        }
    }
    return true;
}

/** OR-set a packed-bit region in one level. */
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
            for (let w = wA + 1; w < wB; w++) { bm[row + w] = 0xffffffff; }
            bm[row + wB] |= maskB;
        }
    }
}
