/**
 * The plugin execution engine: an owned (vendored) priority-sorted handler registry with the two
 * execution modes Sumo needs. This is NOT a `priority-ordered handler engine` dependency — `priority-ordered handler engine`'s `exec` is a single
 * sequential replace-waterfall that fits neither mode, and bypassing it by reaching into its private
 * `mapping` is a fragile boundary. So the ~tiny registry (add/remove/priority-sort/context-bind) is
 * owned here, modeled on the handler engine.s shape, and the two modes are implemented directly:
 *
 * - **OBSERVE (`on`)** → `fanout`: every observer for a key runs **concurrently**, priority sets
 * start order, return values are **ignored**, and one throwing/timing-out observer does NOT stop
 * the others — its error is routed to `onError` ( "observe, parallel, can't block").
 * - **STEER (`before`)** → `steer`: a priority-ordered **async waterfall** with `the partial-object merge contract`
 * modify semantics copied in (a handler's returned `{event}` is **shallow-merged** onto the
 * threaded event), a sticky `{deny}` bail, and an opt-in `previous` "around" wrapper. Timeouts
 * use a local race with guaranteed cleanup; a timeout/throw is **fail-open** unless the handler is registered `{safety:true}`
 * (then fail-closed → deny), per spec 12.
 *
 * @module sumo/plugin/engine
 */

import { STEER_TIMEOUT_MS, OBSERVE_TIMEOUT_MS } from './schema.mjs';
import { cloneValue, timeoutRace } from 'sumo/util';

/** @typedef {{ priority: number, timeout: number, safety: boolean, plugin?: string, match?: ((event: Record<string, unknown>) => boolean)|RegExp|string, fn: Function }} Handler */
/** @typedef {{ event: Record<string, unknown>, inject?: string } | { deny: string, inject?: string }} SteerOutcome */
/** @typedef {(arg: unknown, pluginId?: string) => unknown} EventBuilder */

/**
 * @typedef {object} EngineRegistry
 * @property {(channel: 'observe'|'steer', key: string, fn: Function, opts?: { priority?: number, timeout?: number, safety?: boolean, plugin?: string, match?: ((event: Record<string, unknown>) => boolean)|RegExp|string }) => void} add - Register a handler by channel and key.
 * @property {(channel: 'observe'|'steer', key: string, fn?: Function) => void} remove - Remove handlers by channel and key.
 * @property {(key: string, arg: Record<string, unknown>, build?: EventBuilder) => Promise<void>} fanout - Deliver an observed event to matching handlers.
 * @property {(action: string, event: Record<string, unknown>) => Promise<SteerOutcome>} steer - Run the steering waterfall for an action.
 * @property {Record<'observe'|'steer', Map<string, Handler[]>>} channels - Registered handlers grouped by mode.
 */

/**
 * A per-handler view of the threaded event so a handler mutating its argument in place cannot corrupt
 * the thread — the engine only ever advances the event via returned `{event}` merges. The `payload`
 * and `ext` data bags are **deep-cloned** (`structuredClone`) so even a nested in-place mutation by
 * one handler cannot leak to the next; top-level bound methods (`raw`, `can`, …) are kept by
 * reference. Falls back to a shallow clone if a bag is not structured-cloneable.
 *
 * @access private
 * @param {Record<string, unknown>} event - Event record to clone before passing to plugin code.
 * @returns {Record<string, unknown>} Cloned event view handed to one handler.
 */
function viewOf(event) {
  if (event === null || typeof event !== 'object') return {};
  const v = { ...event };
  v.payload = cloneValue(event.payload);
  v.ext = cloneValue(event.ext);
  return v;
}

/**
 * Does a `before(action, fn, { match })` matcher match this steer event (spec 12)? A string/RegExp
 * tests the tool name (`event.payload.tool.name`); a function is a predicate over the whole event.
 * Anything else (or a thrown predicate) → no match, so an unmatched handler is simply skipped.
 *
 * @access private
 * @param {string|RegExp|((event: Record<string, unknown>) => boolean)} match - Match supplied to `steerMatches`.
 * @param {Record<string, unknown>} event - Event record matched against the steer handler predicate.
 * @returns {boolean} Whether `steerMatches` matched the expected condition.
 */
function steerMatches(match, event) {
  if (typeof match === 'function') return Boolean(match(viewOf(event)));
  const payload = event.payload && typeof event.payload === 'object' ? /** @type {{ tool?: { name?: unknown } }} */ (event.payload) : {};
  const toolName = typeof payload.tool?.name === 'string' ? payload.tool.name : '';
  if (typeof match === 'string') return toolName === match;
  if (match instanceof RegExp) {
    // A global/sticky RegExp carries `lastIndex` state across calls (alternating matches) — test on a
    // fresh, stateless copy so the same input always matches the same way.
    const re = match.global || match.sticky ? new RegExp(match.source, match.flags.replace(/[gy]/g, '')) : match;
    return re.test(toolName);
  }
  return false;
}

/**
 * Normalize a steering handler's return into a chain outcome against `base`.
 * Carries `inject` (a context string) alongside `deny` or `event` so the forward layer can
 * include it as `additionalContext` in the harness-native response.
 *
 * @access private
 * @param {unknown} ret - the handler's raw return.
 * @param {Record<string, unknown>} base - the event to merge onto
 * @returns {SteerOutcome} Normalized steering decision for the waterfall.
 */
function decisionFrom(ret, base) {
  if (ret && typeof ret === 'object') {
    const record = /** @type {{ inject?: unknown, deny?: unknown, event?: unknown }} */ (ret);
    const inject = typeof record.inject === 'string' && record.inject ? record.inject : undefined;
    if ('deny' in record) return { deny: String(record.deny), ...(inject ? { inject } : {}) };
    if (record.event && typeof record.event === 'object') return { event: { ...base, ...record.event }, ...(inject ? { inject } : {}) };
    if (inject) return { event: base, inject };
  }
  return { event: base };
}

/**
 * Create an engine bound to a host `context` (the `this` for handlers) and an `onError` sink.
 *
 * @access public
 * @param {{ context?: object, onError?: (err: unknown, meta?: object) => void }} opts - Engine construction options.
 * @returns {EngineRegistry} Handler registry used for observe and steer delivery.
 */
export function registry({ context, onError = () => {} } = {}) {
  /** @type {Record<'observe'|'steer', Map<string, Handler[]>>} */
  const channels = { observe: new Map(), steer: new Map() };

  /**
   * Register a handler under a channel/key, keeping the array sorted highest-priority-first (stable
   * for ties → registration order, since Array.prototype.sort is stable).
   *
   * @access public
   * @param {'observe'|'steer'} channel - Channel supplied to `add`.
   * @param {string} key - Key used by `add`.
   * @param {Function} fn - Function to register or invoke.
   * @param {{ priority?: number, timeout?: number, safety?: boolean, plugin?: string, match?: ((event: Record<string, unknown>) => boolean)|RegExp|string }} opts - Handler registration options.
   * @returns {void} Adds the handler to the sorted channel list.
   */
  function add(channel, key, fn, opts = {}) {
    const map = channels[/** @type {'observe'|'steer'} */ (channel)];
    const list = map.get(key) ?? [];
    const fallback = channel === 'steer' ? STEER_TIMEOUT_MS : OBSERVE_TIMEOUT_MS;
    const fnMeta = /** @type {{ timeout?: unknown }} */ (/** @type {unknown} */ (fn));
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : typeof fnMeta.timeout === 'number' ? fnMeta.timeout : fallback;
    list.push({
      priority: opts.priority ?? 100,
      timeout,
      safety: opts.safety ?? false,
      match: opts.match, // spec 12: optional matcher; undefined = always runs
      plugin: opts.plugin, // the owning plugin id, so the producer can build a plugin-scoped argument
      fn
    });
    list.sort((a, b) => b.priority - a.priority);
    map.set(key, list);
  }

  /**
   * Remove a specific handler fn for a key, or all handlers for the key when `fn` is omitted.
   *
   * @access public
   * @param {'observe'|'steer'} channel - Channel supplied to `remove`.
   * @param {string} key - Key used by `remove`.
   * @param {Function} [fn] - Optional handler function; omit to remove every handler for the key.
   * @returns {void} Removes matching handlers from the registry.
   */
  function remove(channel, key, fn) {
    const map = channels[/** @type {'observe'|'steer'} */ (channel)];
    const list = map.get(key);
    if (!list) return;
    const remaining = fn ? list.filter((h) => h.fn !== fn) : [];
    if (remaining.length) map.set(key, remaining);
    else map.delete(key);
  }

  /**
   * OBSERVE fan-out: run every observer for `key` concurrently, ignore returns, isolate errors.
   * Resolves once all have settled. Never throws.
   * `build(arg, pluginId)` produces the per-handler argument, so the PRODUCER decides scoping: the
   * runtime passes a builder that turns a raw db record into a fresh, deep-cloned, plugin-scoped
   * `SumoEvent` (correct `emit` identity + observer isolation), while an already-bound object (a
   * messenger `work`) is delivered as-is via the default identity builder.
   * Observers registered under the wildcard key `'*'` receive EVERY event (in addition to the exact-key
   * observers), so a privileged consumer (the orchestrator) can track all activity without enumerating
   * types. A `'*'` fanout never re-runs the wildcard list twice. Note: exact-key observers run before
   * wildcard ones (the two lists are concatenated, not merged by priority), so a handler registered
   * BOTH exactly and under `'*'` would run twice — register under exactly one key.
   *
   * @access public
   * @param {string} key - Key used by `fanout`.
   * @param {Record<string, unknown>} arg - Arg supplied to `fanout`.
   * @param {EventBuilder} build - Builds the per-plugin event view for a handler.
   * @returns {Promise<void>} Resolves after every matching observer has settled.
   */
  async function fanout(key, arg, build = (a) => a) {
    const exact = channels.observe.get(key);
    const wild = key === '*' ? undefined : channels.observe.get('*');
    const list = exact && wild ? [...exact, ...wild] : exact ?? wild;
    if (!list || !list.length) return;
    const settled = await Promise.allSettled(
      // Defer the call into a `.then` so a SYNCHRONOUS throw becomes a rejection allSettled captures,
      // instead of escaping the map() callback.
      list.map((h) => timeoutRace(Promise.resolve().then(() => h.fn.call(context, build(arg, h.plugin))), h.timeout)));
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'rejected') onError(s.reason, { channel: 'observe', key });
    }
  }

  /**
   * STEER waterfall: run the priority-ordered handlers for `action`, threading the event, applying
   * `{event}` merges and bailing on the first (sticky) `{deny}`. Returns the chain outcome.
   *
   * @access public
   * @param {string} action - Action supplied to `steer`.
   * @param {Record<string, unknown>} event - Event record threaded through the steer handler waterfall.
 * @returns {Promise<SteerOutcome>} Final steering decision after all matching handlers run.
   */
  async function steer(action, event) {
    const list = channels.steer.get(action) ?? [];

    /**
     * Run the chain from `index` against `current`. Each handler may call its `previous()` thunk to
     * take control and wrap the downstream chain (an "around" middleware); if it does not, the engine
     * auto-continues to the next handler after merging this handler's return.
     *
     * @access public
     * @param {number} index - Index numeric value used by `runFrom`.
     * @param {Record<string, unknown>} current - Current supplied to `runFrom`.
     * @returns {Promise<SteerOutcome>} Steering decision produced by the downstream handler subtree.
     */
    async function runFrom(index, current) {
      if (index >= list.length) return { event: current };
      const h = list[index];

      // Matcher (spec 12): a handler with a `match` that doesn't match this event is skipped WITHOUT
      // running. A throwing matcher is conservative — a SAFETY hook fails CLOSED (runs the guard
      // anyway) so a buggy matcher can never silently disable a safety check; a non-safety one skips.
      if (h.match !== undefined) {
        let matched;
        try {
          matched = steerMatches(h.match, current);
        } catch (err) {
          onError(err, { channel: 'steer', key: action });
          matched = Boolean(h.safety);
        }
        if (!matched) return runFrom(index + 1, current);
      }

      /** @type {Promise<SteerOutcome> | undefined} the downstream subtree, run once */
      let prevPromise;

      /**
       * Run the downstream hook subtree once and reuse that promise for repeated calls.
       *
       * @access public
       * @returns {Promise<SteerOutcome>} Cached steering decision produced by the downstream handlers.
       */
      function previous() {
        prevPromise ??= runFrom(index + 1, current);
        return prevPromise;
      }

      let ret;
      try {
        ret = await timeoutRace(Promise.resolve(h.fn.call(context, viewOf(current), { previous })), h.timeout);
      } catch (err) {
        onError(err, { channel: 'steer', key: action });
        if (h.safety) return { deny: `${action} safety hook failed` };
        // fail-open: if the handler took control, honor that subtree's outcome; else skip to the next.
        if (prevPromise) return prevPromise.catch(() => ({ event: current }));
        return runFrom(index + 1, current);
      }

      if (prevPromise) {
        // The handler took control via previous(): always await the downstream subtree, then apply
        // this handler's own return ON TOP of it (an "around" wrapper). Deny is sticky.
        // inject threads through: if the wrapper provides its own inject it wins; otherwise the
        // downstream inject is preserved so a roundtable-style inner handler's coaching message
        // survives an outer around-wrapper that doesn't itself set inject.
        const downstream = await prevPromise;
        if ('deny' in downstream) return downstream;
        const result = decisionFrom(ret, downstream.event);
        if (!result.inject && downstream.inject) return { ...result, inject: downstream.inject };
        return result;
      }

      // auto-continue path: deny is sticky (bails immediately); inject is carried forward via
      // a recursive call that merges it into the final outcome at the top of the chain.
      if (ret && typeof ret === 'object' && 'deny' in ret) {
        const record = /** @type {{ deny?: unknown, inject?: unknown }} */ (ret);
        return { deny: String(record.deny), ...(typeof record.inject === 'string' && record.inject ? { inject: record.inject } : {}) };
      }
      const record = ret && typeof ret === 'object' ? /** @type {{ event?: unknown, inject?: unknown }} */ (ret) : {};
      const merged = record.event && typeof record.event === 'object' ? { ...current, ...record.event } : current;
      // Carry inject into the next handler's context so it survives the waterfall.
      if (typeof record.inject === 'string' && record.inject) {
        const downstream = await runFrom(index + 1, merged);
        if ('deny' in downstream) {
          return { deny: downstream.deny, inject: downstream.inject ?? record.inject };
        }
        return { event: downstream.event, inject: downstream.inject ?? record.inject };
      }
      return runFrom(index + 1, merged);
    }

    return runFrom(0, event);
  }

  return { add, remove, fanout, steer, channels };
}
