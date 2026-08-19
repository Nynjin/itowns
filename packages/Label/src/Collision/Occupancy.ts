import { LabelManagerConfig } from '../Types/LabelConfig';

/**
 * Screen-occupancy structure: tracks the screen area already "claimed" by
 * placed labels and answers, for each new candidate, "may this footprint be
 * placed here?" (test*) followed by "claim it" (mark*).
 *
 * All coordinates are **full-resolution screen pixels**. Each implementation
 * applies its own downscale (raster occupancies) or cell size (grid)
 * internally, so callers never need to know the structure's resolution.
 *
 * `prev` on the test methods = "was this label rendered last frame". Only then
 * may the occlusion tolerance (config.occlusionTol) relax the test; a brand-new
 * label always needs a clear footprint. This is the hysteresis that keeps
 * placement stable frame-to-frame.
 *
 * @see makeOccupancy for construction and the support matrix.
 */
export interface Occupancy {
    /** True when {@link testQuad}/{@link markQuad} test the exact rotated quad. */
    readonly supportsQuad: boolean;
    /**
     * True when occlusion tolerance (>0) is actually honored in the configured
     * bounds mode. Binary structures ignore it on their non-countable paths
     * (e.g. pyramid + quad), in which case this is false.
     */
    readonly supportsTolerance: boolean;

    /** (Re)allocate for a full-resolution screen of `screenW`×`screenH` px. */
    resize(screenW: number, screenH: number): void;
    /** Zero all occupancy. Does not reallocate. */
    clear(): void;

    /** True if the AABB may be placed (does not claim it). */
    testRect(x0: number, y0: number, x1: number, y1: number, prev: boolean): boolean;
    /** Claim the AABB. */
    markRect(x0: number, y0: number, x1: number, y1: number): void;

    /** True if the 4-corner quad may be placed (does not claim it). */
    testQuad(qx: ArrayLike<number>, qy: ArrayLike<number>, prev: boolean): boolean;
    /** Claim the 4-corner quad. */
    markQuad(qx: ArrayLike<number>, qy: ArrayLike<number>): void;
}

// ── packed-bit region primitives (shared by every raster occupancy) ──────────

/** OR-set a packed-bit region on one level. */
export function regionSet(bm: Uint32Array, wpr: number, x0: number, y0: number, x1: number, y1: number): void {
    const wA = x0 >> 5, wB = x1 >> 5;
    const maskA = (0xffffffff << (x0 & 31)) >>> 0;
    const maskB = (0xffffffff >>> (31 - (x1 & 31)));
    for (let y = y0; y <= y1; y++) {
        const row = y * wpr;
        if (wA === wB) { bm[row + wA] |= maskA & maskB; } else {
            bm[row + wA] |= maskA;
            for (let w = wA + 1; w < wB; w++) { bm[row + w] = 0xffffffff; }
            bm[row + wB] |= maskB;
        }
    }
}

/** True if no bit is set in a packed-bit region of one level. Early-exits. */
export function regionEmpty(bm: Uint32Array, wpr: number, x0: number, y0: number, x1: number, y1: number): boolean {
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

function popc(v: number): number {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Occlusion test that never counts more than it must. Walk row by row and stop
 * as soon as the answer is decided in either direction:
 *   occupied > limit                      → deny  (already too covered)
 *   occupied + rows-still-to-come ≤ limit → accept (cannot possibly exceed)
 * Exact same predicate as counting the whole box, at a fraction of the reads.
 */
function regionOccludedWithin(
    bm: Uint32Array, wpr: number, x0: number, y0: number, x1: number, y1: number, limit: number,
): boolean {
    const wA = x0 >> 5, wB = x1 >> 5;
    const maskA = (0xffffffff << (x0 & 31)) >>> 0;
    const maskB = (0xffffffff >>> (31 - (x1 & 31)));
    const perRow = x1 - x0 + 1;
    let n = 0, remaining = perRow * (y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) {
        const row = y * wpr;
        if (wA === wB) { n += popc(bm[row + wA] & maskA & maskB); } else {
            n += popc(bm[row + wA] & maskA);
            for (let w = wA + 1; w < wB; w++) { n += popc(bm[row + w]); }
            n += popc(bm[row + wB] & maskB);
        }
        remaining -= perRow;
        if (n > limit) { return false; }          // decided: too occluded
        if (n + remaining <= limit) { return true; } // decided: cannot exceed
    }
    return n <= limit;
}

type SpanCb = (y: number, x0: number, x1: number) => boolean | void;

/**
 * Scanline decomposition of a 4-corner quad at raster (shifted) resolution.
 * `cb(y,x0,x1)` returning false aborts the walk and makes this return false.
 * Spans are conservative: the x-extent is taken over the whole row band
 * [y,y+1], so a thin diagonal sliver cannot slip between two scanlines.
 */
function quadSpans(qx: ArrayLike<number>, qy: ArrayLike<number>, shift: number, W: number, H: number, cb: SpanCb): boolean {
    const inv = 1 / (1 << shift);
    const xs = [qx[0] * inv, qx[1] * inv, qx[2] * inv, qx[3] * inv];
    const ys = [qy[0] * inv, qy[1] * inv, qy[2] * inv, qy[3] * inv];
    let minY = 1e9, maxY = -1e9;
    for (let k = 0; k < 4; k++) { if (ys[k] < minY) { minY = ys[k]; } if (ys[k] > maxY) { maxY = ys[k]; } }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
        const yt = y, yb = y + 1; let lo = 1e9, hi = -1e9;
        for (let e = 0; e < 4; e++) {
            const ax = xs[e], ay = ys[e], bx = xs[(e + 1) & 3], by = ys[(e + 1) & 3];
            if ((ay <= yt && by > yt) || (by <= yt && ay > yt)) { const x = ax + (bx - ax) * (yt - ay) / (by - ay); if (x < lo) { lo = x; } if (x > hi) { hi = x; } }
            if ((ay <= yb && by > yb) || (by <= yb && ay > yb)) { const x = ax + (bx - ax) * (yb - ay) / (by - ay); if (x < lo) { lo = x; } if (x > hi) { hi = x; } }
            if (ay >= yt && ay <= yb) { if (ax < lo) { lo = ax; } if (ax > hi) { hi = ax; } }
        }
        if (hi < lo) { continue; }
        const x0 = Math.max(0, Math.floor(lo)), x1 = Math.min(W - 1, Math.ceil(hi));
        if (x0 > x1) { continue; }
        if (cb(y, x0, x1) === false) { return false; }
    }
    return true;
}

function quadAABB(qx: ArrayLike<number>, qy: ArrayLike<number>, out: [number, number, number, number]): void {
    let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
    for (let k = 0; k < 4; k++) {
        const X = qx[k], Y = qy[k];
        if (X < mnx) { mnx = X; } if (X > mxx) { mxx = X; }
        if (Y < mny) { mny = Y; } if (Y > mxy) { mxy = Y; }
    }
    out[0] = mnx; out[1] = mny; out[2] = mxx; out[3] = mxy;
}

function log2OfPow2(n: number, name: string): number {
    if (n < 1 || (n & (n - 1)) !== 0) { throw new Error(`${name} must be a power of 2, got ${n}`); }
    let s = 0;
    while (1 << s < n) { s++; }
    return s;
}

// ── occupancy implementations ────────────────────────────────────────────────

/** Uniform hash grid over exact AABBs. AABB only (quad falls back to its AABB). */
function makeGrid(config: LabelManagerConfig): Occupancy {
    const cell = Math.max(1, config.gridCell | 0);
    const tol = config.occlusionTol;
    let screenW = 1, screenH = 1, gw = 1, gh = 1;
    let grid: number[][] = [];
    let px0!: Float32Array, py0!: Float32Array, px1!: Float32Array, py1!: Float32Array;
    let seen!: Int32Array, cnt = 0, capN = 0, stamp = 0;

    const alloc = (cap: number) => {
        capN = Math.max(1024, cap);
        px0 = new Float32Array(capN); py0 = new Float32Array(capN);
        px1 = new Float32Array(capN); py1 = new Float32Array(capN);
        seen = new Int32Array(capN); cnt = 0; stamp = 0;
    };
    const grow = () => {
        if (cnt < capN) { return; }
        const nc = capN * 2;
        const g = (a: Float32Array) => { const b = new Float32Array(nc); b.set(a); return b; };
        px0 = g(px0); py0 = g(py0); px1 = g(px1); py1 = g(py1);
        const s = new Int32Array(nc); s.set(seen); seen = s; capN = nc;
    };
    const onScreen = (x0: number, y0: number, x1: number, y1: number) =>
        x1 >= 0 && y1 >= 0 && x0 <= screenW && y0 <= screenH;
    const add = (x0: number, y0: number, x1: number, y1: number) => {
        grow(); const id = cnt++;
        px0[id] = x0; py0[id] = y0; px1[id] = x1; py1[id] = y1;
        let a = (x0 / cell) | 0, b = (x1 / cell) | 0, c = (y0 / cell) | 0, d = (y1 / cell) | 0;
        if (a < 0) { a = 0; } if (c < 0) { c = 0; } if (b >= gw) { b = gw - 1; } if (d >= gh) { d = gh - 1; }
        for (let gy = c; gy <= d; gy++) { for (let gx = a; gx <= b; gx++) { grid[gy * gw + gx].push(id); } }
    };
    // limit < 0 → binary (any hit rejects). limit ≥ 0 → tolerance: accumulate the
    // covered area and reject once it exceeds the limit. The store only ever holds
    // NON-overlapping placed rects, so summing pairwise intersections is exact.
    const query = (x0: number, y0: number, x1: number, y1: number, limit: number): boolean => {
        const binary = limit < 0; let covered = 0; stamp++;
        let a = (x0 / cell) | 0, b = (x1 / cell) | 0, c = (y0 / cell) | 0, d = (y1 / cell) | 0;
        if (a < 0) { a = 0; } if (c < 0) { c = 0; } if (b >= gw) { b = gw - 1; } if (d >= gh) { d = gh - 1; }
        for (let gy = c; gy <= d; gy++) {
            for (let gx = a; gx <= b; gx++) {
                const bk = grid[gy * gw + gx];
                for (let k = 0; k < bk.length; k++) {
                    const p = bk[k];
                    if (seen[p] === stamp) { continue; } seen[p] = stamp;
                    if (!(x0 <= px1[p] && x1 >= px0[p] && y0 <= py1[p] && y1 >= py0[p])) { continue; }
                    if (binary) { return false; }
                    const ix = Math.min(x1, px1[p]) - Math.max(x0, px0[p]);
                    const iy = Math.min(y1, py1[p]) - Math.max(y0, py0[p]);
                    if (ix > 0 && iy > 0) { covered += ix * iy; }
                    if (covered > limit) { return false; }
                }
            }
        }
        return true;
    };
    const lim = (prev: boolean, x0: number, y0: number, x1: number, y1: number) =>
        (prev && tol > 0) ? tol * Math.max(1, x1 - x0) * Math.max(1, y1 - y0) : -1;
    const scratch: [number, number, number, number] = [0, 0, 0, 0];

    return {
        supportsQuad: false,
        supportsTolerance: tol > 0,
        resize(w, h) {
            screenW = Math.max(1, w); screenH = Math.max(1, h);
            gw = Math.ceil(screenW / cell); gh = Math.ceil(screenH / cell);
            grid = Array.from({ length: gw * gh }, () => []);
            alloc(1024);
        },
        clear() { cnt = 0; for (let g = 0; g < grid.length; g++) { grid[g].length = 0; } },
        testRect(x0, y0, x1, y1, prev) { return !onScreen(x0, y0, x1, y1) || query(x0, y0, x1, y1, lim(prev, x0, y0, x1, y1)); },
        markRect(x0, y0, x1, y1) { if (onScreen(x0, y0, x1, y1)) { add(x0, y0, x1, y1); } },
        testQuad(qx, qy, prev) { quadAABB(qx, qy, scratch); return this.testRect(scratch[0], scratch[1], scratch[2], scratch[3], prev); },
        markQuad(qx, qy) { quadAABB(qx, qy, scratch); this.markRect(scratch[0], scratch[1], scratch[2], scratch[3]); },
    };
}

/** Flat packed-bit raster. Count-based → occlusion tolerance on AABB and quad. */
function makeBitmap(config: LabelManagerConfig): Occupancy {
    const shift = log2OfPow2(config.downscale, 'downscale');
    const m = (1 << shift) - 1;
    const tol = config.occlusionTol;
    let W = 1, H = 1, wpr = 1, bits = new Uint32Array(1);
    const regionCount = (x0: number, y0: number, x1: number, y1: number): number => {
        const wA = x0 >> 5, wB = x1 >> 5;
        const maskA = (0xffffffff << (x0 & 31)) >>> 0;
        const maskB = (0xffffffff >>> (31 - (x1 & 31)));
        let n = 0;
        for (let y = y0; y <= y1; y++) {
            const r = y * wpr;
            if (wA === wB) { n += popc(bits[r + wA] & maskA & maskB); } else {
                n += popc(bits[r + wA] & maskA);
                for (let w = wA + 1; w < wB; w++) { n += popc(bits[r + w]); }
                n += popc(bits[r + wB] & maskB);
            }
        }
        return n;
    };
    const spanTest = (walk: (cb: SpanCb) => boolean, tl: number): boolean => {
        if (tl <= 0) { return walk((y, a, b) => regionEmpty(bits, wpr, a, y, b, y)); }
        let o = 0, t = 0;
        walk((y, a, b) => { o += regionCount(a, y, b, y); t += b - a + 1; return true; });
        return t === 0 || o / t <= tl;
    };
    return {
        supportsQuad: true,
        supportsTolerance: tol > 0,
        resize(w, h) {
            W = Math.max(1, Math.ceil(w / config.downscale));
            H = Math.max(1, Math.ceil(h / config.downscale));
            wpr = (W + 31) >> 5; bits = new Uint32Array(wpr * H);
        },
        clear() { bits.fill(0); },
        testRect(x0, y0, x1, y1, prev) {
            const a = x0 >> shift, b = Math.min(W - 1, (x1 + m) >> shift), c = y0 >> shift, d = Math.min(H - 1, (y1 + m) >> shift);
            const tl = prev ? tol : 0;
            if (tl <= 0) { return regionEmpty(bits, wpr, a, c, b, d); }
            return regionOccludedWithin(bits, wpr, a, c, b, d, tl * (b - a + 1) * (d - c + 1));
        },
        markRect(x0, y0, x1, y1) {
            regionSet(bits, wpr, x0 >> shift, y0 >> shift, Math.min(W - 1, (x1 + m) >> shift), Math.min(H - 1, (y1 + m) >> shift));
        },
        testQuad(qx, qy, prev) { return spanTest(cb => quadSpans(qx, qy, shift, W, H, cb), prev ? tol : 0); },
        markQuad(qx, qy) { quadSpans(qx, qy, shift, W, H, (y, a, b) => { regionSet(bits, wpr, a, y, b, y); return true; }); },
    };
}

/**
 * Word-summary bit hierarchy. Level 0 is a flat bitmap; each summary bit covers
 * a whole WORD × 4 rows (branching 128), so one packed-word compare can clear a
 * 1024×16 region. Coarse levels are conservative (a set bit only means "look
 * finer"), so exactness always comes from level 0 — which, being a bitmap, also
 * supports count-based occlusion tolerance.
 */
function makeSummary(config: LabelManagerConfig): Occupancy {
    const shift = log2OfPow2(config.downscale, 'downscale');
    const m = (1 << shift) - 1;
    const tol = config.occlusionTol, sinv = 1 / (1 << shift);
    let W = 1, H = 1;
    let w0 = 1, B0 = new Uint32Array(1);
    let w1 = 1, B1 = new Uint32Array(1);
    let w2 = 1, B2 = new Uint32Array(1);
    const coarseEmpty = (a: number, c: number, b: number, d: number) =>
        regionEmpty(B2, w2, a >> 10, c >> 4, b >> 10, d >> 4) || regionEmpty(B1, w1, a >> 5, c >> 2, b >> 5, d >> 2);
    const setSpan = (a: number, y: number, b: number) => {
        regionSet(B0, w0, a, y, b, y);
        regionSet(B1, w1, a >> 5, y >> 2, b >> 5, y >> 2);
        regionSet(B2, w2, a >> 10, y >> 4, b >> 10, y >> 4);
    };
    const scratch: [number, number, number, number] = [0, 0, 0, 0];
    return {
        supportsQuad: true,
        supportsTolerance: tol > 0,
        resize(w, h) {
            W = Math.max(1, Math.ceil(w / config.downscale)); H = Math.max(1, Math.ceil(h / config.downscale));
            w0 = (W + 31) >> 5; B0 = new Uint32Array(w0 * H);
            const W1 = Math.ceil(W / 32), H1 = Math.ceil(H / 4); w1 = (W1 + 31) >> 5; B1 = new Uint32Array(w1 * H1);
            const W2 = Math.ceil(W / 1024), H2 = Math.ceil(H / 16); w2 = (W2 + 31) >> 5; B2 = new Uint32Array(w2 * H2);
        },
        clear() { B0.fill(0); B1.fill(0); B2.fill(0); },
        testRect(x0, y0, x1, y1, prev) {
            const a = x0 >> shift, b = Math.min(W - 1, (x1 + m) >> shift), c = y0 >> shift, d = Math.min(H - 1, (y1 + m) >> shift);
            if (coarseEmpty(a, c, b, d)) { return true; }
            if (prev && tol > 0) { return regionOccludedWithin(B0, w0, a, c, b, d, tol * (b - a + 1) * (d - c + 1)); }
            return regionEmpty(B0, w0, a, c, b, d);
        },
        markRect(x0, y0, x1, y1) {
            const a = x0 >> shift, b = Math.min(W - 1, (x1 + m) >> shift), c = y0 >> shift, d = Math.min(H - 1, (y1 + m) >> shift);
            regionSet(B0, w0, a, c, b, d); regionSet(B1, w1, a >> 5, c >> 2, b >> 5, d >> 2); regionSet(B2, w2, a >> 10, c >> 4, b >> 10, d >> 4);
        },
        testQuad(qx, qy) {
            quadAABB(qx, qy, scratch);
            const a = Math.max(0, Math.floor(scratch[0] * sinv)), b = Math.min(W - 1, Math.ceil(scratch[2] * sinv));
            const c = Math.max(0, Math.floor(scratch[1] * sinv)), d = Math.min(H - 1, Math.ceil(scratch[3] * sinv));
            if (a > b || c > d) { return true; }
            if (coarseEmpty(a, c, b, d)) { return true; }
            return quadSpans(qx, qy, shift, W, H, (y, p, q) => regionEmpty(B0, w0, p, y, q, y));
        },
        markQuad(qx, qy) { quadSpans(qx, qy, shift, W, H, (y, p, q) => { setSpan(p, y, q); return true; }); },
    };
}

/**
 * Binary quadtree pyramid. Descends from the coarsest level and only recurses
 * into set cells, so a large empty region is confirmed near the top instead of
 * scanning every fine cell. Level 0 is a bitmap → occlusion tolerance works on
 * the AABB path; the quad path is binary (spans) and cannot count, so tolerance
 * is not honored there (supportsTolerance reflects the configured bounds mode).
 */
function makePyramid(config: LabelManagerConfig): Occupancy {
    const shift = log2OfPow2(config.downscale, 'downscale');
    const m = (1 << shift) - 1;
    const tol = config.occlusionTol;
    const maxLevels = Math.max(1, config.pyramidLevels | 0);
    let PW = 1, PH = 1, L = 0;
    let levels: { wpr: number; bits: Uint32Array }[] = [];

    const descend = (k: number, x0: number, y0: number, x1: number, y1: number): boolean => {
        if (k === 0) { const lv = levels[0]; return regionEmpty(lv.bits, lv.wpr, x0, y0, x1, y1); }
        const lv = levels[k], bits = lv.bits, wpr = lv.wpr;
        const cx0 = x0 >> k, cx1 = x1 >> k, cy0 = y0 >> k, cy1 = y1 >> k;
        for (let cy = cy0; cy <= cy1; cy++) {
            const row = cy * wpr;
            for (let cx = cx0; cx <= cx1; cx++) {
                if ((bits[row + (cx >> 5)] & (1 << (cx & 31))) === 0) { continue; }
                const chx0 = Math.max(x0, cx << k), chy0 = Math.max(y0, cy << k);
                const chx1 = Math.min(x1, ((cx + 1) << k) - 1), chy1 = Math.min(y1, ((cy + 1) << k) - 1);
                if (!descend(k - 1, chx0, chy0, chx1, chy1)) { return false; }
            }
        }
        return true;
    };
    const setAll = (a: number, c: number, b: number, d: number) => {
        for (let k = 0; k < L; k++) { const lv = levels[k]; regionSet(lv.bits, lv.wpr, a >> k, c >> k, b >> k, d >> k); }
    };
    // A non-rectangular footprint writes exact spans to level 0 and just its
    // bounding box to the coarse levels (a set coarse cell only means "descend").
    const setCoarse = (a: number, c: number, b: number, d: number) => {
        for (let k = 1; k < L; k++) { const lv = levels[k]; regionSet(lv.bits, lv.wpr, a >> k, c >> k, b >> k, d >> k); }
    };
    return {
        supportsQuad: true,
        supportsTolerance: tol > 0 && config.boundsMode === 'aabb',
        resize(w, h) {
            PW = Math.max(1, Math.ceil(w / config.downscale)); PH = Math.max(1, Math.ceil(h / config.downscale));
            levels = []; let lw = PW, lh = PH;
            for (let k = 0; ; k++) {
                const wpr = (lw + 31) >> 5;
                levels.push({ wpr, bits: new Uint32Array(wpr * lh) });
                if ((lw <= 1 && lh <= 1) || k + 1 >= maxLevels) { break; }
                lw = (lw + 1) >> 1; lh = (lh + 1) >> 1;
            }
            L = levels.length;
        },
        clear() { for (let k = 0; k < L; k++) { levels[k].bits.fill(0); } },
        testRect(x0, y0, x1, y1, prev) {
            const a = x0 >> shift, b = Math.min(PW - 1, (x1 + m) >> shift), c = y0 >> shift, d = Math.min(PH - 1, (y1 + m) >> shift);
            if (prev && tol > 0) {
                if (descend(L - 1, a, c, b, d)) { return true; }
                const l0 = levels[0];
                return regionOccludedWithin(l0.bits, l0.wpr, a, c, b, d, tol * (b - a + 1) * (d - c + 1));
            }
            return descend(L - 1, a, c, b, d);
        },
        markRect(x0, y0, x1, y1) {
            const a = x0 >> shift, b = Math.min(PW - 1, (x1 + m) >> shift), c = y0 >> shift, d = Math.min(PH - 1, (y1 + m) >> shift);
            setAll(a, c, b, d);
        },
        testQuad(qx, qy) {
            let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
            for (let k = 0; k < 4; k++) { const X = qx[k], Y = qy[k]; if (X < mnx) { mnx = X; } if (X > mxx) { mxx = X; } if (Y < mny) { mny = Y; } if (Y > mxy) { mxy = Y; } }
            const inv = 1 / (1 << shift);
            const a = Math.max(0, Math.floor(mnx * inv)), b = Math.min(PW - 1, Math.ceil(mxx * inv));
            const c = Math.max(0, Math.floor(mny * inv)), d = Math.min(PH - 1, Math.ceil(mxy * inv));
            if (a > b || c > d) { return true; }
            if (descend(L - 1, a, c, b, d)) { return true; }        // coarse accept
            const l0 = levels[0];
            return quadSpans(qx, qy, shift, PW, PH, (y, p, q) => regionEmpty(l0.bits, l0.wpr, p, y, q, y));
        },
        markQuad(qx, qy) {
            const l0 = levels[0]; let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
            quadSpans(qx, qy, shift, PW, PH, (y, a, b) => {
                regionSet(l0.bits, l0.wpr, a, y, b, y);
                if (a < mnx) { mnx = a; } if (b > mxx) { mxx = b; } if (y < mny) { mny = y; } if (y > mxy) { mxy = y; }
                return true;
            });
            if (mxx >= mnx) { setCoarse(mnx, mny, mxx, mxy); }
        },
    };
}

/**
 * Build the occupancy selected by `config.occupancyMethod`. All coordinates
 * passed to the returned object are full-resolution screen pixels.
 *
 * Support matrix (see {@link Occupancy.supportsQuad}/{@link Occupancy.supportsTolerance}):
 *   grid    — AABB only; tolerance via area-ratio
 *   bitmap  — AABB + quad; tolerance on both (count-based)
 *   summary — AABB + quad; tolerance on both (level-0 count)
 *   pyramid — AABB + quad; tolerance on AABB only (quad path is binary)
 */
export function makeOccupancy(config: LabelManagerConfig): Occupancy {
    switch (config.occupancyMethod) {
        case 'grid':    return makeGrid(config);
        case 'bitmap':  return makeBitmap(config);
        case 'summary': return makeSummary(config);
        case 'pyramid':
        default:        return makePyramid(config);
    }
}
