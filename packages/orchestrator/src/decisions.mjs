/**
 * The `modify` decision-override mechanism (partial-object waterfall). The orchestrator holds a safe
 * default decision at a named point (`approval`, `prompt`, `rate-limit`, …); plugins override via
 * `sumo.modify(name, fn, opts)`. Each override receives the current decision + the triggering event
 * and returns a partial (shallow-merged over current — flat-decision contract), or nothing
 * (pass-through). A throwing/slow override is skipped fail-open so the decision always resolves and
 * the prompt/approval is never left unanswered.
 *
 * @module sumo/orchestrator/decisions
 */

import { timeoutRace } from 'sumo/util';

/** A slow override must not block prompt/approval handling forever — skip it past this. */
const MODIFY_TIMEOUT_MS = 5_000;

/**
 * @typedef {Record<string, unknown>} Decision
 */

/**
 * @typedef {(decision: Decision, event: Decision) => unknown} DecisionOverride
 */

/**
 * @typedef {object} DecisionRegistry
 * @property {(pluginId: string, name: string, fn: unknown, opts?: { priority?: number }) => void} register - Register one override handler.
 * @property {(name: string, base: Decision, e: Decision) => Promise<Decision>} resolve - Resolve a named decision through registered overrides.
 * @property {Map<string, Array<{ pluginId: string, fn: DecisionOverride, priority: number }>>} points - Registered overrides by decision point.
 */

/**
 * Create the orchestrator decision registry.
 *
 * @access public
 * @param {(err: unknown, meta?: object) => void} onError - Diagnostic sink for invalid or failing overrides.
 * @returns {DecisionRegistry} Decision registry used by orchestrator prompt and approval handlers.
 */
export function createDecisions(onError = () => {}) {
  /** @type {Map<string, Array<{ pluginId: string, fn: DecisionOverride, priority: number }>>} */
  const points = new Map();

  /**
   * Register an override (the staged `sumo.modify` facade verb). Higher priority runs first.
   *
   * @access public
   * @param {string} pluginId - Name used for lookup or registration.
   * @param {string} name - Name used for lookup or registration.
   * @param {unknown} fn - Candidate override function supplied by a plugin.
   * @param {{ priority?: number }} opts - Optional priority, where higher values run earlier.
   * @returns {void} Registers valid override functions for later resolution.
   */
  function register(pluginId, name, fn, opts = {}) {
    if (typeof fn !== 'function') {
      // Defensive (a diagnostic, not a throw): this runs at activation-COMMIT, where a throw would
      // corrupt the transaction (other plugins already committed).
      onError({ code: 'SUMO_MODIFY_INVALID', message: `sumo.modify('${name}', …): handler must be a function — ignored` }, { key: pluginId });
      return;
    }
    const list = points.get(name) ?? [];
    list.push({ pluginId, fn: /** @type {DecisionOverride} */ (fn), priority: opts.priority ?? 100 });
    list.sort((a, b) => b.priority - a.priority); // stable for ties → registration order
    points.set(name, list);
  }

  /**
   * Resolve a decision: thread `base` through every registered override for `name`.
   *
   * @access public
   * @param {string} name - Name used by `resolve`.
   * @param {Decision} base - Default decision to thread through overrides.
   * @param {Decision} e - Event context supplied to every override.
   * @returns {Promise<Decision>} Final decision after shallow-merging override results.
   */
  async function resolve(name, base, e) {
    let current = base;
    for (const { pluginId, fn } of points.get(name) ?? []) {
      let ret;
      try {
        // Hand each override a fresh shallow copy so a handler that returns nothing cannot mutate the
        // threaded decision (pass-through must be a true no-op). Bound by a timeout so a hung override
        // is skipped fail-open rather than blocking the decision forever.
        const view = current && typeof current === 'object' ? { ...current } : current;
        ret = await timeoutRace(Promise.resolve(fn(view, e)), MODIFY_TIMEOUT_MS, `modify override timed out after ${MODIFY_TIMEOUT_MS}ms`);
      } catch (err) {
        // fail-open: a throwing OR slow override is skipped; the decision keeps moving.
        onError(err, { key: pluginId, where: `modify:${name}` });
        continue;
      }
      if (ret && typeof ret === 'object') current = { ...current, ...ret }; // shallow merge; flat decisions
      // a non-object / undefined return = pass-through (current unchanged)
    }
    return current;
  }

  return { register, resolve, points };
}
