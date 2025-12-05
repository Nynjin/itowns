import * as THREE from 'three';

enum BillboardMode {
    Map = 0,
    Viewport = 1,
}

type LabelMaterial = THREE.Material & {
    uniforms: {
        invScreenHeight: { value: number };
        fontSize: { value: number };
        billboardMode: { value: BillboardMode };
    };
};

export { type LabelMaterial, BillboardMode };
