// @ts-expect-error troika-three-text has no types
import { Text as TroikaText } from 'troika-three-text';
import * as THREE from 'three';

interface TextProps {
  text: string;
  anchorX: number | 'left' | 'center' | 'right';
  anchorY: number | 'top' | 'top-baseline' |
    'top-cap' | 'top-ex' | 'middle' | 'bottom-baseline' | 'bottom';
  curveRadius: number;
  direction: 'auto' | 'ltr' | 'rtl';
  font: string | null;
  unicodeFontsURL: string | null;
  fontSize: number;
  fontWeight: number | 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  lang: string | null;
  letterSpacing: number;
  lineHeight: number | 'normal';
  maxWidth: number;
  overflowWrap: 'normal' | 'break-word';
  textAlign: string;
  textIndent: number;
  whiteSpace: 'normal' | 'nowrap';

  // Appearance
  material: THREE.Material | THREE.Material[];
  color: number | string | THREE.Color | null;
  colorRanges: Record<number, number | string | THREE.Color> | null;
  outlineWidth: number | string;
  outlineColor: number | string | THREE.Color;
  outlineOpacity: number;
  outlineBlur: number | string;
  outlineOffsetX: number | string;
  outlineOffsetY: number | string;
  strokeWidth: number | string;
  strokeColor: number | string | THREE.Color;
  strokeOpacity: number;
  fillOpacity: number;
  depthOffset: number;
  clipRect: [number, number, number, number] | null;
  orientation: string;
  glyphGeometryDetail: number;
  sdfGlyphSize: number | null;
  gpuAccelerateSDF: boolean;
  debugSDF: boolean;

  // Methods
  sync(callback?: () => void): void;
  dispose(): void;
}

export type Text = THREE.Mesh & TextProps;
export const Text = TroikaText as unknown as new () => Text;
