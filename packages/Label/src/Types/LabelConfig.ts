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

    // Collision grid
    downscale: number;
    coarseScale: number;
    acceptableOcclusion: number;
    maxOcclusion: number;
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
    sdfScale: 3,
    sdfCapacityMultiplier: 1.5,

    dataTextureCapacityMultiplier: 1.5,
    maxDataTextureWidth: 4096,

    downscale: 8,
    coarseScale: 32,
    acceptableOcclusion: 0.1,
    maxOcclusion: 0.2,
    stationaryThreshold: 0.05,
    fastMoveFraction: 0.5,
    collisionBuckets: 32,

    ndcCullMargin: 0.2,

    renderPenaltyMultiplier: 2,
    fontSizePriorityPower: 1,

    layoutBudgetPerTick: 500,
    layoutTimeBudgetMs: 4,
    updateRate: 0.5,
    cullingRate: 0.5,

    autoResizePxPerUnit: true,
};
