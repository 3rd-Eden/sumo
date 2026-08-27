/**
 * Silence→event timers: the orchestrator's one timer job is converting the ABSENCE of events into
 * events the reactor can act on (the harness can only see transport close, not a live-but-silent
 * session). A periodic sweep over the live-session registry emits `session.idle` after a short quiet
 * and `session.stalled` after a long quiet — once per silence epoch (a fresh epoch starts when activity
 * resumes). It only EMITS; the orchestrator reacts to those events like any other.
 *
 * @module sumo/orchestrator/timers
 */

/**
 * Clamp a number to an inclusive range.
 *
 * @access private
 * @param {number} n - N numeric value used by `clamp`.
 * @param {number} lo - Lo supplied to `clamp`.
 * @param {number} hi - Hi supplied to `clamp`.
 * @returns {number} Numeric output from `clamp`.
 */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * @typedef {object} TimerEntry
 * @property {boolean} done - Whether the session read loop has finished.
 * @property {boolean} awaitingNextTurn - Whether silence detection is paused between turns.
 * @property {number} lastActivityAt - Last activity timestamp in milliseconds.
 * @property {boolean} idleFired - Whether the current epoch already emitted `session.idle`.
 * @property {boolean} stalledFired - Whether the current epoch already emitted `session.stalled`.
 * @property {number} epoch - Silence epoch used for event dedupe.
 * @property {ReturnType<typeof setTimeout>|undefined} [shutdownTimer] - Pending forced-shutdown timer.
 */

/**
 * @typedef {object} TimerRegistry
 * @property {() => void} start - Start the silence sweep.
 * @property {(id: string) => void} bump - Record activity for one session id.
 * @property {() => void} stop - Stop the silence sweep.
 */

/**
 * Create the orchestrator timer registry.
 *
 * @access public
 * @param {{ db: import('sumo/db').SumoDb, timeouts: { idle: number, stall: number }, registry: Map<string, TimerEntry>, onError?: (err: unknown, meta?: object) => void }} deps - Timer dependencies supplied by the orchestrator.
 * @returns {TimerRegistry} Timer controls for starting, bumping, and stopping the silence sweep.
 */
export function createTimers({ db, timeouts, registry, onError = () => {} }) {
  /** @type {ReturnType<typeof setInterval>|undefined} */
  let handle;

  /**
   * Append a silence event with the required per-epoch dedupe (one-shot per epoch).
   *
   * @access public
   * @param {string} type - Event name or type handled by `emit`.
   * @param {string} sessionId - Identifier used by `emit`.
   * @param {unknown} epoch - Epoch supplied to `emit`.
   * @param {Record<string, unknown>} payload - Payload consumed by `emit`.
   * @returns {Promise<void>} Resolves after the silence event has been appended or reported.
   */
  async function emit(type, sessionId, epoch, payload) {
    try {
      await db.append({
        dedupe: `orch:${type}:${sessionId}:${epoch}`, type, sessionId, source: 'orchestrator', payload
      });
    } catch (e) {
      onError(e, { where: type });
    }
  }

  /**
   * One sweep pass: emit idle/stall for any live, non-done, non-awaiting session past its threshold.
   *
   * @access public
   * @returns {void} Mutates eligible entries and schedules silence events.
   */
  function sweep() {
    const now = Date.now();
    for (const [id, entry] of registry) {
      if (entry.done) continue;
      // Skip silence detection while awaiting the next turn (post-completion disarm): the session is
      // intentionally quiet between turns; a stall here would be a false positive. Any real activity
      // (handled via bump()) clears awaitingNextTurn and re-arms the silence epoch.
      if (entry.awaitingNextTurn) continue;
      const silent = now - entry.lastActivityAt;
      if (!entry.idleFired && silent >= timeouts.idle) {
        entry.idleFired = true;
        void emit('session.idle', id, entry.epoch, {});
      }
      if (!entry.stalledFired && silent >= timeouts.stall) {
        entry.stalledFired = true;
        void emit('session.stalled', id, entry.epoch, { sinceMs: silent });
      }
    }
  }

  return {
    /**
     * Start the periodic sweep (idempotent). Interval scales to the smallest threshold.
     *
     * @access public
     * @returns {void} Starts the sweep if it is not already running.
     */
    start() {
      if (handle) return;
      const tick = clamp(Math.floor(Math.min(timeouts.idle, timeouts.stall) / 4), 25, 5_000);
      handle = setInterval(sweep, tick);
      handle.unref(); // never keep the process alive on the orchestrator's account
    },

    /**
     * Record activity for a session: bump last-activity; a new epoch reopens silence detection.
     *
     * @access public
     * @param {string} id - Identifier used by `bump`.
     * @returns {void} Updates activity state for the session when it is still live.
     */
    bump(id) {
      const entry = registry.get(id);
      if (!entry || entry.done) return;
      entry.lastActivityAt = Date.now();
      // Real activity re-arms silence detection if it was paused post-completion (awaitingNextTurn).
      entry.awaitingNextTurn = false;
      // Real activity cancels a pending reap (the session recovered after a stall nudge).
      if (entry.shutdownTimer) {
        clearTimeout(entry.shutdownTimer);
        entry.shutdownTimer = undefined;
      }
      if (entry.idleFired || entry.stalledFired) {
        entry.epoch++;
        entry.idleFired = false;
        entry.stalledFired = false;
      }
    },

    /**
     * Stop the sweep interval owned by this timer bundle.
     *
     * @access public
     * @returns {void} Clears the active sweep interval, if one exists.
     */
    stop() {
      if (handle) clearInterval(handle);
      handle = undefined;
    }
  };
}
