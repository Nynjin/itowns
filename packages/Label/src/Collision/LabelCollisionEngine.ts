import { Camera, PerspectiveCamera, Vector2, WebGLRenderer } from 'three';
import { Label } from '../Label';
import { PyramidOccupancy } from './PyramidOccupancy';
import { LabelProjector, ScreenAABB } from './LabelProjector';
import { LabelManagerConfig } from '../Types/LabelConfig';
import { LabelProfiler } from '../Profiler';

/**
 * Resolves label occlusion by scoring candidates, then placing them 
 * near-to-far onto a hierarchical occupancy bitmap.
 *
 * Default scoring favors larger, closer and already visible labels.
 *
 * Call {@link evaluate} once per culling interval from the render loop.
 */
export class LabelCollisionEngine {
    private _labelsById      = new Map<string, Label>();
    private _labelsList:      Label[] = [];
    /** label.id → index in _labelsList for O(1) swap-remove */
    private _labelIndexMap   = new Map<string, number>();
    private _candidates:      Label[] = [];

    private readonly _renderer:       WebGLRenderer;
    private readonly _downscaleShift: number;
    private readonly _bitmap:         PyramidOccupancy;
    private readonly _projector:      LabelProjector;
    private readonly _numBuckets:     number;
    private readonly _buckets:        Label[][];
    private readonly _scratchAABB:    ScreenAABB = { x0: 0, y0: 0, x1: 0, y1: 0, fullArea: 0 };
    private readonly _tmpVec2         = new Vector2();
    private readonly _config:         LabelManagerConfig;

    constructor(renderer: WebGLRenderer, config: LabelManagerConfig) {
        this._renderer       = renderer;
        this._config         = config;
        this._downscaleShift = log2OfPow2(config.downscale, 'downscale');
        this._bitmap         = new PyramidOccupancy(config.pyramidLevels);
        this._projector      = new LabelProjector(config);
        this._numBuckets     = config.collisionBuckets;
        this._buckets        = Array.from({ length: this._numBuckets }, () => []);
        this._syncToViewport();
    }

    /**
     * Add labels to the collision set. Duplicate IDs are silently ignored.
     * @param labels - labels to register
     */
    addLabels(labels: Label[]) {
        for (const label of labels) {
            if (this._labelsById.has(label.id)) continue;
            this._labelsById.set(label.id, label);
            this._labelIndexMap.set(label.id, this._labelsList.length);
            this._labelsList.push(label);
        }
    }

    /**
     * Remove labels from the collision set by ID.
     * @param ids - label IDs to unregister
     */
    removeLabels(ids: string[]) {
        if (ids.length === 0) return;
        for (const id of ids) {
            const idx = this._labelIndexMap.get(id);
            if (idx === undefined) continue;
            this._labelsById.delete(id);
            this._labelIndexMap.delete(id);
            const last = this._labelsList[this._labelsList.length - 1];
            this._labelsList[idx] = last;
            this._labelsList.pop();
            if (idx < this._labelsList.length) {
                this._labelIndexMap.set(last.id, idx); // update moved label's index
            }
        }
    }

    /** Remove all labels from the collision set. */
    clear() {
        this._labelsById.clear();
        this._labelsList.length = 0;
        this._labelIndexMap.clear();
        this._candidates = [];
    }

    /**
     * Run one collision evaluation pass against the current camera and viewport.
     * Call-site gating (stationary / fast-move skips) is owned by the manager.
     *
     * @param camera - the active scene camera
     * @returns true if any label's `shouldRender` state changed
     */
    evaluate(camera: Camera): boolean {
        if (this._labelsById.size === 0) return false;

        this._syncToViewport();

        let near = 0.1, far = 1e7;
        if (camera instanceof PerspectiveCamera) { near = camera.near; far = camera.far; }

        this._projector.setFrame(
            camera.matrixWorldInverse,
            camera.projectionMatrix,
            this._bitmap.width,
            this._bitmap.height,
            near,
            far,
        );
        this._bitmap.clear();

        const logMin   = Math.log1p(near * near);
        const logMax   = Math.log1p(far  * far);
        const logRange = (logMax - logMin) || 1;
        const logScale = (this._numBuckets - 1) / logRange;

        // Phase 1 — candidate filter + score: keep frustum/visibility-passing
        // labels and compute their composite distance·size priority score.
        const _pCand = LabelProfiler.begin();
        let changed = false;
        this._candidates.length = 0;
        const { x: cx, y: cy, z: cz } = camera.position;

        for (const label of this._labelsList) {
            if (!label.groupVisible) {
                if (label.shouldRender) { label.shouldRender = false; changed = true; }
                label.isCandidate = false;
                continue;
            }
            label.isCandidate = label.visible   &&
                label.opacity > 0               &&
                label.glyphs.length > 0         &&
                label.bounds.width > 0          &&
                this._projector.checkVisible(label);

            if (!label.isCandidate) {
                if (label.shouldRender) { label.shouldRender = false; changed = true; }
                continue;
            }

            const { x, y, z } = label.position;
            const distSq     = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
            const sizeFactor = this._config.baseFontSize / label.fontSize;
            label.score      = distSq * (sizeFactor ** this._config.fontSizePriorityPower);
            this._candidates.push(label);
        }
        LabelProfiler.end('candidate', _pCand);

        if (this._candidates.length === 0) { return changed || true; }

        // Phase 2 — priority sort: scatter candidates into depth buckets by
        // score (low index = near = high priority).
        const _pSort = LabelProfiler.begin();
        let minBucket = this._numBuckets, maxBucket = -1;

        for (let i = 0; i < this._candidates.length; i++) {
            const label = this._candidates[i];
            let logScore = Math.log1p(label.score);
            if (!label.shouldRender) logScore *= this._config.renderPenaltyMultiplier;

            let b = ((logScore - logMin) * logScale) | 0;
            if (b < 0) b = 0;
            else if (b >= this._numBuckets) b = this._numBuckets - 1;

            this._buckets[b].push(label);
            if (b < minBucket) minBucket = b;
            if (b > maxBucket) maxBucket = b;
        }
        LabelProfiler.end('priority', _pSort);

        // Phase 3 — occlusion placement: walk buckets near-to-far, project each
        // label and test it against the occupancy bitmap to set shouldRender.
        const _pOccl = LabelProfiler.begin();
        const aabb = this._scratchAABB;

        for (let b = minBucket; b <= maxBucket; b++) {
            const bucket = this._buckets[b];

            for (let i = 0; i < bucket.length; i++) {
                const label = bucket[i];

                if (!this._projector.project(label, aabb)) {
                    if (label.shouldRender) { label.shouldRender = false; changed = true; }
                    continue;
                }

                const { x0, y0, x1, y1 } = aabb;

                // Binary occupancy: a label is placed iff its box is entirely free.
                // Stability comes from the depth-bucket ORDER (already-rendered labels
                // score higher via renderPenaltyMultiplier, so they are placed first
                // and reclaim their spot) — not from any allowed-overlap leniency.
                const shouldRender = this._bitmap.isEmpty(x0, y0, x1, y1);
                if (shouldRender) this._bitmap.set(x0, y0, x1, y1);

                if (shouldRender !== label.shouldRender) { label.shouldRender = shouldRender; changed = true; }
            }

            bucket.length = 0;
        }
        LabelProfiler.end('occlusion', _pOccl);

        return changed;
    }

    dispose() {}

    private _syncToViewport() {
        const size = this._renderer.getSize(this._tmpVec2);
        const w    = Math.max(1, size.x >> this._downscaleShift);
        const h    = Math.max(1, size.y >> this._downscaleShift);
        if (w !== this._bitmap.width || h !== this._bitmap.height) { this._bitmap.resize(w, h); return true; }
        return false;
    }
}

function log2OfPow2(n: number, name: string): number {
    if (n < 1 || (n & (n - 1)) !== 0) throw new Error(`${name} must be a power of 2, got ${n}`);
    let s = 0;
    while (1 << s < n) s++;
    return s;
}

