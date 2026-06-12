import { Matrix4 } from 'three';
import { Label } from '../Label';
import { HierarchicalBitmap } from '../Collision/HierarchicalBitmap';
import { LabelProjector, ScreenAABB } from '../Collision/LabelProjector';
import type { LabelManagerConfig } from '../Types/LabelConfig';

/**
 * Collision engine variant for Web Worker context.
 *
 * Identical algorithm to LabelCollisionEngine but:
 *   - no WebGLRenderer dependency (viewport size set explicitly)
 *   - evaluate() accepts pre-extracted camera matrices instead of a Camera object
 *   - advanceFades() is co-located here since the worker owns all label state
 */
export class WorkerCollisionEngine {
    private readonly _labelsById = new Map<string, Label>();
    private readonly _candidates: Label[] = [];

    private readonly _downscaleShift: number;
    private readonly _bitmap:         HierarchicalBitmap;
    private readonly _projector:      LabelProjector;
    private readonly _numBuckets:     number;
    private readonly _buckets:        Label[][];
    private readonly _scratchAABB:    ScreenAABB = { x0: 0, y0: 0, x1: 0, y1: 0 };
    /** Ids whose shouldRender / isCandidate changed this pass — reused. */
    private readonly _changed         = new Set<string>();
    /** Reused matrices for the per-evaluation camera frame (setFrame copies them). */
    private readonly _viewMat         = new Matrix4();
    private readonly _projMat          = new Matrix4();
    private readonly _config:         LabelManagerConfig;

    constructor(config: LabelManagerConfig) {
        this._config         = config;
        this._downscaleShift = log2OfPow2(config.downscale);
        this._bitmap         = new HierarchicalBitmap(config.coarseScale);
        this._projector      = new LabelProjector(config);
        this._numBuckets     = config.collisionBuckets;
        this._buckets        = Array.from({ length: this._numBuckets }, () => []);
    }

    // ── Label registration ───────────────────────────────────────────────────

    addLabels(labels: Label[]) {
        for (const l of labels) this._labelsById.set(l.id, l);
    }

    removeLabels(ids: string[]) {
        if (ids.length === 0) return;
        for (const id of ids) this._labelsById.delete(id);
        const idSet = new Set(ids);
        const c = this._candidates;
        for (let i = c.length - 1; i >= 0; i--) {
            if (idSet.has(c[i].id)) c.splice(i, 1);
        }
    }

    /** Explicit viewport resize — call when the canvas size changes. */
    setViewport(vpWidth: number, vpHeight: number) {
        const w = Math.max(1, vpWidth  >> this._downscaleShift);
        const h = Math.max(1, vpHeight >> this._downscaleShift);
        if (w !== this._bitmap.width || h !== this._bitmap.height) {
            this._bitmap.resize(w, h);
        }
    }

    // ── Collision evaluation ─────────────────────────────────────────────────

    /**
     * Run one collision pass.
     * @returns ids + typed arrays of updated shouldRender / isCandidate.
     *          Only labels whose state changed are included.
     */
    evaluate(
        projMatrix: Float32Array, viewMatrix: Float32Array,
        camX: number, camY: number, camZ: number,
        near: number, far: number,
    ): { ids: string[]; shouldRender: Uint8Array; isCandidate: Uint8Array } | null {
        if (this._labelsById.size === 0) return null;

        this._projector.setFrame(
            this._viewMat.fromArray(viewMatrix),
            this._projMat.fromArray(projMatrix),
            this._bitmap.width,
            this._bitmap.height,
            far,
        );
        this._bitmap.clear();

        const logMin   = Math.log1p(near * near);
        const logMax   = Math.log1p(far  * far);
        const logRange = (logMax - logMin) || 1;
        const logScale = (this._numBuckets - 1) / logRange;

        this._candidates.length = 0;
        const changed = this._changed;
        changed.clear();

        for (const label of this._labelsById.values()) {
            const wasCandidate = label.isCandidate;
            if (!label.groupVisible) {
                if (label.shouldRender) { label.shouldRender = false; changed.add(label.id); }
                label.isCandidate = false;
                if (wasCandidate) changed.add(label.id);
                continue;
            }
            label.isCandidate =
                label.visible &&
                label.opacity > 0 &&
                label.glyphs.length > 0 &&
                label.bounds.width > 0 &&
                this._projector.checkVisible(label);
            if (label.isCandidate !== wasCandidate) changed.add(label.id);

            if (!label.isCandidate) {
                if (label.shouldRender) { label.shouldRender = false; changed.add(label.id); }
                continue;
            }

            const dx = label.position.x - camX;
            const dy = label.position.y - camY;
            const dz = label.position.z - camZ;
            const distSq = dx * dx + dy * dy + dz * dz;
            label.score = distSq * ((this._config.baseFontSize / label.fontSize) ** this._config.fontSizePriorityPower);
            this._candidates.push(label);
        }

        if (this._candidates.length > 0) {
            let minBucket = this._numBuckets, maxBucket = -1;
            for (const label of this._candidates) {
                let logScore = Math.log1p(label.score);
                if (!label.shouldRender) logScore *= this._config.renderPenaltyMultiplier;
                let b = ((logScore - logMin) * logScale) | 0;
                if (b < 0) b = 0; else if (b >= this._numBuckets) b = this._numBuckets - 1;
                this._buckets[b].push(label);
                if (b < minBucket) minBucket = b;
                if (b > maxBucket) maxBucket = b;
            }

            const aabb = this._scratchAABB;
            for (let b = minBucket; b <= maxBucket; b++) {
                const bucket = this._buckets[b];
                for (const label of bucket) {
                    if (!this._projector.project(label, aabb)) {
                        if (label.shouldRender) { label.shouldRender = false; changed.add(label.id); }
                        continue;
                    }
                    const { x0, y0, x1, y1 } = aabb;
                    let sr: boolean;
                    if (this._bitmap.isCoarseEmpty(x0, y0, x1, y1)) {
                        this._bitmap.setRegion(x0, y0, x1, y1);
                        sr = true;
                    } else {
                        const area  = (x1 - x0 + 1) * (y1 - y0 + 1);
                        const occ   = this._bitmap.countFine(x0, y0, x1, y1);
                        const thr   = label.shouldRender ? this._config.maxOcclusion : this._config.acceptableOcclusion;
                        sr = occ / area <= thr;
                        if (sr) this._bitmap.setRegion(x0, y0, x1, y1);
                    }
                    if (sr !== label.shouldRender) { label.shouldRender = sr; changed.add(label.id); }
                }
                bucket.length = 0;
            }
        }

        if (changed.size === 0) return null;

        // Emit only the labels whose shouldRender / isCandidate actually changed.
        const ids = [...changed];
        const shouldRender = new Uint8Array(ids.length);
        const isCandidate  = new Uint8Array(ids.length);
        for (let i = 0; i < ids.length; i++) {
            const l = this._labelsById.get(ids[i]);
            if (!l) continue;
            shouldRender[i] = l.shouldRender ? 1 : 0;
            isCandidate[i]  = l.isCandidate  ? 1 : 0;
        }
        return { ids, shouldRender, isCandidate };
    }

    // ── Fade advancement ─────────────────────────────────────────────────────

    /**
     * Advance all occlusionFade values toward their target.
     * @returns changed label ids + new fade values, or null if nothing moved.
     */
    advanceFades(frameDeltaMs: number): { ids: string[]; occlusionFades: Float32Array } | null {
        const step = frameDeltaMs / this._config.fadeDurationMs;
        const ids: string[] = [];
        const fades: number[] = [];

        for (const label of this._labelsById.values()) {
            const target = label.shouldRender ? 0.0 : 1.0;
            if (label.occlusionFade === target) continue;
            label.occlusionFade = label.occlusionFade < target
                ? Math.min(target, label.occlusionFade + step)
                : Math.max(target, label.occlusionFade - step);
            ids.push(label.id);
            fades.push(label.occlusionFade);
        }

        if (ids.length === 0) return null;
        return { ids, occlusionFades: new Float32Array(fades) };
    }
}

function log2OfPow2(n: number): number {
    if (n < 1 || (n & (n - 1)) !== 0) throw new Error(`downscale must be a power of 2, got ${n}`);
    let s = 0;
    while (1 << s < n) s++;
    return s;
}
