
import { Label, LabelChangeType } from './Label';
import { SDFAtlas, FontChars } from './Shaping/SDFAtlas';
import { applyShaping } from './Shaping/RTL';
import { LabelManagerConfig } from './Types/LabelConfig';
import { FontKey } from './Shaping/FontKey';

export const enum DirtyLevel {
    None = 0,
    StyleUpdate = 1,
    LayoutUpdate = 2,
    Add = 3,
    Dispose = 4,
    ChangeGroup = 5,
}

export class LabelAtlasManager {
    readonly labels: Set<Label> = new Set<Label>();
    readonly dirty: Map<Label, DirtyLevel> = new Map<Label, DirtyLevel>();

    private _atlas: SDFAtlas | null = null;
    /**
     * Tracks which chars are needed per font variant.
     * Key: fontKeyStr(fontKey), Value: the FontKey + the char set for that font.
     * Atlas slots are never reclaimed — the set only grows.
     */
    private _fontCharsMap = new Map<string, { fontKey: FontKey; chars: Set<string> }>();
    private _charsDirty = false;
    private _listeners = new Set<() => void>();
    private _unsubs = new Map<Label, () => void>();
    private readonly _config: LabelManagerConfig;

    constructor(config: LabelManagerConfig) {
        this._config = config;
    }

    // ── Char tracking ─────────────────────────────────────────────────────────

    private _addCharsFromLabel(label: Label): boolean {
        const fk = label.fontKey;
        const fkStr = label.fontKeyString;
        let entry = this._fontCharsMap.get(fkStr);
        if (!entry) {
            // New font variant — seed with mandatory fallback glyphs.
            entry = { fontKey: fk, chars: new Set(['?', ' ']) };
            this._fontCharsMap.set(fkStr, entry);
        }
        let newChars = false;
        for (const c of applyShaping(label.getDisplayText())) {
            if (!entry.chars.has(c)) { entry.chars.add(c); newChars = true; }
        }
        return newChars;
    }

    // ── Label management ──────────────────────────────────────────────────────

    addLabel(label: Label) { this.addLabels([label]); }

    addLabels(labels: Label[]) {
        for (const label of labels) {
            if (this.labels.has(label)) {
                console.warn(`Label ${label.id} with text "${label.getDisplayText()}" already exists`);
                continue;
            }
            if (this._addCharsFromLabel(label)) this._charsDirty = true;
            this.labels.add(label);
            this._markDirty(label, DirtyLevel.Add);

            const unsub = label.onChange((changes) => {
                if (changes & LabelChangeType.Font) {
                    // Font changed — add new font's chars and re-layout in place.
                    // No cross-group move needed with a single shared group.
                    if (this._addCharsFromLabel(label)) this._charsDirty = true;
                    this._markDirty(label, DirtyLevel.LayoutUpdate);
                    this._emit();
                    return;
                }
                if (changes & LabelChangeType.Dispose) {
                    this.removeLabel(label);
                    this._markDirty(label, DirtyLevel.Dispose);
                    this._emit();
                    return;
                }
                if (changes & LabelChangeType.Text) {
                    if (this._addCharsFromLabel(label)) this._charsDirty = true;
                    this._markDirty(label, DirtyLevel.LayoutUpdate);
                }
                if (changes & (LabelChangeType.Layout | LabelChangeType.Transform)) {
                    this._markDirty(label, DirtyLevel.LayoutUpdate);
                }
                if (changes & (LabelChangeType.Style | LabelChangeType.Visibility)) {
                    this._markDirty(label, DirtyLevel.StyleUpdate);
                }
                this._emit();
            });
            this._unsubs.set(label, unsub);
        }
        if (this.dirty.size > 0) this._emit();
    }

    removeLabel(label: Label) { this.removeLabels([label]); }

    removeLabels(labels: Label[]) {
        for (const label of labels) {
            if (!this.labels.delete(label)) {
                console.warn(`Label ${label.id} not found in group`);
                continue;
            }
            this._unsubs.get(label)?.();
            this._unsubs.delete(label);
            this.dirty.delete(label);
            this._markDirty(label, DirtyLevel.Dispose);
            // Note: we do NOT shrink _fontCharsMap — atlas slots are permanent.
        }
        if (this.dirty.size > 0) this._emit();
    }

    // ── Atlas access ──────────────────────────────────────────────────────────

    /**
     * Returns the current atlas, rasterizing any newly-seen glyphs if needed.
     */
    getAtlas(): { atlas: SDFAtlas; dirty: boolean; resized: boolean } {
        const atlasOptions = {
            fontSize: this._config.baseFontSize,
            scale: this._config.sdfScale,
            capacityMultiplier: this._config.sdfCapacityMultiplier,
        };
        if (!this._atlas) {
            this._atlas = new SDFAtlas(atlasOptions);
            this._charsDirty = true; // must populate on first creation
        }
        if (!this._charsDirty) {
            return { atlas: this._atlas, dirty: false, resized: false };
        }
        this._charsDirty = false;
        const fontCharsArray: FontChars[] = [...this._fontCharsMap.values()];
        const { dirty, resize } = this._atlas.setChars(fontCharsArray);
        return { atlas: this._atlas, dirty, resized: resize };
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    dispose() {
        this._unsubs.forEach(unsub => unsub());
        this._unsubs.clear();
        this.labels.clear();
        this.dirty.clear();
        this._atlas?.dispose();
        this._atlas = null;
        this._fontCharsMap.clear();
        this._listeners.clear();
    }

    onChange(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    flushDirty() { this.dirty.clear(); }

    flushDirtyFor(labels: Iterable<Label>) {
        for (const label of labels) this.dirty.delete(label);
    }

    /** The font variants currently tracked — needed by the async manager to send per-font glyph maps to the worker. */
    get fontVariants(): ReadonlyArray<{ fkStr: string; fontKey: FontKey }> {
        return [...this._fontCharsMap.entries()].map(([fkStr, { fontKey }]) => ({ fkStr, fontKey }));
    }

    private _markDirty(label: Label, level: DirtyLevel) {
        if (level > (this.dirty.get(label) ?? DirtyLevel.None)) {
            this.dirty.set(label, level);
        }
    }

    private _emit() {
        for (const listener of this._listeners) listener();
    }
}
