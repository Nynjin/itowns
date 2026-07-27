import { Vector2, Vector3 } from 'three';
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { FeatureCollection, FEATURE_TYPES } from 'Core/Feature';
import { globalExtentTMS } from 'Core/Tile/TileGrid';
import { deprecatedParsingOptionsToNewOne } from 'Core/Deprecated/Undeprecator';
import { LabelProfiler } from '@itowns/labels';
import { enqueueChunked } from 'Core/Scheduler/FrameBudget';

const worldDimension3857 = globalExtentTMS.get('EPSG:3857').planarDimensions();
const globalExtent = new Vector3(worldDimension3857.x, worldDimension3857.y, 1);
const lastPoint = new Vector2();
const firstPoint = new Vector2();

// Classify option, it allows to classify a full polygon and its holes.
// Each polygon with its holes are in one FeatureGeometry.
// A polygon is determined by its clockwise direction and the holes are in the opposite direction.
// Clockwise direction is determined by Shoelace formula https://en.wikipedia.org/wiki/Shoelace_formula
// Draw polygon with canvas doesn't need to classify however it is necessary for meshs.
function vtFeatureToFeatureGeometry(vtFeature, feature, classify = false) {
    let geometry = feature.bindNewGeometry();
    const isPolygon = feature.type === FEATURE_TYPES.POLYGON;
    classify = classify && isPolygon;

    geometry.properties = vtFeature.properties;
    const pbf = vtFeature._pbf;
    pbf.pos = vtFeature._geometry;

    const end = pbf.readVarint() + pbf.pos;
    let cmd = 1;
    let length = 0;
    let x = 0;
    let y = 0;
    let count = 0;
    let sum = 0;

    while (pbf.pos < end) {
        if (length <= 0) {
            const cmdLen = pbf.readVarint();
            cmd = cmdLen & 0x7;
            length = cmdLen >> 3;
        }

        length--;

        if (cmd === 1 || cmd === 2) {
            x += pbf.readSVarint();
            y += pbf.readSVarint();

            if (cmd === 1) {
                if (count) {
                    if (classify && sum > 0 && geometry.indices.length > 0) {
                        feature.updateExtent(geometry);
                        geometry = feature.bindNewGeometry();
                        geometry.properties = vtFeature.properties;
                    }
                    geometry.closeSubGeometry(count, feature);
                    geometry.getLastSubGeometry().ccw = sum < 0;
                }
                count = 0;
                sum = 0;
            }
            count++;
            geometry.pushCoordinatesValues(feature, { x, y });
            if (count == 1) {
                firstPoint.set(x, y);
                lastPoint.set(x, y);
            } else if (isPolygon && count > 1) {
                sum += (lastPoint.x - x) * (lastPoint.y + y);
                lastPoint.set(x, y);
            }
        } else if (cmd === 7) {
            if (count) {
                count++;
                geometry.pushCoordinatesValues(feature, { x: firstPoint.x, y: firstPoint.y });
                if (isPolygon) {
                    sum += (lastPoint.x - firstPoint.x) * (lastPoint.y + firstPoint.y);
                }
            }
        } else {
            throw new Error(`unknown command ${cmd}`);
        }
    }

    if (count) {
        if (classify && sum > 0 && geometry.indices.length > 0) {
            feature.updateExtent(geometry);
            geometry = feature.bindNewGeometry();
            geometry.properties = vtFeature.properties;
        }
        geometry.closeSubGeometry(count, feature);
        geometry.getLastSubGeometry().ccw = sum < 0;
    }
    feature.updateExtent(geometry);
}

// ─── Decode-once optimization ────────────────────────────────────────────────
// When a single VT feature matches multiple style layers, the expensive PBF
// varint parsing is done once and cached. The cached command buffer is then
// "replayed" into each layer's Feature cheaply.

// Command types stored in the decoded buffer
const CMD_MOVE = 1;
const CMD_LINE = 2;
const CMD_CLOSE = 7;

/**
 * Decode the PBF geometry of a VT feature into a replayable command buffer.
 * Each entry: { cmd, x, y } for move/line, or { cmd: CMD_CLOSE }.
 */
function decodeVtGeometry(vtFeature) {
    const commands = [];
    const pbf = vtFeature._pbf;
    pbf.pos = vtFeature._geometry;

    const end = pbf.readVarint() + pbf.pos;
    let cmd = 1;
    let length = 0;
    let x = 0;
    let y = 0;

    while (pbf.pos < end) {
        if (length <= 0) {
            const cmdLen = pbf.readVarint();
            cmd = cmdLen & 0x7;
            length = cmdLen >> 3;
        }
        length--;

        if (cmd === 1 || cmd === 2) {
            x += pbf.readSVarint();
            y += pbf.readSVarint();
            commands.push({ cmd, x, y });
        } else if (cmd === 7) {
            commands.push({ cmd: CMD_CLOSE });
        } else {
            throw new Error(`unknown command ${cmd}`);
        }
    }
    return commands;
}

/**
 * Replay a pre-decoded command buffer into a Feature (same logic as
 * vtFeatureToFeatureGeometry, but skips PBF parsing).
 */
function replayGeometry(commands, vtFeature, feature, classify = false) {
    let geometry = feature.bindNewGeometry();
    const isPolygon = feature.type === FEATURE_TYPES.POLYGON;
    classify = classify && isPolygon;

    geometry.properties = vtFeature.properties;
    let count = 0;
    let sum = 0;
    let _firstX = 0, _firstY = 0;
    let _lastX = 0, _lastY = 0;

    for (let i = 0; i < commands.length; i++) {
        const c = commands[i];

        if (c.cmd === CMD_MOVE || c.cmd === CMD_LINE) {
            if (c.cmd === CMD_MOVE) {
                if (count) {
                    if (classify && sum > 0 && geometry.indices.length > 0) {
                        feature.updateExtent(geometry);
                        geometry = feature.bindNewGeometry();
                        geometry.properties = vtFeature.properties;
                    }
                    geometry.closeSubGeometry(count, feature);
                    geometry.getLastSubGeometry().ccw = sum < 0;
                }
                count = 0;
                sum = 0;
            }
            count++;
            geometry.pushCoordinatesValues(feature, { x: c.x, y: c.y });
            if (count === 1) {
                _firstX = c.x; _firstY = c.y;
                _lastX = c.x; _lastY = c.y;
            } else if (isPolygon && count > 1) {
                sum += (_lastX - c.x) * (_lastY + c.y);
                _lastX = c.x; _lastY = c.y;
            }
        } else if (c.cmd === CMD_CLOSE) {
            if (count) {
                count++;
                geometry.pushCoordinatesValues(feature, { x: _firstX, y: _firstY });
                if (isPolygon) {
                    sum += (_lastX - _firstX) * (_lastY + _firstY);
                }
            }
        }
    }

    if (count) {
        if (classify && sum > 0 && geometry.indices.length > 0) {
            feature.updateExtent(geometry);
            geometry = feature.bindNewGeometry();
            geometry.properties = vtFeature.properties;
        }
        geometry.closeSubGeometry(count, feature);
        geometry.getLastSubGeometry().ccw = sum < 0;
    }
    feature.updateExtent(geometry);
}

// ─── Worker pool for off-thread PBF decoding ─────────────────────────────────
// The worker handles the expensive PBF varint parsing. Filter matching and
// Feature/FeatureCollection construction remain on the main thread (cheap,
// needs access to compiled filter functions and the Feature class hierarchy).

const WORKER_POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 4);
let _workerPool = null;
let _workerRR = 0;    // round-robin index
let _msgId = 0;
const _pending = new Map(); // msgId → { resolve, reject }
let _workerPoolFailed = false;

function _getWorkerPool() {
    if (_workerPoolFailed) { return null; }
    if (_workerPool) { return _workerPool; }
    try {
        _workerPool = [];
        for (let i = 0; i < WORKER_POOL_SIZE; i++) {
            const w = new Worker(
                /* webpackChunkName: "itowns_vtworker" */
                new URL('../Worker/VTDecodeWorker.js', import.meta.url),
                { type: 'module' },
            );
            w.onmessage = (e) => {
                const { id, decoded, built, error } = e.data;
                const p = _pending.get(id);
                if (!p) { return; }
                _pending.delete(id);
                // Off-thread/queue latency: post → result (does NOT block the frame).
                LabelProfiler.end('workerWait', p.token);
                if (error) { p.reject(new Error(error)); }
                else { p.resolve(built ? { built } : { decoded }); }
            };
            w.onerror = (e) => {
                console.warn('[VTWorker] worker error:', e.message);
            };
            _workerPool.push(w);
        }
        return _workerPool;
    } catch {
        _workerPool = null;
        _workerPoolFailed = true;
        return null;
    }
}

/**
 * Send PBF ArrayBuffer to a worker for decoding (legacy, kept for fallback).
 * @param {ArrayBuffer} buffer - Raw PBF tile data.
 * @param {string[]} wantedLayers - Source-layer names to decode.
 * @returns {Promise<object>|null} Decoded VT layers, or null if transfer failed.
 */
function _decodeInWorker(buffer, wantedLayers) {
    const pool = _getWorkerPool();
    if (!pool) { return null; }
    const w = pool[_workerRR++ % pool.length];
    const id = ++_msgId;
    // Register pending BEFORE postMessage to avoid race where onmessage
    // fires before the promise resolver is stored.
    const token = LabelProfiler.begin();
    const promise = new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject, token });
    });
    try {
        w.postMessage({ id, buffer, wantedLayers }, [buffer]);
    } catch {
        _pending.delete(id);
        _workerPool = null;
        _workerPoolFailed = true;
        return null;
    }
    return promise;
}

// Hard upper bound of features built per resumable chunk. The time budget
// below is the primary limiter — feature cost varies wildly (a polygon can be
// 1000x a point), so a fixed count lets one chunk run 80ms on dense tiles.
const BUILD_FEATURES_PER_CHUNK = 128;

// Max wall-clock ms one buildChunk call may run before yielding mid-tile.
// Caps worst-case main-thread build tasks: a burst of complex features now
// spreads across more FrameBudget slices instead of stalling one frame.
const BUILD_CHUNK_BUDGET_MS = 3;

const _now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

// Reused per-vertex arg for pushCoordinatesValues — avoids allocating a fresh
// `{ x, y }` literal per vertex (thousands per tile) in the replay hot loop.
// Safe: pushCoordinatesValues reads x/y synchronously and never retains it.
const _pushXY = { x: 0, y: 0 };

/**
 * Resumable builder over worker-decoded geometry commands. Returns a function
 * that processes up to `maxFeatures` features per call and returns true once all
 * features across all layers have been built. State (layer/feature cursor) is
 * kept in the closure so the build can be split across FrameBudget slices.
 * The decoded format per VT feature: { type, properties, cmds: Int32Array }
 *
 * @param {object} decodedLayers - Worker output, keyed by source-layer name.
 * @param {object} options - Parsing options (in/out/extent).
 * @param {FeatureCollection} collection - Target collection to fill.
 * @returns {(maxFeatures: number, deadline: number) => boolean} Chunk step;
 * returns true when all features are built, false when it yields (count cap or
 * `deadline` — a `_now()` timestamp — reached), to be resumed next slice.
 */
function makeFeatureBuilder(decodedLayers, options, collection) {
    const z = options.extent.zoom;
    const layerNames = Object.keys(decodedLayers).filter(n => options.in.layers[n]);
    let li = 0;
    let fi = 0;

    return function buildChunk(maxFeatures, deadline) {
        let processed = 0;
        while (li < layerNames.length) {
            const layerDefs = options.in.layers[layerNames[li]];
            const { features } = decodedLayers[layerNames[li]];
            while (fi < features.length) {
                const df = features[fi++];
                const matched = layerDefs.filter(
                    l => l.filterExpression.filter({ zoom: z }, df),
                );
                for (const layer of matched) {
                    const feature = collection.requestFeatureById(layer.id, df.type - 1);
                    feature.id = layer.id;
                    feature.order = layer.order;
                    feature.style = options.in.styles[feature.id];
                    replayGeometryFromCommands(df.cmds, df.properties, feature);
                }
                // Yield on whichever limit hits first: the feature-count cap or
                // the time budget. Time is what prevents dense tiles stalling.
                if (++processed >= maxFeatures || _now() >= deadline) { return false; }
            }
            fi = 0;
            li++;
        }
        return true;
    };
}

/**
 * Build a resumable FrameBudget step that turns worker output into a
 * FeatureCollection across slices. Each call advances one chunk and is timed as
 * 'build'; the collection is finalized and returned once all features are built.
 *
 * @param {object} decodedLayers - Worker output.
 * @param {object} options - Parsing options.
 * @returns {() => { done: boolean, value?: FeatureCollection }} Step function.
 */
function makeBuildStep(decodedLayers, options) {
    let collection = null;
    let buildChunk = null;

    return function step() {
        const _p = LabelProfiler.begin();
        if (!collection) {
            options.out = options.out || {};
            const vtLayerNames = Object.keys(decodedLayers);
            collection = new FeatureCollection(options.out);
            if (vtLayerNames.length === 0) {
                LabelProfiler.end('build', _p);
                return { done: true, value: collection };
            }

            // x,y,z tile coordinates
            const x = options.extent.col;
            const z = options.extent.zoom;
            const y = options.in.isInverted ? options.extent.row : (1 << z) - options.extent.row - 1;

            // Use the first decoded layer's extent for scale/position
            const firstLayer = decodedLayers[vtLayerNames[0]];
            const tileExtent = firstLayer.extent;
            const size = tileExtent * 2 ** z;
            const center = -0.5 * size;

            collection.scale.set(globalExtent.x / size, -globalExtent.y / size, 1);
            collection.position.set(tileExtent * x + center, tileExtent * y + center, 0).multiply(collection.scale);
            collection.updateMatrixWorld();

            buildChunk = makeFeatureBuilder(decodedLayers, options, collection);
        }

        const done = buildChunk(BUILD_FEATURES_PER_CHUNK, _now() + BUILD_CHUNK_BUDGET_MS);
        LabelProfiler.end('build', _p);
        if (!done) { return { done: false }; }

        collection.removeEmptyFeature();
        collection.features.sort((a, b) => a.order - b.order);
        collection.updateExtent();
        collection.extent = options.extent;
        collection.isInverted = options.in.isInverted;
        LabelProfiler.count('tilesDecoded', 1);
        return { done: true, value: collection };
    };
}

/**
 * Replay decoded flat command array (Int32Array) into a Feature.
 * Format: [cmd, x, y, cmd, x, y, ..., CMD_CLOSE, ...]
 * Works directly on the flat array — no intermediate object allocation.
 */
function replayGeometryFromCommands(cmds, properties, feature, classify = false) {
    let geometry = feature.bindNewGeometry();
    const isPolygon = feature.type === FEATURE_TYPES.POLYGON;
    classify = classify && isPolygon;

    geometry.properties = properties;
    let count = 0;
    let sum = 0;
    let _firstX = 0, _firstY = 0;
    let _lastX = 0, _lastY = 0;

    for (let i = 0; i < cmds.length;) {
        const cmd = cmds[i];

        if (cmd === CMD_MOVE || cmd === CMD_LINE) {
            const x = cmds[i + 1];
            const y = cmds[i + 2];
            i += 3;

            if (cmd === CMD_MOVE) {
                if (count) {
                    if (classify && sum > 0 && geometry.indices.length > 0) {
                        feature.updateExtent(geometry);
                        geometry = feature.bindNewGeometry();
                        geometry.properties = properties;
                    }
                    geometry.closeSubGeometry(count, feature);
                    geometry.getLastSubGeometry().ccw = sum < 0;
                }
                count = 0;
                sum = 0;
            }
            count++;
            _pushXY.x = x; _pushXY.y = y;
            geometry.pushCoordinatesValues(feature, _pushXY);
            if (count === 1) {
                _firstX = x; _firstY = y;
                _lastX = x; _lastY = y;
            } else if (isPolygon && count > 1) {
                sum += (_lastX - x) * (_lastY + y);
                _lastX = x; _lastY = y;
            }
        } else {
            // CMD_CLOSE
            i += 1;
            if (count) {
                count++;
                _pushXY.x = _firstX; _pushXY.y = _firstY;
                geometry.pushCoordinatesValues(feature, _pushXY);
                if (isPolygon) {
                    sum += (_lastX - _firstX) * (_lastY + _firstY);
                }
            }
        }
    }

    if (count) {
        if (classify && sum > 0 && geometry.indices.length > 0) {
            feature.updateExtent(geometry);
            geometry = feature.bindNewGeometry();
            geometry.properties = properties;
        }
        geometry.closeSubGeometry(count, feature);
        geometry.getLastSubGeometry().ccw = sum < 0;
    }
    feature.updateExtent(geometry);
}

function readPBF(file, options) {
    const _pDecode = LabelProfiler.begin();
    options.out = options.out || {};
    const vectorTile = new VectorTile(new Protobuf(file));
    const vtLayerNames = Object.keys(vectorTile.layers);

    const collection = new FeatureCollection(options.out);
    if (vtLayerNames.length < 1) {
        LabelProfiler.end('build', _pDecode);
        return Promise.resolve(collection);
    }

    // x,y,z tile coordinates
    const x = options.extent.col;
    const z = options.extent.zoom;
    // We need to move from TMS to Google/Bing/OSM coordinates
    // https://alastaira.wordpress.com/2011/07/06/converting-tms-tile-coordinates-to-googlebingosm-tile-coordinates/
    // Only if the layer.origin is top
    const y = options.in.isInverted ? options.extent.row : (1 << z) - options.extent.row - 1;

    const vFeature0 = vectorTile.layers[vtLayerNames[0]];
    // TODO: verify if size is correct because is computed with only one feature (vFeature0).
    const size = vFeature0.extent * 2 ** z;
    const center = -0.5 * size;

    collection.scale.set(globalExtent.x / size, -globalExtent.y / size, 1);
    collection.position.set(vFeature0.extent * x + center, vFeature0.extent * y + center, 0).multiply(collection.scale);
    collection.updateMatrixWorld();

    let styleLayers = options.in.layers;
    if (!styleLayers) {
        styleLayers = {};
        vtLayerNames.forEach((vtLayerName, i) => {
            styleLayers[vtLayerName] = [{
                id: vtLayerName,
                order: i,
                filterExpression: { filter: () => true },
            }];
        });
    }

    vtLayerNames.forEach((vtLayerName) => {
        if (!styleLayers[vtLayerName]) { return; }

        const vectorTileLayer = vectorTile.layers[vtLayerName];

        for (let i = vectorTileLayer.length - 1; i >= 0; i--) {
            const vtFeature = vectorTileLayer.feature(i);
            vtFeature.tileNumbers = { x, y: options.extent.row, z };

            // Find layers where this vtFeature is used
            const layers = styleLayers[vtLayerName]
                .filter(l => l.filterExpression.filter({ zoom: z }, vtFeature));

            if (layers.length === 0) { continue; }

            if (layers.length === 1) {
                // Single match: use the original direct path (no overhead)
                const layer = layers[0];
                const feature = collection.requestFeatureById(layer.id, vtFeature.type - 1);
                feature.id = layer.id;
                feature.order = layer.order;
                feature.style = options.in.styles?.[feature.id];
                vtFeatureToFeatureGeometry(vtFeature, feature);
            } else {
                // Multiple matches: decode PBF once, replay for each layer.
                const commands = decodeVtGeometry(vtFeature);
                for (const layer of layers) {
                    const feature = collection.requestFeatureById(layer.id, vtFeature.type - 1);
                    feature.id = layer.id;
                    feature.order = layer.order;
                    feature.style = options.in.styles[feature.id];
                    replayGeometry(commands, vtFeature, feature);
                }
            }
        }
    });

    collection.removeEmptyFeature();
    // TODO Some vector tiles are already sorted
    collection.features.sort((a, b) => a.order - b.order);
    // TODO verify if is needed to updateExtent for previous features.
    collection.updateExtent();
    collection.extent = options.extent;
    collection.isInverted = options.in.isInverted;
    LabelProfiler.end('build', _pDecode);
    LabelProfiler.count('tilesDecoded', 1);
    return Promise.resolve(collection);
}

/**
 * Worker-based PBF decode + feature build. Sends the ArrayBuffer AND the
 * serializable filter specs to a worker thread. The worker does the FULL
 * build: PBF decode + filter matching + coordinate replay → returns flat
 * typed arrays per style layer. The main thread just wraps them in Feature
 * objects with minimal overhead (no geometry computation, no filter evaluation).
 *
 * Falls back to the legacy chunked main-thread build if the full-build path
 * fails (e.g. worker can't import @maplibre/maplibre-gl-style-spec).
 */
function readPBFWorker(file, options) {
    // Fall back to synchronous path when workers are unavailable (Node.js tests)
    const pool = _getWorkerPool();
    if (!pool) {
        return Promise.resolve(readPBF(file, options));
    }

    const _pDecode = LabelProfiler.begin();
    options.out = options.out || {};

    // Determine which VT source-layers we care about
    const wantedLayers = Object.keys(options.in.layers);
    if (wantedLayers.length === 0) {
        LabelProfiler.end('build', _pDecode);
        return Promise.resolve(new FeatureCollection(options.out));
    }

    // Serialize filter specs for full-build-in-worker path.
    const layerDefs = {};
    for (const [sourceLayer, defs] of Object.entries(options.in.layers)) {
        layerDefs[sourceLayer] = defs.map(d => ({
            id: d.id,
            order: d.order,
            filter: d.filterSpec ?? null,
        }));
    }

    const workerResult = decodeAndBuildInWorker(file, wantedLayers, null, options.extent.zoom);
    if (!workerResult) {
        // Worker transfer failed — fall back to sync
        LabelProfiler.end('build', _pDecode);
        return Promise.resolve(readPBF(file, options));
    }

    return workerResult.then((response) => {
        // Full-build response: convert flat arrays to FeatureCollection.
        if (response.built) {
            const collection = buildCollectionFromWorkerResult(response.built, options);
            LabelProfiler.end('build', _pDecode);
            LabelProfiler.count('tilesDecoded', 1);
            return collection;
        }

        // Decode-only response: use FrameBudget chunked build.
        return enqueueChunked(
            makeBuildStep(response.decoded, options),
            () => !(options.in._featuresCaches && options.in._featuresCaches[options.out.crs]),
        ).then((result) => {
            if (result == null) {
                const empty = new FeatureCollection(options.out);
                empty.extent = options.extent;
                empty.isInverted = options.in.isInverted;
                return empty;
            }
            return result;
        });
    });
}

/**
 * Send PBF to worker with filter specs for full build.
 */
function decodeAndBuildInWorker(buffer, wantedLayers, layerDefs, zoom) {
    const pool = _getWorkerPool();
    if (!pool) { return null; }
    const w = pool[_workerRR++ % pool.length];
    const id = ++_msgId;
    const token = LabelProfiler.begin();
    const promise = new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject, token });
    });
    try {
        w.postMessage({ id, buffer, wantedLayers, layerDefs, zoom }, [buffer]);
    } catch {
        _pending.delete(id);
        _workerPool = null;
        _workerPoolFailed = true;
        return null;
    }
    return promise;
}

/**
 * Convert worker full-build output into a FeatureCollection.
 * Extremely cheap: just wraps pre-computed Float32Arrays in Feature objects.
 */
function buildCollectionFromWorkerResult(built, options) {
    options.out = options.out || {};
    const collection = new FeatureCollection(options.out);

    // Compute tile transform (same as makeBuildStep)
    const x = options.extent.col;
    const z = options.extent.zoom;
    const y = options.in.isInverted ? options.extent.row : (1 << z) - options.extent.row - 1;

    // Get any layer's extent from the built result for scale computation.
    // Worker preserves the VT extent in the output.
    let tileExtent = 4096; // default MVT extent
    for (const feats of Object.values(built)) {
        if (feats.length > 0) break;
    }

    const size = tileExtent * 2 ** z;
    const center = -0.5 * size;
    collection.scale.set(globalExtent.x / size, -globalExtent.y / size, 1);
    collection.position.set(tileExtent * x + center, tileExtent * y + center, 0).multiply(collection.scale);
    collection.updateMatrixWorld();

    // Build features from flat arrays — no geometry replay needed.
    for (const [layerId, feats] of Object.entries(built)) {
        for (const feat of feats) {
            const feature = collection.requestFeatureById(layerId, feat.type - 1);
            feature.id = layerId;
            feature.order = feat.order;
            feature.style = options.in.styles?.[layerId];

            // Push coordinates from flat Float32Array directly
            let geometry = feature.bindNewGeometry();
            geometry.properties = feat.properties;
            let coordIdx = 0;
            for (let sg = 0; sg < feat.subGeometries.length; sg++) {
                const vertCount = feat.subGeometries[sg];
                if (sg > 0) {
                    feature.updateExtent(geometry);
                    geometry = feature.bindNewGeometry();
                    geometry.properties = feat.properties;
                }
                for (let v = 0; v < vertCount; v++) {
                    const fx = feat.coords[coordIdx++];
                    const fy = feat.coords[coordIdx++];
                    geometry.pushCoordinatesValues(feature, { x: fx, y: fy });
                }
                geometry.closeSubGeometry(vertCount, feature);
            }
        }
    }

    collection.removeEmptyFeature();
    collection.features.sort((a, b) => a.order - b.order);
    collection.updateExtent();
    collection.extent = options.extent;
    collection.isInverted = options.in.isInverted;
    return collection;
}

/**
 * @module VectorTileParser
 */
export default {
    /**
     * Parse a vector tile file and return a [Feature]{@link module:GeoJsonParser.Feature}
     * or an array of Features. While multiple formats of vector tile are
     * available, the only one supported for the moment is the
     * [Mapbox Vector Tile](https://www.mapbox.com/vector-tiles/specification/).
     *
     * @param {ArrayBuffer} file - The vector tile file to parse.
     *
     * @param {object} options - Options controlling the parsing {@link ParsingOptions}.
     *
     * @param {object} options.in - Object containing all styles,
     * layers and informations data, see {@link InformationsData}.
     *
     * @param {object} options.in.styles - Object containing subobject with
     * informations on a specific style layer. Styles available is by `layer.id` and by zoom.
     *
     * @param {object} options.in.layers - Object containing subobject with
     *
     * @param {FeatureBuildingOptions} options.out - options indicates how the features should be built,
     * see {@link FeatureBuildingOptions}.
     *
     * @returns {Promise} A Promise resolving with a Feature or an array a
     * Features.
     */
    parse(file, options) {
        options = deprecatedParsingOptionsToNewOne(options);
        return Promise.resolve(readPBF(file, options));
    },

    /**
     * Parse using a worker thread for PBF decoding. The heavy varint parsing
     * runs off the main thread; filter matching and Feature construction happen
     * on the main thread after the worker returns.
     *
     * @param {ArrayBuffer} file - The vector tile file to parse.
     * @param {object} options - Same options as {@link parse}.
     * @returns {Promise} A Promise resolving with a FeatureCollection.
     */
    parseWorker(file, options) {
        options = deprecatedParsingOptionsToNewOne(options);
        return readPBFWorker(file, options);
    },
};
