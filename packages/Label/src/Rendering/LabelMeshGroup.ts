import {
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Mesh,
    PlaneGeometry,
    ShaderMaterial,
} from 'three';
import { SDFAtlas } from '../Shaping/SDFAtlas';
import {
    createFillMaterial,
    updateFillAtlas,
    updateFillUniforms,
    updateFillPxPerUnit,
} from './Materials/FillMaterial';
import {
    createHaloMaterial,
    updateHaloAtlas,
    updateHaloUniforms,
    updateHaloPxPerUnit,
} from './Materials/HaloMaterial';
import { GlyphInstance } from '../Shaping/GlyphRun';
import { Label } from '../Label';
import { InstancedDataTexture } from './Textures/InstancedDataTexture';
import { LabelManagerConfig } from '../Types/LabelConfig';

/**
 * T0: label position (x, y, z) + fontSize
 * T1: label rotation (quat x, y, z, w)
 * T2: color + opacity (r, g, b, a)
 * T3: halo color + opacity (r, g, b, a)
 * T4: halo params (width, blur, -, -)
 * T5: rotation alignment + symbol placement (rotationAlignment, symbolPlacement, -, -)
 */
export const LABEL_TEXELS = 6;

/**
 * T0: label index (i, -, -, -)
 * T1: char offset (x, y) + size (w, h)  [font-pixel space]
 * T2: (px, py) in atlas + (pw, ph) size in atlas
 */
export const GLYPH_TEXELS = 3;

/** Float offset of the first style texel (T2) within a label's allocation. */
const STYLE_FLOAT_OFFSET = 2 * 4; // 2 texels × 4 floats/texel
/** Number of floats covering T2-T5 (colour, halo colour, halo params, alignment). */
const STYLE_FLOAT_COUNT = 4 * 4;  // 4 texels × 4 floats/texel

/** Write all 6 label texels (T0-T5). Used on add and layout/transform updates. */
function fillLabelTexels(label: Label, out: Float32Array) {
    // T0: position & fontSize
    out[0] = label.position.x;
    out[1] = label.position.y;
    out[2] = label.position.z;
    out[3] = label.fontSize;
    // T1: rotation
    out[4] = label.rotation.x;
    out[5] = label.rotation.y;
    out[6] = label.rotation.z;
    out[7] = label.rotation.w;
    // T2: color + opacity
    out[8] = label.color.r;
    out[9] = label.color.g;
    out[10] = label.color.b;
    out[11] = label.opacity;
    // T3: halo color + opacity
    out[12] = label.haloColor.r;
    out[13] = label.haloColor.g;
    out[14] = label.haloColor.b;
    out[15] = label.getDisplayedHaloOpacity();
    // T4: halo params
    out[16] = label.haloWidth;
    out[17] = label.haloBlur;
    out[18] = 0;
    out[19] = 0;
    // T5: rotation alignment + symbol placement
    out[20] = label.rotationAlignment;
    out[21] = label.symbolPlacement;
    out[22] = 0;
    out[23] = 0;
}

/** Write only T2-T5 (colour, halo, params, alignment). Used for style-only updates. */
function fillStyleTexels(label: Label, out: Float32Array) {
    out[8]  = label.color.r;
    out[9]  = label.color.g;
    out[10] = label.color.b;
    out[11] = label.opacity;
    out[12] = label.haloColor.r;
    out[13] = label.haloColor.g;
    out[14] = label.haloColor.b;
    out[15] = label.getDisplayedHaloOpacity();
    out[16] = label.haloWidth;
    out[17] = label.haloBlur;
    out[18] = 0;
    out[19] = 0;
    out[20] = label.rotationAlignment;
    out[21] = label.symbolPlacement;
    out[22] = 0;
    out[23] = 0;
}

function fillGlyphTexels(labelIdx: number, glyphs: GlyphInstance[], out: Float32Array) {
    for (let i = 0; i < glyphs.length; i++) {
        const glyph = glyphs[i];
        const idx = i * GLYPH_TEXELS * 4;
        out[idx]     = labelIdx;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 0;

        out[idx + 4] = glyph.offset.x;
        out[idx + 5] = glyph.offset.y;
        out[idx + 6] = glyph.glyph.w;
        out[idx + 7] = glyph.glyph.h;

        out[idx + 8]  = glyph.glyph.px;
        out[idx + 9]  = glyph.glyph.py;
        out[idx + 10] = glyph.glyph.pw;
        out[idx + 11] = glyph.glyph.ph;
    }
}

export type LabelMesh = Mesh<InstancedBufferGeometry, ShaderMaterial>;

export class LabelMeshGroup {
    readonly geom: InstancedBufferGeometry = new InstancedBufferGeometry();
    readonly fillMesh: LabelMesh = new Mesh(this.geom);
    readonly haloMesh: LabelMesh = new Mesh(this.geom);

    private _glyphIndex: Int32Array = new Int32Array(1000000);
    private _occlusionFade: Float32Array = new Float32Array(1000000);
    private _glyphIndexAttr: InstancedBufferAttribute = new InstancedBufferAttribute(this._glyphIndex, 1);
    private _occlusionFadeAttr: InstancedBufferAttribute = new InstancedBufferAttribute(this._occlusionFade, 1);

    private _labelTexelScratch = new Float32Array(LABEL_TEXELS * 4);
    private _glyphTexelScratch = new Float32Array(GLYPH_TEXELS * 4 * 64);

    private _labelDataBuffer: InstancedDataTexture;
    private _glyphDataBuffer: InstancedDataTexture;

    private _globeAlignment = false;
    private readonly _config: LabelManagerConfig;

    constructor(config: LabelManagerConfig) {
        this._config = config;
        this._labelDataBuffer = new InstancedDataTexture(
            LABEL_TEXELS,
            config.maxDataTextureWidth,
            config.dataTextureCapacityMultiplier,
        );
        this._glyphDataBuffer = new InstancedDataTexture(
            GLYPH_TEXELS,
            config.maxDataTextureWidth,
            config.dataTextureCapacityMultiplier,
        );

        const base = new PlaneGeometry(1, 1);
        this.geom.index = base.index;
        this.geom.attributes.position = base.attributes.position;
        this.geom.attributes.uv = base.attributes.uv;
        base.dispose();

        this.fillMesh.frustumCulled = false;
        this.haloMesh.frustumCulled = false;
        this.fillMesh.renderOrder = 1;
        this.haloMesh.renderOrder = 0;
        this.fillMesh.matrixAutoUpdate = false;
        this.haloMesh.matrixAutoUpdate = false;
        // Layer 31: instanced label meshes are placed on this layer only.
        // The camera default mask (layer 0) naturally excludes them from
        // the EffectComposer's RenderPass, preventing AGX tone-mapping from
        // washing them out. c3DEngine renders them directly after the composer.
        this.fillMesh.layers.set(31);
        this.haloMesh.layers.set(31);

        this.geom.setAttribute('glyphIndex', this._glyphIndexAttr);
        this.geom.setAttribute('occlusionFade', this._occlusionFadeAttr);
    }

    private _syncUniforms() {
        if (!this.fillMesh.material?.uniforms) return;

        updateFillUniforms(
            this.fillMesh.material,
            this._labelDataBuffer.texture,
            this._glyphDataBuffer.texture,
            this._globeAlignment,
        );
        updateHaloUniforms(
            this.haloMesh.material,
            this._labelDataBuffer.texture,
            this._glyphDataBuffer.texture,
            this._globeAlignment,
        );
        this.fillMesh.material.uniformsNeedUpdate = true;
        this.haloMesh.material.uniformsNeedUpdate = true;
    }

    syncAtlas(atlas: SDFAtlas) {
        if (!this.fillMesh.material?.uniforms) {
            this.fillMesh.material = createFillMaterial(
                atlas,
                this._labelDataBuffer.texture,
                this._glyphDataBuffer.texture,
                this._config.baseFontSize,
                this._config.pxPerUnit,
            );
            this.haloMesh.material = createHaloMaterial(
                atlas,
                this._labelDataBuffer.texture,
                this._glyphDataBuffer.texture,
                this._config.baseFontSize,
                this._config.pxPerUnit,
            );
            this.fillMesh.material.uniforms.uGlobeAlignment.value = this._globeAlignment ? 1 : 0;
            this.haloMesh.material.uniforms.uGlobeAlignment.value = this._globeAlignment ? 1 : 0;
            this.fillMesh.material.uniformsNeedUpdate = true;
            this.haloMesh.material.uniformsNeedUpdate = true;
        }
        else {
            updateFillAtlas(this.fillMesh.material, atlas);
            updateHaloAtlas(this.haloMesh.material, atlas);
            this._syncUniforms();
        }
    }

    /** Update pxPerUnit uniform without re-layout. */
    updatePxPerUnit(pxPerUnit: number) {
        if (!this.fillMesh.material?.uniforms) return;
        updateFillPxPerUnit(this.fillMesh.material, pxPerUnit);
        updateHaloPxPerUnit(this.haloMesh.material, pxPerUnit);
        this.fillMesh.material.uniformsNeedUpdate = true;
        this.haloMesh.material.uniformsNeedUpdate = true;
    }

    update(
        toAdd: Label[],
        toRemove: string[],
        toUpdateLayout: Label[],
        toUpdateStyle: Label[],
        atlas?: SDFAtlas,
        globeAlignment?: boolean,
    ) {
        this._globeAlignment = globeAlignment ?? this._globeAlignment;

        for (const id of toRemove) {
            this._labelDataBuffer.removeKey(id);
            this._glyphDataBuffer.removeKey(id);
        }
        for (const l of toAdd) {
            this._writeLabel(l, false);
            this._writeGlyphs(l);
        }
        for (const l of toUpdateLayout) {
            this._writeLabel(l, true);
            this._writeGlyphs(l);
        }
        for (const l of toUpdateStyle) {
            this._writeLabelStyle(l);
        }

        if (atlas) {
            this.syncAtlas(atlas);
        }
        else {
            this._syncUniforms();
        }

        this.geom.instanceCount = 0;
    }

    private _writeLabelStyle(label: Label) {
        fillStyleTexels(label, this._labelTexelScratch);
        this._labelDataBuffer.patchFirstKey(
            label.id,
            STYLE_FLOAT_OFFSET,
            this._labelTexelScratch.subarray(STYLE_FLOAT_OFFSET, STYLE_FLOAT_OFFSET + STYLE_FLOAT_COUNT),
        );
    }

    private _writeLabel(label: Label, isUpdate: boolean) {
        fillLabelTexels(label, this._labelTexelScratch);
        const alloc = { key: label.id, flatItems: this._labelTexelScratch };
        if (isUpdate) {
            this._labelDataBuffer.updateKey(alloc);
        }
        else {
            this._labelDataBuffer.addToKey(alloc);
        }
    }

    private _writeGlyphs(label: Label) {
        const labelIdx = this._labelDataBuffer.getFirstTexelIdxOf(label.id);
        if (labelIdx === undefined) return;

        const need = label.glyphs.length * GLYPH_TEXELS * 4;
        if (this._glyphTexelScratch.length < need) {
            this._glyphTexelScratch = new Float32Array(need);
        }
        fillGlyphTexels(labelIdx, label.glyphs, this._glyphTexelScratch);
        this._glyphDataBuffer.updateKey({
            key: label.id,
            flatItems: this._glyphTexelScratch.subarray(0, need),
        });
    }

    reemitGlyphs(label: Label) {
        this._writeGlyphs(label);
    }

    cull(labels: Iterable<Label>) {
        let pos = 0;
        let hasHalo = false;

        for (const label of labels) {
            if (!label.shouldRender && label.occlusionFade === 1) {
                label.isRendered = false;
                continue;
            }

            const glyphIndices = this._glyphDataBuffer.getTexelIndicesOf(label.id);
            if (!glyphIndices) {
                label.isRendered = false;
                continue;
            }

            label.isRendered = true;
            for (let i = 0; i < glyphIndices.length; i++) {
                this._glyphIndex[pos] = glyphIndices[i];
                this._occlusionFade[pos] = label.occlusionFade;
                pos++;
            }

            if (label.hasHalo()) hasHalo = true;
        }

        this.geom.instanceCount = pos;

        // Only upload the portion of the buffer that is actually used.
        // Without this, THREE.js uploads the full 1M-element pre-allocated
        // arrays (4 MB each) on every cull(), which stalls the GPU pipeline
        // on every notifyChange (click / navigation).
        const uploadCount = Math.max(1, pos);
        this._glyphIndexAttr.clearUpdateRanges();
        this._glyphIndexAttr.addUpdateRange(0, uploadCount);
        this._glyphIndexAttr.needsUpdate = true;
        this._occlusionFadeAttr.clearUpdateRanges();
        this._occlusionFadeAttr.addUpdateRange(0, uploadCount);
        this._occlusionFadeAttr.needsUpdate = true;

        this.fillMesh.visible = pos > 0;
        this.haloMesh.visible = hasHalo;
    }

    dispose() {
        this.geom.dispose();
        this._labelDataBuffer.dispose();
        this._glyphDataBuffer.dispose();
        this.fillMesh.material.dispose();
        this.haloMesh.material.dispose();
    }
}
