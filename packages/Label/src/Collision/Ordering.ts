import { Label } from '../Label';
import { LabelManagerConfig } from '../Types/LabelConfig';

/**
 * Priority-ordering strategy for the collision pass. Given this frame's
 * candidates and their priority keys (lower key = higher priority = placed
 * first), fill `out` with the labels in attempt order and return the count.
 *
 * `keyMin`/`keyMax` bound the key domain for fixed-range bucketing; radix
 * ignores them and calibrates to the observed key range instead.
 *
 * @see makeOrdering
 */
export interface Ordering {
    run(
        candidates: Label[], keys: Float64Array, n: number,
        keyMin: number, keyMax: number, out: Label[],
    ): number;
}

/**
 * Depth-bucket scatter — O(n). Scatter each candidate into one of K buckets by
 * its key over the fixed [keyMin,keyMax] domain, then walk buckets near→far.
 * Labels in the same bucket keep candidate order. This reproduces the historical
 * LabelCollisionEngine ordering exactly when fed log-domain keys and the
 * near/far-derived key range.
 */
class BucketOrdering implements Ordering {
    private readonly _K: number;
    private readonly _buckets: Label[][];

    constructor(numBuckets: number) {
        this._K = Math.max(1, numBuckets | 0);
        this._buckets = Array.from({ length: this._K }, () => []);
    }

    run(candidates: Label[], keys: Float64Array, n: number, keyMin: number, keyMax: number, out: Label[]): number {
        const K = this._K, buckets = this._buckets;
        const scale = (K - 1) / ((keyMax - keyMin) || 1);
        let minB = K, maxB = -1;
        for (let i = 0; i < n; i++) {
            let b = ((keys[i] - keyMin) * scale) | 0;
            if (b < 0) { b = 0; } else if (b >= K) { b = K - 1; }
            buckets[b].push(candidates[i]);
            if (b < minB) { minB = b; }
            if (b > maxB) { maxB = b; }
        }
        let p = 0;
        for (let b = minB; b <= maxB; b++) {
            const bk = buckets[b];
            for (let j = 0; j < bk.length; j++) { out[p++] = bk[j]; }
            bk.length = 0;
        }
        return p;
    }
}

/**
 * LSD radix sort — O(n·d). Quantises the key to 20 bits over the observed range
 * and sorts by two 10-bit digits (two stable counting-sort passes). Produces the
 * order a comparison sort would, at linear cost and with no comparisons. Exact
 * ordering (no intra-bucket jitter) unlike {@link BucketOrdering}.
 */
class RadixOrdering implements Ordering {
    private _q = new Int32Array(0);
    private _idxSrc = new Int32Array(0);
    private _idxDst = new Int32Array(0);
    private readonly _cnt = new Int32Array(1024);

    run(candidates: Label[], keys: Float64Array, n: number, _keyMin: number, _keyMax: number, out: Label[]): number {
        if (this._q.length < n) {
            this._q = new Int32Array(n);
            this._idxSrc = new Int32Array(n);
            this._idxDst = new Int32Array(n);
        }
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) { const k = keys[i]; if (k < lo) { lo = k; } if (k > hi) { hi = k; } }
        const scale = 1048575 / ((hi - lo) || 1); // 2^20 - 1
        const q = this._q;
        for (let i = 0; i < n; i++) { q[i] = ((keys[i] - lo) * scale) | 0; }

        let src = this._idxSrc, dst = this._idxDst;
        for (let i = 0; i < n; i++) { src[i] = i; }
        const cnt = this._cnt;
        for (let sh = 0; sh < 20; sh += 10) {
            cnt.fill(0);
            for (let i = 0; i < n; i++) { cnt[(q[src[i]] >> sh) & 1023]++; }
            let s = 0;
            for (let b = 0; b < 1024; b++) { const c = cnt[b]; cnt[b] = s; s += c; }
            for (let i = 0; i < n; i++) { const d = (q[src[i]] >> sh) & 1023; dst[cnt[d]++] = src[i]; }
            const t = src; src = dst; dst = t;
        }
        for (let i = 0; i < n; i++) { out[i] = candidates[src[i]]; }
        return n;
    }
}

/** Build the ordering selected by `config.sortMethod`. */
export function makeOrdering(config: LabelManagerConfig): Ordering {
    if (config.sortMethod === 'radix') { return new RadixOrdering(); }
    return new BucketOrdering(config.collisionBuckets);
}
