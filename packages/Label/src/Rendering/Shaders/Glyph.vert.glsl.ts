import { DATA_TEXTURE_FETCH } from './DataTextureFetch.glsl';

export const GLYPH_VERT = /* glsl */ `
precision highp float;

// Label data texture layout:
//   T0: position.xyz, fontSize
//   T1: rotation quat (x, y, z, w)
//   T2: color (r, g, b) + opacity
//   T3: haloColor (r, g, b) + haloOpacity
//   T4: haloWidth, haloBlur, -, -
//   T5: rotationAlignment, symbolPlacement, -, -
//
// Glyph data texture layout:
//   T0: label index, -, -, -
//   T1: char offset (x, y) + size (w, h)  [font-pixel space]
//   T2: (px, py) in atlas + (pw, ph) atlas size

${DATA_TEXTURE_FETCH}

attribute int   glyphIndex;   // per-instance glyph slot, written by cull()
attribute float occlusionFade;

uniform int   uGlobeAlignment;
uniform float uBaseFontSize;
uniform float uPxPerUnit;

flat out int   vLabelId;
flat out int   vGlyphId;
flat out float vOcclusionFade;
out vec2       vUv;

vec3 rotateByQuat(vec3 v, vec4 q) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

vec4 mapAlignedPosition(vec3 local, vec4 rot, vec3 labelPos) {
  vec3 rotated  = rotateByQuat(local, rot);
  vec3 centerWS = (modelMatrix * vec4(labelPos, 1.0)).xyz;

  if (uGlobeAlignment == 1) {
    vec3 n     = normalize(centerWS);
    vec3 ref   = abs(n.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
    vec3 east  = normalize(cross(ref, n));
    vec3 north = normalize(cross(n, east));
    vec3 world = east * rotated.x + north * rotated.y + n * rotated.z;
    return projectionMatrix * viewMatrix * vec4(centerWS + world, 1.0);
  }

  return projectionMatrix * viewMatrix * modelMatrix * vec4(labelPos + rotated, 1.0);
}

vec4 viewportAlignedPosition(vec3 local, vec3 labelPos) {
  vec4 centerVS = modelViewMatrix * vec4(labelPos, 1.0);
  return projectionMatrix * vec4(centerVS.xyz + vec3(local.xy, 0.0), 1.0);
}

void main() {
  vUv           = uv;
  vGlyphId      = glyphIndex;
  vOcclusionFade = occlusionFade;

  vec4 g0      = glyphFetch(glyphIndex, 0);
  vLabelId     = int(g0.x);
  vec4 g1      = glyphFetch(glyphIndex, 1);
  vec2 charOff = g1.xy;
  vec2 size    = g1.zw;

  vec4  t0       = labelFetch(vLabelId, 0);
  vec3  labelPos = t0.xyz;
  float fontSize = t0.w;
  vec4  rot      = labelFetch(vLabelId, 1);
  vec4  t5       = labelFetch(vLabelId, 5);
  int   rotAlign = int(t5.x);
  int   symPlace = int(t5.y);

  // font-pixels -> world units, then multiply by depth to maintain constant screen size
  float viewDist    = length((modelViewMatrix * vec4(labelPos, 1.0)).xyz);
  float sizeScale   = (fontSize / uBaseFontSize) / uPxPerUnit * viewDist;
  vec3  quad        = position * vec3(size    * sizeScale, 1.0);
  vec3  local       = vec3(charOff * sizeScale, 0.0) + quad;

  switch (rotAlign) {
    case 0:  gl_Position = mapAlignedPosition(local, rot, labelPos);   break;
    case 1:  gl_Position = viewportAlignedPosition(local, labelPos);   break;
    default: gl_Position = (symPlace == 0)
               ? viewportAlignedPosition(local, labelPos)
               : mapAlignedPosition(local, rot, labelPos);
             break;
  }
}
`;
