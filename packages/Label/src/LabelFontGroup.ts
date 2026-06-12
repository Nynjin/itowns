
import { Label, LabelChangeType } from './Label';
import { FontKey, fontKeyString } from './Shaping/FontKey';
import { SDFAtlas } from './Shaping/SDFAtlas';
import { applyShaping } from './Shaping/RTL';
import { LabelManagerConfig } from './Types/LabelConfig';

export const enum DirtyLevel {
    None = 0,
    StyleUpdate = 1,
    LayoutUpdate = 2,
    Add = 3,
    Dispose = 4,
    ChangeGroup = 5,
}

export class LabelFontGroup {
    readonly key: FontKey;
    readonly labels: Set<Label> = new Set<Label>();
    readonly dirty: Map<Label, DirtyLevel> = new Map<Label, DirtyLevel>();

    private atlas: SDFAtlas | null = null;
    private uniqueChars = new Set<string>();
    private _charsDirty = false;
    private _listeners = new Set<() => void>();
    private _unsubs = new Map<Label, () => void>();
    private readonly _config: LabelManagerConfig;

    constructor(key: FontKey, config: LabelManagerConfig) {
        this.key = key;
        this._config = config;
        // Fallback char and space should always be present
        this.uniqueChars.add('?').add(' ');
    }

    private _recomputeUniqueChars(): boolean {
        const next = new Set<string>().add('?').add(' ');
        for (const label of this.labels) {
            for (const c of applyShaping(label.getDisplayText())) next.add(c);
        }
        if (next.size === this.uniqueChars.size) {
            let changed = false;
            for (const c of next) if (!this.uniqueChars.has(c)) { changed = true; break; }
            if (!changed) return false;
        }
        this.uniqueChars = next;
        return true;
    }

    private _addChars(label: Label): boolean {
        let newChars = false;
        for (const c of applyShaping(label.getDisplayText())) {
            if (!this.uniqueChars.has(c)) { this.uniqueChars.add(c); newChars = true; }
        }
        return newChars;
    }

    addLabel(label: Label) { this.addLabels([label]); }

    addLabels(labels: Label[]) {
        for (const label of labels) {
            if (this.labels.has(label)) {
                console.warn(`Label already exists in group for font ${fontKeyString(this.key)}`);
                continue;
            }
            if (this._addChars(label)) {
                this._charsDirty = true;
            }
            this.labels.add(label);
            this._markDirty(label, DirtyLevel.Add);

            const unsub = label.onChange((changes) => {
                if (changes & LabelChangeType.Font) {
                    this.removeLabel(label);
                    this._markDirty(label, DirtyLevel.ChangeGroup);
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
                    if (this._addChars(label)) {
                        this._charsDirty = true;
                    }
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

        if (this.dirty.size > 0) {
            this._emit();
        }
    }

    removeLabel(label: Label) {
        this.removeLabels([label]);
    }

    removeLabels(labels: Label[]) {
        for (const label of labels) {
            if (!this.labels.delete(label)) {
                console.warn(`Label ${label.id} not found in group for font ${fontKeyString(this.key)}`);
                continue;
            }
            this._unsubs.get(label)?.();
            this._unsubs.delete(label);

            this.dirty.delete(label);
            this._markDirty(label, DirtyLevel.Dispose);
            this._charsDirty = true;
        }
        if (this.dirty.size > 0) {
            this._emit();
        }
    }

    /**
     * Returns the current atlas, creating or updating it if needed.
     * @returns atlas state
     */
    getAtlas(): { atlas: SDFAtlas; dirty: boolean; resized: boolean } {
        if (this._charsDirty) {
            this._recomputeUniqueChars();
            this._charsDirty = false;
        }
        const atlasOptions = {
            fontSize: this._config.baseFontSize,
            scale: this._config.sdfScale,
            capacityMultiplier: this._config.sdfCapacityMultiplier,
        };
        if (!this.atlas) {
            this.atlas = new SDFAtlas([...this.uniqueChars], this.key, atlasOptions);
            return { atlas: this.atlas, dirty: true, resized: false };
        }
        const { dirty, resize } = this.atlas.addChars(this.uniqueChars);
        return { atlas: this.atlas, dirty, resized: resize };
    }

    dispose() {
        this._unsubs.forEach(unsub => unsub());
        this._unsubs.clear();
        this.labels.clear();
        this.dirty.clear();
        this.atlas?.dispose();
        this.atlas = null;
        this.uniqueChars.clear();
        this._listeners.clear();
    }

    onChange(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    flushDirty() {
        this.dirty.clear();
    }

    flushDirtyFor(labels: Iterable<Label>) {
        for (const label of labels) this.dirty.delete(label);
    }

    private _markDirty(labels: Label, level: DirtyLevel) {
        if (level > (this.dirty.get(labels) ?? DirtyLevel.None)) {
            this.dirty.set(labels, level);
        }
    }

    private _emit() {
        for (const listener of this._listeners) listener();
    }
}
