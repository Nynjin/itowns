// @ts-expect-error - no types available
import rtlText from '@mapbox/mapbox-gl-rtl-text';

const { applyArabicShaping, processBidirectionalText } = await rtlText;

export function applyShaping(text: string): string {
    if (!text) return text;
    return applyArabicShaping(text);
}

export function reorderParagraph(text: string, breakIndices: number[]): string[] {
    if (!text) return [''];
    return processBidirectionalText(text, breakIndices);
}

export function isParagraphRTL(text: string): boolean {
    for (const char of text) {
        const cp = char.codePointAt(0) ?? 0;
        // Strongly RTL: Hebrew, Arabic, Syriac, Thaana, NKo, etc.
        if (
            (cp >= 0x0590 && cp <= 0x08FF) ||
            (cp >= 0xFB1D && cp <= 0xFDFF) ||
            (cp >= 0xFE70 && cp <= 0xFEFF)
        ) return true;
        // Strongly LTR: Latin, Greek, Cyrillic, etc.
        if (
            (cp >= 0x0041 && cp <= 0x007A) ||
            (cp >= 0x00C0 && cp <= 0x024F) ||
            (cp >= 0x0370 && cp <= 0x03FF) ||
            (cp >= 0x0400 && cp <= 0x04FF)
        ) return false;
    }
    return false;
}
