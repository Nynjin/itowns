/**
 * Cooperative main-thread time-budget scheduler.
 *
 * Heavy per-tile work — vector-tile feature building, DOM label creation —
 * used to run synchronously in the promise microtask that resolves a fetch.
 * When a burst of tiles resolved together, all that work piled into a single
 * event-loop turn → one long task → a dropped-frame stall.
 *
 * {@link enqueueBudgeted} defers a job and drains the queue in time-bounded
 * slices, yielding to the event loop (via MessageChannel, falling back to
 * setTimeout) between slices so requestAnimationFrame and rendering can
 * interleave. The work then spreads across a few frames instead of stalling
 * one. Granularity is per-job: a single oversized job still runs to completion
 * (jobs are never split), but bursts of many jobs no longer land in one turn.
 */

/** Per-slice main-thread budget, in milliseconds. */
const BUDGET_MS = 4;

/** @type {{ run: Function, resolve: Function, reject: Function, cancelled?: Function }[]} */
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
        const job = _queue.shift();
        try {
            // Skip work that became irrelevant while queued (e.g. tile disposed).
            job.resolve(job.cancelled && job.cancelled() ? null : job.run());
        } catch (e) {
            job.reject(e);
        }
        // Never split a job: budget is checked only *after* one completes.
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

export default { enqueueBudgeted };
