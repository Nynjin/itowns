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

    // Collision occupancy (binary quadtree pyramid — see PyramidOccupancy)
    downscale: number;
    /**
     * Depth of the binary occupancy pyramid. 1 = flat early-exit bitmap; deeper
     * prunes large empty regions faster but adds descent overhead on tiny boxes.
     * The sweet spot depends on `downscale` and typical label size (≈4 at full
     * resolution, shallower when heavily downscaled).
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
    /** Number of depth-sort buckets used during collision evaluation. */
    collisionBuckets: number;

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

    downscale: 8,
    pyramidLevels: 4,
    stationaryThreshold: 0.05,
    fastMoveFraction: 10,
    collisionBuckets: 256,

    ndcCullMargin: 0.2,

    renderPenaltyMultiplier: 8,
    fontSizePriorityPower: 1,

    layoutBudgetPerTick: 0,
    layoutTimeBudgetMs: 2,
    updateRate: 0.2,
    cullingRate: 0.05,

    autoResizePxPerUnit: true,
};
