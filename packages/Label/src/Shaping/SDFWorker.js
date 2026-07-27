/**
 * Web Worker for SDF glyph rasterization via TinySDF + OffscreenCanvas.
 *
 * Offloads the expensive per-glyph Canvas2D rasterization from the main thread.
 * The worker maintains its own TinySDF instances (which use OffscreenCanvas
 * internally) and returns raw pixel data + metrics for each glyph batch.
 *
 * Protocol:
 *   Main → Worker: { id, batch: Array<{ char, fontKey }>, config: { fontSize, scale, buffer, radius, cutoff } }
 *   Worker → Main: { id, results: Array<{ char, fontKey, data: Uint8Array, width, height, glyphAdvance, glyphTop }> }
 *                   (data buffers are transferred, not copied)
 */
import TinySDF from '@mapbox/tiny-sdf';

const fontToSDF = new Map();

function getOrCreateSDF(fontKey, config) {
    const key = `${fontKey.font}\x00${fontKey.weight}\x00${fontKey.style}`;
    if (!fontToSDF.has(key)) {
        fontToSDF.set(key, new TinySDF({
            fontSize: config.fontSize * config.scale,
            fontFamily: fontKey.font,
            fontWeight: fontKey.weight,
            fontStyle: fontKey.style,
            buffer: config.buffer,
            radius: config.radius,
            cutoff: config.cutoff,
        }));
    }
    return fontToSDF.get(key);
}

self.onmessage = function onmessage(e) {
    const { id, batch, config } = e.data;
    const results = [];
    const transferables = [];

    for (const { char, fontKey } of batch) {
        const sdf = getOrCreateSDF(fontKey, config);
        const g = sdf.draw(char);

        // Copy the Uint8ClampedArray to a Uint8Array for clean transfer
        let data;
        if (g.width > 0 && g.height > 0) {
            data = new Uint8Array(g.data.buffer.slice(0));
            transferables.push(data.buffer);
        } else {
            data = new Uint8Array(0);
        }

        results.push({
            char,
            fontKey,
            data,
            width: g.width,
            height: g.height,
            glyphAdvance: g.glyphAdvance,
            glyphTop: g.glyphTop,
        });
    }

    self.postMessage({ id, results }, transferables);
};
