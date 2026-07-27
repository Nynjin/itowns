import TinySDF from '@mapbox/tiny-sdf';
import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from 'three';
import { FontKey, fontKeyStr, glyphKey } from './FontKey';
import { GlyphInfo } from './GlyphRun';
import { LabelProfiler } from '../Profiler';

export interface SDFAtlasOptions {
    /** Font size (px) at which glyphs are rasterized. */
    fontSize: number;
    /** SDF oversampling multiplier. */
    scale: number;
    /** Slot pre-allocation growth factor. */
    capacityMultiplier: number;
}

export interface FontChars {
    fontKey: FontKey;
    chars: Iterable<string>;
}

// ── OffscreenCanvas worker singleton ─────────────────────────────────────────
let _sdfWorker: Worker | null = null;
let _sdfMsgId = 0;
const _sdfPending = new Map<number, { resolve: (results: any[]) => void; reject: (e: Error) => void }>();

function _getSDFWorker(): Worker | null {
    if (_sdfWorker) return _sdfWorker;
    // OffscreenCanvas is required for TinySDF in a worker (Canvas2D context).
    if (typeof OffscreenCanvas === 'undefined') return null;
    try {
        _sdfWorker = new Worker(
            /* webpackChunkName: "itowns_sdfworker" */
            new URL('./SDFWorker.js', import.meta.url),
            { type: 'module' },
        );
        _sdfWorker.onmessage = (e: MessageEvent) => {
            const { id, results } = e.data;
            const p = _sdfPending.get(id);
            if (p) {
                _sdfPending.delete(id);
                p.resolve(results);
            }
        };
        _sdfWorker.onerror = () => {
            // Worker failed — fall back to main-thread rasterization
            _sdfWorker = null;
        };
        return _sdfWorker;
    } catch {
        return null;
    }
}

export class SDFAtlas {
    private _texture: DataTexture = new DataTexture(new Uint8Array(1), 1, 1, RedFormat, UnsignedByteType);
    readonly glyphs: Map<string, GlyphInfo> = new Map<string, GlyphInfo>();

    get texture(): DataTexture { return this._texture; }
    readonly fontSize: number;
    readonly buffer: number;
    readonly cutoff: number;
    readonly radius: number;

    private _data: Uint8Array = new Uint8Array(1);
    private _cellSize: number;
    private _width = 0;
    private _cols = 0;
    private _capacity = 0;
    private _slotCount = 0;

    private readonly _scale: number;
    private readonly _capacityMultiplier: number;

    private readonly _fontToSDF = new Map<string, TinySDF>();

    /**
     * Set to true when the async SDF worker responds with real glyph metrics.
     * Consumers must check this, invalidate layout caches, and re-layout labels
     * that were laid out with placeholder (advance=0) metrics.
     * Reset to false after consumption.
     */
    metricsUpdated = false;

    constructor(options: SDFAtlasOptions) {
        const { fontSize, scale, capacityMultiplier } = options;
        this.fontSize = fontSize;
        this._scale = scale;
        this._capacityMultiplier = capacityMultiplier;

        // TODO: improve configuration for better glyph quality if possible
        this.buffer = Math.ceil(fontSize * scale * 0.5);
        this.radius = this.buffer;
        this.cutoff = 0.495; // Slightly less than 0.5 as some glyphs have a very thin edge
        this._cellSize = fontSize * scale + this.buffer * 2;

        // Pre-allocate at 1024×1024 to avoid early resize cascades when the
        // first tile batch lands. The capacity is derived from the cell grid
        // that fits in 1024 px.
        this._preAllocate(1024);
    }

    /** Pre-allocate the atlas to a given texture size without rasterizing anything. */
    private _preAllocate(size: number) {
        this._width = size;
        this._cols = Math.floor(size / this._cellSize);
        const rows = Math.floor(size / this._cellSize);
        this._capacity = this._cols * rows;
        this._data = new Uint8Array(size * size);
        this._texture.dispose();
        this._texture = new DataTexture(this._data, size, size, RedFormat, UnsignedByteType);
        this._texture.flipY = false;
        this._texture.generateMipmaps = false;
        this._texture.minFilter = LinearFilter;
        this._texture.magFilter = LinearFilter;
    }

    setChars(fontChars: FontChars[]): { dirty: boolean; resize: boolean } {
        const newGlyphs: { char: string; fontKey: FontKey }[] = [];

        for (const { fontKey, chars } of fontChars) {
            const fk = fontKeyStr(fontKey);
            if (!this._fontToSDF.has(fk)) {
                // Render at fontSize * scale so the SDF image is _scale× larger than
                // baseFontSize. Dividing g.width / _scale in _drawChars then gives
                // consistent logical dimensions regardless of the scale setting.
                this._fontToSDF.set(fk, new TinySDF({
                    fontSize: this.fontSize * this._scale,
                    fontFamily: fontKey.font,
                    fontWeight: fontKey.weight,
                    fontStyle: fontKey.style,
                    buffer: this.buffer,
                    radius: this.radius,
                    cutoff: this.cutoff,
                }));
            }


            for (const c of chars) {
                if (!this.glyphs.has(glyphKey(fontKey, c))) {
                    newGlyphs.push({ char: c, fontKey });
                }
            }
        }

        if (newGlyphs.length === 0) return { dirty: false, resize: false };

        let resize = false;
        if (this._slotCount + newGlyphs.length > this._capacity) {
            this._resize(this._slotCount + newGlyphs.length);
            resize = true;
        }

        // Try to dispatch to OffscreenCanvas worker for off-thread rasterization.
        // If the worker is available, glyphs are rasterized asynchronously and
        // blitted when the response arrives (setCharsAsync path). Fall back to
        // synchronous main-thread rasterization if OffscreenCanvas is unavailable.
        const worker = _getSDFWorker();
        if (worker && newGlyphs.length > 0) {
            this._dispatchToWorker(worker, newGlyphs);
        } else {
            this._drawChars(newGlyphs);
        }

        this._texture.needsUpdate = true;
        LabelProfiler.count('glyphsRasterized', newGlyphs.length);
        LabelProfiler.count('atlasUpload', 1);
        LabelProfiler.max('atlasTexelsMax', this._width * this._width);
        return { dirty: true, resize };
    }

    /** Dispatch glyph batch to the OffscreenCanvas worker for async rasterization. */
    private _dispatchToWorker(worker: Worker, entries: { char: string; fontKey: FontKey }[]) {
        const id = ++_sdfMsgId;
        const batch = entries.map(e => ({ char: e.char, fontKey: e.fontKey }));
        const config = {
            fontSize: this.fontSize,
            scale: this._scale,
            buffer: this.buffer,
            radius: this.radius,
            cutoff: this.cutoff,
        };

        // Reserve slots NOW (synchronous) so layout can proceed with positions.
        // The actual pixel data arrives later and is blitted in.
        for (const { char: c, fontKey } of entries) {
            const key = glyphKey(fontKey, c);
            if (this.glyphs.has(key)) continue;
            const slot = this._slotCount++;
            const x = (slot % this._cols) * this._cellSize;
            const y = Math.floor(slot / this._cols) * this._cellSize;
            // Store placeholder metrics (advance=0) — updated when worker responds.
            this.glyphs.set(key, { px: x, py: y, pw: 0, ph: 0, w: 0, h: 0, advance: 0, top: 0 });
        }

        _sdfPending.set(id, {
            resolve: (results: any[]) => {
                for (const r of results) {
                    const key = glyphKey(r.fontKey, r.char);
                    const g = this.glyphs.get(key);
                    if (!g) continue;
                    // Update metrics from worker result
                    g.pw = r.width;
                    g.ph = r.height;
                    g.w = r.width / this._scale || 1;
                    g.h = r.height / this._scale || 1;
                    g.advance = r.glyphAdvance / this._scale || 1;
                    g.top = r.glyphTop / this._scale || 0;
                    // Blit pixel data into atlas
                    if (r.width > 0 && r.height > 0) {
                        this._blit(r.data, g.px, g.py, r.width, r.height);
                    }
                }
                this._texture.needsUpdate = true;
                this.metricsUpdated = true;
            },
            reject: () => { /* Worker error — glyphs stay blank until next setChars */ },
        });

        worker.postMessage({ id, batch, config });
    }

    /**
     * Returns a plain `compoundKey → GlyphInfo` record for a single font variant,
     * suitable for posting to the layout worker.
     * Keys are kept in full compound format (`font\x00weight\x00style\x00char`)
     * because layoutText uses glyphKey() to look them up.
     */
    getGlyphsForFont(fontKey: FontKey): Record<string, GlyphInfo> {
        const prefix = `${fontKey.font}\x00${fontKey.weight}\x00${fontKey.style}\x00`;
        const result: Record<string, GlyphInfo> = {};
        for (const [key, glyph] of this.glyphs) {
            if (key.startsWith(prefix)) result[key] = glyph;
        }
        return result;
    }

    dispose() {
        this._texture.dispose();
    }

    private _drawChars(entries: { char: string; fontKey: FontKey }[]) {
        for (const { char: c, fontKey } of entries) {
            const key = glyphKey(fontKey, c);
            if (this.glyphs.has(key)) continue;

            const sdf = this._fontToSDF.get(fontKeyStr(fontKey));

            if (!sdf) {
                console.warn(`No TinySDF instance for fontKey: ${fontKeyStr(fontKey)}`);
                continue;
            }

            const slot = this._slotCount++;
            const x = (slot % this._cols) * this._cellSize;
            const y = Math.floor(slot / this._cols) * this._cellSize;
            const g = sdf.draw(c);

            if (g.width > 0 && g.height > 0) {
                this._blit(g.data, x, y, g.width, g.height);
            }

            this.glyphs.set(key, {
                px: x,
                py: y,
                pw: g.width,
                ph: g.height,
                w: g.width / this._scale || 1,
                h: g.height / this._scale || 1,
                advance: g.glyphAdvance / this._scale || 1,
                top: g.glyphTop / this._scale || 0,
            });
        }
    }

    private _blit(src: Uint8ClampedArray, dx: number, dy: number, w: number, h: number) {
        for (let row = 0; row < h; row++) {
            this._data.set(
                src.subarray(row * w, (row + 1) * w),
                (dy + row) * this._width + dx,
            );
        }
    }

    private _resize(minChars: number) {
        this._capacity = Math.ceil(minChars * this._capacityMultiplier);
        this._cols = Math.ceil(Math.sqrt(this._capacity));
        const rows = Math.ceil(this._capacity / this._cols);

        const newSize = nextPow2(Math.max(
            this._cols * this._cellSize,
            rows * this._cellSize,
        ));

        const oldData = this._data;
        const oldWidth = this._width;
        const newData = new Uint8Array(newSize * newSize);

        let slot = 0;
        for (const [, g] of this.glyphs) {
            const newX = (slot % this._cols) * this._cellSize;
            const newY = Math.floor(slot / this._cols) * this._cellSize;

            for (let row = 0; row < g.ph; row++) {
                const srcOff = (g.py + row) * oldWidth + g.px;
                newData.set(oldData.subarray(srcOff, srcOff + g.pw), (newY + row) * newSize + newX);
            }

            g.px = newX;
            g.py = newY;
            slot++;
        }

        this._data = newData;
        this._width = newSize;

        this._texture.dispose();
        this._texture = new DataTexture(newData, newSize, newSize, RedFormat, UnsignedByteType);
        this._texture.flipY = false;
        this._texture.generateMipmaps = false;
        this._texture.minFilter = LinearFilter;
        this._texture.magFilter = LinearFilter;
        this._texture.needsUpdate = true;
    }
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
