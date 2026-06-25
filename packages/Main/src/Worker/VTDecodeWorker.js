/**
 * Web Worker for vector tile PBF decoding.
 *
 * Offloads the expensive PBF varint parsing from the main thread.
 * The worker receives an ArrayBuffer (the raw .pbf/.mvt tile) plus
 * tile metadata, and returns decoded features per VT source-layer
 * with their geometry commands and properties.
 *
 * Filter matching and Feature object construction remain on the main
 * thread (cheap operations that need access to compiled style filters
 * and the Feature/FeatureCollection class hierarchy).
 */
import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

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
    const { id, buffer, wantedLayers } = e.data;
    try {
        const decoded = decodeTile(buffer, wantedLayers);
        // Collect all cmds Int32Arrays for zero-copy transfer
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
