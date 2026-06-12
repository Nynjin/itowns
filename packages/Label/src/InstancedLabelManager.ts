import { Camera, Matrix4, PerspectiveCamera, WebGLRenderer, Scene } from 'three';
import { fontKeyOf, fontKeyString } from './Shaping/FontKey';
import layoutText from './Shaping/TextLayout';
import { LabelFontGroup, DirtyLevel } from './LabelFontGroup';
import { Label } from './Label';
import { LabelMeshGroup } from './Rendering/LabelMeshGroup';
import type { LabelMesh } from './Rendering/LabelMeshGroup';
import { LabelCollisionEngine } from './Collision/LabelCollisionEngine';
import { LabelManagerConfig, DefaultLabelConfig } from './Types/LabelConfig';
import { computePxPerUnit } from './Utils';

interface LabelGroup {
    fontGroup: LabelFontGroup;
    meshGroup: LabelMeshGroup;
}

export interface LabelMeshPair {
    fill: LabelMesh;
    halo: LabelMesh;
}

export class InstancedLabelManager {
    readonly config: LabelManagerConfig;
    private _lastUpdateTime = 0;
    private _lastCullTime = 0;
    private _lastFrameTime = 0;
    private _hasPendingWork = false;
    
    // ── VP-matrix tracking for stationary / fast-move skip ─────────────────
    /** VP matrix at the time of the last collision evaluation. */
    private readonly _lastEvalVP   = new Matrix4();
    /** VP matrix from the immediately previous frame (used to detect instantaneous speed). */
    private readonly _lastFrameVP  = new Matrix4();
    /** Scratch VP matrix computed each tick. */
    private readonly _curVP        = new Matrix4();
    
    private _vpInitialized = false;
    private _scene: Scene | null = null;
    private _lastCamera: Camera | null = null;
    private _resizeObserver: ResizeObserver | null = null;

    private readonly _renderer: WebGLRenderer;
    private readonly _groups      = new Map<string, LabelGroup>();
    private readonly _labelsById  = new Map<string, Label>();
    readonly meshes: LabelMeshPair[] = [];
    collision: LabelCollisionEngine;

    private readonly _toAddBuffer: Label[] = [];
    private readonly _toRemoveBuffer: string[] = [];
    private readonly _toLayoutBuffer: Label[] = [];
    private readonly _toStyleBuffer: Label[] = [];
    private readonly _toRegroupBuffer: Label[] = [];
    private readonly _processedLabels: Label[] = [];

    constructor(renderer: WebGLRenderer, options?: Partial<LabelManagerConfig>) {
        this.config = { ...DefaultLabelConfig, ...options };
        this._renderer = renderer;
        this.collision = new LabelCollisionEngine(renderer, this.config);

        if (this.config.autoResizePxPerUnit) {
            this._resizeObserver = new ResizeObserver(() => {
                if (this._lastCamera) {
                    this.updatePxPerUnit(computePxPerUnit(this._lastCamera, this._renderer));
                }
            });
            this._resizeObserver.observe(renderer.domElement);
        }
    }

    // ─── Scene management ─────────────────────────────────────────────────────

    attachTo(scene: Scene) {
        this._scene = scene;
        for (const pair of this.meshes) scene.add(pair.fill, pair.halo);
    }

    // ─── Labels in / out ──────────────────────────────────────────────────────

    addLabel(label: Label) { this.addLabels([label]); }
    removeLabel(label: Label) { this.removeLabels([label]); }

    addLabels(labels: Label[]) {
        const byKey = this._groupByFontKey(labels);
        for (const [key, bucket] of byKey) {
            this._getOrCreate(key, bucket[0]).fontGroup.addLabels(bucket);
        }
        for (const l of labels) this._labelsById.set(l.id, l);
    }

    removeLabels(labels: Label[]) {
        const byKey = this._groupByFontKey(labels);
        for (const [key, bucket] of byKey) {
            this._groups.get(key)?.fontGroup.removeLabels(bucket);
        }
        for (const l of labels) this._labelsById.delete(l.id);
    }

    updatePxPerUnit(pxPerUnit: number) {
        this.config.pxPerUnit = pxPerUnit;
        for (const group of this._groups.values()) {
            group.meshGroup.updatePxPerUnit(pxPerUnit);
        }
    }

    // ─── Per-frame work ───────────────────────────────────────────────────────

    tick(camera: Camera) {
        this._lastCamera = camera;
        const now = performance.now();
        const frameDelta = now - this._lastFrameTime;
        this._lastFrameTime = now;

        let anySynced = false;
        const dueForUpdate = this._hasPendingWork || now - this._lastUpdateTime >= this.config.updateRate * 1000;
        if (dueForUpdate) {
            this._hasPendingWork = false;
            for (const group of this._groups.values()) {
                if (this._isDirty(group)) {
                    this._syncGroup(group);
                    anySynced = true;
                }
            }
            if (anySynced && !this._hasPendingWork) {
                this._lastUpdateTime = now;
                this._lastCullTime = 0;
            }
            else if (anySynced) {
                this._lastCullTime = 0;
            }
        }

        // ── VP-matrix checks ─────────────────────────────────────────────────
        this._curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

        if (!this._vpInitialized) {
            this._lastEvalVP.copy(this._curVP);
            this._lastFrameVP.copy(this._curVP);
            this._vpInitialized = true;
        }

        // 1. Instantaneous speed (frame-to-frame delta) breaks deadlocks
        const frameDiff = matrixMaxDiff(this._curVP, this._lastFrameVP);
        const isFastMove = frameDiff > this.config.fastMoveFraction;

        // 2. Cumulative drift (delta since last collision eval)
        const evalDiff = matrixMaxDiff(this._curVP, this._lastEvalVP);
        const isStationary = evalDiff < this.config.stationaryThreshold;

        // Update frame tracker immediately for the next frame
        this._lastFrameVP.copy(this._curVP);

        let collisionRan = false;
        const dueForCollision = now - this._lastCullTime >= this.config.cullingRate * 1000;
        
        // Force evaluation if labels were added/modified (anySynced) OR if it's 
        // time and the camera is moving normally.
        if (anySynced || (dueForCollision && !isStationary && !isFastMove)) {
            collisionRan = this.collision.evaluate(camera);
            this._lastCullTime = now;
            this._lastEvalVP.copy(this._curVP);
        }

        const fadesChanged = this._advanceFades(frameDelta);
        const farCullChanged = this._applyFarCull(camera);

        if (collisionRan || fadesChanged || farCullChanged || anySynced) {
            for (const group of this._groups.values()) {
                group.meshGroup.cull(group.fontGroup.labels);
            }
        }
    }

    dispose() {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        if (this._scene) {
            for (const pair of this.meshes) this._scene.remove(pair.fill, pair.halo);
            this._scene = null;
        }
        for (const group of this._groups.values()) {
            group.fontGroup.dispose();
            group.meshGroup.dispose();
        }
        this._groups.clear();
        this.meshes.length = 0;
        this._labelsById.clear();
        this.collision.dispose();
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    private _groupByFontKey(labels: Label[]): Map<string, Label[]> {
        const byKey = new Map<string, Label[]>();
        for (const label of labels) {
            const key = fontKeyString(fontKeyOf(label));
            if (!key) continue;
            let bucket = byKey.get(key);
            if (!bucket) { bucket = []; byKey.set(key, bucket); }
            bucket.push(label);
        }
        return byKey;
    }

    private _isDirty(group: LabelGroup): boolean {
        return group.fontGroup.dirty.size > 0;
    }

    /**
     * Per-frame far-plane cull — runs unconditionally every frame, bypassing
     * the cullingRate gate.  Hides labels at the start of the fog zone
     * (`scene.fog.near` when available, otherwise `camera.far`) so they
     * disappear before the un-fogged label shader makes them look crisp
     * against a fogged background.
     * @param camera - the active scene camera
     * @returns true if any label's shouldRender state changed
     */
    private _applyFarCull(camera: Camera): boolean {
        const camFar = camera instanceof PerspectiveCamera ? camera.far : 1e7;
        const fog    = this._scene?.fog as { near?: number } | null | undefined;
        const far    = (fog?.near != null && fog.near > 0) ? fog.near : camFar;
        const ve     = camera.matrixWorldInverse.elements;
        let changed = false;
        for (const l of this._labelsById.values()) {
            if (!l.shouldRender) continue;
            const { x, y, z } = l.position;
            const cvz = ve[2] * x + ve[6] * y + ve[10] * z + ve[14];
            if (cvz < -far) {
                l.shouldRender  = false;
                l.occlusionFade = 1.0; // skip fade — hide immediately
                changed = true;
            }
        }
        return changed;
    }

    private _advanceFades(frameDeltaMs: number): boolean {
        const step = frameDeltaMs / this.config.fadeDurationMs;
        let changed = false;
        for (const l of this._labelsById.values()) {
            const target = l.shouldRender ? 0.0 : 1.0;
            if (l.occlusionFade === target) continue;
            changed = true;
            l.occlusionFade = l.occlusionFade < target
                ? Math.min(target, l.occlusionFade + step)
                : Math.max(target, l.occlusionFade - step);
        }
        return changed;
    }

    private _getOrCreate(key: string, sample: Label): LabelGroup {
        const existing = this._groups.get(key);
        if (existing) return existing;

        const meshGroup = new LabelMeshGroup(this.config);
        const fontGroup = new LabelFontGroup(fontKeyOf(sample), this.config);
        const group: LabelGroup = { fontGroup, meshGroup };

        this._groups.set(key, group);
        this.meshes.push({ fill: meshGroup.fillMesh, halo: meshGroup.haloMesh });
        this._scene?.add(meshGroup.fillMesh, meshGroup.haloMesh);
        return group;
    }

    private _syncGroup(group: LabelGroup) {
        const { fontGroup, meshGroup } = group;
        const { atlas, dirty, resized } = fontGroup.getAtlas();
        const dirtyMap = fontGroup.dirty;
        const budget = this.config.layoutBudgetPerTick;

        this._toAddBuffer.length = 0;
        this._toRemoveBuffer.length = 0;
        this._toLayoutBuffer.length = 0;
        this._toStyleBuffer.length = 0;
        this._toRegroupBuffer.length = 0;
        this._processedLabels.length = 0;

        let layoutCount = 0;

        for (const [label, level] of dirtyMap) {
            switch (level) {
                case DirtyLevel.Add:
                    if (budget > 0 && layoutCount >= budget) {
                        this._hasPendingWork = true;
                        continue;
                    }
                    this._toAddBuffer.push(layoutText(label, atlas.glyphs, this.config.baseFontSize));
                    this._processedLabels.push(label);
                    layoutCount++;
                    break;
                case DirtyLevel.Dispose:
                    this._toRemoveBuffer.push(label.id);
                    this._processedLabels.push(label);
                    break;
                case DirtyLevel.ChangeGroup:
                    this._toRemoveBuffer.push(label.id);
                    this._toRegroupBuffer.push(label);
                    this._processedLabels.push(label);
                    break;
                case DirtyLevel.LayoutUpdate:
                    if (budget > 0 && layoutCount >= budget) {
                        this._hasPendingWork = true;
                        continue;
                    }
                    this._toLayoutBuffer.push(layoutText(label, atlas.glyphs, this.config.baseFontSize));
                    this._processedLabels.push(label);
                    layoutCount++;
                    break;
                case DirtyLevel.StyleUpdate:
                    this._toStyleBuffer.push(label);
                    this._processedLabels.push(label);
                    break;
                default:
                    break;
            }
        }

        this.collision.removeLabels(this._toRemoveBuffer);
        this.collision.addLabels(this._toAddBuffer);

        meshGroup.update(
            this._toAddBuffer,
            this._toRemoveBuffer,
            this._toLayoutBuffer,
            this._toStyleBuffer,
            dirty ? atlas : undefined,
            !!this.config.globeAlignment,
        );

        if (resized) {
            const alreadyRelaidOut = new Set([
                ...this._toAddBuffer.map(l => l.id),
                ...this._toLayoutBuffer.map(l => l.id),
            ]);
            for (const label of fontGroup.labels) {
                if (!alreadyRelaidOut.has(label.id)) {
                    layoutText(label, atlas.glyphs, this.config.baseFontSize);
                }
                meshGroup.reemitGlyphs(label);
            }
        }

        fontGroup.flushDirtyFor(this._processedLabels);

        if (this._toRegroupBuffer.length > 0) {
            this.addLabels(this._toRegroupBuffer);
        }
    }
}

/** Max absolute element-wise difference between two 4×4 matrices (clip-space delta). */
function matrixMaxDiff(a: Matrix4, b: Matrix4): number {
    let max = 0;
    for (let i = 0; i < 15; i++) max = Math.max(max, Math.abs(a.elements[i] - b.elements[i]));
    return max;
}
