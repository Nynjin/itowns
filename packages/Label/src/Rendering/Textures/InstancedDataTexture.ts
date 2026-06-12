import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';

const FLOATS_PER_TEXEL = 4; // RGBA

export interface ItemAllocation {
    key: string;
    /** Raw floats: itemCount × texelsPerItem × 4. Empty Float32Array = no-op for add, removal for update. */
    flatItems: Float32Array;
}

/**
 * Manages a growable square Float32 DataTexture whose rows are allocated
 * to keyed items. Each item occupies a fixed number of consecutive texels.
 * Free slots are recycled; the texture only grows, never shrinks.
 */
export class InstancedDataTexture {
    private _data: Float32Array = new Float32Array(0);
    private _texture: DataTexture = new DataTexture();
    private _width = 1;
    private _itemCapacity = 0;
    private _usedSlots = 0;

    /** key → texel-unit indices, one per item slot (length = number of items for that key). */
    private _keyToIndices = new Map<string, number[]>();
    /** Stack of free texel-unit indices. */
    private _freeSlots: number[] = [];

    readonly texelsPerItem: number;
    private readonly _floatsPerItem: number;
    private readonly _maxTextureWidth: number;
    private readonly _capacityMultiplier: number;

    get texture()   { return this._texture; }
    get width()     { return this._width; }
    get capacity()  { return this._itemCapacity; }
    get usedSlots() { return this._usedSlots; }

    constructor(
        texelsPerItem: number,
        maxTexWidth: number,
        capacityMultiplier: number,
    ) {
        this.texelsPerItem        = texelsPerItem;
        this._floatsPerItem       = texelsPerItem * FLOATS_PER_TEXEL;
        this._maxTextureWidth     = maxTexWidth;
        this._capacityMultiplier  = capacityMultiplier;
    }

    // ─── Queries ───────────────────────────────────────────────────────────────

    getKeys(): string[] {
        return [...this._keyToIndices.keys()];
    }

    getAllTexelIndices(): number[] {
        const out: number[] = [];
        for (const indices of this._keyToIndices.values()) out.push(...indices);
        return out;
    }

    getTexelIndicesOf(key: string): number[] | undefined {
        return this._keyToIndices.get(key);
    }

    getFirstTexelIdxOf(key: string): number | undefined {
        return this._keyToIndices.get(key)?.[0];
    }

    // ─── Mutations ─────────────────────────────────────────────────────────────

    addToKey(alloc: ItemAllocation)  { this.addToKeys([alloc]); }
    updateKey(alloc: ItemAllocation) { this.updateKeys([alloc]); }
    removeKey(key: string)           { this.removeKeys([key]); }

    /**
     * Overwrite a contiguous sub-range of floats within the first slot of a
     * keyed item without touching the rest of its data.  Used for style-only
     * updates that only need to patch a subset of texels (e.g. T2-T5 colour /
     * halo data) while leaving T0/T1 position/rotation unchanged.
     *
     * @param key        - allocation key
     * @param floatOffset - float offset from the start of the item's allocation
     * @param src        - floats to write (src.length must fit within the item)
     */
    patchFirstKey(key: string, floatOffset: number, src: Float32Array): void {
        const indices = this._keyToIndices.get(key);
        if (!indices || indices.length === 0) return;
        this._data.set(src, indices[0] * FLOATS_PER_TEXEL + floatOffset);
        this._texture.needsUpdate = true;
    }

    addToKeys(allocations: ItemAllocation[]) {
        // Pre-resize once for the whole batch.
        let totalNew = 0;
        for (const { flatItems } of allocations) {
            if (!this._validate(flatItems)) continue;
            totalNew += flatItems.length / this._floatsPerItem;
        }
        if (this._usedSlots + totalNew > this._itemCapacity) {
            this._resize(this._usedSlots + totalNew);
        }
        for (const alloc of allocations) {
            if (alloc.flatItems.length === 0) continue;
            if (!this._validate(alloc.flatItems)) continue;
            this._addRaw(alloc.key, alloc.flatItems);
        }
        this._texture.needsUpdate = true;
    }

    updateKeys(allocations: ItemAllocation[]) {
        // First pass: overwrite / shrink existing slots, collect overflow to insert.
        const toInsert: ItemAllocation[] = [];
        for (const alloc of allocations) {
            if (!this._validate(alloc.flatItems)) continue;
            const overflow = this._updateRaw(alloc.key, alloc.flatItems);
            if (overflow) toInsert.push(overflow);
        }
        // Second pass: insert overflow items (may need resize).
        if (toInsert.length > 0) {
            let totalNew = 0;
            for (const { flatItems } of toInsert) totalNew += flatItems.length / this._floatsPerItem;
            if (this._usedSlots + totalNew > this._itemCapacity) {
                this._resize(this._usedSlots + totalNew);
            }
            for (const alloc of toInsert) this._addRaw(alloc.key, alloc.flatItems);
        }
        this._texture.needsUpdate = true;
    }

    removeKeys(keys: string[]) {
        for (const key of keys) this._removeRaw(key);
        this._texture.needsUpdate = true;
    }

    dispose() {
        this._texture.dispose();
    }

    // ─── Private: raw operations (no needsUpdate, no resize) ──────────────────

    /**
     * Append all items in flatItems under key.
     * Caller must ensure capacity before calling.
     * @param key - allocation key
     * @param flatItems - packed float data (itemCount × floatsPerItem)
     */
    private _addRaw(key: string, flatItems: Float32Array) {
        const itemCount = flatItems.length / this._floatsPerItem;
        const indices = this._keyToIndices.get(key) ?? [];

        for (let i = 0; i < itemCount; i++) {
            const slot = this._freeSlots.pop();
            if (slot === undefined) throw new Error('InstancedDataTexture: no free slots (resize failed)');
            this._write(slot, flatItems, i * this._floatsPerItem);
            indices.push(slot);
        }

        this._keyToIndices.set(key, indices);
        this._usedSlots += itemCount;
    }

    /**
     * Overwrite common slots, free excess, return overflow (new > old) as
     * a zero-copy subarray allocation for the caller to insert.
     * @param key - allocation key
     * @param flatItems - packed float data (itemCount × floatsPerItem)
     * @returns overflow allocation to insert, or null if no growth needed
     */
    private _updateRaw(key: string, flatItems: Float32Array): ItemAllocation | null {
        const existing = this._keyToIndices.get(key) ?? [];
        const newCount = flatItems.length / this._floatsPerItem;
        const oldCount = existing.length;
        const common   = Math.min(newCount, oldCount);

        // Overwrite slots that exist in both old and new.
        for (let i = 0; i < common; i++) {
            this._write(existing[i], flatItems, i * this._floatsPerItem);
        }

        // Free excess old slots.
        for (let i = common; i < oldCount; i++) {
            this._clear(existing[i]);
            this._freeSlots.push(existing[i]);
        }
        existing.length = common;
        this._usedSlots -= (oldCount - common);

        if (newCount === 0) {
            this._keyToIndices.delete(key);
            return null;
        }
        this._keyToIndices.set(key, existing);

        if (newCount > oldCount) {
            // Return the tail as a subarray — zero-copy, valid for this call.
            return {
                key,
                flatItems: flatItems.subarray(common * this._floatsPerItem),
            };
        }
        return null;
    }

    private _removeRaw(key: string) {
        const indices = this._keyToIndices.get(key);
        // Absent key is a valid no-op: with async layout a label can be removed
        // from the glyph buffer before its glyphs were ever written.
        if (!indices) {
            return;
        }
        for (const slot of indices) {
            this._freeSlots.push(slot);
        }
        this._keyToIndices.delete(key);
        this._usedSlots -= indices.length;
    }

    // ─── Private: typed-array primitives ──────────────────────────────────────

    /**
     * Copy floatsPerItem floats from src[srcOffset..] into _data at texel slot.
     * @param texelSlot - destination texel index
     * @param src - source float array
     * @param srcOffset - byte offset into src
     */
    private _write(texelSlot: number, src: Float32Array, srcOffset: number) {
        this._data.set(
            src.subarray(srcOffset, srcOffset + this._floatsPerItem),
            texelSlot * FLOATS_PER_TEXEL,
        );
    }

    /**
     * Zero out the floats for one item slot.
     * @param texelSlot - texel index of the slot to clear
     */
    private _clear(texelSlot: number) {
        this._data.fill(
            0,
            texelSlot * FLOATS_PER_TEXEL,
            (texelSlot + this.texelsPerItem) * FLOATS_PER_TEXEL,
        );
    }

    private _validate(flatItems: Float32Array): boolean {
        if (flatItems.length === 0) return true;
        if (flatItems.length % this._floatsPerItem !== 0) {
            console.warn(
                `InstancedDataTexture: float count ${flatItems.length} is not a multiple of ${this._floatsPerItem} (${this.texelsPerItem} texels × 4)`,
            );
            return false;
        }
        return true;
    }

    // ─── Private: capacity / texture ──────────────────────────────────────────

    private _resize(needed: number) {
        const newWidth   = this._calcWidth(needed);
        const texelCount = newWidth * newWidth;
        const newData    = new Float32Array(texelCount * FLOATS_PER_TEXEL);
        newData.set(this._data);
        this._data  = newData;
        this._width = newWidth;

        const oldCap = this._itemCapacity;
        const newCap = Math.floor(texelCount / this.texelsPerItem);
        // Direct index assignment is faster than push() for large batches.
        for (let i = oldCap; i < newCap; i++) {
            this._freeSlots[this._freeSlots.length] = i * this.texelsPerItem;
        }
        this._itemCapacity = newCap;
        this._regenerateTexture();
    }

    private _calcWidth(needed: number): number {
        const texelCapacity = Math.ceil(needed * this.texelsPerItem * this._capacityMultiplier);
        if (texelCapacity === 0) return 1;
        const w = Math.ceil(Math.sqrt(texelCapacity));
        if (w > this._maxTextureWidth) {
            console.warn(`InstancedDataTexture: width ${w} exceeds max ${this._maxTextureWidth}`);
        }
        return w;
    }

    private _regenerateTexture() {
        this._texture.dispose();
        this._texture = new DataTexture(this._data, this._width, this._width, RGBAFormat, FloatType);
        this._texture.minFilter = NearestFilter;
        this._texture.magFilter = NearestFilter;
        this._texture.needsUpdate = true;
    }
}
