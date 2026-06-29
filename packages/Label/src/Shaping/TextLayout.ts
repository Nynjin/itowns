import { Vector2 } from 'three';
import { Label } from '../Label';
import { GlyphInfo, GlyphInstance } from './GlyphRun';
import { glyphKey } from './FontKey';
import lineBreak from './LineBreak';
import textAlign from './TextAlign';
import { applyShaping, reorderParagraph, isParagraphRTL } from './RTL';
import anchorText from './TextAnchors';

/**
 * Lay out a label's glyphs in font-pixel space (baseFontSize atlas pixels).
 * pxPerUnit and per-label fontSize scaling are deferred to the vertex shader so
 * that changing either requires only a uniform update, not a full CPU re-layout.
 * @param label        - the label to lay out (mutated in-place)
 * @param glyphs       - glyph map from the current SDF atlas
 * @param baseFontSize - atlas base font size from config (advances are in these units)
 * @returns the same label, with glyphs and bounds updated
 */
export default function layoutText(
    label: Label,
    glyphs: Map<string, GlyphInfo>,
    baseFontSize: number,
): Label {
    const fk = label.fontKey;
    const fallback = glyphs.get(glyphKey(fk, '?'));
    if (!fallback) throw new Error('Atlas missing fallback glyph "?"');
    const chars: GlyphInstance[] = [];

    const shapedText = applyShaping(label.getDisplayText());
    const paragraphIsRTL = isParagraphRTL(shapedText);
    const { breakIndices } = lineBreak(label, glyphs, baseFontSize, shapedText);
    const visualLines = reorderParagraph(shapedText, breakIndices);

    // All layout coordinates are in baseFontSize pixel units; the shader scales
    // by (label.fontSize / baseFontSize) at render time.
    const letterSpacing = label.letterSpacing * baseFontSize;
    const lineHeight = label.lineHeight * baseFontSize;
    const offsetX = label.offset.x * baseFontSize;
    const offsetY = label.offset.y * baseFontSize;

    // Resolve each visual line's glyphs
    const resolvedLines: GlyphInfo[][] = visualLines.map((line) => {
        const resolved: GlyphInfo[] = new Array(line.length);
        for (let i = 0; i < line.length; i++) {
            resolved[i] = glyphs.get(glyphKey(fk, line[i])) ?? fallback;
        }
        return resolved;
    });

    // Calculate line widths from resolved glyphs
    const lineWidths: number[] = resolvedLines.map((resolved) => {
        if (resolved.length === 0) return 0;
        let w = 0;
        const last = resolved.length - 1;
        for (let i = 0; i < last; i++) {
            w += resolved[i].advance + letterSpacing;
        }
        w += resolved[last].advance;
        return w;
    });

    const maxLineWidth = lineWidths.length > 0 ? Math.max(...lineWidths) : 0;

    // Layout each character — all coordinates in font-pixel space
    for (let lineIdx = 0; lineIdx < visualLines.length; lineIdx++) {
        const line = visualLines[lineIdx];
        const resolved = resolvedLines[lineIdx];
        if (resolved.length === 0) continue;
        const last = resolved.length - 1;

        const { alignOffsetX, extraSpacePerWordGap } = textAlign(
            label,
            { idx: lineIdx, text: line, width: lineWidths[lineIdx], count: visualLines.length },
            maxLineWidth,
            paragraphIsRTL,
        );

        let cursor = alignOffsetX;
        const y = -lineIdx * lineHeight;

        for (let i = 0; i < last; i++) {
            const g: GlyphInfo = {
                px: resolved[i].px,
                py: resolved[i].py,
                pw: resolved[i].pw,
                ph: resolved[i].ph,
                w: resolved[i].w,
                h: resolved[i].h,
                advance: resolved[i].advance,
                top: resolved[i].top,
            };

            chars.push({
                glyph: g,
                offset: new Vector2(
                    cursor + g.w / 2,
                    (g.top + y) - g.h / 2,
                ),
            });

            cursor += g.advance + letterSpacing;
            if (line[i] === ' ') cursor += extraSpacePerWordGap;
        }

        const r = resolved[last];
        chars.push({
            glyph: {
                px: r.px,
                py: r.py,
                pw: r.pw,
                ph: r.ph,
                w: r.w,
                h: r.h,
                advance: r.advance,
                top: r.top,
            },
            offset: new Vector2(
                cursor + r.w / 2,
                (r.top + y) - r.h / 2,
            ),
        });
    }

    if (chars.length > 0) {
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        for (const ch of chars) {
            const halfW = ch.glyph.w / 2;
            const halfH = ch.glyph.h / 2;
            const x0 = ch.offset.x - halfW, x1 = ch.offset.x + halfW;
            const y0 = ch.offset.y - halfH, y1 = ch.offset.y + halfH;
            if (x0 < minX) minX = x0;
            if (x1 > maxX) maxX = x1;
            if (y0 < minY) minY = y0;
            if (y1 > maxY) maxY = y1;
        }

        maxX += label.padding.right;
        minX -= label.padding.left;
        maxY += label.padding.top;
        minY -= label.padding.bottom;

        const { shiftX, shiftY } = anchorText(
            label,
            { minX, maxX, minY, maxY },
            offsetX,
            offsetY,
        );

        for (const ch of chars) {
            ch.offset.x += shiftX;
            ch.offset.y += shiftY;
        }

        label.bounds = {
            width: maxX - minX,
            height: maxY - minY,
        };
    } else {
        label.bounds = {
            width: maxLineWidth,
            height: visualLines.length * lineHeight,
        };
    }

    label.glyphs = chars;
    return label;
}
