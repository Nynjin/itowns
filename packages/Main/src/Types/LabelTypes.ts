import * as THREE from 'three';

enum BillboardMode {
    Map = 0,
    Viewport = 1,
}

type LabelMaterial = THREE.Material & {
    uniforms: {
        uInvScreenHeight: { value: number };
        uFontSize: { value: number };
        uBillboardMode: { value: BillboardMode };
    };
};

type TextStyleType = {
    field: string;
    font: string[];
    color: number | string | THREE.Color;
    opacity: number;
    size: number;
    spacing: number;
    transform: 'uppercase' | 'lowercase' | 'none';

    anchor: 'center' | 'left' | 'right' | 'top' | 'bottom' |
    'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    justify: 'auto' | 'left' | 'center' | 'right' | 'justify';
    offset: number[];
    padding: number;
    wrap: number;
    lineHeight: number;

    haloColor?: number | string | THREE.Color;
    haloWidth?: number;
    haloBlur?: number;

    rotation: 'map' | 'viewport' | 'auto';
    placement: 'point' | 'line' | 'line-center';
    zOrder: 'auto' | 'Y' | 'source';
};

export { type LabelMaterial, BillboardMode, type TextStyleType };
