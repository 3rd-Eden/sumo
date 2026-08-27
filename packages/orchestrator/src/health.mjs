/**
 * The four-signal liveness answer (). Only the orchestrator that owns a session can answer whether
 * it is alive — it holds the handle and tracks its activity. Signals: process (no terminal exit seen),
 * state (registry-tracked, not doc-polled), activity (event within the stall window), output (a
 * non-empty capture). `capture()` returns a Result and may be expensive (interactive transports shell
 * to tmux), so it is called at most once per `health()`; an unsupported capture degrades to unknown
 * rather than counting as death.
 *
 * @module sumo/orchestrator/health
 */
import { ok, fail } from './schema.mjs';

/**
 * Execute `health`.
 *
 * @access public
 * @param {{ id?: string, capture?: () => Promise<{ ok: boolean, value?: unknown }> }} session - Owned session handle being inspected.
 * @param {{ terminal?: boolean, done?: boolean, lastActivityAt: number }|undefined} entry - Live registry entry for the session, when this orchestrator owns it.
 * @param {{ stall: number }} timeouts - Timeout values for lifecycle checks.
 * @returns {Promise<import('./schema.mjs').Result>} Promise that resolves with the shared Result returned by `health`.
 */
export async function health(session, entry, timeouts) {
  if (!entry) {
    // Not an owned session — the orchestrator has no handle/history to answer from.
    return fail('SUMO_SESSION_UNKNOWN', `health: '${session?.id ?? '?'}' is not an owned session`);
  }
  const now = Date.now();
  // `done` (read loop ended) precedes the terminal EVENT; a session past done() is not alive even
  // though the terminal event may not have landed yet (review: health-after-done must not say alive).
  const process = !entry.terminal && !entry.done;
  let state = 'running';
  if (entry.terminal) {
    state = 'ended';
  } else if (entry.done) {
    state = 'done';
  }
  const activity = now - entry.lastActivityAt < timeouts.stall;

  /** @type {boolean | 'unknown'} */
  let output = 'unknown';
  if (typeof session?.capture === 'function') {
    const r = await session.capture();
    if (r && r.ok) output = !!(r.value && String(r.value).length > 0);
    // !r.ok → capability unsupported: leave 'unknown' (never treat as death)
  }

  const alive = process && activity;
  return ok({ alive, signals: { process, state, activity, output } });
}
