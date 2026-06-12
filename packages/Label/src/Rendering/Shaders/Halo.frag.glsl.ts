import { DATA_TEXTURE_FETCH } from './DataTextureFetch.glsl';

export const HALO_FRAG = /* glsl */ `
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
  vec4 t3 = labelFetch(vLabelId, 3);
  vec4 t4 = labelFetch(vLabelId, 4);

  float haloWidth = t4.x;
  float haloBlur  = t4.y;

  vec2  atlasUV = (g2.xy + vec2(vUv.x, 1.0 - vUv.y) * g2.zw) / float(uAtlasWidth);
  float sdf     = texture(uAtlas, atlasUV).r;

  float atlasTexPerPx = 0.5 * (length(dFdx(atlasUV)) + length(dFdy(atlasUV))) * float(uAtlasWidth);
  float fw = max(atlasTexPerPx / float(uRadius), 0.003);

  float haloWidthSDF = haloWidth * fw;
  float haloBlurSDF  = max(haloBlur * fw, fw * 0.75);

  // Clamp solidEdge so a large width doesn't overshoot the SDF padding
  float solidEdge = max(uCutoff - haloWidthSDF, 0.05);
  // Clamp fadeEdge above 0 so empty space (sdf=0) always evaluates to alpha 0
  float fadeEdge  = max(solidEdge - haloBlurSDF, 0.001);

  float alpha = smoothstep(fadeEdge, solidEdge + fw * 0.5, sdf);
  if (alpha < 0.01) discard;

  outColor = vec4(t3.rgb, alpha * t2.a * t3.a * (1.0 - vOcclusionFade));
}
`;
