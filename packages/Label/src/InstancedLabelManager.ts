import { Camera, Matrix4, PerspectiveCamera, WebGLRenderer, Scene } from 'three';
import layoutText from './Shaping/TextLayout';
import { LabelAtlasManager, DirtyLevel } from './LabelAtlasManager';
import { Label, LabelBounds } from './Label';
import type { GlyphInstance } from './Shaping/GlyphRun';
import { LabelBatch } from './Rendering/LabelBatch';
import type { LabelMesh } from './Rendering/LabelBatch';
import { LabelCollisionEngine } from './Collision/LabelCollisionEngine';
import { LabelManagerConfig, DefaultLabelConfig } from './Types/LabelConfig';
import { computePxPerUnit } from './Utils';
import { LabelProfiler } from './Profiler';


export class InstancedLabelManager {
    readonly config: LabelManagerConfig;
    private _lastUpdateCheck = 0;
    private _lastCullCheck = 0;
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
    private _atlas: LabelAtlasManager | null = null;
    private _batch: LabelBatch | null = null;
    private readonly _labelsById  = new Map<string, Label>();
    readonly meshes: LabelMesh[] = [];
    collision: LabelCollisionEngine;

    private readonly _toAddBuffer: Label[] = [];
    private readonly _toRemoveBuffer: string[] = [];
    private readonly _toLayoutBuffer: Label[] = [];
    private readonly _toStyleBuffer: Label[] = [];

    /**
     * Caches layout results (glyphs + bounds) keyed by the set of label properties
     * that determine the layout. Labels sharing a key reuse the same glyphs array
     * reference — safe because glyphs are never mutated after layout.
     * Cleared whenever the SDF atlas grows (glyph metrics change).
     */
    private readonly _layoutCache = new Map<string, { glyphs: GlyphInstance[]; bounds: LabelBounds }>();

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
        for (const mesh of this.meshes) scene.add(mesh);
    }

    // ─── Labels in / out ──────────────────────────────────────────────────────

    addLabel(label: Label) { this.addLabels([label]); }
    removeLabel(label: Label) { this.removeLabels([label]); }

    addLabels(labels: Label[]) {
        const _p = LabelProfiler.begin();
        this._getOrCreate().atlas.addLabels(labels);
        for (const l of labels) this._labelsById.set(l.id, l);
        LabelProfiler.end('register', _p);
    }

    removeLabels(labels: Label[]) {
        const _p = LabelProfiler.begin();
        this._atlas?.removeLabels(labels);
        for (const l of labels) this._labelsById.delete(l.id);
        LabelProfiler.end('delete', _p);
    }

    updatePxPerUnit(pxPerUnit: number) {
        this.config.pxPerUnit = pxPerUnit;
        this._batch?.updatePxPerUnit(pxPerUnit);
    }

    // ─── Per-frame work ───────────────────────────────────────────────────────

    tick(camera: Camera) {
        this._lastCamera = camera;
        const now = performance.now();
        const frameDelta = now - this._lastFrameTime;
        this._lastFrameTime = now;

        // ── Sync: timer starts a batch, frame budget limits per-frame cost ──
        let anySynced = false;
        const dueForUpdate = now - this._lastUpdateCheck >= this.config.updateRate * 1000;
        if (dueForUpdate || this._hasPendingWork) {
            if (this._atlas && this._batch && this._atlas.dirty.size > 0) {
                this._syncGroup(this._atlas, this._batch);
                anySynced = true;
            }
            // Timer only resets when the batch is fully drained.
            if (!this._hasPendingWork) {
                this._lastUpdateCheck = now;
            }
        }

        // ── PBO upload: push dirty DataTexture rows to GPU asynchronously ──
        if (this._batch) {
            this._batch.uploadDirty(this._renderer);
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
        const dueForCollision = now - this._lastCullCheck >= this.config.cullingRate * 1000;
        
        // Allows evaluation to run if any labels were added/removed or re-shaped, even if the camera is stationary.
        if (dueForCollision && !isFastMove && (!isStationary || anySynced)) {
            collisionRan = this.collision.evaluate(camera);
            this._lastCullCheck = now;
            this._lastEvalVP.copy(this._curVP);
        }

        // Nothing registered → this manager is idle (e.g. DOM / no-label mode
        // still ticks it). Skip the per-frame passes entirely so they don't show
        // up as phantom cost on modes that don't use instanced labels.
        if (this._labelsById.size === 0) {
            return;
        }

        let _p = LabelProfiler.begin();
        const fadesChanged = this._advanceFades(frameDelta);
        LabelProfiler.end('fades', _p);

        _p = LabelProfiler.begin();
        const farCullChanged = this._applyFarCull(camera);
        LabelProfiler.end('farcull', _p);

        if (collisionRan || fadesChanged || farCullChanged
            || (anySynced && (this._toRemoveBuffer.length > 0 || this._toStyleBuffer.length > 0 || this._toLayoutBuffer.length > 0))) {
            _p = LabelProfiler.begin();
            if (this._atlas && this._batch) {
                this._batch.cull(this._atlas.labels);
            }
            LabelProfiler.end('cull', _p);
        }
    }

    dispose() {
        this._resizeObserver?.disconnect();
        this._resizeObserver = null;
        if (this._scene) {
            for (const mesh of this.meshes) this._scene.remove(mesh);
            this._scene = null;
        }
        this._atlas?.dispose();
        this._batch?.dispose();
        this._atlas = null;
        this._batch = null;
        this.meshes.length = 0;
        this._labelsById.clear();
        this.collision.dispose();
    }

    // ─── Internals ────────────────────────────────────────────────────────────

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

    /**
     * Apply layout to a label, using the cache to skip recomputation for labels
     * that share the same text, font, and layout properties.
     * The glyphs array is shared by reference across cache-hit labels — safe
     * because glyphs are never mutated after layout.
     */
    private _layoutFromCache(label: Label, glyphs: Map<string, import('./Shaping/GlyphRun').GlyphInfo>): void {
        const p = label.padding;
        const o = label.offset;
        const key = `${label.getDisplayText()}|${label.fontKeyString}|${label.fontSize}|${label.maxWidth}|${label.letterSpacing}|${label.lineHeight}|${label.textAlign}|${label.anchorX}|${label.anchorY}|${o.x},${o.y}|${p.top},${p.right},${p.bottom},${p.left}`;
        const cached = this._layoutCache.get(key);
        if (cached) {
            label.glyphs = cached.glyphs;
            label.bounds = cached.bounds;
        } else {
            layoutText(label, glyphs, this.config.baseFontSize);
            this._layoutCache.set(key, { glyphs: label.glyphs, bounds: label.bounds });
        }
    }

    private _getOrCreate(): { atlas: LabelAtlasManager; batch: LabelBatch } {
        if (this._atlas && this._batch) return { atlas: this._atlas, batch: this._batch };
        this._batch = new LabelBatch(this.config);
        this._atlas = new LabelAtlasManager(this.config);
        this.meshes.push(this._batch.mesh);
        this._scene?.add(this._batch.mesh);
        return { atlas: this._atlas, batch: this._batch };
    }

    private _syncGroup(fontGroup: LabelAtlasManager, meshGroup: LabelBatch) {
        const _pAtlas = LabelProfiler.begin();
        const { atlas, dirty, resized } = fontGroup.getAtlas();
        LabelProfiler.end('atlas', _pAtlas);
        const dirtyMap = fontGroup.dirty;
        const budget = this.config.layoutBudgetPerTick;

        this._toAddBuffer.length = 0;
        this._toRemoveBuffer.length = 0;
        this._toLayoutBuffer.length = 0;
        this._toStyleBuffer.length = 0;

        let layoutCount = 0;
        this._hasPendingWork = false;

        const _pShape = LabelProfiler.begin();
        for (const [label, level] of dirtyMap) {
            switch (level) {
                case DirtyLevel.Add:
                    if (budget > 0 && layoutCount >= budget) {
                        this._hasPendingWork = true;
                        continue;
                    }
                    this._layoutFromCache(label, atlas.glyphs);
                    this._toAddBuffer.push(label);
                    layoutCount++;
                    break;
                case DirtyLevel.Dispose:
                    this._toRemoveBuffer.push(label.id);
                    break;
                case DirtyLevel.LayoutUpdate:
                    if (budget > 0 && layoutCount >= budget) {
                        this._hasPendingWork = true;
                        continue;
                    }
                    LabelProfiler.count('reshape', 1);
                    this._layoutFromCache(label, atlas.glyphs);
                    this._toLayoutBuffer.push(label);
                    layoutCount++;
                    break;
                case DirtyLevel.StyleUpdate:
                    this._toStyleBuffer.push(label);
                    break;
                default:
                    break;
            }
        }
        LabelProfiler.end('layout', _pShape);

        this.collision.removeLabels(this._toRemoveBuffer);
        this.collision.addLabels(this._toAddBuffer);

        // Position: write the shaped glyph/label data into the GPU data textures
        // (the instanced analog of DOM updateCSSPosition — commit to render).
        const _pUpload = LabelProfiler.begin();
        meshGroup.update(
            this._toAddBuffer,
            this._toRemoveBuffer,
            this._toLayoutBuffer,
            this._toStyleBuffer,
            dirty ? atlas : undefined,
            !!this.config.globeAlignment,
        );

        if (resized) {
            // The glyph atlas grew: glyph metrics changed — cached layouts are stale.
            this._layoutCache.clear();
            // Re-lay-out and re-emit every label in the group (O(group size) spike).
            LabelProfiler.count('atlasResize', 1);
            LabelProfiler.count('atlasReemit', fontGroup.labels.size);
            const alreadyRelaidOut = new Set<string>();
            for (const l of this._toAddBuffer) alreadyRelaidOut.add(l.id);
            for (const l of this._toLayoutBuffer) alreadyRelaidOut.add(l.id);
            for (const label of fontGroup.labels) {
                if (!alreadyRelaidOut.has(label.id)) {
                    this._layoutFromCache(label, atlas.glyphs);
                }
                meshGroup.reemitGlyphs(label);
            }
        }
        LabelProfiler.end('position', _pUpload);

        // Flush only the labels we actually processed this frame.
        if (this._hasPendingWork) {
            // Budget hit: flush only processed entries, leave the rest dirty.
            for (const l of this._toAddBuffer) fontGroup.dirty.delete(l);
            for (const id of this._toRemoveBuffer) {
                // Dispose entries are keyed by label reference, find & delete.
                for (const [label, level] of fontGroup.dirty) {
                    if (level === DirtyLevel.Dispose && label.id === id) {
                        fontGroup.dirty.delete(label);
                        break;
                    }
                }
            }
            for (const l of this._toLayoutBuffer) fontGroup.dirty.delete(l);
            for (const l of this._toStyleBuffer) fontGroup.dirty.delete(l);
        } else {
            fontGroup.flushDirty();
        }
    }
}

/** Max absolute element-wise difference between two 4×4 matrices (clip-space delta). */
function matrixMaxDiff(a: Matrix4, b: Matrix4): number {
    let max = 0;
    for (let i = 0; i < 15; i++) max = Math.max(max, Math.abs(a.elements[i] - b.elements[i]));
    return max;
}
