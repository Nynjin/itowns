import { Vector2, Vector3 } from 'three';
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { FeatureCollection, FEATURE_TYPES } from 'Core/Feature';
import { globalExtentTMS } from 'Core/Tile/TileGrid';
import { deprecatedParsingOptionsToNewOne } from 'Core/Deprecated/Undeprecator';
import { LabelProfiler } from '@itowns/labels';

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
                const { id, decoded, error } = e.data;
                const p = _pending.get(id);
                if (!p) { return; }
                _pending.delete(id);
                if (error) { p.reject(new Error(error)); }
                else { p.resolve(decoded); }
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
 * Send PBF ArrayBuffer to a worker for decoding.
 * @param {ArrayBuffer} buffer - Raw PBF tile data.
 * @param {string[]} wantedLayers - Source-layer names to decode.
 * @returns {Promise<object>|null} Decoded VT layers, or null if transfer failed.
 */
function decodeInWorker(buffer, wantedLayers) {
    const pool = _getWorkerPool();
    if (!pool) { return null; }
    const w = pool[_workerRR++ % pool.length];
    const id = ++_msgId;
    // Register pending BEFORE postMessage to avoid race where onmessage
    // fires before the promise resolver is stored.
    const promise = new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject });
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

/**
 * Build Features from worker-decoded geometry commands.
 * The decoded format per VT feature: { type, properties, cmds: Int32Array }
 */
function buildFeaturesFromDecoded(decodedLayers, options, collection) {
    const z = options.extent.zoom;

    for (const vtLayerName of Object.keys(decodedLayers)) {
        const layerDefs = options.in.layers[vtLayerName];
        if (!layerDefs) { continue; }

        const { features } = decodedLayers[vtLayerName];

        for (const df of features) {
            // Apply style-layer filter matching (fast, pre-compiled functions)
            const matched = layerDefs.filter(
                l => l.filterExpression.filter({ zoom: z }, df),
            );
            if (matched.length === 0) { continue; }

            // Replay flat cmds directly into each matching layer's Feature
            for (const layer of matched) {
                const feature = collection.requestFeatureById(layer.id, df.type - 1);
                feature.id = layer.id;
                feature.order = layer.order;
                feature.style = options.in.styles[feature.id];
                replayGeometryFromCommands(df.cmds, df.properties, feature);
            }
        }
    }
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
            geometry.pushCoordinatesValues(feature, { x, y });
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
        LabelProfiler.end('decode', _pDecode);
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
    LabelProfiler.end('decode', _pDecode);
    LabelProfiler.count('tilesDecoded', 1);
    return Promise.resolve(collection);
}

/**
 * Worker-based PBF decode: sends the ArrayBuffer to a worker thread for
 * varint parsing, then builds Features from the decoded data on the main thread.
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
        LabelProfiler.end('decode', _pDecode);
        return Promise.resolve(new FeatureCollection(options.out));
    }

    const workerResult = decodeInWorker(file, wantedLayers);
    if (!workerResult) {
        // Worker transfer failed — fall back to sync
        LabelProfiler.end('decode', _pDecode);
        return Promise.resolve(readPBF(file, options));
    }

    return workerResult.then((decodedLayers) => {
        // Now measure only the main-thread portion (feature building)
        const _pBuild = LabelProfiler.begin();
        const vtLayerNames = Object.keys(decodedLayers);
        const collection = new FeatureCollection(options.out);
        if (vtLayerNames.length === 0) {
            LabelProfiler.end('decode', _pBuild);
            return collection;
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

        // Build Features from decoded data (filter matching + construction)
        buildFeaturesFromDecoded(decodedLayers, options, collection);

        collection.removeEmptyFeature();
        collection.features.sort((a, b) => a.order - b.order);
        collection.updateExtent();
        collection.extent = options.extent;
        collection.isInverted = options.in.isInverted;
        LabelProfiler.end('decode', _pBuild);
        LabelProfiler.count('tilesDecoded', 1);
        return collection;
    });
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
