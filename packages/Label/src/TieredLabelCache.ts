import { LabelCache } from './LabelCache';
import type { Label } from './Label';

/**
 * The subset of a label manager that {@link TieredLabelCache} needs. Both
 * InstancedLabelManager and InstancedLabelManagerAsync satisfy it structurally.
 */
export interface LabelStore {
    /** Register labels: allocate GPU slots, upload, add to collision. */
    addLabels(labels: Label[]): void;
    /** Unregister labels: free GPU slots, remove from collision. */
    removeLabels(labels: Label[]): void;
}

/**
 * A generic, tiered cache for sets of labels whose owner (e.g. a tile) has gone
 * out of view but may return. It is deliberately independent of tiles, geography
 * or any host app: a caller keys a label set by an arbitrary string and supplies
 * how to read the labels out of the cached value, so it works for tile sets,
 * per-label singletons, or anything else.
 *
 * Three tiers, in cost order:
 *   1. **Hot** — labels stay registered in the store (GPU slots resident) but
 *      hidden via `groupVisible = false`. Restore is a visibility flip: zero GPU
 *      work. Small capacity — the "instant revisit" set.
 *   2. **Cold** — when a set falls out of the hot tier it is demoted: its labels
 *      are `removeLabels`'d (GPU slots freed) but the label objects are kept
 *      (they still hold their shaped glyphs, so no re-layout on return). Restore
 *      re-registers them (`addLabels`) — one upload, no re-shape. Larger
 *      capacity — cheap CPU objects, bounded GPU memory.
 *   3. **Deleted** — evicted from the cold tier; the objects are dropped (their
 *      GPU slots were already freed on demotion).
 *
 * @template T - the cached value type (e.g. a Map of source→label, or Label[]).
 */
export class TieredLabelCache<T> {
    #store: LabelStore;
    #getLabels: (entry: T) => Label[];
    #hot: LabelCache<T>;
    #cold: LabelCache<T>;

    /**
     * @param store - the label manager used to free/re-register cold sets.
     * @param getLabels - reads the label list out of a cached value.
     * @param hotCapacity - max resident (GPU-warm) sets; 0 sends every park
     * straight to cold.
     * @param coldCapacity - max freed-but-cached sets before true deletion.
     */
    constructor(
        store: LabelStore,
        getLabels: (entry: T) => Label[],
        hotCapacity: number,
        coldCapacity: number,
    ) {
        this.#store = store;
        this.#getLabels = getLabels;

        // Cold eviction = true delete. The labels were already removeLabels'd on
        // demotion, so there is nothing to free here — just let them be dropped.
        this.#cold = new LabelCache<T>(coldCapacity, () => { /* GC */ });

        // Hot eviction = demote to cold: free GPU slots, keep the objects.
        this.#hot = new LabelCache<T>(hotCapacity, (entry, key) => {
            this.#store.removeLabels(this.#getLabels(entry));
            this.#cold.put(key, entry);
        });
    }

    /**
     * @param key - the label-set key.
     * @returns true if the set is cached in either tier.
     */
    has(key: string): boolean {
        return this.#hot.has(key) || this.#cold.has(key);
    }

    /**
     * Park a label set whose owner just unloaded: hide its labels (kept
     * resident) and place it in the hot tier. Overflowing the hot tier demotes
     * the oldest set to cold; overflowing cold deletes the oldest.
     * @param key - the label-set key.
     * @param entry - the cached value.
     */
    park(key: string, entry: T): void {
        for (const label of this.#getLabels(entry)) { label.groupVisible = false; }
        this.#hot.put(key, entry);
    }

    /**
     * Restore a previously-parked label set, or null if not cached. Hot sets are
     * shown with a visibility flip; cold sets are re-registered (one upload).
     * The returned value is removed from the cache — the caller owns it again.
     * @param key - the label-set key.
     * @returns the cached value, or null when absent.
     */
    restore(key: string): T | null {
        const hot = this.#hot.take(key);
        if (hot !== undefined) {
            for (const label of this.#getLabels(hot)) { label.groupVisible = true; }
            return hot;
        }
        const cold = this.#cold.take(key);
        if (cold !== undefined) {
            const labels = this.#getLabels(cold);
            for (const label of labels) { label.groupVisible = true; }
            this.#store.addLabels(labels);
            return cold;
        }
        return null;
    }

    /**
     * Drop every cached set. Hot sets are still registered, so they are
     * unregistered from the store; cold sets were already freed on demotion.
     */
    clear(): void {
        for (const entry of this.#hot.takeAll()) {
            this.#store.removeLabels(this.#getLabels(entry));
        }
        this.#cold.takeAll();
    }

    /** @returns number of resident (hot) sets — GPU slots held. */
    get hotSize(): number { return this.#hot.size; }

    /** @returns number of freed-but-cached (cold) sets. */
    get coldSize(): number { return this.#cold.size; }
}
