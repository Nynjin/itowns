import { Label } from '../Label';
import { GlyphInfo } from './GlyphRun';
import { glyphKey } from './FontKey';

export interface LineBreaks {
    lines: string[];
    breakIndices: number[];
}

export default function lineBreak(
    label: Label,
    glyphs: Map<string, GlyphInfo>,
    baseFontSize: number,
    text = label.getDisplayText(),
): LineBreaks {
    const fallback = glyphs.get(glyphKey(label.fontKey, '?'));
    if (!fallback) throw new Error('Atlas missing fallback glyph "?"');

    if (!text) {
        return { lines: [''], breakIndices: [0] };
    }

    if (label.maxWidth >= Infinity) {
        return { lines: [text], breakIndices: [text.length] };
    }

    // Advances from the atlas are in baseFontSize pixel units; scale spacing to match.
    const letterSpacing = label.letterSpacing * baseFontSize;
    const maxWidth = label.maxWidth * baseFontSize;
    const lines: string[] = [];
    const breakIndices: number[] = [];

    let i = 0;
    while (i < text.length) {
        // Skip leading spaces at the start of each line
        while (i < text.length && text[i] === ' ') i++;
        if (i >= text.length) break;

        let lineStr = '';
        let lineWidth = 0;

        // Track the last space position so we can break at a word boundary
        let lastSpaceI = -1;       // index in `text` of the last space that fit
        let lastSpaceLineLen = 0;  // length of lineStr when that space was recorded

        while (i < text.length) {
            const c = text[i];
            const adv = (glyphs.get(glyphKey(label.fontKey, c)) ?? fallback).advance;
            const charW = adv + (lineStr.length > 0 ? letterSpacing : 0);

            // Overflow — only after at least one char is on the line
            if (lineStr.length > 0 && lineWidth + charW > maxWidth) {
                if (lastSpaceI >= 0) {
                    // Break at the last word boundary
                    lines.push(lineStr.slice(0, lastSpaceLineLen));
                    // Break index = position just after the space
                    breakIndices.push(lastSpaceI + 1);
                    i = lastSpaceI + 1;
                } else {
                    // No word boundary — break mid-character
                    lines.push(lineStr);
                    breakIndices.push(i);
                }
                lineStr = '';
                break;
            }

            if (c === ' ') {
                lastSpaceI = i;
                lastSpaceLineLen = lineStr.length;
            }

            lineStr += c;
            lineWidth += charW;
            i++;
        }

        if (lineStr) {
            lines.push(lineStr);
            breakIndices.push(i);
        }
    }

    if (lines.length === 0) {
        lines.push('');
        breakIndices.push(text.length);
    }

    return { lines, breakIndices };
}
