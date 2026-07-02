// MapLibre instrumentation probe
// ─────────────────────────────────────────────────────────────────────────
// Taps a live `maplibregl.Map` and emits per-frame stage records in the SAME
// shape the iTowns label-bench `FrameStatsCollector` consumes, keyed onto the
// shared PROF_KEYS taxonomy (workerWait, geomBuild, layout, candidate,
// priority, occlusion, gpu, webgl, net). This makes an iTowns frame record and
// a MapLibre frame record diffable stage-by-stage.
//
// Design choice: everything here is RUNTIME WRAPPING of objects reachable from
// the live map instance — no maplibre source fork, no patch-package needed for
// these stages. The prebuilt browser bundle is loaded as-is; we wrap:
//   • Actor.sendAsync (per worker actor)        → workerWait  (decode+bucket+
//                                                  symbol-layout round trip,
//                                                  async → "between-frame")
//   • Style._updatePlacement / Placement        → candidate / priority /
//                                                  occlusion (main-thread
//                                                  collision, "in-frame")
//   • gl.bufferData / bufferSubData / texImage2D → gpu (buffer/atlas upload)
//   • gl.drawElements / drawArrays               → webgl + draw calls + tris
//
// Stages that live purely inside the worker and need a finer split
// (decode vs populate vs glyph layout) are folded into `workerWait` here; the
// worker-internal split + the forced-label-count cap are applied via a patched
// worker (see packages/Bench/patches) and are layered on top of this probe.

type NumMap = Record<string, number>;

export interface ProfSnapshot {
    /** in-frame main-thread cost per stage (blocks the cpu window) */
    prof: NumMap;
    /** between-frame cost per stage (async / worker — delays next rAF) */
    profBetween: NumMap;
    /** number of calls per stage over the frame */
    profCalls: NumMap;
    /** worst single-call cost per stage over the frame */
    profCallPeak: NumMap;
    /** label/feature counts for the frame */
    counts: NumMap;
    /** WebGL draw calls issued this frame */
    drawCalls: number;
    /** triangles submitted this frame */
    tris: number;
    /** synchronous main-thread render-window time this frame (cpu window) */
    cpuMs: number;
}

// PROF_KEYS the harness understands. MapLibre populates the meaningful subset;
// the rest stay 0 so the exported schema lines up key-for-key with iTowns.
const STAGE_KEYS = [
    'net', 'workerWait', 'build', 'geomBuild', 'parse', 'register', 'layout',
    'thin', 'delete', 'candidate', 'priority', 'occlusion', 'position',
    'atlas', 'cull', 'fades', 'farcull', 'showhide', 'webgl', 'gpu',
] as const;

const COUNT_KEYS = ['total', 'isCandidate', 'shouldRender', 'isRendered', 'groups'] as const;

function zero(keys: readonly string[]): NumMap {
    const o: NumMap = {};
    for (const k of keys) { o[k] = 0; }
    return o;
}

const now = () => performance.now();

export class MapLibreProbe {
    private map: any;
    private installed = false;
    private wraps: Array<() => void> = [];

    // per-frame accumulators
    private inFrame: NumMap = zero(STAGE_KEYS);
    private between: NumMap = zero(STAGE_KEYS);
    private calls: NumMap = zero(STAGE_KEYS);
    private callPeak: NumMap = zero(STAGE_KEYS);
    private counts: NumMap = zero(COUNT_KEYS);
    private drawCalls = 0;
    private tris = 0;

    // total synchronous main-thread time spent inside map._render this frame
    // (placement + painter + GL submit) — the "cpu window", analogous to the
    // iTowns stage.cpu. interFrame = frameMs - cpuMs then captures worker/async.
    private cpuMs = 0;

    // ── Async GPU timer (EXT_disjoint_timer_query_webgl2) ────────────────────
    // Mirrors the iTowns c3DEngine GPU timer: bracket the whole render submit in
    // a TIME_ELAPSED query, drain finished results a few frames later into the
    // `gpu` stage (real GPU execution time, distinct from the CPU-side `webgl`
    // submit cost we already measure by wrapping drawElements).
    private gl: WebGL2RenderingContext | null = null;
    private gpuTimer: {
        ext: any; free: any[]; pending: any[]; active: any;
    } = { ext: undefined, free: [], pending: [], active: null };
    private pendingGpuMs = 0;

    // worker round-trips resolve asynchronously between frames; we accumulate
    // their wall time as it lands and flush it into the next drained frame.
    private pendingWorkerMs = 0;
    private pendingWorkerCalls = 0;
    private pendingWorkerPeak = 0;
    // worker-internal sub-stage time (from the patched worker's per-tile __bench),
    // accumulated as tiles resolve and flushed as between-frame cost next drain.
    private pendingStage: NumMap = { register: 0, priority: 0, layout: 0 };
    private pendingStageCalls: NumMap = { register: 0, priority: 0, layout: 0 };
    private pendingStagePeak: NumMap = { register: 0, priority: 0, layout: 0 };

    constructor(map: any) {
        this.map = map;
    }

    /** Install all runtime wraps. Idempotent. */
    attach(): void {
        if (this.installed) { return; }
        this.installed = true;
        this.wrapActors();
        this.wrapPlacement();
        this.wrapGL();
        this.wrapRender();
    }

    /** Remove all wraps and restore originals. */
    detach(): void {
        for (const undo of this.wraps.splice(0)) {
            try { undo(); } catch { /* ignore */ }
        }
        this.installed = false;
    }

    private accumIn(stage: string, ms: number): void {
        this.inFrame[stage] += ms;
        this.calls[stage] += 1;
        if (ms > this.callPeak[stage]) { this.callPeak[stage] = ms; }
    }

    // ── workerWait: time every loadTile/reloadTile actor round trip ─────────
    // These are async (the worker decodes PBF, builds buckets, runs symbol
    // layout off-thread), so the wall time is "between-frame" cost.
    private wrapActors(): void {
        // maplibre-gl v4 message types are short codes: "LT"=loadTile,
        // "RT"=reloadTile. (The old "loadTile"/"reloadTile" strings never matched,
        // so workerWait read 0 and MapLibre's whole off-thread cost was invisible.)
        const isTileMsg = (t: any) => t === 'LT' || t === 'RT'
            || t === 'loadTile' || t === 'reloadTile';
        const dispatcher = this.map?.style?.dispatcher;
        const actors: any[] = dispatcher?.actors || [];
        for (const actor of actors) {
            const orig = actor.sendAsync;
            if (typeof orig !== 'function') { continue; }
            actor.sendAsync = (message: any, abortController?: any) => {
                const timed = isTileMsg(message?.type);
                const t0 = timed ? now() : 0;
                const p = orig.call(actor, message, abortController);
                if (timed && p && typeof p.then === 'function') {
                    p.then((result: any) => this.onWorkerDone(now() - t0, result),
                        () => { /* aborted/failed — don't count */ });
                }
                return p;
            };
            this.wraps.push(() => { actor.sendAsync = orig; });
        }
    }

    // A tile finished in the worker. We DELIBERATELY ignore the sendAsync
    // round-trip wall time (`_ms`) — it is dominated by worker-queue latency
    // (a tile waits seconds behind others in the single worker), not by work,
    // and produced the absurd multi-second `workerWait` peaks. Instead we use the
    // patched worker's per-tile `__bench` = the tile's REAL in-worker CPU cost:
    //   register = populate − sort   (feature creation / shaping setup)
    //   priority = sort              (symbol-sort-key sort)
    //   layout   = performSymbolLayout (glyph shaping / quad + collision boxes)
    //   workerWait = create + layout = the honest total worker CPU for the tile.
    private onWorkerDone(_ms: number, result?: any): void {
        const b = result && result.__bench;
        if (!b) { return; }
        const create = b.create || 0; // populate, includes the sort block
        const sort = b.sort || 0;
        const layout = b.layout || 0;
        const workMs = create + layout;
        this.pendingWorkerMs += workMs;
        this.pendingWorkerCalls += 1;
        if (workMs > this.pendingWorkerPeak) { this.pendingWorkerPeak = workMs; }
        const reg = create - sort;
        if (reg > 0) {
            this.pendingStage.register += reg;
            this.pendingStageCalls.register += 1;
            if (reg > this.pendingStagePeak.register) { this.pendingStagePeak.register = reg; }
        }
        if (sort > 0) {
            this.pendingStage.priority += sort;
            this.pendingStageCalls.priority += 1;
            if (sort > this.pendingStagePeak.priority) { this.pendingStagePeak.priority = sort; }
        }
        if (layout > 0) {
            this.pendingStage.layout += layout;
            this.pendingStageCalls.layout += 1;
            if (layout > this.pendingStagePeak.layout) { this.pendingStagePeak.layout = layout; }
        }
    }

    // ── collision / placement (main thread) ────────────────────────────────
    // Map maplibre's placement onto the iTowns collision split:
    //   continuePlacement (build + collide candidates) → candidate
    //   commit (finalize chosen set)                    → priority
    //   updateLayerOpacities (apply, fade)              → occlusion
    private wrapPlacement(): void {
        const style = this.map?.style;
        if (!style) { return; }

        // Whole-step wrapper around _updatePlacement gives us a reliable hook
        // even as Placement instances are recreated each pass; from inside we
        // lazily wrap the current placement/pauseablePlacement instances.
        const origUpdate = style._updatePlacement;
        if (typeof origUpdate === 'function') {
            style._updatePlacement = (...args: any[]) => {
                this.ensurePlacementWrapped(style);
                const t0 = now();
                const r = origUpdate.apply(style, args);
                // any time not attributed to the sub-stages below lands here as
                // the candidate/build cost of this placement pass
                this.accumIn('candidate', now() - t0);
                return r;
            };
            this.wraps.push(() => { style._updatePlacement = origUpdate; });
        }
    }

    private placementWrapped = new WeakSet<object>();
    private ensurePlacementWrapped(style: any): void {
        const pp = style.pauseablePlacement;
        if (pp && !this.placementWrapped.has(pp)) {
            this.placementWrapped.add(pp);
            const commit = pp.commit;
            if (typeof commit === 'function') {
                pp.commit = (...a: any[]) => {
                    const t0 = now();
                    const r = commit.apply(pp, a);
                    this.accumIn('priority', now() - t0);
                    return r;
                };
            }
        }
        const placement = style.placement;
        if (placement && !this.placementWrapped.has(placement)) {
            this.placementWrapped.add(placement);
            const ulo = placement.updateLayerOpacities;
            if (typeof ulo === 'function') {
                placement.updateLayerOpacities = (...a: any[]) => {
                    const t0 = now();
                    const r = ulo.apply(placement, a);
                    this.accumIn('occlusion', now() - t0);
                    return r;
                };
            }
        }
    }

    // ── GPU upload + draw counting ─────────────────────────────────────────
    private wrapGL(): void {
        const gl: WebGLRenderingContext | WebGL2RenderingContext | undefined =
            this.map?.painter?.context?.gl;
        if (!gl) { return; }
        // Keep a handle for the GPU timer (WebGL2 only).
        if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
            this.gl = gl;
        }

        const wrapTimed = (name: string, stage: string) => {
            const orig = (gl as any)[name];
            if (typeof orig !== 'function') { return; }
            (gl as any)[name] = (...a: any[]) => {
                const t0 = now();
                const r = orig.apply(gl, a);
                this.accumIn(stage, now() - t0);
                return r;
            };
            this.wraps.push(() => { (gl as any)[name] = orig; });
        };

        // Split GPU uploads the way the iTowns taxonomy does:
        //   vertex/index buffer uploads → geomBuild (geometry build/upload)
        //   texture uploads            → atlas    (SDF glyph atlas upload)
        wrapTimed('bufferData', 'geomBuild');
        wrapTimed('bufferSubData', 'geomBuild');
        wrapTimed('texImage2D', 'atlas');
        wrapTimed('texSubImage2D', 'atlas');

        // draws → webgl stage + draw-call/triangle counters
        const wrapDraw = (name: 'drawElements' | 'drawArrays') => {
            const orig = (gl as any)[name];
            if (typeof orig !== 'function') { return; }
            (gl as any)[name] = (mode: number, ...rest: any[]) => {
                const t0 = now();
                const r = orig.call(gl, mode, ...rest);
                this.accumIn('webgl', now() - t0);
                this.drawCalls += 1;
                // count is rest[0] for both signatures (drawElements: count,
                // type, offset; drawArrays: first, count → rest[1])
                const count = name === 'drawElements' ? rest[0] : rest[1];
                if (typeof count === 'number' && mode === gl.TRIANGLES) {
                    this.tris += count / 3;
                }
                return r;
            };
            this.wraps.push(() => { (gl as any)[name] = orig; });
        };
        wrapDraw('drawElements');
        wrapDraw('drawArrays');
    }

    // ── total render cpu window ────────────────────────────────────────────
    private wrapRender(): void {
        const map = this.map;
        const orig = map._render;
        if (typeof orig !== 'function') { return; }
        map._render = (...a: any[]) => {
            this.gpuTimerBegin();
            const t0 = now();
            const r = orig.apply(map, a);
            this.cpuMs += now() - t0;
            this.gpuTimerEnd();
            return r;
        };
        this.wraps.push(() => { map._render = orig; });
    }

    // Open a GPU timer around this render submit. One query in flight at a time
    // (matching iTowns); if the extension is missing we simply never populate gpu.
    private gpuTimerBegin(): void {
        const gl = this.gl;
        if (!gl) { return; }
        const t = this.gpuTimer;
        if (t.ext === undefined) {
            t.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') || null;
        }
        if (!t.ext || t.active) { return; }
        const q = t.free.pop() || gl.createQuery();
        gl.beginQuery(t.ext.TIME_ELAPSED_EXT, q);
        t.active = q;
    }

    // Close the active query and drain any finished ones (oldest first) into
    // pendingGpuMs. Results arrive a few frames late, so — like workerWait — this
    // is between-frame cost, flushed into the next drained frame.
    private gpuTimerEnd(): void {
        const gl = this.gl;
        const t = this.gpuTimer;
        if (!gl || !t.ext) { return; }
        if (t.active) {
            gl.endQuery(t.ext.TIME_ELAPSED_EXT);
            t.pending.push(t.active);
            t.active = null;
        }
        while (t.pending.length) {
            const q = t.pending[0];
            const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE);
            const disjoint = gl.getParameter(t.ext.GPU_DISJOINT_EXT);
            if (!available) { break; }
            t.pending.shift();
            if (!disjoint) {
                const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
                this.pendingGpuMs += ns / 1e6;
            }
            t.free.push(q);
        }
    }

    /**
     * Drop any worker round-trips / sub-stage time that resolved BEFORE the
     * measured pass (i.e. accumulated during warmup). Call once right before
     * measuring, otherwise the whole warmup backlog dumps into frame 1 and makes
     * the first step look catastrophically slow.
     */
    resetPending(): void {
        this.pendingWorkerMs = 0;
        this.pendingWorkerCalls = 0;
        this.pendingWorkerPeak = 0;
        this.pendingGpuMs = 0;
        this.pendingStage = { register: 0, priority: 0, layout: 0 };
        this.pendingStageCalls = { register: 0, priority: 0, layout: 0 };
        this.pendingStagePeak = { register: 0, priority: 0, layout: 0 };
    }

    /** Reset per-frame accumulators. Call at the start of each measured frame. */
    beginFrame(): void {
        this.inFrame = zero(STAGE_KEYS);
        this.between = zero(STAGE_KEYS);
        this.calls = zero(STAGE_KEYS);
        this.callPeak = zero(STAGE_KEYS);
        this.counts = zero(COUNT_KEYS);
        this.drawCalls = 0;
        this.tris = 0;
        this.cpuMs = 0;
    }

    /**
     * Set the per-frame label counts (from a placement/source query the caller
     * performs). `total` = candidates considered, `isRendered` = placed/visible.
     */
    setCounts(c: Partial<NumMap>): void {
        for (const k of COUNT_KEYS) {
            if (c[k] != null) { this.counts[k] = c[k] as number; }
        }
    }

    /**
     * Drain accumulated stage data into a snapshot for the current frame and
     * fold in any worker round-trips that resolved since the last drain.
     */
    drainFrame(): ProfSnapshot {
        // attribute resolved worker wall time to this frame as between-frame
        this.between.workerWait += this.pendingWorkerMs;
        this.calls.workerWait += this.pendingWorkerCalls;
        if (this.pendingWorkerPeak > this.callPeak.workerWait) {
            this.callPeak.workerWait = this.pendingWorkerPeak;
        }
        this.pendingWorkerMs = 0;
        this.pendingWorkerCalls = 0;
        this.pendingWorkerPeak = 0;

        // GPU query results that came back since the last drain — async, so
        // between-frame cost like workerWait.
        if (this.pendingGpuMs) {
            this.between.gpu += this.pendingGpuMs;
            this.calls.gpu += 1;
            if (this.pendingGpuMs > this.callPeak.gpu) { this.callPeak.gpu = this.pendingGpuMs; }
            this.pendingGpuMs = 0;
        }

        // worker-internal sub-stages (decode/create/layout) resolved since last
        // drain — between-frame cost, and a subset of workerWait above.
        for (const k of ['register', 'priority', 'layout']) {
            if (this.pendingStage[k]) {
                this.between[k] += this.pendingStage[k];
                this.calls[k] += this.pendingStageCalls[k];
                if (this.pendingStagePeak[k] > this.callPeak[k]) { this.callPeak[k] = this.pendingStagePeak[k]; }
                this.pendingStage[k] = 0;
                this.pendingStageCalls[k] = 0;
                this.pendingStagePeak[k] = 0;
            }
        }

        return {
            prof: { ...this.inFrame },
            profBetween: { ...this.between },
            profCalls: { ...this.calls },
            profCallPeak: { ...this.callPeak },
            counts: { ...this.counts },
            drawCalls: this.drawCalls,
            tris: Math.round(this.tris),
            cpuMs: this.cpuMs,
        };
    }
}

// ── Camera mapping: iTowns {range,tilt,heading} → MapLibre {zoom,pitch,bearing}
// ─────────────────────────────────────────────────────────────────────────
// iTowns `range` is the metric distance from the camera to the look-at point on
// the ground; MapLibre frames its `center` at exactly that look-at point. So the
// faithful mapping is: pick the zoom whose camera-to-center distance equals
// `range`. MapLibre's camera-to-center distance (in screen px) is
//   C = 0.5 * viewportHeight / tan(fov/2)
// and the ground metres per screen-px at the center, zoom z, latitude φ is
//   mpp = (2πR·cos φ) / (512·2^z)      (R = 6378137, MapLibre uses 512-px tiles)
// Setting range = C·mpp and solving for z gives a closed form that depends only
// on the live viewport height, FOV and latitude — no hand-tuned constants. This
// replaces the old `25.8 − log2(range)` guess that ignored viewport and FOV and
// so never framed the same horizon as the globe camera.
const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137; // metres

interface CamParams { heightPx: number; fovRad: number }

/**
 * camera→ground metres → web-mercator zoom for a given viewport/FOV/latitude.
 * Falls back to a viewport-independent approximation (720px @ 0.6435 rad, the
 * MapLibre defaults) when no live params are supplied.
 */
export function rangeToZoom(range: number, latDeg = 0, p?: CamParams): number {
    const heightPx = p?.heightPx || 720;
    const fovRad = p?.fovRad || 0.6435011087932844; // MapLibre default FOV
    const camToCenterPx = 0.5 * heightPx / Math.tan(fovRad / 2);
    const cosLat = Math.cos(latDeg * Math.PI / 180) || 1e-6;
    // range = camToCenterPx · (EARTH_CIRCUMFERENCE·cosLat) / (512·2^z)
    const z = Math.log2(camToCenterPx * EARTH_CIRCUMFERENCE * cosLat / (512 * range));
    return Math.max(0, Math.min(24, z));
}

/**
 * iTowns tilt → MapLibre pitch. The two conventions are INVERTED:
 *   • iTowns GlobeControls: tilt = 90 − φ, so tilt 90° = nadir (straight down),
 *     tilt 0° = horizon (default view is ~89.5°, i.e. looking down).
 *   • MapLibre: pitch 0° = straight down (top view), pitch 85° = toward horizon.
 * So pitch = 90 − tilt (clamped to the map's maxPitch). With pitch = tilt the
 * camera looked exactly opposite (low iTowns tilt = horizon, but low MapLibre
 * pitch = nadir). Both are globes, so once inverted they frame the same view.
 */
export function tiltToPitch(tilt: number, maxPitch = 85): number {
    return Math.max(0, Math.min(maxPitch, 90 - tilt));
}

/**
 * @param d      the STEP drive() output ({coord,range,tilt,heading})
 * @param map    optional live maplibre map — when passed, zoom/pitch are derived
 *               from its actual viewport height, FOV and maxPitch for an exact
 *               framing match; omit for the default-viewport approximation.
 */
export function driveToCamera(
    d: { coord: { x: number; y: number }; range: number; tilt: number; heading: number },
    map?: any,
) {
    const tr = map?.transform;
    const camParams: CamParams | undefined = tr
        ? { heightPx: tr.height, fovRad: tr._fov ?? 0.6435011087932844 }
        : undefined;
    const maxPitch = typeof map?.getMaxPitch === 'function' ? map.getMaxPitch() : 85;
    return {
        center: [d.coord.x, d.coord.y] as [number, number],
        zoom: rangeToZoom(d.range, d.coord.y, camParams),
        bearing: ((d.heading % 360) + 360) % 360,
        pitch: tiltToPitch(d.tilt, maxPitch),
    };
}
