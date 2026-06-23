import TinySDF from "@mapbox/tiny-sdf";
import { DataTexture, LinearFilter, RedFormat, UnsignedByteType } from "three";
import { FontKey } from "./FontKey";
import { GlyphInfo } from "./GlyphRun";
import { LabelProfiler } from "../Profiler";

export interface SDFAtlasOptions {
    /** Font size (px) at which glyphs are rasterized. */
    fontSize: number;
    /** SDF oversampling multiplier. */
    scale: number;
    /** Slot pre-allocation growth factor. */
    capacityMultiplier: number;
}

export class SDFAtlas {
    texture: DataTexture;
    readonly glyphs: Map<string, GlyphInfo> = new Map<string, GlyphInfo>();
    readonly cutoff: number;
    readonly radius: number;

    private _data: Uint8Array;
    private _width: number;
    private _sdf: TinySDF;
    private _cellSize: number;
    private _cols: number;
    private _capacity: number;
    private _slotCount = 0;

    private readonly _scale: number;
    private readonly _capacityMultiplier: number;

    constructor(chars: string[], fontKey: FontKey, options: SDFAtlasOptions) {
        const { fontSize, scale, capacityMultiplier } = options;
        this._scale = scale;
        this._capacityMultiplier = capacityMultiplier;

        const buffer = Math.ceil(fontSize * scale * 0.5);
        this.radius = buffer;
        this.cutoff = 0.495;

        this._sdf = new TinySDF({
            fontSize: fontSize * scale,
            fontFamily: fontKey.font,
            fontWeight: fontKey.weight,
            fontStyle: fontKey.style,
            buffer,
            radius: this.radius,
            cutoff: this.cutoff,
        });

        this._cellSize = fontSize * scale + buffer * 2;
        this._capacity = Math.max(8, Math.ceil(chars.length * capacityMultiplier));
        this._cols = Math.ceil(Math.sqrt(this._capacity));
        const rows = Math.ceil(this._capacity / this._cols);

        this._width = nextPow2(Math.max(
            this._cols * this._cellSize,
            rows * this._cellSize,
        ));
        this._data = new Uint8Array(this._width * this._width);

        this.texture = new DataTexture(
            this._data, this._width, this._width,
            RedFormat, UnsignedByteType,
        );
        this.texture.flipY = false;
        this.texture.generateMipmaps = false;
        this.texture.minFilter = LinearFilter;
        this.texture.magFilter = LinearFilter;

        this._drawChars(chars);
        this.texture.needsUpdate = true;
    }

    addChars(chars: Iterable<string>): { dirty: boolean; resize: boolean } {
        const newChars: string[] = [];
        for (const c of chars) {
            if (!this.glyphs.has(c)) newChars.push(c);
        }
        if (newChars.length === 0) return { dirty: false, resize: false };

        let resize = false;
        if (this._slotCount + newChars.length > this._capacity) {
            this._resize(this._slotCount + newChars.length);
            resize = true;
        }

        this._drawChars(newChars);
        this.texture.needsUpdate = true;
        // A full-atlas GPU re-upload is now pending (DataTexture.needsUpdate),
        // and we just rasterized newChars glyphs on the CPU. Both scale with the
        // (large, growing) character set; record them so the cost is visible.
        LabelProfiler.count('glyphsRasterized', newChars.length);
        LabelProfiler.count('atlasUpload', 1);
        LabelProfiler.max('atlasTexelsMax', this._width * this._width);
        return { dirty: true, resize };
    }

    dispose() {
        this.texture.dispose();
    }

    private _drawChars(chars: string[]) {
        for (const c of chars) {
            if (this.glyphs.has(c)) continue;

            const slot = this._slotCount++;
            const x = (slot % this._cols) * this._cellSize;
            const y = Math.floor(slot / this._cols) * this._cellSize;
            const g = this._sdf.draw(c);

            if (g.width > 0 && g.height > 0) {
                this._blit(g.data, x, y, g.width, g.height);
            }

            this.glyphs.set(c, {
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

        this.texture.dispose();
        this.texture = new DataTexture(newData, newSize, newSize, RedFormat, UnsignedByteType);
        this.texture.flipY = false;
        this.texture.generateMipmaps = false;
        this.texture.minFilter = LinearFilter;
        this.texture.magFilter = LinearFilter;
        this.texture.needsUpdate = true;
    }
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
