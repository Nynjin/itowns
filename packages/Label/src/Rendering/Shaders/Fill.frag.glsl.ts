import { DATA_TEXTURE_FETCH } from './DataTextureFetch.glsl';

export const FILL_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uAtlas;
uniform int       uAtlasWidth;
uniform float     uCutoff;
uniform float     uRadius;

${DATA_TEXTURE_FETCH}

in vec2       vUv;
flat in int   vLabelId;
flat in int   vGlyphId;
flat in float vOcclusionFade;

out vec4 outColor;

void main() {
  vec4 g2 = glyphFetch(vGlyphId, 2);
  vec4 t2 = labelFetch(vLabelId, 2);

  vec2  atlasUV = (g2.xy + vec2(vUv.x, 1.0 - vUv.y) * g2.zw) / float(uAtlasWidth);
  float sdf     = texture(uAtlas, atlasUV).r;

  float atlasTexPerPx = 0.5 * (length(dFdx(atlasUV)) + length(dFdy(atlasUV))) * float(uAtlasWidth);
  float fw = max(atlasTexPerPx / float(uRadius), 0.003);

  float alpha = smoothstep(uCutoff - fw * 0.5, uCutoff + fw * 0.5, sdf);
  if (alpha < 0.01) discard;

  outColor = vec4(t2.rgb, t2.a * alpha * (1.0 - vOcclusionFade));
}
`;
