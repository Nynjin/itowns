/**
 * Cooperative main-thread time-budget scheduler.
 *
 * Heavy per-tile work — vector-tile feature building, DOM label creation —
 * used to run synchronously in the promise microtask that resolves a fetch.
 * When a burst of tiles resolved together, all that work piled into a single
 * event-loop turn → one long task → a dropped-frame stall.
 *
 * {@link enqueueBudgeted} defers a one-shot job; {@link enqueueChunked} defers a
 * *resumable* job that is run in chunks across slices. The queue is drained in
 * time-bounded slices, yielding to the event loop (via MessageChannel, falling
 * back to setTimeout) between slices so requestAnimationFrame and rendering can
 * interleave. Work then spreads across a few frames instead of stalling one.
 * A one-shot job still runs to completion once started, so for a single
 * oversized unit of work use enqueueChunked so it can be split mid-flight.
 */

/** Per-slice main-thread budget, in milliseconds. */
const BUDGET_MS = 4;

/**
 * @type {{ run?: Function, step?: Function, resolve: Function, reject: Function,
 *          cancelled?: Function }[]}
 */
const _queue = [];
let _scheduled = false;
let _port = null;

const _now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

function _pump() {
    _scheduled = false;
    const start = _now();
    while (_queue.length > 0) {
        const job = _queue[0];

        // Drop work that became irrelevant while queued (e.g. tile disposed).
        if (job.cancelled && job.cancelled()) {
            _queue.shift();
            job.resolve(null);
            continue;
        }

        if (job.step) {
            // Resumable job: run chunks until done or the slice is exhausted.
            let res;
            try {
                do { res = job.step(); }
                while (!res.done && _now() - start < BUDGET_MS);
            } catch (e) {
                _queue.shift();
                job.reject(e);
                continue;
            }
            if (!res.done) {
                // Slice exhausted mid-job: keep it at the front and resume next slice.
                _schedulePump();
                break;
            }
            _queue.shift();
            job.resolve(res.value);
        } else {
            // One-shot job (never split: budget is checked only after it completes).
            _queue.shift();
            try { job.resolve(job.run()); }
            catch (e) { job.reject(e); }
        }

        if (_queue.length > 0 && _now() - start >= BUDGET_MS) {
            _schedulePump();
            break;
        }
    }
}

function _schedulePump() {
    if (_scheduled) { return; }
    _scheduled = true;
    if (_port) {
        _port.postMessage(0);
    } else {
        setTimeout(_pump, 0);
    }
}

if (typeof MessageChannel !== 'undefined') {
    const channel = new MessageChannel();
    _port = channel.port2;
    channel.port1.onmessage = _pump;
}

/**
 * Defer `run` to a budgeted main-thread slice.
 *
 * @param {Function} run - Synchronous work; its return value resolves the promise.
 * @param {Function} [cancelled] - Optional predicate evaluated at drain time; if
 * it returns true the job is skipped and the promise resolves with `null`.
 * @returns {Promise} Resolves with `run()`'s result (or `null` when cancelled).
 */
export function enqueueBudgeted(run, cancelled) {
    return new Promise((resolve, reject) => {
        _queue.push({ run, resolve, reject, cancelled });
        _schedulePump();
    });
}

/**
 * Defer a *resumable* job to budgeted main-thread slices.
 *
 * `step` is called repeatedly: it must do a small bounded chunk of work and
 * return `{ done: false }` while more remains, or `{ done: true, value }` when
 * finished. The job runs across as many slices as needed (yielding between
 * them), so a single oversized unit of work no longer blocks one frame.
 *
 * @param {() => { done: boolean, value?: any }} step - Advances one chunk.
 * @param {Function} [cancelled] - Optional predicate; if it becomes true before
 * completion the job is dropped and the promise resolves with `null`.
 * @returns {Promise} Resolves with the final `value` (or `null` when cancelled).
 */
export function enqueueChunked(step, cancelled) {
    return new Promise((resolve, reject) => {
        _queue.push({ step, resolve, reject, cancelled });
        _schedulePump();
    });
}

export default { enqueueBudgeted, enqueueChunked };
