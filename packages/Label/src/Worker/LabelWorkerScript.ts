/**
 * Web Worker entry point for the label pipeline.
 *
 * Runs: layoutText, collision evaluation, and fade advancement.
 * Atlas rasterization (SDFAtlas / OffscreenCanvas) stays on the main thread
 * since it requires Canvas2D; only the glyph metrics are sent here.
 *
 * Build note: loaded as the `itowns_labelworker` webpack entry via
 * `new Worker(new URL('./LabelWorkerScript.js', import.meta.url), { type: 'module' })`.
 */

import { Quaternion, Vector2 } from 'three';
import { Label, TextAnchorX, TextAnchorY, TextAlign, TextTransform, RotationAlignment, SymbolPlacement } from '../Label';
import layoutText from '../Shaping/TextLayout';
import type { GlyphInfo, GlyphInstance } from '../Shaping/GlyphRun';
import { DefaultLabelConfig } from '../Types/LabelConfig';
import type { LabelManagerConfig } from '../Types/LabelConfig';
import { WorkerCollisionEngine } from './WorkerCollisionEngine';
import type { MainToWorker, WorkerToMain, SerialisedLabel, LabelDelta, SerialisedGlyphInstance } from './WorkerMessages';

/**
 * Glyph instances carry a three Vector2 `offset`; structured clone turns it into
 * a plain `{x, y}` on the way out, which is exactly SerialisedGlyphInstance.
 * This cast documents that the wire shape differs from the in-worker type.
 */
function serialiseGlyphs(glyphs: GlyphInstance[]): SerialisedGlyphInstance[] {
    return glyphs as unknown as SerialisedGlyphInstance[];
}

// ── State ────────────────────────────────────────────────────────────────────

let config: LabelManagerConfig = { ...DefaultLabelConfig };

/** Shadow Label instances — real Label objects, worker-safe since Label has no DOM deps. */
const labels  = new Map<string, Label>();

/** Atlas glyph metrics per font key.  Populated via SET_ATLAS. */
const atlases = new Map<string, Map<string, GlyphInfo>>();

/** Persistent labelId → fontKey for every live label (used to re-layout on atlas resize). */
const labelFontKeys = new Map<string, string>();

/** Labels waiting for their font atlas before layout can run. */
const pendingLayout = new Map<string, string>(); // labelId → fontKey

let collision: WorkerCollisionEngine | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function post(msg: WorkerToMain, transfer?: Transferable[]) {
    if (transfer?.length) {
        self.postMessage(msg, { transfer });
    } else {
        self.postMessage(msg);
    }
}

function deserialise(init: SerialisedLabel): Label {
    const label = new Label({
        text:              init.text,
        textTransform:     init.textTransform as TextTransform,
        font:              init.font,
        fontSize:          init.fontSize,
        fontWeight:        init.fontWeight,
        letterSpacing:     init.letterSpacing,
        lineHeight:        init.lineHeight,
        maxWidth:          init.maxWidth,
        textAlign:         init.textAlign as TextAlign,
        padding:           { top: init.padding[0], right: init.padding[1], bottom: init.padding[2], left: init.padding[3] },
        position:          [init.position[0], init.position[1], init.position[2]],
        rotation:          new Quaternion(init.rotation[0], init.rotation[1], init.rotation[2], init.rotation[3]),
        offset:            new Vector2(init.offset[0], init.offset[1]),
        anchorX:           init.anchorX  as TextAnchorX,
        anchorY:           init.anchorY  as TextAnchorY,
        rotationAlignment: init.rotationAlignment as RotationAlignment,
        symbolPlacement:   init.symbolPlacement   as SymbolPlacement,
        visible:           init.visible,
        opacity:           init.opacity,
    });
    // Force the main-thread id so EVAL_DONE / LAYOUT_DONE bitmask ids match the
    // main-thread labels.  Label generates a random id in its constructor.
    (label as any)._id = init.id;
    return label;
}

function applyDelta(label: Label, delta: LabelDelta) {
    if (delta.position)         label.position          = [delta.position[0], delta.position[1], delta.position[2]];
    if (delta.rotation)         label.rotation          = new Quaternion(...delta.rotation);
    if (delta.offset)           label.offset            = new Vector2(delta.offset[0], delta.offset[1]);
    if (delta.fontSize   != null) (label as any)._fontSize   = delta.fontSize;
    if (delta.visible    != null) (label as any)._visible    = delta.visible;
    if (delta.opacity    != null) (label as any)._opacity    = delta.opacity;
    if (delta.groupVisible != null) label.groupVisible        = delta.groupVisible;
    // Text / layout properties — mark for re-layout (set on backing fields to skip reactive emit)
    let needsRelayout = false;
    if (delta.text          != null) { (label as any)._text          = delta.text;          needsRelayout = true; }
    if (delta.textTransform != null) { (label as any)._textTransform = delta.textTransform; needsRelayout = true; }
    if (delta.font          != null) { (label as any)._font          = delta.font;          needsRelayout = true; }
    if (delta.fontWeight    != null) { (label as any)._fontWeight    = delta.fontWeight;    needsRelayout = true; }
    if (delta.letterSpacing != null) { (label as any)._letterSpacing = delta.letterSpacing; needsRelayout = true; }
    if (delta.lineHeight    != null) { (label as any)._lineHeight    = delta.lineHeight;    needsRelayout = true; }
    if (delta.maxWidth      != null) { (label as any)._maxWidth      = delta.maxWidth;      needsRelayout = true; }
    if (delta.textAlign     != null) { (label as any)._textAlign     = delta.textAlign;     needsRelayout = true; }
    if (delta.padding       != null) { (label as any)._padding       = { top: delta.padding[0], right: delta.padding[1], bottom: delta.padding[2], left: delta.padding[3] }; needsRelayout = true; }
    if (delta.anchorX       != null) { (label as any)._anchorX       = delta.anchorX;       needsRelayout = true; }
    if (delta.anchorY       != null) { (label as any)._anchorY       = delta.anchorY;       needsRelayout = true; }
    return needsRelayout;
}

function tryLayout(label: Label, fontKey: string): boolean {
    const glyphs = atlases.get(fontKey);
    if (!glyphs) {
        pendingLayout.set(label.id, fontKey);
        return false;
    }
    layoutText(label, glyphs, config.baseFontSize);
    return true;
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<MainToWorker>) => {
    const msg = event.data;

    switch (msg.type) {
        case 'INIT': {
            config = { ...DefaultLabelConfig, ...msg };
            collision = new WorkerCollisionEngine(config);
            break;
        }

        case 'SET_PX_PER_UNIT': {
            config.pxPerUnit = msg.pxPerUnit;
            break;
        }

        case 'RECONFIGURE': {
            Object.assign(config, msg.config);
            collision?.reconfigure(msg.config);
            break;
        }

        case 'ADD_LABELS': {
            const layoutResults: WorkerToMain & { type: 'LAYOUT_DONE' } = { type: 'LAYOUT_DONE', results: [] };

            for (const init of msg.labels) {
                const label = deserialise(init);
                // groupVisible is not a Label constructor option — set directly
                label.groupVisible = init.groupVisible;
                labels.set(init.id, label);
                labelFontKeys.set(init.id, init.fontKey);

                const laid = tryLayout(label, init.fontKey);
                if (laid) {
                    layoutResults.results.push({
                        id:     label.id,
                        glyphs: serialiseGlyphs(label.glyphs),
                        bounds: label.bounds,
                    });
                }
            }

            collision?.addLabels([...msg.labels.map(i => labels.get(i.id)!).filter(Boolean)]);

            if (layoutResults.results.length > 0) {
                post(layoutResults);
            }
            break;
        }

        case 'REMOVE_LABELS': {
            for (const id of msg.ids) {
                labels.delete(id);
                labelFontKeys.delete(id);
                pendingLayout.delete(id);
            }
            collision?.removeLabels(msg.ids);
            break;
        }

        case 'UPDATE_LABELS': {
            const relayoutIds: { id: string; fontKey: string }[] = [];

            for (const delta of msg.updates) {
                const label = labels.get(delta.id);
                if (!label) continue;
                const needsRelayout = applyDelta(label, delta);
                if (needsRelayout) {
                    const fontKey = labelFontKeys.get(delta.id) ?? label.font;
                    relayoutIds.push({ id: delta.id, fontKey });
                }
            }

            if (relayoutIds.length > 0) {
                const layoutResults: WorkerToMain & { type: 'LAYOUT_DONE' } = { type: 'LAYOUT_DONE', results: [] };
                for (const { id, fontKey } of relayoutIds) {
                    const label = labels.get(id);
                    if (!label) continue;
                    if (tryLayout(label, fontKey)) {
                        layoutResults.results.push({ id, glyphs: serialiseGlyphs(label.glyphs), bounds: label.bounds });
                    }
                }
                if (layoutResults.results.length > 0) post(layoutResults);
            }
            break;
        }

        case 'SET_ATLAS': {
            const glyphMap = new Map(Object.entries(msg.glyphs)) as Map<string, GlyphInfo>;
            atlases.set(msg.fontKey, glyphMap);

            const layoutResults: WorkerToMain & { type: 'LAYOUT_DONE' } = { type: 'LAYOUT_DONE', results: [] };

            if (msg.resized) {
                // Atlas was repacked: every glyph's atlas coords changed, so every
                // already-laid-out label of this font must be re-laid-out and re-emitted.
                for (const [labelId, fontKey] of labelFontKeys) {
                    if (fontKey !== msg.fontKey) continue;
                    const label = labels.get(labelId);
                    if (!label) continue;
                    layoutText(label, glyphMap, config.baseFontSize);
                    pendingLayout.delete(labelId);
                    layoutResults.results.push({ id: labelId, glyphs: serialiseGlyphs(label.glyphs), bounds: label.bounds });
                }
            } else {
                // Atlas only grew (new glyphs appended): existing coords are stable,
                // so only labels that were waiting for this atlas need layout.
                for (const [labelId, pendingKey] of pendingLayout) {
                    if (pendingKey !== msg.fontKey) continue;
                    const label = labels.get(labelId);
                    if (!label) { pendingLayout.delete(labelId); continue; }
                    layoutText(label, glyphMap, config.baseFontSize);
                    pendingLayout.delete(labelId);
                    layoutResults.results.push({ id: labelId, glyphs: serialiseGlyphs(label.glyphs), bounds: label.bounds });
                }
            }
            if (layoutResults.results.length > 0) post(layoutResults);
            break;
        }

        case 'EVALUATE': {
            if (!collision) break;
            collision.setViewport(msg.vpWidth, msg.vpHeight);

            const result = collision.evaluate(
                msg.projMatrix, msg.viewMatrix,
                msg.camX, msg.camY, msg.camZ,
                msg.near, msg.far,
            );
            if (result) {
                post(
                    { type: 'EVAL_DONE', ids: result.ids, shouldRender: result.shouldRender, isCandidate: result.isCandidate },
                    [result.shouldRender.buffer, result.isCandidate.buffer],
                );
            }
            break;
        }

        case 'FRAME': {
            if (!collision) break;
            const result = collision.advanceFades(msg.frameDelta);
            // Only message back when fades actually moved — avoids a per-frame
            // postMessage round-trip while the label set is visually settled.
            if (result) {
                post(
                    { type: 'FADES_DONE', ids: result.ids, occlusionFades: result.occlusionFades, anyChanged: true },
                    [result.occlusionFades.buffer],
                );
            }
            break;
        }
    }
};
