import { Matrix4 } from 'three';
import { Label } from '../Label';
import { LabelManagerConfig } from '../Types/LabelConfig';
import { LabelProfiler } from '../Profiler';
import { LabelProjector, ScreenAABB } from './LabelProjector';
import { Occupancy, makeOccupancy } from './Occupancy';
import { Ordering, makeOrdering } from './Ordering';

/** Per-evaluation camera + viewport frame, in full-resolution screen pixels. */
export interface CollisionFrame {
    view: Matrix4;
    proj: Matrix4;
    camX: number;
    camY: number;
    camZ: number;
    near: number;
    far: number;
    screenW: number;
    screenH: number;
}

/**
 * Shared collision algorithm used by both the main-thread {@link LabelCollisionEngine}
 * and the worker {@link WorkerCollisionEngine}. Runs the classic greedy pipeline:
 *
 *   1. candidate filter + distance·size score  (profiler stage `candidate`)
 *   2. priority ordering                        (profiler stage `priority`)
 *   3. occlusion placement                      (profiler stage `occlusion`)
 *
 * Each of ordering, occupancy and bounds model is selectable at runtime via
 * {@link reconfigure}. The defaults are the benchmarked configuration for these
 * three axes — radix 20-bit ordering, full-resolution bitmap occupancy, AABB
 * bounds, occlusion tolerance 0.1 (see docs/label-collision-algorithms.html).
 * One footprint is tested per label; the per-glyph collider chain the bench
 * measures for curved labels is not implemented here.
 *
 * The engines differ only in how they source labels and camera data — this class
 * owns the algorithm and mutates `label.shouldRender` / `label.isCandidate`.
 */
export class CollisionCore {
    private readonly _config: LabelManagerConfig;
    private _projector!: LabelProjector;
    private _occupancy!: Occupancy;
    private _ordering!:  Ordering;

    private _candidates: Label[] = [];
    private _ordered:    Label[] = [];
    private _keys        = new Float64Array(0);
    private _candidateCount = 0;

    private readonly _scratchAABB: ScreenAABB = { x0: 0, y0: 0, x1: 0, y1: 0, fullArea: 0 };
    private readonly _qx = new Float32Array(4);
    private readonly _qy = new Float32Array(4);

    private _lastW = 0;
    private _lastH = 0;

    /**
     * @param config - the manager's config object, held by reference. reconfigure()
     *   mutates it in place so the manager and core stay in sync.
     */
    constructor(config: LabelManagerConfig) {
        this._config = config;
        this._rebuild();
    }

    /** Number of candidates that survived the last candidate filter. */
    get candidateCount(): number { return this._candidateCount; }
    /** The active occupancy — read `supportsQuad` / `supportsTolerance` for UI/warnings. */
    get occupancy(): Occupancy { return this._occupancy; }

    /**
     * Apply a partial config change and rebuild ordering / occupancy / projector.
     * Invalid combinations are clamped (quad bounds on a non-quad occupancy →
     * AABB) with a one-line warning. Registered labels are unaffected.
     */
    reconfigure(partial: Partial<LabelManagerConfig>): void {
        Object.assign(this._config, partial);
        this._rebuild();
    }

    private _rebuild(): void {
        const cfg = this._config;
        // Clamp an unsupported bounds mode before building the real occupancy, so
        // that pyramid.supportsTolerance (which depends on boundsMode) is correct.
        if (cfg.boundsMode === 'quad' && !makeOccupancy(cfg).supportsQuad) {
            // eslint-disable-next-line no-console
            console.warn(`[labels] occupancy '${cfg.occupancyMethod}' has no exact-quad support; using AABB bounds.`);
            cfg.boundsMode = 'aabb';
        }
        this._occupancy = makeOccupancy(cfg);
        this._ordering  = makeOrdering(cfg);
        this._projector = new LabelProjector(cfg);
        if (cfg.occlusionTol > 0 && !this._occupancy.supportsTolerance) {
            // eslint-disable-next-line no-console
            console.warn(`[labels] occlusionTol is ignored by occupancy '${cfg.occupancyMethod}' in '${cfg.boundsMode}' bounds mode.`);
        }
        this._lastW = 0; this._lastH = 0; // force occupancy resize on next evaluate
    }

    /**
     * Run one collision pass over `labels`. Mutates `shouldRender`/`isCandidate`.
     * @param labels  - the full label set (any iterable)
     * @param f       - camera + viewport frame
     * @param changed - optional sink; every label id whose shouldRender OR
     *                  isCandidate flipped is added (used by the worker to emit a diff)
     * @returns true if any label's `shouldRender` changed this pass
     */
    evaluate(labels: Iterable<Label>, f: CollisionFrame, changed?: Set<string>): boolean {
        if (f.screenW !== this._lastW || f.screenH !== this._lastH) {
            this._occupancy.resize(f.screenW, f.screenH);
            this._lastW = f.screenW; this._lastH = f.screenH;
        }
        this._projector.setFrame(f.view, f.proj, f.screenW, f.screenH, f.near, f.far);
        this._occupancy.clear();

        const cfg = this._config;
        const logMin = Math.log1p(f.near * f.near);
        const logMax = Math.log1p(f.far * f.far);

        let srChanged = false;
        const cands = this._candidates;
        cands.length = 0;
        const cx = f.camX, cy = f.camY, cz = f.camZ;

        // ── Phase 1: candidate filter + score ────────────────────────────────
        const _pCand = LabelProfiler.begin();
        for (const label of labels) {
            const wasCand = label.isCandidate;
            if (!label.groupVisible) {
                if (label.shouldRender) { label.shouldRender = false; srChanged = true; changed?.add(label.id); }
                label.isCandidate = false;
                if (wasCand) { changed?.add(label.id); }
                continue;
            }
            label.isCandidate = label.visible &&
                label.opacity > 0 &&
                label.glyphs.length > 0 &&
                label.bounds.width > 0 &&
                this._projector.checkVisible(label);
            if (label.isCandidate !== wasCand) { changed?.add(label.id); }

            if (!label.isCandidate) {
                if (label.shouldRender) { label.shouldRender = false; srChanged = true; changed?.add(label.id); }
                continue;
            }

            const dx = label.position.x - cx;
            const dy = label.position.y - cy;
            const dz = label.position.z - cz;
            const distSq = dx * dx + dy * dy + dz * dz;
            label.score = distSq * ((cfg.baseFontSize / label.fontSize) ** cfg.fontSizePriorityPower);
            cands.push(label);
        }
        LabelProfiler.end('candidate', _pCand);

        this._candidateCount = cands.length;
        if (cands.length === 0) { return srChanged; }

        // ── Phase 2: priority ordering ───────────────────────────────────────
        const _pSort = LabelProfiler.begin();
        const n = cands.length;
        if (this._keys.length < n) { this._keys = new Float64Array(n); }
        if (this._ordered.length < n) { this._ordered.length = n; }
        const keys = this._keys;
        const penalty = cfg.renderPenaltyMultiplier;
        for (let i = 0; i < n; i++) {
            let ls = Math.log1p(cands[i].score);
            if (!cands[i].shouldRender) { ls *= penalty; }
            keys[i] = ls;
        }
        const m = this._ordering.run(cands, keys, n, logMin, logMax, this._ordered);
        LabelProfiler.end('priority', _pSort);

        // ── Phase 3: occlusion placement ─────────────────────────────────────
        const _pOccl = LabelProfiler.begin();
        const ordered = this._ordered;
        const occ = this._occupancy;
        const useQuad = cfg.boundsMode === 'quad' && occ.supportsQuad;

        if (useQuad) {
            const qx = this._qx, qy = this._qy;
            for (let s = 0; s < m; s++) {
                const label = ordered[s];
                const was = label.shouldRender;
                if (!this._projector.projectQuad(label, qx, qy)) {
                    if (was) { label.shouldRender = false; srChanged = true; changed?.add(label.id); }
                    continue;
                }
                const sr = occ.testQuad(qx, qy, was);
                if (sr) { occ.markQuad(qx, qy); }
                if (sr !== was) { label.shouldRender = sr; srChanged = true; changed?.add(label.id); }
            }
        } else {
            const aabb = this._scratchAABB;
            for (let s = 0; s < m; s++) {
                const label = ordered[s];
                const was = label.shouldRender;
                if (!this._projector.project(label, aabb)) {
                    if (was) { label.shouldRender = false; srChanged = true; changed?.add(label.id); }
                    continue;
                }
                const sr = occ.testRect(aabb.x0, aabb.y0, aabb.x1, aabb.y1, was);
                if (sr) { occ.markRect(aabb.x0, aabb.y0, aabb.x1, aabb.y1); }
                if (sr !== was) { label.shouldRender = sr; srChanged = true; changed?.add(label.id); }
            }
        }
        LabelProfiler.end('occlusion', _pOccl);

        return srChanged;
    }
}
