/**
 * Shared GLSL block included in every shader that reads from the label or
 * glyph data textures. Declares the four uniforms and the two fetch helpers.
 *
 * Include once per shader stage, before any code that calls labelFetch /
 * glyphFetch.
 */
export const DATA_TEXTURE_FETCH = /* glsl */ `
uniform highp sampler2D uLabelTex;
uniform int             uLabelTexWidth;
uniform highp sampler2D uGlyphTex;
uniform int             uGlyphTexWidth;

vec4 labelFetch(int instanceId, int texel) {
  int li = instanceId + texel;
  int w  = max(uLabelTexWidth, 1);
  return texelFetch(uLabelTex, ivec2(li % w, li / w), 0);
}

vec4 glyphFetch(int instanceId, int texel) {
  int li = instanceId + texel;
  int w  = max(uGlyphTexWidth, 1);
  return texelFetch(uGlyphTex, ivec2(li % w, li / w), 0);
}
`;
