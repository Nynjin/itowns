/**
 * Web Worker for vector tile PBF decoding + feature building.
 *
 * Offloads BOTH the PBF varint parsing AND the feature geometry construction
 * from the main thread. When `layerDefs` (filter specs) are provided, the
 * worker does the full build: filter matching + coordinate replay → returns
 * flat typed arrays per style layer ready for the main thread to assign to
 * Feature objects with zero geometry computation.
 *
 * Without `layerDefs`, falls back to the decode-only path (returns raw
 * commands + properties for main-thread FrameBudget building).
 */
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';

const CMD_MOVE = 1;
const CMD_LINE = 2;
const CMD_CLOSE = 7;

/**
 * Decode a VT feature's PBF geometry into a flat command array.
 * Format: [cmd, x, y, cmd, x, y, ..., CMD_CLOSE, ...]
 * Move/line entries have 3 elements (cmd, x, y).
 * Close entries have 1 element (CMD_CLOSE).
 */
function decodeGeometry(vtFeature) {
    const tmp = [];
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

        if (cmd === CMD_MOVE || cmd === CMD_LINE) {
            x += pbf.readSVarint();
            y += pbf.readSVarint();
            tmp.push(cmd, x, y);
        } else if (cmd === CMD_CLOSE) {
            tmp.push(CMD_CLOSE);
        }
    }
    return new Int32Array(tmp);
}

/**
 * Decode an entire vector tile.
 * @param {ArrayBuffer} buffer - Raw PBF tile data.
 * @param {string[]} wantedLayers - Source-layer names to decode (skip others).
 * @returns Decoded VT layers with features.
 */
function decodeTile(buffer, wantedLayers) {
    const vectorTile = new VectorTile(new Protobuf(buffer));
    const vtLayerNames = Object.keys(vectorTile.layers);
    const wantedSet = wantedLayers ? new Set(wantedLayers) : null;

    const result = {};

    for (const name of vtLayerNames) {
        if (wantedSet && !wantedSet.has(name)) { continue; }

        const vtLayer = vectorTile.layers[name];
        const features = [];

        for (let i = vtLayer.length - 1; i >= 0; i--) {
            const vtFeature = vtLayer.feature(i);
            features.push({
                type: vtFeature.type,             // 1=point, 2=line, 3=polygon
                properties: vtFeature.properties,  // plain object
                cmds: decodeGeometry(vtFeature),   // flat command array
            });
        }

        result[name] = { extent: vtLayer.extent, features };
    }

    return result;
}

// ── Worker message handler ───────────────────────────────────────────────────
self.onmessage = function onmessage(e) {
    const { id, buffer, wantedLayers, layerDefs, zoom } = e.data;
    try {
        const decoded = decodeTile(buffer, wantedLayers);

        // Full build path: filter + coordinate extraction in the worker.
        // Only available when featureFilter loaded successfully.
        if (layerDefs && featureFilter) {
            const built = buildInWorker(decoded, layerDefs, zoom);
            const transferables = [];
            for (const layer of Object.values(built)) {
                for (const feat of layer) {
                    if (feat.coords.buffer.byteLength > 0) {
                        transferables.push(feat.coords.buffer);
                    }
                }
            }
            self.postMessage({ id, built }, transferables);
            return;
        }

        // Decode-only path (legacy fallback)
        const transferables = [];
        for (const layerName of Object.keys(decoded)) {
            for (const f of decoded[layerName].features) {
                transferables.push(f.cmds.buffer);
            }
        }
        self.postMessage({ id, decoded }, transferables);
    } catch (err) {
        self.postMessage({ id, error: err.message });
    }
};

// ── Full build in worker ─────────────────────────────────────────────────────
// Compiles filter expressions from raw JSON specs, evaluates them per feature,
// and produces flat coordinate arrays (Float32) for each matched style layer.
// The main thread only needs to wrap these in Feature objects — no geometry
// replay, no coordinate computation.

const _compiledFilters = new Map();

function getCompiledFilter(filterSpec) {
    const key = JSON.stringify(filterSpec);
    if (!_compiledFilters.has(key)) {
        _compiledFilters.set(key, featureFilter(filterSpec));
    }
    return _compiledFilters.get(key);
}

/**
 * Build features from decoded layers using provided filter definitions.
 * @param decoded - Decoded VT layers from decodeTile()
 * @param layerDefs - { [sourceLayer]: [{ id, order, filter }] }
 * @param zoom - Current tile zoom level
 * @returns { [layerId]: Array<{ type, properties, coords: Float32Array, subGeometries: Int32Array }> }
 */
function buildInWorker(decoded, layerDefs, zoom) {
    const result = {};

    for (const [sourceLayer, defs] of Object.entries(layerDefs)) {
        const vtLayer = decoded[sourceLayer];
        if (!vtLayer) continue;

        for (const def of defs) {
            if (!result[def.id]) result[def.id] = [];
            const compiledFilter = def.filter
                ? getCompiledFilter(def.filter)
                : { filter: () => true };

            for (const df of vtLayer.features) {
                if (!compiledFilter.filter({ zoom }, df)) continue;

                // Replay commands into flat coordinate array
                const { coords, subGeometries } = replayCmdsToArrays(df.cmds);
                result[def.id].push({
                    type: df.type,
                    properties: df.properties,
                    coords,
                    subGeometries, // Int32Array of vertex counts per sub-geometry
                    order: def.order,
                });
            }
        }
    }

    return result;
}

/**
 * Replay flat command array into coordinate Float32Array + sub-geometry counts.
 * Returns { coords: Float32Array([x0,y0, x1,y1, ...]), subGeometries: Int32Array([count0, count1, ...]) }
 */
function replayCmdsToArrays(cmds) {
    const coordsBuf = [];
    const subGeos = [];
    let count = 0;
    let firstX = 0, firstY = 0;

    for (let i = 0; i < cmds.length;) {
        const cmd = cmds[i];
        if (cmd === CMD_MOVE || cmd === CMD_LINE) {
            const x = cmds[i + 1];
            const y = cmds[i + 2];
            i += 3;

            if (cmd === CMD_MOVE && count > 0) {
                subGeos.push(count);
                count = 0;
            }
            if (cmd === CMD_MOVE) {
                firstX = x; firstY = y;
            }
            coordsBuf.push(x, y);
            count++;
        } else {
            // CMD_CLOSE
            i += 1;
            coordsBuf.push(firstX, firstY);
            count++;
        }
    }
    if (count > 0) subGeos.push(count);

    return {
        coords: new Float32Array(coordsBuf),
        subGeometries: new Int32Array(subGeos),
    };
}
