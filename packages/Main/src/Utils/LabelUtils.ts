import * as THREE from 'three';
// @ts-expect-error troika-three-utils has no types
import { createDerivedMaterial as untypedCreateDerivedMaterial } from 'troika-three-utils';

const createDerivedMaterial = untypedCreateDerivedMaterial as
(baseMaterial: THREE.Material, options: unknown) => THREE.Material;

type LabelMaterial = THREE.Material & {
    uniforms: {
        invScreenHeight: { value: number };
        fontSize: { value: number };
    };
};
/**
 * Creates a material suitable for rendering labels that always face the camera
 * and with consistent on-screen size regardless of zoom or camera.
 * @param baseMaterial - The base THREE.Material to derive from
 * @param opts - Options to customize the derived material
 * @returns LabelMaterial
 */
const createLabelMaterial =
(baseMaterial: THREE.Material, opts: object) => createDerivedMaterial(
    baseMaterial,
    {
        uniforms: {
            invScreenHeight: { value: 1.0 /
                (typeof window !== 'undefined' ? window.innerHeight : 1080.0) },
            fontSize: { value: 100.0 },
        },
        vertexDefs: `
        uniform float invScreenHeight; // 1.0 / viewport height in pixels
        uniform float fontSize;       // pixels per local unit
        `,
        vertexMainOutro: `
        // Label center in view space
        vec4 centerVS = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);

        // perspective vs ortho detection
        float p33 = projectionMatrix[3][3];
        float f   = projectionMatrix[1][1];

        // World-units-per-pixel at this depth
        float wpp = (p33 > 0.5)
            ? ((2.0 * invScreenHeight) / f)                  // orthographic
            : ((-centerVS.z) * 2.0 * invScreenHeight / f);   // perspective

        // View-space right/up axes (screen aligned)
        vec3 rightVS = vec3(1.0, 0.0, 0.0);
        vec3 upVS    = vec3(0.0, 1.0, 0.0);

        // Local glyph offset in pixels (XY only)
        vec2 offsPx = position.xy * fontSize;

        // Convert pixel offset to view-space units
        vec3 viewOffset = rightVS * (offsPx.x * wpp) + upVS * (offsPx.y * wpp);

        vec4 finalVS = vec4(centerVS.xyz + viewOffset, 1.0);
        gl_Position = projectionMatrix * finalVS;
        `,
        ...opts,
    },
) as LabelMaterial;

export { createLabelMaterial };
