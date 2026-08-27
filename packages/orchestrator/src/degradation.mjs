/**
 * Harness degradation tracking — port of the reference implementation `packages/agent/src/backends/index.js`
 * `recordFailure` / `recordWarning` / `degraded` / `clearFailures` pattern.
 *
 * A harness is considered degraded after 2 failures within a 30-minute window, OR after 3 warnings.
 * Degraded harnesses are skipped during failover routing; their slot is re-opened after the window expires
 * or on an explicit clear.
 *
 * Separate from the orchestrator's spawn-rate `guards.mjs` (which counts concurrent live sessions and
 * spawns per minute): degradation tracks **post-spawn failure signals** (budget exhausted, auth failed,
 * rapid-death with a classified code) across a longer window.
 *
 * @module sumo/orchestrator/degradation
 */

/** Window within which failures count toward degradation (ms). Matches the reference implementation's 30-minute window. */
const WINDOW_MS = 30 * 60 * 1000;
/** Failure count within the window before a harness is marked degraded. */
const FAILURE_THRESHOLD = 2;
/** Warning count before a warning is promoted to a failure. */
const WARNING_THRESHOLD = 3;

/**
 * @typedef {{ count: number, warnings: number, first: number, last: number }} FailureEntry
 */

/**
 * @typedef {object} DegradationTracker
 * @property {(harness: string) => void} recordFailure - Record a hard harness failure.
 * @property {(harness: string) => void} recordWarning - Record a soft harness warning.
 * @property {(harness: string) => void} clearFailures - Clear failure and warning history.
 * @property {(harness: string) => boolean} degraded - Test whether a harness is currently degraded.
 * @property {() => Map<string, FailureEntry>} snapshot - Copy failure and warning state.
 */

/**
 * Create a degradation tracker.
 *
 * @access public
 * @returns {DegradationTracker} Harness degradation tracker used during failover routing.
 */
export function createDegradation() {
  /** @type {Map<string, FailureEntry>} */
  const failures = new Map();

  /**
   * Record a hard failure for a harness (budget exhausted, auth failed, unavailable, etc.).
   * Two failures within WINDOW_MS mark the harness as degraded.
   *
   * @access public
   * @param {string} harness - Harness supplied to `recordFailure`.
   * @returns {void} Updates hard-failure counters for the harness.
   */
  function recordFailure(harness) {
    const now = Date.now();
    const entry = failures.get(harness);
    if (!entry) {
      failures.set(harness, { count: 1, warnings: 0, first: now, last: now });
    } else {
      failures.set(harness, { ...entry, count: entry.count + 1, last: now });
    }
  }

  /**
   * Record a soft warning for a harness. Warnings and failures are independent counters.
   * Three warnings within the window independently mark the harness as degraded (the reference implementation pattern:
   * `degraded()` checks EITHER counter; warnings never convert to failure count).
   *
   * @access public
   * @param {string} harness - Harness supplied to `recordWarning`.
   * @returns {void} Updates warning counters for the harness.
   */
  function recordWarning(harness) {
    const now = Date.now();
    const entry = failures.get(harness);
    const warnings = (entry?.warnings ?? 0) + 1;
    if (entry) {
      failures.set(harness, { ...entry, warnings, last: now });
    } else {
      failures.set(harness, { count: 0, warnings, first: now, last: now });
    }
  }

  /**
   * Clear all failure + warning history for a harness (e.g. after a successful spawn, or explicit reset).
   *
   * @access public
   * @param {string} harness - Harness supplied to `clearFailures`.
   * @returns {void} Removes tracked degradation state for the harness.
   */
  function clearFailures(harness) {
    failures.delete(harness);
  }

  /**
   * Is this harness currently degraded?
   * Either >= FAILURE_THRESHOLD failures OR >= WARNING_THRESHOLD warnings within WINDOW_MS.
   * Warnings and failures are independent counters — 3 warnings degrade as surely as 2 failures.
   * Old entries (outside the window) are ignored: "stale failures should not count as degradation".
   *
   * @access public
   * @param {string} harness - Harness supplied to `degraded`.
   * @returns {boolean} Whether `degraded` matched the expected condition.
   */
  function degraded(harness) {
    const entry = failures.get(harness);
    if (!entry) return false;
    if ((Date.now() - entry.last) >= WINDOW_MS) return false;
    return entry.count >= FAILURE_THRESHOLD || entry.warnings >= WARNING_THRESHOLD;
  }

  return {
    recordFailure,
    recordWarning,
    clearFailures,
    degraded,

    /**
     * Return a copy of degradation state for diagnostics.
     *
     * @access public
     * @returns {Map<string, FailureEntry>} Copy of the failure and warning state by harness id.
     */
    snapshot() { return new Map(failures); }
  };
}
