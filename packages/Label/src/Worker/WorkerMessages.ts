import type { GlyphInfo } from '../Shaping/GlyphRun';

// ── Serialised label sent on ADD_LABELS ──────────────────────────────────────

export interface SerialisedLabel {
    id:               string;
    fontKey:          string;

    // Text layout
    text:             string;
    textTransform:    number;
    font:             string;
    fontSize:         number;
    fontWeight:       string;
    letterSpacing:    number;
    lineHeight:       number;
    maxWidth:         number;
    textAlign:        number;
    padding:          [number, number, number, number]; // top right bottom left

    // Collision / projection
    position:         [number, number, number];
    rotation:         [number, number, number, number]; // quat xyzw
    offset:           [number, number];
    anchorX:          number;
    anchorY:          number;
    rotationAlignment: number;
    symbolPlacement:  number;

    // Visibility
    visible:          boolean;
    opacity:          number;
    groupVisible:     boolean;
}

export interface LabelDelta {
    id:            string;
    position?:     [number, number, number];
    rotation?:     [number, number, number, number];
    offset?:       [number, number];
    fontSize?:     number;
    visible?:      boolean;
    opacity?:      number;
    groupVisible?: boolean;
    // Text / layout fields that require re-layout in the worker
    text?:             string;
    textTransform?:    number;
    font?:             string;
    fontWeight?:       string;
    letterSpacing?:    number;
    lineHeight?:       number;
    maxWidth?:         number;
    textAlign?:        number;
    padding?:          [number, number, number, number];
    anchorX?:          number;
    anchorY?:          number;
}

// ── Main → Worker ────────────────────────────────────────────────────────────

export type MainToWorker =
    | { type: 'INIT';          baseFontSize: number; fadeDurationMs: number;
                               downscale: number; coarseScale: number;
                               acceptableOcclusion: number; maxOcclusion: number;
                               collisionBuckets: number; ndcCullMargin: number;
                               renderPenaltyMultiplier: number; fontSizePriorityPower: number;
                               pxPerUnit: number }
    | { type: 'ADD_LABELS';    labels: SerialisedLabel[] }
    | { type: 'UPDATE_LABELS'; updates: LabelDelta[] }
    | { type: 'REMOVE_LABELS'; ids: string[] }
    // Atlas glyph metrics for a font key — must arrive before or with ADD_LABELS
    // so the worker can run layoutText.  Sent whenever the atlas is dirty/resized.
    // resized=true means the atlas was repacked: every glyph's atlas coords
    // changed, so all already-laid-out labels of this font must be re-laid-out.
    | { type: 'SET_ATLAS';     fontKey: string; glyphs: Record<string, GlyphInfo>; baseFontSize: number; resized: boolean }
    | { type: 'SET_PX_PER_UNIT'; pxPerUnit: number }
    | { type: 'EVALUATE';      projMatrix: Float32Array; viewMatrix: Float32Array;
                               camX: number; camY: number; camZ: number;
                               near: number; far: number;
                               vpWidth: number; vpHeight: number }
    | { type: 'FRAME';         frameDelta: number };

// ── Worker → Main ────────────────────────────────────────────────────────────

// Serialised glyph instance — Vector2 arrives as plain {x,y} via structured clone.
// fillGlyphTexels only reads .x/.y / primitive fields so no reconstruction needed.
export interface SerialisedGlyphInstance {
    glyph:    GlyphInfo;
    offset:   { x: number; y: number };
    rotation?: { x: number; y: number; z: number; w: number };
}

export type WorkerToMain =
    | { type: 'LAYOUT_DONE';
        results: Array<{ id: string; glyphs: SerialisedGlyphInstance[]; bounds: { width: number; height: number } }> }
    // Parallel arrays — same order, indexed by position in the arrays.
    // Only includes labels whose shouldRender / isCandidate changed.
    | { type: 'EVAL_DONE';
        ids: string[];
        shouldRender: Uint8Array;   // transferable
        isCandidate:  Uint8Array }  // transferable
    // Only includes labels whose occlusionFade actually moved this frame.
    | { type: 'FADES_DONE';
        ids: string[];
        occlusionFades: Float32Array;  // transferable
        anyChanged: boolean };
