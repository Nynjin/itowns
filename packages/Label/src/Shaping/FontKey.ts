import { Label } from '../Label';

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

export function fontKeyOf(label: Label): FontKey {
    const parsed = parseFontString(label.font);
    return {
        font: parsed.font,
        // Explicit label properties override what was parsed from the font string
        weight: label.fontWeight !== 'normal' ? label.fontWeight : parsed.weight,
        style: label.fontStyle !== 'normal' ? label.fontStyle : parsed.style,
    };
}

export function fontKeyString(key: FontKey): string {
    return `${key.font}|${key.weight}|${key.style}`;
}
