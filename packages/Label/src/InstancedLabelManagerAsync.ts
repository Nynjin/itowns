/**
 * Worker-backed drop-in replacement for InstancedLabelManager.
 *
 * What moves to the worker:
 *   - layoutText()          (text shaping + glyph run computation)
 *   - collision evaluation  (frustum check, screen projection, bitmap)
 *   - fade advancement      (occlusionFade interpolation)
 *
 * What stays on the main thread:
 *   - SDFAtlas (glyph rasterisation — needs Canvas2D, not worker-safe without OffscreenCanvas)
 *   - LabelMeshGroup / GPU data-texture writes
 *   - cull() — writes to InstancedBufferAttribute + sets needsUpdate
 *   - Three.js scene management
 *   - VP-matrix gate (stationary / fast-move skip)
 */

import { Camera, Matrix4, PerspectiveCamera, Scene, Vector2, WebGLRenderer } from 'three';
import { fontKeyOf, fontKeyString } from './Shaping/FontKey';
import { LabelFontGroup, DirtyLevel } from './LabelFontGroup';
import { Label } from './Label';
import { LabelMeshGroup } from './Rendering/LabelMeshGroup';
import type { GlyphInfo } from './Shaping/GlyphRun';
import { DefaultLabelConfig, LabelManagerConfig } from './Types/LabelConfig';
import { computePxPerUnit } from './Utils';
import type { LabelMeshPair } from './InstancedLabelManager';
import type { MainToWorker, WorkerToMain, SerialisedLabel } from './Worker/WorkerMessages';

interface LabelGroup {
    fontGroup:  LabelFontGroup;
    meshGroup:  LabelMeshGroup;
    /** Last atlas dirty flag — used to gate SET_ATLAS posts. */
    atlasSent:  boolean;
}

/** Max element-wise diff of two 4×4 matrices (clip space, scale-invariant). */
function matrixMaxDiff(a: Matrix4, b: Matrix4): number {
    let max = 0;
    for (let i = 0; i < 15; i++) max = Math.max(max, Math.abs(a.elements[i] - b.elements[i]));
    return max;
}

export class InstancedLabelManagerAsync {
    readonly config: LabelManagerConfig;
    readonly meshes: LabelMeshPair[] = [];

    private readonly _renderer:    WebGLRenderer;
    private readonly _groups       = new Map<string, LabelGroup>();
    private readonly _labelsById   = new Map<string, Label>();
    /** Maps labelId → fontKey for O(1) group lookup in message handlers. */
    private readonly _labelFontKey = new Map<string, string>();

    private _scene:         Scene | null = null;
    private _lastCamera:    Camera | null = null;
    private _resizeObserver: ResizeObserver | null = null;

    private _lastUpdateTime  = 0;
    private _lastCullTime    = 0;
    private _lastFrameTime   = 0;
    private _hasPendingWork  = false;

    // VP-matrix gate (same logic as sync manager)
    private readonly _lastEvalVP   = new Matrix4();
    private readonly _lastFrameVP  = new Matrix4();
    private readonly _curVP        = new Matrix4();
    private _evalVPInitialized     = false;

    // Per-evaluation scratch — reused (postMessage copies, never transfers them).
    private readonly _vpSize       = new Vector2();
    private readonly _projScratch  = new Float32Array(16);
    private readonly _viewScratch  = new Float32Array(16);

    // Worker
    private readonly _worker: Worker;
    /** Messages received from worker, drained at the top of each tick(). */
    private readonly _inbox: WorkerToMain[] = [];
    /** Labels for which GPU glyph data has not yet been written (awaiting LAYOUT_DONE). */
    private readonly _pendingGlyphs = new Map<string, Label>();
    /** Labels that have an allocated slot in the GPU data texture. */
    private readonly _gpuLabels     = new Set<string>();
    /** Whether any worker message was applied this tick — triggers cull(). */
    private _needsCull = false;

    constructor(renderer: WebGLRenderer, options?: Partial<LabelManagerConfig>) {
        this.config   = { ...DefaultLabelConfig, ...options };
        this._renderer = renderer;

        this._worker = new Worker(
            /* webpackChunkName: "itowns_labelworker" */
            new URL('./Worker/LabelWorkerScript.js', import.meta.url),
            { type: 'module' },
        );
        this._worker.onmessage = (e: MessageEvent<WorkerToMain>) => this._inbox.push(e.data);
        this._worker.onerror = (e) => {
            console.error('[LabelWorker] failed to load / threw:', e.message, e.filename, e.lineno, e);
        };
        this._worker.onmessageerror = (e) => {
            console.error('[LabelWorker] message deserialisation error:', e);
        };

        const cfg = this.config;
        this._post({
            type: 'INIT',
            baseFontSize: cfg.baseFontSize, fadeDurationMs: cfg.fadeDurationMs,
            downscale: cfg.downscale, coarseScale: cfg.coarseScale,
            acceptableOcclusion: cfg.acceptableOcclusion, maxOcclusion: cfg.maxOcclusion,
            collisionBuckets: cfg.collisionBuckets, ndcCullMargin: cfg.ndcCullMargin,
            renderPenaltyMultiplier: cfg.renderPenaltyMultiplier,
            fontSizePriorityPower: cfg.fontSizePriorityPower,
            pxPerUnit: cfg.pxPerUnit,
        });

        if (cfg.autoResizePxPerUnit) {
            this._resizeObserver = new ResizeObserver(() => {
                if (this._lastCamera) this.updatePxPerUnit(computePxPerUnit(this._lastCamera, this._renderer));
            });
            this._resizeObserver.observe(renderer.domElement);
        }
    }

    // ── Scene management ─────────────────────────────────────────────────────

    attachTo(scene: Scene) {
        this._scene = scene;
        for (const pair of this.meshes) scene.add(pair.fill, pair.halo);
    }

    // ── Labels in / out ──────────────────────────────────────────────────────

    addLabel(label: Label)  { this.addLabels([label]); }
    removeLabel(label: Label) { this.removeLabels([label]); }

    addLabels(labels: Label[]) {
        const byKey = this._groupByFontKey(labels);
        for (const [key, bucket] of byKey) {
            this._getOrCreate(key, bucket[0]).fontGroup.addLabels(bucket);
        }
        for (const l of labels) {
            this._labelsById.set(l.id, l);
            this._labelFontKey.set(l.id, fontKeyString(fontKeyOf(l)));
        }
    }

    removeLabels(labels: Label[]) {
        const byKey = this._groupByFontKey(labels);
        for (const [key, bucket] of byKey) {
            this._groups.get(key)?.fontGroup.removeLabels(bucket);
        }
        const ids = labels.map(l => l.id);
        for (const l of labels) {
            this._labelsById.delete(l.id);
            this._labelFontKey.delete(l.id);
            this._pendingGlyphs.delete(l.id);
        }
        this._post({ type: 'REMOVE_LABELS', ids });
    }

    updatePxPerUnit(pxPerUnit: number) {
        this.config.pxPerUnit = pxPerUnit;
        for (const g of this._groups.values()) g.meshGroup.updatePxPerUnit(pxPerUnit);
        this._post({ type: 'SET_PX_PER_UNIT', pxPerUnit });
    }

    // ── Per-frame work ────────────────────────────────────────────────────────

    tick(camera: Camera) {
        this._lastCamera = camera;
        const now       = performance.now();
        const frameDelta = now - this._lastFrameTime;
        this._lastFrameTime = now;

        // 1. Drain worker inbox — apply layout / eval / fade results.
        // Worker messages can't arrive mid-tick (single thread), so the buffer
        // is stable here: process all, then clear in one shot.
        this._needsCull = false;
        for (let i = 0; i < this._inbox.length; i++) this._handleWorkerMsg(this._inbox[i]);
        this._inbox.length = 0;

        // 2. Sync font groups (atlas + GPU label slots, send deltas to worker)
        let anySynced = false;
        const dueForUpdate = this._hasPendingWork || now - this._lastUpdateTime >= this.config.updateRate * 1000;
        if (dueForUpdate) {
            this._hasPendingWork = false;
            for (const [key, group] of this._groups) {
                if (group.fontGroup.dirty.size > 0) {
                    this._syncGroup(key, group);
                    anySynced = true;
                }
            }
            if (anySynced) {
                if (!this._hasPendingWork) this._lastUpdateTime = now;
                this._lastCullTime = 0;
            }
        }

        // 3. VP gate — stationary / fast-move check (mirrors the sync manager)
        this._curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        if (!this._evalVPInitialized) {
            this._lastEvalVP.copy(this._curVP);
            this._lastFrameVP.copy(this._curVP);
            this._evalVPInitialized = true;
        }
        // Instantaneous speed (frame-to-frame) — breaks the deadlock where a
        // stale _lastEvalVP would otherwise keep isFastMove true forever.
        const frameDiff = matrixMaxDiff(this._curVP, this._lastFrameVP);
        const isFastMove = frameDiff > this.config.fastMoveFraction;
        // Cumulative drift since last evaluation.
        const evalDiff = matrixMaxDiff(this._curVP, this._lastEvalVP);
        const isStationary = evalDiff < this.config.stationaryThreshold;
        this._lastFrameVP.copy(this._curVP);

        // 4. Send EVALUATE to worker — forced when labels changed (anySynced),
        // otherwise when due and the camera is moving at a moderate pace.
        const dueForCollision = now - this._lastCullTime >= this.config.cullingRate * 1000;
        if (this._labelsById.size > 0 && (anySynced || (dueForCollision && !isStationary && !isFastMove))) {
            const vpSize = this._renderer.getSize(this._vpSize);
            let near = 0.1, far = 1e7;
            if (camera instanceof PerspectiveCamera) { near = camera.near; far = camera.far; }

            this._projScratch.set(camera.projectionMatrix.elements);
            this._viewScratch.set(camera.matrixWorldInverse.elements);
            this._post({
                type: 'EVALUATE',
                projMatrix: this._projScratch,
                viewMatrix: this._viewScratch,
                camX: camera.position.x, camY: camera.position.y, camZ: camera.position.z,
                near, far,
                vpWidth: vpSize.x, vpHeight: vpSize.y,
            });

            this._lastCullTime = now;
            this._lastEvalVP.copy(this._curVP);
        }

        // 5. Advance fades in the worker — only while labels exist.
        if (this._labelsById.size > 0) {
            this._post({ type: 'FRAME', frameDelta });
        }

        // 6. Cull if anything changed this tick
        const farCullChanged = this._applyFarCull(camera);
        if (this._needsCull || anySynced || farCullChanged) {
            for (const group of this._groups.values()) {
                group.meshGroup.cull(group.fontGroup.labels);
            }
        }
    }

    dispose() {
        this._resizeObserver?.disconnect();
        this._worker.terminate();
        if (this._scene) {
            for (const pair of this.meshes) this._scene.remove(pair.fill, pair.halo);
        }
        for (const g of this._groups.values()) {
            g.fontGroup.dispose();
            g.meshGroup.dispose();
        }
        this._groups.clear();
        this.meshes.length = 0;
        this._labelsById.clear();
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private _post(msg: MainToWorker) {
        this._worker.postMessage(msg);
    }

    private _groupByFontKey(labels: Label[]): Map<string, Label[]> {
        const byKey = new Map<string, Label[]>();
        for (const label of labels) {
            const key = fontKeyString(fontKeyOf(label));
            if (!key) continue;
            let b = byKey.get(key);
            if (!b) { b = []; byKey.set(key, b); }
            b.push(label);
        }
        return byKey;
    }

    private _getOrCreate(key: string, sample: Label): LabelGroup {
        const existing = this._groups.get(key);
        if (existing) return existing;
        const meshGroup  = new LabelMeshGroup(this.config);
        const fontGroup  = new LabelFontGroup(fontKeyOf(sample), this.config);
        const group: LabelGroup = { fontGroup, meshGroup, atlasSent: false };
        this._groups.set(key, group);
        this.meshes.push({ fill: meshGroup.fillMesh, halo: meshGroup.haloMesh });
        this._scene?.add(meshGroup.fillMesh, meshGroup.haloMesh);
        return group;
    }

    private _syncGroup(fontKey: string, group: LabelGroup) {
        const { fontGroup, meshGroup } = group;
        const { atlas, dirty, resized } = fontGroup.getAtlas();

        // If atlas changed, sync GPU material + send glyph metrics to worker
        if (dirty || resized || !group.atlasSent) {
            meshGroup.syncAtlas(atlas);
            // Convert Map<string, GlyphInfo> to plain Record for postMessage.
            // resized → worker re-lays-out ALL labels of this font (atlas coords moved).
            const glyphsRecord: Record<string, GlyphInfo> = {};
            for (const [ch, g] of atlas.glyphs) glyphsRecord[ch] = g;
            this._post({
                type: 'SET_ATLAS', fontKey, glyphs: glyphsRecord,
                baseFontSize: this.config.baseFontSize, resized,
            });
            group.atlasSent = true;
        }

        const budget  = this.config.layoutBudgetPerTick;
        let layoutCount = 0;

        const toAdd:    Label[] = [];
        const toRemove: string[] = [];
        const toStyle:  Label[] = [];
        const workerAdd: SerialisedLabel[] = [];

        for (const [label, level] of fontGroup.dirty) {
            switch (level) {
                case DirtyLevel.Add:
                case DirtyLevel.LayoutUpdate: {
                    if (budget > 0 && layoutCount >= budget) {
                        this._hasPendingWork = true;
                        continue;
                    }
                    // GPU label slot — no glyphs yet (they arrive via LAYOUT_DONE)
                    toAdd.push(label);
                    this._pendingGlyphs.set(label.id, label);
                    this._gpuLabels.add(label.id);
                    workerAdd.push(this._serialise(label, fontKey));
                    layoutCount++;
                    break;
                }
                case DirtyLevel.StyleUpdate:
                    // Only style-update labels that already have a GPU slot.
                    if (this._gpuLabels.has(label.id)) toStyle.push(label);
                    break;
                case DirtyLevel.Dispose:
                case DirtyLevel.ChangeGroup:
                    // Only remove from GPU if a slot was ever allocated.
                    if (this._gpuLabels.has(label.id)) {
                        toRemove.push(label.id);
                        this._gpuLabels.delete(label.id);
                    }
                    this._pendingGlyphs.delete(label.id);
                    break;
            }
        }

        // GPU writes for removes + adds (label T0-T5 data) + style
        meshGroup.update(toAdd, toRemove, [], toStyle, dirty ? atlas : undefined, false);

        // Worker: register new labels (for layout + collision)
        if (workerAdd.length > 0) this._post({ type: 'ADD_LABELS', labels: workerAdd });
        if (toRemove.length  > 0) this._post({ type: 'REMOVE_LABELS', ids: toRemove });

        fontGroup.flushDirty();
    }

    private _serialise(label: Label, fontKey: string): SerialisedLabel {
        return {
            id:               label.id,
            fontKey,
            text:             label.text,
            textTransform:    label.textTransform,
            font:             label.font,
            fontSize:         label.fontSize,
            fontWeight:       label.fontWeight,
            letterSpacing:    label.letterSpacing,
            lineHeight:       label.lineHeight,
            maxWidth:         label.maxWidth,
            textAlign:        label.textAlign,
            padding:          [label.padding.top, label.padding.right, label.padding.bottom, label.padding.left],
            position:         [label.position.x,  label.position.y,  label.position.z],
            rotation:         [label.rotation.x,  label.rotation.y,  label.rotation.z, label.rotation.w],
            offset:           [label.offset.x,    label.offset.y],
            anchorX:          label.anchorX,
            anchorY:          label.anchorY,
            rotationAlignment: label.rotationAlignment,
            symbolPlacement:  label.symbolPlacement,
            visible:          label.visible,
            opacity:          label.opacity,
            groupVisible:     label.groupVisible,
        };
    }

    // ── Worker message handlers ───────────────────────────────────────────────

    private _handleWorkerMsg(msg: WorkerToMain) {
        switch (msg.type) {
            case 'LAYOUT_DONE':
                this._onLayoutDone(msg);
                break;
            case 'EVAL_DONE':
                this._onEvalDone(msg.ids, msg.shouldRender, msg.isCandidate);
                break;
            case 'FADES_DONE':
                if (msg.anyChanged) this._onFadesDone(msg.ids, msg.occlusionFades);
                break;
        }
    }

    private _onLayoutDone(msg: WorkerToMain & { type: 'LAYOUT_DONE' }) {
        for (const { id, glyphs, bounds } of msg.results) {
            const label = this._labelsById.get(id);
            if (!label) continue;
            // Apply layout results to the main-thread label (non-reactive fields — no onChange fired)
            label.glyphs = glyphs as any;
            label.bounds = bounds;
            this._pendingGlyphs.delete(id);

            // Write glyph data to GPU
            const key   = this._labelFontKey.get(id);
            const group = key ? this._groups.get(key) : undefined;
            group?.meshGroup.reemitGlyphs(label);
        }
        this._needsCull = true;
    }

    private _onEvalDone(ids: string[], shouldRender: Uint8Array, isCandidate: Uint8Array) {
        for (let i = 0; i < ids.length; i++) {
            const label = this._labelsById.get(ids[i]);
            if (!label) continue;
            label.shouldRender = shouldRender[i] === 1;
            label.isCandidate  = isCandidate[i]  === 1;
        }
        // Re-apply far-cull with the latest camera so a stale EVAL_DONE
        // from before a far-plane shrink cannot re-show clipped labels.
        if (this._lastCamera) this._applyFarCull(this._lastCamera);
        this._needsCull = true;
    }

    /**
     * Per-frame far-plane cull — runs unconditionally every frame, bypassing
     * the cullingRate gate.  Hides labels at the start of the fog zone
     * (`scene.fog.near` when available, otherwise `camera.far`) so they
     * disappear before the un-fogged label shader makes them look crisp
     * against a fogged background.
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

    private _onFadesDone(ids: string[], occlusionFades: Float32Array) {
        for (let i = 0; i < ids.length; i++) {
            const label = this._labelsById.get(ids[i]);
            if (label) label.occlusionFade = occlusionFades[i];
        }
        this._needsCull = true;
    }
}
