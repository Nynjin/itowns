export interface FontKey {
    font: string;
    weight: string;
    style: string;
}

// CSS weight keyword → normalized CSS font-weight value
const WEIGHT_MAP: Record<string, string> = {
    thin: '100',
    hairline: '100',
    extralight: '200',
    ultralight: '200',
    light: '300',
    regular: 'normal',
    medium: '500',
    semibold: '600',
    demibold: '600',
    bold: 'bold',
    extrabold: '800',
    ultrabold: '800',
    black: '900',
    heavy: '900',
};

const STYLE_TOKENS = new Set(['italic', 'oblique']);

function parseSingleFontDescriptor(fontDescriptor: string): FontKey {
    const parts = fontDescriptor.trim().split(/\s+/);
    let weight = 'normal';
    let style = 'normal';

    while (parts.length > 1) {
        const token = parts[parts.length - 1].toLowerCase();
        if (STYLE_TOKENS.has(token)) {
            style = token;
            parts.pop();
        } else if (token in WEIGHT_MAP) {
            weight = WEIGHT_MAP[token];
            parts.pop();
        } else {
            break;
        }
    }

    return {
        font: parts.join(' '),
        weight,
        style,
    };
}

/**
 * Parse a dataset font string such as "Open Sans Bold Italic" into its
 * constituent parts. Recognized weight and style keywords are stripped from
 * the end of the name; the remainder is the font family.
 *
 * @param fontString - composite font descriptor from the dataset
 * @returns parsed font, weight and style
 */
export function parseFontString(fontString: string): FontKey {
    const candidates = fontString.split(',').map(s => s.trim()).filter(Boolean);
    if (candidates.length === 0) {
        return { font: 'sans-serif', weight: 'normal', style: 'normal' };
    }

    // Parse each candidate independently so descriptor tokens are removed from
    // each font family in the stack.
    const parsedCandidates = candidates.map(parseSingleFontDescriptor);
    const primary = parsedCandidates[0];
    return {
        font: parsedCandidates.map(c => c.font).join(','),
        weight: primary.weight,
        style: primary.style,
    };
}

/** Stable string key for a FontKey — used for Map lookups and inter-thread messages. */
export function fontKeyStr(fontKey: FontKey): string {
    return `${fontKey.font}|${fontKey.weight}|${fontKey.style}`;
}

/**
 * Compound atlas glyph key: identifies a (fontVariant, character) pair uniquely.
 * NUL separators prevent collisions between font names / weights that contain `|`.
 */
export function glyphKey(fontKey: FontKey, char: string): string {
    return `${fontKey.font}\x00${fontKey.weight}\x00${fontKey.style}\x00${char}`;
}
