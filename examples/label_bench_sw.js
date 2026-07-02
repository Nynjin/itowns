// Benchmark service worker — per-MODE cold cache.
//
// Goal: every benchmark mode (iTowns None / 3D / DOM, MapLibre no-labels / labels)
// starts from a COLD tile cache, but WITHIN a mode tiles cache normally (a real
// session). So the page clears this worker's cache before each mode; the first
// fetch of any tile in a mode goes to the network (bypassing the browser HTTP cache
// via `no-store`), then is served from the worker cache for the rest of that mode.
//
// This holds the dataset identical and the starting condition identical (cold) for
// every mode, so no mode free-rides on another's cached tiles — without mangling
// URLs (cross-origin CORS / <img> textures keep working).

const CACHE = 'bench-cold-v1';

// Map data both engines fetch: raster/vector tiles, glyphs, sprites, TileJSON —
// matched by host or by path/extension. Broad but map-specific so we never disturb
// the app's own scripts/styles/config.
const MAP_DATA = /(pole-emploi\.fr|cartocdn\.com|basemaps\.|geopf\.fr|\.pbf(\?|$)|\.mvt(\?|$)|\/\d+\/\d+\/\d+\.(png|jpg|webp)(\?|$)|\/glyphs?\/|\/sprite)/i;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || !MAP_DATA.test(req.url)) { return; }
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req);
        if (hit) { return hit; }                                  // warm within a mode
        // Cold: bypass the browser HTTP cache so it's a real network fetch, then
        // store in the worker cache for the rest of this mode.
        const res = await fetch(req, { cache: 'no-store' }).catch(() => fetch(req));
        try { await cache.put(req, res.clone()); } catch (e) { /* opaque/uncacheable */ }
        return res;
    })());
});

// Page → SW: wipe the cache so the NEXT mode starts cold. Replies via the port.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'CLEAR_BENCH_CACHE') {
        event.waitUntil((async () => {
            await caches.delete(CACHE);
            if (event.ports && event.ports[0]) { event.ports[0].postMessage({ ok: true }); }
        })());
    }
});
