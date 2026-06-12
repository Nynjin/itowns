import { Vector2, Quaternion } from 'three';

export interface GlyphInfo {
    px: number;
    py: number;
    pw: number;
    ph: number;

    w: number;
    h: number;
    advance: number;
    top: number;
}

export interface GlyphInstance {
    glyph: GlyphInfo;

    /** Label-local position in baseFontSize pixel units. */
    offset: Vector2;

    /** Optional orientation (identity by default). */
    rotation?: Quaternion;
}
