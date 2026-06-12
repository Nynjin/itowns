import { DataTexture, GLSL3, ShaderMaterial } from 'three';
import { GLYPH_VERT } from '../Shaders/Glyph.vert.glsl';
import { FILL_FRAG } from '../Shaders/Fill.frag.glsl';
import { SDFAtlas } from '../../Shaping/SDFAtlas';

export function createFillMaterial(
    atlas: SDFAtlas,
    labelTex: DataTexture,
    glyphTex: DataTexture,
    baseFontSize: number,
    pxPerUnit: number,
): ShaderMaterial {
    const material = new ShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: GLYPH_VERT,
        fragmentShader: FILL_FRAG,
        uniforms: {
            uAtlas: { value: atlas.texture },
            uAtlasWidth: { value: atlas.texture.width },
            uCutoff: { value: atlas.cutoff },
            uRadius: { value: atlas.radius },
            uLabelTex: { value: labelTex },
            uGlyphTex: { value: glyphTex },
            uLabelTexWidth: { value: labelTex.width },
            uGlyphTexWidth: { value: glyphTex.width },
            uGlobeAlignment: { value: 0 },
            uBaseFontSize: { value: baseFontSize },
            uPxPerUnit: { value: pxPerUnit },
        },
        transparent: true,
        depthWrite: true,
        depthTest: false,
    });

    return material;
}

export function updateFillAtlas(
    material: ShaderMaterial,
    atlas: SDFAtlas,
) {
    material.uniforms.uAtlas.value = atlas.texture;
    material.uniforms.uAtlasWidth.value = atlas.texture.width;
    material.uniforms.uCutoff.value = atlas.cutoff;
    material.uniforms.uRadius.value = atlas.radius;
}

export function updateFillUniforms(
    material: ShaderMaterial,
    labelTex: DataTexture,
    glyphTex: DataTexture,
    globeAlignment: boolean,
) {
    material.uniforms.uLabelTex.value = labelTex;
    material.uniforms.uGlyphTex.value = glyphTex;
    material.uniforms.uLabelTexWidth.value = labelTex.width;
    material.uniforms.uGlyphTexWidth.value = glyphTex.width;
    material.uniforms.uGlobeAlignment.value = globeAlignment ? 1 : 0;
}

export function updateFillPxPerUnit(material: ShaderMaterial, pxPerUnit: number) {
    material.uniforms.uPxPerUnit.value = pxPerUnit;
}
