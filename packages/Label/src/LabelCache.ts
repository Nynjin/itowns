/**
 * A bounded, insertion-ordered (LRU) cache for keyed values.
 *
 * Generic and self-contained — it has no knowledge of tiles, labels, the GPU
 * or the scene graph. Callers choose what a key and a value mean (e.g. a tile
 * id → that tile's label set), so the same cache serves tile-grouped or
 * per-label use without a mode switch.
 *
 * Values are released through the `onEvict` callback when capacity is exceeded
 * (oldest first) or {@link LabelCache.clear} is called. Entries removed via
 * {@link LabelCache.take} (or drained via {@link LabelCache.takeAll}) are handed
 * to the caller and are NOT evicted — the caller owns them from then on. The
 * evicted key is passed to `onEvict` so callers can, for example, demote an
 * over-capacity entry into a second cache under the same key.
 *
 * @template T - the stored value type.
 */
export class LabelCache<T> {
    #map = new Map<string, T>();
    #capacity: number;
    #onEvict: (value: T, key: string) => void;

    /**
     * @param capacity - maximum number of entries; `put` evicts the oldest
     * beyond this. Use `Infinity` for an unbounded cache.
     * @param onEvict - called with the value AND key of every entry dropped by
     * capacity eviction or `clear` (not by `take`/`takeAll`). Release or demote
     * resources here.
     */
    constructor(capacity: number, onEvict: (value: T, key: string) => void) {
        this.#capacity = capacity;
        this.#onEvict = onEvict;
    }

    /**
     * @param key - the lookup key.
     * @returns true if `key` has a stored value.
     */
    has(key: string): boolean {
        return this.#map.has(key);
    }

    /**
     * Remove and return the value for `key`, transferring ownership to the
     * caller (no `onEvict`).
     * @param key - the key to take.
     * @returns the stored value, or undefined when absent.
     */
    take(key: string): T | undefined {
        const value = this.#map.get(key);
        if (value !== undefined) {
            this.#map.delete(key);
        }
        return value;
    }

    /**
     * Store `value` under `key` as the most-recently-used entry, evicting the
     * oldest entries (via `onEvict`) while over capacity.
     * @param key - the key to store under.
     * @param value - the value to store.
     */
    put(key: string, value: T): void {
        // Re-inserting moves the key to the end (most-recently-used).
        this.#map.delete(key);
        this.#map.set(key, value);
        while (this.#map.size > this.#capacity) {
            const oldestKey = this.#map.keys().next().value as string;
            const oldest = this.#map.get(oldestKey) as T;
            this.#map.delete(oldestKey);
            this.#onEvict(oldest, oldestKey);
        }
    }

    /**
     * Remove and return every value without invoking `onEvict`, leaving the
     * cache empty. Use when the caller will dispose the values itself (e.g. a
     * teardown that must not trigger demotion side-effects).
     * @returns all stored values, in insertion order.
     */
    takeAll(): T[] {
        const all = [...this.#map.values()];
        this.#map.clear();
        return all;
    }

    /** Evict every entry (each through `onEvict`) and empty the cache. */
    clear(): void {
        this.#map.forEach((value, key) => this.#onEvict(value, key));
        this.#map.clear();
    }

    /** @returns the current number of stored entries. */
    get size(): number {
        return this.#map.size;
    }
}
