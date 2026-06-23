/**
 * Opt-in micro-profiler for the label pipeline.
 *
 * Disabled by default: when {@link Profiler.enabled} is false every call is a
 * single boolean test, so production code paths are unaffected. The label
 * benchmark turns it on to attribute per-stage CPU cost (shaping, GPU upload,
 * collision sub-phases, registration, deletion, …).
 *
 * Usage at an instrumented site:
 * ```ts
 * const t = LabelProfiler.begin();
 * doWork();
 * LabelProfiler.end('shape', t);
 * ```
 * The consumer calls {@link Profiler.reset} once per frame and reads
 * {@link Profiler.ms} / {@link Profiler.calls} to get per-frame attribution.
 */
class Profiler {
    /** Master switch. Leave false in production. */
    enabled = false;

    /** Accumulated milliseconds per stage key, since the last reset(). */
    readonly ms: Record<string, number> = {};

    /** Invocation count per stage key, since the last reset(). */
    readonly calls: Record<string, number> = {};

    /**
     * Maximum duration of any single begin/end pair since the last reset().
     * Unlike `ms` (which sums all calls in a frame), this isolates the single
     * worst invocation — useful for network timers where the per-frame sum is
     * biased by how many responses happen to cluster in one frame.
     */
    readonly callPeak: Record<string, number> = {};

    /**
     * Free-form numeric counters (since the last reset()), e.g. how many labels
     * were created this frame or how many times the glyph atlas grew. Used to
     * surface burst behaviour the timers alone can't explain.
     */
    readonly counts: Record<string, number> = {};

    /**
     * Start a timer.
     * @returns a token to hand to {@link Profiler.end}, or 0 when disabled.
     */
    begin(): number {
        return this.enabled ? performance.now() : 0;
    }

    /**
     * Stop a timer started by {@link Profiler.begin} and accumulate the elapsed
     * time (and one invocation) under `key`. No-op when disabled.
     */
    end(key: string, token: number): void {
        if (!this.enabled || token === 0) { return; }
        const elapsed = performance.now() - token;
        this.ms[key] = (this.ms[key] || 0) + elapsed;
        this.calls[key] = (this.calls[key] || 0) + 1;
        if (elapsed > (this.callPeak[key] || 0)) { this.callPeak[key] = elapsed; }
    }

    /** Add `n` to a free-form counter under `key`. No-op when disabled. */
    count(key: string, n = 1): void {
        if (!this.enabled) { return; }
        this.counts[key] = (this.counts[key] || 0) + n;
    }

    /**
     * Track the running maximum of `value` under `key` (a gauge, not a sum) —
     * e.g. the largest single batch ever produced by one call. No-op when disabled.
     */
    max(key: string, value: number): void {
        if (!this.enabled) { return; }
        if (value > (this.counts[key] || 0)) { this.counts[key] = value; }
    }

    /**
     * Add raw milliseconds to a timer key without the begin/end pair — for costs
     * measured outside JS (e.g. an async GPU timer query whose result arrives
     * several frames later). No-op when disabled.
     */
    addMs(key: string, ms: number): void {
        if (!this.enabled) { return; }
        this.ms[key] = (this.ms[key] || 0) + ms;
        this.calls[key] = (this.calls[key] || 0) + 1;
    }

    /** Zero every accumulator while keeping the key set stable (cheap to read). */
    reset(): void {
        for (const k in this.ms) { this.ms[k] = 0; }
        for (const k in this.calls) { this.calls[k] = 0; }
        for (const k in this.callPeak) { this.callPeak[k] = 0; }
        for (const k in this.counts) { this.counts[k] = 0; }
    }
}

/** Process-wide singleton shared by the manager, collision engine and layer. */
export const LabelProfiler = new Profiler();
