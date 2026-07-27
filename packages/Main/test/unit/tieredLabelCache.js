import assert from 'assert';
import { TieredLabelCache } from '@itowns/labels';

// Minimal fakes: the cache only reads/writes `groupVisible` on labels and hands
// label lists to store.add/removeLabels — no GPU needed.
function makeLabel() { return { groupVisible: true }; }
function makeStore() {
    const store = {
        added: [],
        removed: [],
        addLabels(labels) { store.added.push(labels); },
        removeLabels(labels) { store.removed.push(labels); },
    };
    return store;
}
const identity = e => e; // cached value IS the label array

describe('TieredLabelCache', function () {
    it('park hides labels and holds them resident (hot)', function () {
        const store = makeStore();
        const cache = new TieredLabelCache(store, identity, 4, 8);
        const set = [makeLabel(), makeLabel()];

        cache.park('t1', set);

        assert.ok(set.every(l => l.groupVisible === false)); // hidden
        assert.strictEqual(cache.hotSize, 1);
        assert.strictEqual(cache.coldSize, 0);
        assert.deepStrictEqual(store.removed, []); // resident, not freed
        assert.ok(cache.has('t1'));
    });

    it('restore from hot is a visibility flip (no store calls)', function () {
        const store = makeStore();
        const cache = new TieredLabelCache(store, identity, 4, 8);
        const set = [makeLabel()];
        cache.park('t1', set);

        const restored = cache.restore('t1');

        assert.strictEqual(restored, set);
        assert.ok(set.every(l => l.groupVisible === true)); // shown
        assert.deepStrictEqual(store.added, []);   // hot restore uploads nothing
        assert.deepStrictEqual(store.removed, []);
        assert.ok(!cache.has('t1')); // taken out — caller owns it again
    });

    it('overflowing hot demotes the oldest set to cold (frees GPU)', function () {
        const store = makeStore();
        const cache = new TieredLabelCache(store, identity, 1, 8); // hot cap = 1
        const a = [makeLabel()];
        const b = [makeLabel()];

        cache.park('a', a);
        cache.park('b', b); // 'a' demoted to cold

        assert.strictEqual(cache.hotSize, 1);
        assert.strictEqual(cache.coldSize, 1);
        assert.deepStrictEqual(store.removed, [a]); // 'a' freed on demotion
        assert.ok(cache.has('a')); // still cached, just cold
        assert.ok(cache.has('b'));
    });

    it('restore from cold re-registers the set (one upload)', function () {
        const store = makeStore();
        const cache = new TieredLabelCache(store, identity, 1, 8);
        const a = [makeLabel()];
        const b = [makeLabel()];
        cache.park('a', a);
        cache.park('b', b); // 'a' -> cold (removed)

        const restored = cache.restore('a');

        assert.strictEqual(restored, a);
        assert.deepStrictEqual(store.added, [a]); // cold restore re-uploads
        assert.ok(a.every(l => l.groupVisible === true));
        assert.ok(!cache.has('a'));
    });

    it('overflowing cold truly deletes (no extra store calls)', function () {
        const store = makeStore();
        const cache = new TieredLabelCache(store, identity, 0, 1); // hot=0 → straight to cold
        const a = [makeLabel()];
        const b = [makeLabel()];

        cache.park('a', a); // hot=0 → demote immediately to cold; removed
        cache.park('b', b); // cold cap 1 → 'a' deleted (already freed), 'b' cold

        assert.deepStrictEqual(store.removed, [a, b]); // both freed on demotion
        assert.strictEqual(store.added.length, 0);
        assert.ok(!cache.has('a')); // deleted
        assert.ok(cache.has('b'));
        assert.strictEqual(cache.coldSize, 1);
    });

    it('clear() frees hot sets and drops cold sets', function () {
        const store = makeStore();
        const cache = new TieredLabelCache(store, identity, 1, 8); // hot cap = 1
        const g1 = [makeLabel()];
        const g2 = [makeLabel()];
        cache.park('g1', g1); // hot
        cache.park('g2', g2); // g1 demoted to cold (removed once)
        store.removed.length = 0; // ignore the demotion removal

        cache.clear();

        // g2 was hot (registered) → removed; g1 was cold (already freed) → dropped.
        assert.deepStrictEqual(store.removed, [g2]);
        assert.ok(!cache.has('g1'));
        assert.ok(!cache.has('g2'));
        assert.strictEqual(cache.hotSize, 0);
        assert.strictEqual(cache.coldSize, 0);
    });

    it('works with a non-array cached value (generic getLabels)', function () {
        const store = makeStore();
        // Cached value is a Map<key, label> — like a tile's source→label map.
        const cache = new TieredLabelCache(store, m => [...m.values()], 4, 8);
        const l = makeLabel();
        const map = new Map([['src', l]]);

        cache.park('tile', map);
        assert.strictEqual(l.groupVisible, false);
        const restored = cache.restore('tile');
        assert.strictEqual(restored, map);
        assert.strictEqual(l.groupVisible, true);
    });
});
