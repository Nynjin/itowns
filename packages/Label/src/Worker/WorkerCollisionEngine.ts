import { Matrix4 } from 'three';
import { Label } from '../Label';
import type { LabelManagerConfig } from '../Types/LabelConfig';
import { CollisionCore, CollisionFrame } from '../Collision/CollisionCore';

/**
 * Collision engine variant for the Web Worker context.
 *
 * Shares the exact algorithm of {@link LabelCollisionEngine} through the common
 * {@link CollisionCore}, but:
 *   - no WebGLRenderer dependency (viewport size is set explicitly)
 *   - evaluate() accepts pre-extracted camera matrices instead of a Camera object
 *   - it returns a diff (only labels whose state changed) for postMessage
 *   - advanceFades() is co-located here since the worker owns all label state
 */
export class WorkerCollisionEngine {
    private readonly _labelsById = new Map<string, Label>();
    private readonly _candidates: Label[] = [];
    private readonly _core:  CollisionCore;
    private readonly _config: LabelManagerConfig;

    /** Ids whose shouldRender / isCandidate changed this pass — reused. */
    private readonly _changed = new Set<string>();
    private readonly _viewMat = new Matrix4();
    private readonly _projMat = new Matrix4();
    private readonly _frame:   CollisionFrame = {
        view: new Matrix4(), proj: new Matrix4(),
        camX: 0, camY: 0, camZ: 0, near: 0.1, far: 1e7, screenW: 1, screenH: 1,
    };
    /** Full-resolution viewport (px). The occupancy downscales internally. */
    private _vpW = 1;
    private _vpH = 1;

    constructor(config: LabelManagerConfig) {
        this._config = config;
        this._core   = new CollisionCore(config);
    }

    // ── Label registration ───────────────────────────────────────────────────

    addLabels(labels: Label[]) {
        for (const l of labels) { this._labelsById.set(l.id, l); }
    }

    removeLabels(ids: string[]) {
        if (ids.length === 0) { return; }
        for (const id of ids) { this._labelsById.delete(id); }
        const idSet = new Set(ids);
        const c = this._candidates;
        for (let i = c.length - 1; i >= 0; i--) {
            if (idSet.has(c[i].id)) { c.splice(i, 1); }
        }
    }

    /** Explicit viewport resize (full-resolution px) — call when the canvas size changes. */
    setViewport(vpWidth: number, vpHeight: number) {
        this._vpW = Math.max(1, vpWidth);
        this._vpH = Math.max(1, vpHeight);
    }

    /**
     * Change the collision algorithm at runtime.
     * @see CollisionCore.reconfigure
     */
    reconfigure(partial: Partial<LabelManagerConfig>) { this._core.reconfigure(partial); }

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
        if (this._labelsById.size === 0) { return null; }

        const changed = this._changed;
        changed.clear();

        const f = this._frame;
        f.view = this._viewMat.fromArray(viewMatrix);
        f.proj = this._projMat.fromArray(projMatrix);
        f.camX = camX; f.camY = camY; f.camZ = camZ;
        f.near = near; f.far = far;
        f.screenW = this._vpW; f.screenH = this._vpH;

        this._core.evaluate(this._labelsById.values(), f, changed);

        if (changed.size === 0) { return null; }

        // Emit only the labels whose shouldRender / isCandidate actually changed.
        const ids = [...changed];
        const shouldRender = new Uint8Array(ids.length);
        const isCandidate  = new Uint8Array(ids.length);
        for (let i = 0; i < ids.length; i++) {
            const l = this._labelsById.get(ids[i]);
            if (!l) { continue; }
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
            if (label.occlusionFade === target) { continue; }
            label.occlusionFade = label.occlusionFade < target
                ? Math.min(target, label.occlusionFade + step)
                : Math.max(target, label.occlusionFade - step);
            ids.push(label.id);
            fades.push(label.occlusionFade);
        }

        if (ids.length === 0) { return null; }
        return { ids, occlusionFades: new Float32Array(fades) };
    }
}
