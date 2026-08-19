import { Camera, Matrix4, PerspectiveCamera, Vector2, WebGLRenderer } from 'three';
import { Label } from '../Label';
import { LabelManagerConfig } from '../Types/LabelConfig';
import { CollisionCore, CollisionFrame } from './CollisionCore';

/**
 * Main-thread collision engine. Owns the label registration set and the render
 * frame extraction; delegates the actual candidate → order → place algorithm to
 * the shared {@link CollisionCore}, whose ordering / occupancy / bounds model are
 * runtime-selectable via {@link reconfigure}.
 *
 * Call {@link evaluate} once per culling interval from the render loop.
 */
export class LabelCollisionEngine {
    private _labelsById    = new Map<string, Label>();
    private _labelsList:     Label[] = [];
    /** label.id → index in _labelsList for O(1) swap-remove */
    private _labelIndexMap = new Map<string, number>();

    private readonly _renderer: WebGLRenderer;
    private readonly _core:     CollisionCore;
    private readonly _tmpVec2   = new Vector2();
    private readonly _frame:    CollisionFrame = {
        view: new Matrix4(), proj: new Matrix4(),
        camX: 0, camY: 0, camZ: 0, near: 0.1, far: 1e7, screenW: 1, screenH: 1,
    };

    constructor(renderer: WebGLRenderer, config: LabelManagerConfig) {
        this._renderer = renderer;
        this._core     = new CollisionCore(config);
    }

    /**
     * Add labels to the collision set. Duplicate IDs are silently ignored.
     * @param labels - labels to register
     */
    addLabels(labels: Label[]) {
        for (const label of labels) {
            if (this._labelsById.has(label.id)) { continue; }
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
        if (ids.length === 0) { return; }
        for (const id of ids) {
            const idx = this._labelIndexMap.get(id);
            if (idx === undefined) { continue; }
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
    }

    /**
     * Change the collision algorithm (ordering / occupancy / bounds model and
     * their params) at runtime. Registered labels are unaffected. See
     * {@link CollisionCore.reconfigure}.
     */
    reconfigure(partial: Partial<LabelManagerConfig>) { this._core.reconfigure(partial); }

    /** The active occupancy — expose `supportsQuad` / `supportsTolerance` for UI. */
    get occupancy() { return this._core.occupancy; }

    /**
     * Run one collision evaluation pass against the current camera and viewport.
     * Call-site gating (stationary / fast-move skips) is owned by the manager.
     *
     * @param camera - the active scene camera
     * @returns true if any label's `shouldRender` state changed
     */
    evaluate(camera: Camera): boolean {
        if (this._labelsById.size === 0) { return false; }

        const size = this._renderer.getSize(this._tmpVec2);
        let near = 0.1, far = 1e7;
        if (camera instanceof PerspectiveCamera) { near = camera.near; far = camera.far; }

        const f = this._frame;
        f.view = camera.matrixWorldInverse;
        f.proj = camera.projectionMatrix;
        f.camX = camera.position.x; f.camY = camera.position.y; f.camZ = camera.position.z;
        f.near = near; f.far = far;
        f.screenW = Math.max(1, size.x); f.screenH = Math.max(1, size.y);

        const changed = this._core.evaluate(this._labelsList, f);
        // Preserve historical contract: a pass with zero candidates always
        // reports "changed" so the manager re-runs its cull.
        return changed || this._core.candidateCount === 0;
    }

    dispose() {}
}
