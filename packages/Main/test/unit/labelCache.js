import assert from 'assert';
import { LabelCache } from '@itowns/labels';

describe('LabelCache', function () {
    it('stores and retrieves by key (take transfers ownership, no evict)', function () {
        const evicted = [];
        const cache = new LabelCache(4, v => evicted.push(v));

        cache.put('a', 1);
        assert.ok(cache.has('a'));
        assert.strictEqual(cache.size, 1);

        assert.strictEqual(cache.take('a'), 1);
        assert.ok(!cache.has('a'));
        assert.strictEqual(cache.size, 0);
        // take() hands the value to the caller — it must not be evicted.
        assert.deepStrictEqual(evicted, []);
    });

    it('returns undefined for a missing key', function () {
        const cache = new LabelCache(2, () => {});
        assert.strictEqual(cache.take('missing'), undefined);
        assert.ok(!cache.has('missing'));
    });

    it('evicts the oldest entry (LRU) when over capacity, with its key', function () {
        const evicted = [];
        const cache = new LabelCache(2, (v, k) => evicted.push([k, v]));

        cache.put('a', 'A');
        cache.put('b', 'B');
        cache.put('c', 'C'); // over capacity → oldest 'a' evicted

        assert.deepStrictEqual(evicted, [['a', 'A']]);
        assert.ok(!cache.has('a'));
        assert.ok(cache.has('b'));
        assert.ok(cache.has('c'));
        assert.strictEqual(cache.size, 2);
    });

    it('takeAll() drains without invoking onEvict', function () {
        const evicted = [];
        const cache = new LabelCache(4, v => evicted.push(v));
        cache.put('a', 'A');
        cache.put('b', 'B');

        assert.deepStrictEqual(cache.takeAll(), ['A', 'B']);
        assert.strictEqual(cache.size, 0);
        assert.deepStrictEqual(evicted, []); // takeAll must NOT evict
    });

    it('re-inserting a key promotes it to most-recently-used', function () {
        const evicted = [];
        const cache = new LabelCache(2, v => evicted.push(v));

        cache.put('a', 'A');
        cache.put('b', 'B');
        cache.put('a', 'A2'); // 'a' becomes newest → 'b' is now oldest
        cache.put('c', 'C');  // evicts oldest 'b', not 'a'

        assert.deepStrictEqual(evicted, ['B']);
        assert.ok(cache.has('a'));
        assert.ok(!cache.has('b'));
        assert.ok(cache.has('c'));
    });

    it('clear() evicts every entry and empties the cache', function () {
        const evicted = [];
        const cache = new LabelCache(4, v => evicted.push(v));

        cache.put('a', 'A');
        cache.put('b', 'B');
        cache.clear();

        assert.deepStrictEqual(evicted.sort(), ['A', 'B']);
        assert.strictEqual(cache.size, 0);
        assert.ok(!cache.has('a'));
    });

    it('supports an unbounded (Infinity) capacity', function () {
        const evicted = [];
        const cache = new LabelCache(Infinity, v => evicted.push(v));
        for (let i = 0; i < 1000; i++) { cache.put(`k${i}`, i); }
        assert.strictEqual(cache.size, 1000);
        assert.deepStrictEqual(evicted, []);
    });
});
