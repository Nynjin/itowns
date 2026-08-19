/**
 * Priority-ordering strategy for the collision pass.
 *   'bucket' — O(n) depth-bucket scatter (approximate within a bucket)
 *   'radix'  — O(n·d) LSD radix sort (exact order, no comparisons)
 * The full O(n log n) comparison sort is intentionally not offered here.
 */
export type SortMethod = 'bucket' | 'radix';

/**
 * Screen-occupancy structure used to test/claim placed label footprints.
 *   'grid'    — uniform hash grid over exact AABBs (no rasterisation, AABB only)
 *   'bitmap'  — flat packed-bit raster (count-based, supports occlusion tolerance)
 *   'pyramid' — binary quadtree pyramid (early-exit; tolerance on AABB only)
 *   'summary' — word-summary bit hierarchy (branching 128; tolerance via level 0)
 */
export type OccupancyMethod = 'grid' | 'bitmap' | 'pyramid' | 'summary';

/**
 * Footprint model tested against the occupancy.
 *   'aabb' — screen-space axis-aligned bounding box (cheapest)
 *   'quad' — the exact rotated 4-corner quad (rotation-aware; raster occupancy only)
 * Curved (per-glyph) footprints are not implemented.
 */
export type BoundsMode = 'aabb' | 'quad';

export interface LabelManagerConfig {
    pxPerUnit: number;
    globeAlignment?: boolean;

    // Manager behavior
    fadeDurationMs: number;

    // Atlas building
    /** Font size (px) used to rasterize glyphs. Per-label sizes are ratios to this in the shader. */
    baseFontSize: number;
    /** SDF oversampling multiplier — higher = sharper at large sizes, bigger atlas texture. */
    sdfScale: number;
    /** Atlas slot pre-allocation growth factor. */
    sdfCapacityMultiplier: number;

    // GPU data textures
    /** Growth factor for instanced label/glyph data textures. */
    dataTextureCapacityMultiplier: number;
    /** Maximum width (texels) for instanced data textures. */
    maxDataTextureWidth: number;
    /**
     * Expected peak count of simultaneously-live labels. Pre-allocates the label
     * data texture so tile churn doesn't grow it through several resizes, each of
     * which disposes + fully re-uploads the texture (a webgl-submit/GPU spike).
     * Oversizing only costs VRAM.
     */
    initialLabelCapacity: number;
    /**
     * Expected peak count of simultaneously-live glyphs (≈ initialLabelCapacity ×
     * avg glyphs/label). Pre-allocates the glyph data texture — this is the buffer
     * that resizes most under churn since one label emits many glyphs.
     */
    initialGlyphCapacity: number;

    // Unloaded-label cache (see TieredLabelCache). The host groups labels (e.g.
    // by tile) and parks a group when its owner unloads; a revisit restores it.
    /**
     * Max resident (hot) label sets kept GPU-warm and merely hidden. Restoring
     * one is a visibility flip (zero upload). Small — this is the instant-revisit
     * set. 0 sends every parked set straight to the cold tier.
     */
    hotLabelCacheSize: number;
    /**
     * Max cold label sets: GPU slots freed but label objects kept, so a restore
     * re-uploads once (no re-shape) instead of a full rebuild. Larger than hot —
     * cheap CPU objects, bounded GPU. 0 disables the cold tier.
     */
    coldLabelCacheSize: number;

    /**
     * Viewport -> raster downscale for the raster occupancies ('bitmap',
     * 'summary', 'pyramid'); must be a power of 2. 1 = one bit per screen pixel,
     * which is the benchmarked default: coarser rasters are faster but reject
     * labels they should accept (the footprint is dilated by up to one cell per
     * side), measured at -3 to -4 % placement at 1 against -23 to -24 % at 8.
     * Ignored by 'grid'.
     */
    downscale: number;
    /**
     * Depth of the binary occupancy pyramid. 1 = flat early-exit bitmap; deeper
     * prunes large empty regions faster but adds descent overhead on tiny boxes.
     * The sweet spot depends on `downscale` and typical label size (≈4 at full
     * resolution, shallower when heavily downscaled).
     * Only used by occupancyMethod='pyramid'.
     */
    pyramidLevels: number;
    /**
     * VP-matrix max-element delta (clip space, scale-invariant).
     * Skip collision evaluation when the view changed less than this since the
     * last evaluation — camera is essentially stationary.
     * Equivalent to the old viewProjThreshold.
     */
    stationaryThreshold: number;
    /**
     * VP-matrix max-element delta (clip space, scale-invariant).
     * Skip collision evaluation when the view changed more than this since the
     * last evaluation — camera is moving so fast the result would be stale
     * before the next interval. Automatically adapts to globe scale, altitude,
     * FOV and zoom level because the VP matrix normalises all of these.
     * ~0.5 ≈ half a clip-unit shift per interval ≈ ~17° rotation or a large
     * zoom jump.  Set to Infinity to disable.
     */
    fastMoveFraction: number;
    /** Number of depth-sort buckets used during collision evaluation (sortMethod='bucket'). */
    collisionBuckets: number;

    // Algorithm selectors (see LabelCollisionEngine.reconfigure / manager.setCollisionConfig).
    // Defaults are the benchmarked configuration: radix + bitmap + AABB, tolerance 0.1.
    // The historical behaviour was bucket + pyramid + AABB, strict (occlusionTol 0).
    /** Priority-ordering strategy. See {@link SortMethod}. */
    sortMethod: SortMethod;
    /** Screen-occupancy structure. See {@link OccupancyMethod}. */
    occupancyMethod: OccupancyMethod;
    /** Footprint model tested against the occupancy. See {@link BoundsMode}. */
    boundsMode: BoundsMode;
    /**
     * Cell size (full-resolution screen px) for occupancyMethod='grid'. Larger
     * cells = fewer, fatter buckets. Ignored by the raster occupancies.
     */
    gridCell: number;
    /**
     * Occlusion tolerance in [0,1): the fraction of an already-rendered label's
     * footprint that may be covered and still keep it visible (hysteresis). 0 =
     * strict/binary (any overlap rejects). Only applies to labels that were
     * rendered last frame — a new label always needs a clear footprint.
     * Support by occupancy: grid (AABB), bitmap (AABB+quad), summary (AABB+quad),
     * pyramid (AABB only — the quad path is binary and ignores this).
     */
    occlusionTol: number;

    // Projector
    ndcCullMargin: number;

    // Sorting
    renderPenaltyMultiplier: number;
    /**
     * Exponent applied to (baseFontSize / fontSize) when computing the
     * collision-sort score. Higher values give larger labels stronger priority
     * over equally-distant smaller ones.
     *   0 = no size influence (distance only)
     *   1 = linear (2× bigger label scores as if √2× closer)
     *   2 = quadratic (2× bigger label scores as if 2× closer)
     */
    fontSizePriorityPower: number;

    // Performance
    /**
     * Max labels that run layoutText() per tick (covers both Add and LayoutUpdate).
     * Acts as a hard cap. 0 = unlimited.
     */
    layoutBudgetPerTick: number;
    /**
     * Max wall-clock ms spent in layoutText() per tick. Bounds the in-frame
     * layout cost by TIME rather than count, so expensive shaping (e.g. CJK
     * fonts, where one label can cost 10× a Latin one) can't blow a frame. At
     * least one label is always laid out per tick to guarantee progress.
     * 0 = time-unlimited (fall back to the count cap only).
     */
    layoutTimeBudgetMs: number;
    updateRate: number;   // seconds
    cullingRate: number;  // seconds

    /**
     * When true the manager watches the renderer canvas with a ResizeObserver
     * and calls updatePxPerUnit() automatically using the last camera seen in tick().
     * Disable if you manage pxPerUnit manually.
     */
    autoResizePxPerUnit: boolean;
}

export const DefaultLabelConfig: LabelManagerConfig = {
    pxPerUnit: 1024,
    globeAlignment: false,

    fadeDurationMs: 300,

    baseFontSize: 24,
    sdfScale: 2,
    sdfCapacityMultiplier: 2,

    dataTextureCapacityMultiplier: 2,
    maxDataTextureWidth: 4096,
    // Sized to cover the label_bench churn working set (peaks ~2.9k labels /
    // ~23k glyphs) so a full churn pass triggers zero data-texture resizes.
    initialLabelCapacity: 4096,
    initialGlyphCapacity: 32768,
    hotLabelCacheSize: 512,
    coldLabelCacheSize: 2048,

    downscale: 1,
    pyramidLevels: 4,
    stationaryThreshold: 0.05,
    fastMoveFraction: 10,
    collisionBuckets: 256,

    // Benchmarked configuration, for the three axes this engine implements:
    // radix 20-bit ordering (2 passes of 10) + full-resolution bitmap occupancy
    // + AABB bounds + occlusion tolerance 0.1. Measured against the previous
    // defaults (bucket + pyramid /8, strict) on 6 000 labels at 1920x1080:
    // ~2x faster and ~1.8x more labels placed, at slightly higher churn.
    // NOTE the benchmark's best configuration also uses a PER-GLYPH AABB chain
    // for line (curved) labels, which this engine does not implement — it tests
    // one footprint per label. The remaining ~12 points of quality in
    // docs/label-collision-algorithms.html chapter 11 are behind that feature.
    sortMethod: 'radix',
    occupancyMethod: 'bitmap',
    boundsMode: 'aabb',
    gridCell: 32,
    occlusionTol: 0.1,

    ndcCullMargin: 0.2,

    renderPenaltyMultiplier: 8,
    fontSizePriorityPower: 1,

    layoutBudgetPerTick: 0,
    layoutTimeBudgetMs: 2,
    updateRate: 0.2,
    cullingRate: 0.05,

    autoResizePxPerUnit: true,
};
