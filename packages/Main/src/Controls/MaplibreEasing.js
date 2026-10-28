// Experiment of geo-engine-bench (not for merge): camera moves as MapLibre GL JS makes them, with
// the constants of its 6.15.0 release: the wheel zoom of src/ui/handler/scroll_zoom.ts and the
// glide after a drag of src/ui/handler_inertia.ts; plus a light smoothing of drags, which MapLibre
// does not have (SMOOTHING_MS).

/**
 * Time constant of the smoothing of drags, orbits, middle-button zooms and trackpad zooms, ms: the
 * camera covers 1 - e^(-t / SMOOTHING_MS) of what is left of a movement after t ms (63 % after
 * 40 ms, 92 % after 100 ms). Chosen for a slight smoothing; 0 would follow the pointer exactly.
 */
export const SMOOTHING_MS = 40;
/** Duration of the ease of a smoothed zoom step (middle button, trackpad), ms: 95 % of the smoothing. */
export const SMOOTH_ZOOM_MS = 3 * SMOOTHING_MS;

/**
 * Cubic Bézier easing through (0, 0), (p1x, p1y), (p2x, p2y) and (1, 1), as CSS defines it; the
 * solver of @mapbox/unitbezier (BSD-2-Clause, Copyright Mapbox), which MapLibre uses.
 */
export function bezier(p1x, p1y, p2x, p2y) {
    const cx = 3 * p1x;
    const bx = 3 * (p2x - p1x) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * p1y;
    const by = 3 * (p2y - p1y) - cy;
    const ay = 1 - cy - by;
    return (x, epsilon = 1e-6) => {
        if (x <= 0) { return 0; }
        if (x >= 1) { return 1; }
        let t = x;
        for (let i = 0; i < 8; i++) {
            const x2 = ((ax * t + bx) * t + cx) * t - x;
            if (Math.abs(x2) < epsilon) { return ((ay * t + by) * t + cy) * t; }
            const d2 = (3 * ax * t + 2 * bx) * t + cx;
            if (Math.abs(d2) < 1e-6) { break; }
            t -= x2 / d2;
        }
        let t0 = 0;
        let t1 = 1;
        t = x;
        for (let i = 0; i < 20; i++) {
            const x2 = ((ax * t + bx) * t + cx) * t;
            if (Math.abs(x2 - x) < epsilon) { break; }
            if (x > x2) { t0 = t; } else { t1 = t; }
            t = (t0 + t1) * 0.5;
        }
        return ((ay * t + by) * t + cy) * t;
    };
}

/**
 * Duration of the ease of one wheel step, ms, counted from the wheel event, not from the start of
 * the step: the 40 ms a new scroll waits (WheelInput) are already part of it. MapLibre adds
 * WHEEL_EVENT_ADJUSTMENT_MS to the time since the event.
 */
export const WHEEL_DURATION_MS = 200;
export const WHEEL_EVENT_ADJUSTMENT_MS = 5;
/** Wheel delta of one notch on some mice (exact multiples identify a mouse wheel), px. */
const WHEEL_ZOOM_DELTA = 4.000244140625;
/** Zoom per wheel pixel: for trackpads and single small steps, and for larger mouse wheel steps. */
const DEFAULT_ZOOM_RATE = 1 / 100;
const WHEEL_ZOOM_RATE = 1 / 450;
/** Largest zoom scale of the deltas of one frame. */
const MAX_SCALE_PER_FRAME = 2;

/**
 * Wheel events turned into zoom steps as MapLibre's ScrollZoomHandler does: each event is told
 * apart as a mouse wheel or a trackpad (by its size and its interval with the previous one; a
 * lone event of a new scroll waits 40 ms for a second one), and the deltas received until the
 * next frame are summed into one step: `requestFrame()` asks for that frame, and `flush()`, called
 * within it, passes the step to `onStep(delta, type, eventTime)`: `delta` in px, positive to zoom
 * in, `type` 'wheel' or 'trackpad', `eventTime` the performance.now() of the last wheel event,
 * from which the ease of the step is timed.
 */
export class WheelInput {
    #onStep;
    #requestFrame;
    #type = null;
    #lastValue = 0;
    #lastTime = 0;
    #timeout = null;
    #delta = 0;

    constructor(onStep, requestFrame) {
        this.#onStep = onStep;
        this.#requestFrame = requestFrame;
    }

    /** Passes the deltas summed since the last call to `onStep`, if any. */
    flush() {
        const step = this.#delta;
        this.#delta = 0;
        if (step !== 0) { this.#onStep(step, this.#type ?? 'wheel', this.#lastTime); }
    }

    /** A wheel event's `deltaY` and `deltaMode` (lines count 40 px). */
    push(deltaY, deltaMode) {
        let value = deltaMode === 1 ? deltaY * 40 : deltaY;
        const now = performance.now();
        const timeDelta = now - this.#lastTime;
        this.#lastTime = now;
        if (value !== 0 && (value % WHEEL_ZOOM_DELTA) === 0) {
            this.#type = 'wheel';
        } else if (value !== 0 && Math.abs(value) < 4) {
            this.#type = 'trackpad';
        } else if (timeDelta > 400) {
            // A new scroll: wait for a second event to tell its kind, or take it as a wheel.
            this.#type = null;
            this.#lastValue = value;
            this.#timeout = setTimeout(() => {
                this.#timeout = null;
                this.#type = 'wheel';
                this.#add(-this.#lastValue);
            }, 40);
        } else if (!this.#type) {
            this.#type = Math.abs(timeDelta * value) < 200 ? 'trackpad' : 'wheel';
            if (this.#timeout) {
                clearTimeout(this.#timeout);
                this.#timeout = null;
                value += this.#lastValue;
            }
        }
        if (this.#type) { this.#add(-value); }
    }

    #add(delta) {
        this.#delta += delta;
        this.#requestFrame();
    }
}

/**
 * Zoom scale of the summed wheel delta of a frame (> 1 zooms in), MapLibre's sigmoid: small
 * scrolls still move, large ones are compressed, never beyond MAX_SCALE_PER_FRAME.
 */
export function wheelScale(delta, type) {
    const rate = type === 'wheel' && Math.abs(delta) > WHEEL_ZOOM_DELTA ? WHEEL_ZOOM_RATE : DEFAULT_ZOOM_RATE;
    const scale = MAX_SCALE_PER_FRAME / (1 + Math.exp(-Math.abs(delta * rate)));
    return delta < 0 ? 1 / scale : scale;
}
/** MapLibre's default easing (util.ts defaultEasing). */
const DEFAULT_EASING = bezier(0.25, 0.1, 0.25, 1);

/**
 * Easings of successive wheel steps (scroll_zoom.ts _smoothOutEasing): the first one is the
 * default easing; each next one starts at the speed the previous one had at that moment, so a
 * step arriving during another continues the motion without a jolt.
 */
export class WheelEasing {
    #previous = null;

    /** The easing of a step starting now, over `duration` ms. */
    next(duration = WHEEL_DURATION_MS) {
        let easing = DEFAULT_EASING;
        if (this.#previous) {
            const { start, duration: d, easing: e } = this.#previous;
            const t = (performance.now() - start) / d;
            const speed = e(t + 0.01) - e(t);
            const x = 0.27 / Math.sqrt(speed * speed + 0.0001) * 0.01;
            const y = Math.sqrt(0.27 * 0.27 - x * x);
            easing = bezier(x, y, 0.25, 1);
        }
        this.#previous = { start: performance.now(), duration, easing };
        return easing;
    }
}

/**
 * Glide easing and parameters of MapLibre's inertia (handler_inertia.ts): px or degrees, per s.
 * The decelerations are MapLibre's times GLIDE_FIRMNESS: with MapLibre's own, the glide felt too
 * long on this page; doubling them keeps the speed at release and halves the glide's length and
 * duration.
 */
const LINEARITY = 0.3;
const GLIDE_FIRMNESS = 2;
export const GLIDE_EASING = bezier(0, 0, 0.3, 1);
export const PAN_GLIDE = { deceleration: 2500 * GLIDE_FIRMNESS, maxSpeed: 1400 };
export const BEARING_GLIDE = { deceleration: 1000 * GLIDE_FIRMNESS, maxSpeed: 360 };
export const PITCH_GLIDE = { deceleration: 1000 * GLIDE_FIRMNESS, maxSpeed: 90 };
/** Oldest movement kept, and window the release speed is measured over, ms. */
const BUFFER_CUTOFF_MS = 160;
const VELOCITY_WINDOW_MS = 60;

/**
 * The glide continuing a movement of `amount` (px or degrees) made over `durationMs`, as
 * calculateEasing computes it: the speed, scaled by the linearity and capped, decreases at a
 * constant rate. Returns the glide's length (same unit as `amount`, same sign) and duration, ms.
 */
export function glide(amount, durationMs, { deceleration, maxSpeed }) {
    const speed = Math.min(Math.max(amount * LINEARITY / (durationMs / 1000), -maxSpeed), maxSpeed);
    const duration = Math.abs(speed) / (deceleration * LINEARITY);
    return { amount: speed * (duration / 2), duration: duration * 1000 };
}

/**
 * Movements of a drag, recorded as they happen, from which the glide at release is computed as
 * MapLibre does: the movements of the last VELOCITY_WINDOW_MS (at least the last two records),
 * over the time up to the release, so that a drag held still before release does not glide.
 */
export class MoveRecorder {
    #entries = [];

    clear() { this.#entries = []; }

    /** Records `move`, an object of numbers (screen pixels or radians), summed at release. */
    record(move) {
        const now = performance.now();
        while (this.#entries.length && now - this.#entries[0].time > BUFFER_CUTOFF_MS) { this.#entries.shift(); }
        this.#entries.push({ time: now, move });
    }

    /**
     * The moves of the measuring window but the first (which only marks its start) and the time
     * from that first record to now, ms; null with fewer than two records.
     */
    release() {
        const now = performance.now();
        const entries = this.#entries.filter(e => now - e.time <= BUFFER_CUTOFF_MS);
        this.clear();
        if (entries.length < 2) { return null; }
        let first = entries.length - 2;
        while (first > 0 && entries[first - 1].time >= now - VELOCITY_WINDOW_MS) { first--; }
        return { moves: entries.slice(first + 1).map(e => e.move), durationMs: now - entries[first].time };
    }
}
