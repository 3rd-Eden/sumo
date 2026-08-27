/**
 * Runaway protection: per-plugin + global rate limits, a per-spawnKey loop budget (`maxRounds`),
 * `maxAgents` concurrency, and a rapid-death circuit-breaker. All operate on counts/timers,
 * independent of any workflow. The spawn check + reservation are synchronous so two concurrent
 * `sumo.run` calls cannot both pass at the cap (no `await` between check and increment).
 *
 * @module sumo/orchestrator/guards
 */
import { ok, fail } from './schema.mjs';

/**
 * @typedef {{ spawnKey: string, pluginId: string, liveCount: number }} GuardContext
 */

/**
 * @typedef {boolean | { ok: boolean, code?: string, reason?: string } | Promise<unknown>} GuardDecision
 */

/**
 * @typedef {(ctx: GuardContext) => GuardDecision} GuardFunction
 */

/**
 * @typedef {object} GuardRegistry
 * @property {(spawnKey: string, pluginId: string) => import('./schema.mjs').Result} reserve - Reserve one live-session slot.
 * @property {(spawnKey: string) => void} rollback - Undo a failed spawn reservation.
 * @property {() => void} release - Release one live-session slot.
 * @property {(spawnKey: string) => void} recordRapidDeath - Advance rapid-death breaker state.
 * @property {(spawnKey: string) => void} recordNormalEnd - Clear rapid-death breaker state.
 * @property {(name: string, g: unknown) => void} add - Register a synchronous custom guard.
 * @property {() => { liveCount: number, rounds: Map<string, number>, rapidDeaths: Map<string, number> }} snapshot - Copy guard counters for diagnostics.
 */

/**
 * Create the orchestrator guard registry.
 *
 * @access public
 * @param {{ guards: { maxAgents: number, maxRounds: number, rapidDeathThreshold: number, rate: { windowMs: number, max: number } } }} config - Guard configuration.
 * @param {(err: unknown, meta?: object) => void} onError - Diagnostic sink for invalid or throwing custom guards.
 * @returns {GuardRegistry} Guard controls used by the orchestrator spawn path.
 */
export function createGuards(config, onError = () => {}) {
  const { maxAgents, maxRounds, rapidDeathThreshold, rate } = config.guards;

  let liveCount = 0;
  /** @type {number[]} global spawn timestamps (sliding window) */
  const globalSpawns = [];
  /** @type {Map<string, number[]>} per-plugin spawn timestamps */
  const pluginSpawns = new Map();
  /** @type {Map<string, number>} spawns per spawnKey (cumulative loop budget) */
  const rounds = new Map();
  /** @type {Map<string, number>} consecutive rapid deaths per spawnKey */
  const rapidDeaths = new Map();
  /** @type {Map<string, GuardFunction>} */
  const custom = new Map();

  /**
   * Drop timestamps outside the configured rate window.
   *
   * @access public
   * @param {number[]} arr - Arr supplied to `prune`.
   * @param {number} now - Now supplied to `prune`.
   * @returns {number[]} List produced by `prune`.
   */
  function prune(arr, now) {
    const cutoff = now - rate.windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
    return arr;
  }

  /**
   * Synchronously check every guard AND reserve a slot — call this before the first `await` in the
   * spawn path. On pass: `liveCount`, the rate windows, and the round counter are all advanced.
   *
   * @access public
   * @param {string} spawnKey - Spawn key supplied to `reserve`.
   * @param {string} pluginId - Plugin identifier.
   * @returns {import('./schema.mjs').Result} Shared Result returned by `reserve`.
   */
  function reserve(spawnKey, pluginId) {
    const now = Date.now();

    if ((rapidDeaths.get(spawnKey) ?? 0) >= rapidDeathThreshold) {
      return fail('SUMO_BREAKER_OPEN', `circuit-breaker open for '${spawnKey}' (${rapidDeathThreshold}+ consecutive rapid deaths)`);
    }
    if ((rounds.get(spawnKey) ?? 0) >= maxRounds) {
      return fail('SUMO_MAX_ROUNDS', `'${spawnKey}' exceeded maxRounds (${maxRounds})`);
    }
    if (liveCount >= maxAgents) {
      return fail('SUMO_MAX_AGENTS', `maxAgents (${maxAgents}) reached`);
    }
    prune(globalSpawns, now);
    if (globalSpawns.length >= rate.max) {
      return fail('SUMO_RATE_LIMITED', `global spawn rate exceeded (${rate.max}/${rate.windowMs}ms)`);
    }
    const p = pluginSpawns.get(pluginId) ?? [];
    prune(p, now);
    if (p.length >= rate.max) {
      return fail('SUMO_RATE_LIMITED', `plugin '${pluginId}' spawn rate exceeded (${rate.max}/${rate.windowMs}ms)`);
    }
    for (const [name, g2] of custom) {
      /** @type {unknown} */
      let v;
      try {
        v = g2({ spawnKey, pluginId, liveCount });
      } catch (err) {
        onError(err, { key: name, where: 'guard' }); // a throwing guard is skipped (don't block every spawn)
        continue;
      }
      const possiblePromise = v && typeof v === 'object' ? /** @type {{ then?: unknown }} */ (v) : null;
      if (typeof possiblePromise?.then === 'function') {
        // reserve() is synchronous (the maxAgents invariant) so it cannot await — an async guard can't
        // be evaluated. Surface it loudly instead of silently allowing the spawn.
        onError({ code: 'SUMO_GUARD_ASYNC', message: `guard '${name}' returned a Promise; guards must be synchronous — ignored` }, { key: name });
        continue;
      }
      const result = v && typeof v === 'object' ? /** @type {{ ok?: unknown, code?: unknown, reason?: unknown }} */ (v) : null;
      const blocked = v === false || result?.ok === false;
      if (blocked) {
        const code = typeof result?.code === 'string' ? result.code : 'SUMO_GUARD_TRIPPED';
        const reason = typeof result?.reason === 'string' ? result.reason : `guard '${name}' tripped`;
        return fail(code, reason);
      }
    }

    // reserve (synchronous — no await above)
    liveCount++;
    globalSpawns.push(now);
    p.push(now);
    pluginSpawns.set(pluginId, p);
    rounds.set(spawnKey, (rounds.get(spawnKey) ?? 0) + 1);
    return ok();
  }

  /**
   * Roll back a reservation when the spawn itself failed (no session was created).
   *
   * @access public
   * @param {string} spawnKey - Spawn key supplied to `rollback`.
   * @returns {void} Releases at most one live slot and rewinds the round counter.
   */
  function rollback(spawnKey) {
    if (liveCount > 0) liveCount--;
    rounds.set(spawnKey, Math.max(0, (rounds.get(spawnKey) ?? 1) - 1));
  }

  /**
   * A live session ended (any exit) — free its concurrency slot. Idempotent via the caller's guard.
   *
   * @access public
   * @returns {void} Releases at most one live slot.
   */
  function release() {
    if (liveCount > 0) liveCount--;
  }

  /**
   * A session under this key crashed within the rapid-death window — advance the breaker.
   *
   * @access public
   * @param {string} spawnKey - Spawn key supplied to `recordRapidDeath`.
   * @returns {void} Updates rapid-death breaker state for the spawn key.
   */
  function recordRapidDeath(spawnKey) {
    rapidDeaths.set(spawnKey, (rapidDeaths.get(spawnKey) ?? 0) + 1);
  }

  /**
   * A session under this key ended normally — reset the breaker.
   *
   * @access public
   * @param {string} spawnKey - Spawn key supplied to `recordNormalEnd`.
   * @returns {void} Clears rapid-death breaker state for the spawn key.
   */
  function recordNormalEnd(spawnKey) {
    rapidDeaths.delete(spawnKey);
  }

  /**
   * Register a custom guard. `g(ctx)` runs SYNCHRONOUSLY in the spawn path and returns falsy/`{ok:false}`
   * to block a spawn (async guards are unsupported — they cannot be awaited at reserve time).
   * Validation is defensive (a diagnostic, not a throw): this runs at activation-COMMIT, where a throw
   * would corrupt the transaction.
   *
   * @access public
   * @param {string} name - Name used by `add`.
   * @param {unknown} g - Candidate guard function supplied by a plugin.
   * @returns {void} Registers valid guards and reports invalid values.
   */
  function add(name, g) {
    if (typeof g !== 'function') {
      onError({ code: 'SUMO_GUARD_INVALID', message: `sumo.guard('${name}', …): guard must be a function — ignored` }, { key: name });
      return;
    }
    custom.set(name, /** @type {GuardFunction} */ (g));
  }

  return {
    reserve,
    rollback,
    release,
    recordRapidDeath,
    recordNormalEnd,
    add,

    /**
     * Return a copy of guard counters so callers cannot mutate live state.
     *
     * @access public
     * @returns {{ liveCount: number, rounds: Map<string, number>, rapidDeaths: Map<string, number> }} Structured output from `snapshot`.
     */
    snapshot() { return ({ liveCount, rounds: new Map(rounds), rapidDeaths: new Map(rapidDeaths) }); }
  };
}
