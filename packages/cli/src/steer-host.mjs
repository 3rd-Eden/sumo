/**
 * The project-scoped steering host (spec 12, ). This is the composition layer that co-hosts the
 * plugin runtime + orchestrator INSIDE the daemon process without the storage daemon (`sumo/db`)
 * gaining any harness/runtime knowledge (): the daemon routes its generic `steer` control op to
 * the `onSteer` handler this module supplies (see `start({ onSteer })`).
 *
 * Why project-scoped: `plugin` resolves config once from a single `cwd`, so a
 * single global runtime would serve hooks from OTHER projects with the wrong plugins and policy. Each
 * distinct project (keyed by `project`) gets its OWN warm runtime, built lazily on first steer,
 * evicted on idle independently of daemon storage.
 *
 * Readiness: a socket being up does not mean a project's plugins are loaded. A `steer`
 * arriving mid-activation awaits the project's `readyPromise` within a bounded budget, then fails with
 * `SUMO_RUNTIME_STARTING` (the caller maps that to its fail-open/closed policy) rather than crashing.
 *
 * @module sumo/cli/steer-host
 */

import { plugin } from 'sumo/plugin';
import { Orchestrator } from 'sumo/orchestrator';
import { project } from 'sumo/config';
import { SumoError, key } from 'sumo/db';
import { correlate } from 'sumo/agent-artifacts';

/** Default per-project idle eviction window (independent of the daemon's storage idle-shutdown). */
const DEFAULT_PROJECT_IDLE_MS = 5 * 60 * 1000;
/** Default bound on how long a steer waits for a project runtime to finish activating. */
const DEFAULT_READY_BUDGET_MS = 4000;

/**
 * @typedef {{ ok: boolean, value?: unknown, code?: string, reason?: string }} ControlResult
 * @typedef {{ event: Record<string, unknown> } | { deny: string, inject?: string }} SteerDecision
 * @typedef {{ category: string, reasoning: string, remedy?: string[] }} HarnessDiagnosis
 * @typedef {{ id: string, providers: string[] }} HarnessRow
 * @typedef {Record<string, unknown> & { cwd?: string, ext?: Record<string, unknown>, observationSource?: string }} SessionDoc
 * @typedef {{ harness: string, nativeSessionId?: string }} IdentityRequest
 * @typedef {{ id: string, op: 'steer', harness: string, cwd: string, action: string, payload?: Record<string, unknown>, ext?: Record<string, unknown>, nativeSessionId?: string }} SteerRequest
 * @typedef {{ id: string, op: 'session', sessionId: string, action: string, payload?: Record<string, unknown>, cwd?: string }} SessionControlRequest
 * @typedef {object} SteerRuntime
 * @property {() => Promise<unknown>} start - Activate config, plugins, and subscriptions.
 * @property {() => Promise<void>} stop - Stop plugin ingress and destroy activated plugins.
 * @property {(action: string, spec?: { payload?: Record<string, unknown>, ext?: Record<string, unknown>, can?: Record<string, unknown>, sessionId?: string }) => Promise<SteerDecision>} steer - Run the project steering waterfall.
 * @property {(verb: string, handler: (pluginId: string, ...args: unknown[]) => unknown, opts?: { staged?: boolean }) => void} extendFacade - Add daemon-hosted verbs before activation.
 * @property {() => HarnessRow[]} listHarnesses - Return registered harness ids and provider declarations.
 * @property {() => string[]} harnessFallback - Return configured fallback harness ids.
 * @property {(harnessId: string, output: string) => HarnessDiagnosis|null} diagnoseFor - Classify captured terminal output for known prompts.
 * @typedef {object} SteerOrchestrator
 * @property {(sessionId: string, action: string, payload?: Record<string, unknown>) => Promise<ControlResult>} control - Send a control action to a live session.
 * @property {() => void} stop - Stop orchestrator timers and live session bookkeeping.
 * @typedef {object} SteerHostOptions
 * @property {() => import('sumo/db').SumoDb} [inProcessClient] - In-process daemon client factory.
 * @property {number} [readyBudgetMs] - Maximum milliseconds to wait for project activation.
 * @property {number} [projectIdleMs] - Idle milliseconds before evicting a warm project runtime.
 * @property {NodeJS.ProcessEnv} [env] - Environment used for project key and plugin config resolution.
 * @typedef {object} SteerHost
 * @property {(req: SteerRequest) => Promise<SteerDecision>} onSteer - Daemon steering handler.
 * @property {(req: SessionControlRequest) => Promise<ControlResult>} onSession - Daemon live-session control handler.
 * @property {() => Promise<void>} dispose - Stop all warm project runtimes.
 */

/**
 * @typedef {object} ProjectEntry
 * @property {string} key
 * @property {SteerRuntime} runtime
 * @property {SteerOrchestrator} orchestrator
 * @property {import('sumo/db').SumoDb} db
 * @property {Promise<void>} readyPromise
 * @property {'starting'|'ready'|'failed'} state
 * @property {Error} [error]
 * @property {number} inflight
 * @property {ReturnType<typeof setTimeout>} [idleTimer]
 */

/**
 * Create the steering host.
 *
 * @access public
 * @param {SteerHostOptions} opts - Daemon-local dependencies and runtime timing knobs.
 * @returns {SteerHost} Handlers mounted by the daemon for steering and session control.
 */
export function createSteerHost({
  inProcessClient,
readyBudgetMs = DEFAULT_READY_BUDGET_MS,
projectIdleMs = DEFAULT_PROJECT_IDLE_MS,
env = process.env
} = {}) {
  if (typeof inProcessClient !== 'function') {
    throw new SumoError({ name: 'cli', method: 'createSteerHost', code: 'SUMO_RUNTIME_STARTING', message: 'inProcessClient is required' });
  }
  const openDb = inProcessClient;

  /** @type {Map<string, ProjectEntry>} */
  const projects = new Map();
  let disposing = false;

  /**
   * Get or lazily create a project's warm runtime. The entry (and its single `readyPromise`) is
   * created SYNCHRONOUSLY before any await, so concurrent first-steers for one project share one
   * activation rather than racing two runtimes.
   *
   * @access public
   * @param {string} cwd - Filesystem location used by `ensureProject`.
   * @returns {ProjectEntry} Project entry returned by `ensureProject`.
   */
  function ensureProject(cwd) {
    const key = project({ cwd, env });
    const existing = projects.get(key);
    // A previously-FAILED entry is not permanently poisoned (review): drop it so a transient start
    // failure (daemon hiccup, momentary import error) can be retried by this fresh build.
    if (existing && existing.state !== 'failed') return existing;
    if (existing) projects.delete(key);

    const db = openDb();
    const runtime = /** @type {SteerRuntime} */ (plugin({ cwd, env, db }));
    // Construct the orchestrator BEFORE runtime.start() so its seams (wrapRun/extendFacade) and
    // handlers are wired when the runtime subscribes (spec 10).
    // `listHarnesses` is a lazy callback — it reads factories at call time (after start()) so the
    // orchestrator's failover routing sees all registered adapters without needing them at construction.
    const orchestrator = /** @type {SteerOrchestrator} */ (new Orchestrator({
      runtime: /** @type {ConstructorParameters<typeof Orchestrator>[0]['runtime']} */ (/** @type {unknown} */ (runtime)), db, /**
       * List harness ids known to the active runtime.
       *
       * @access public
       * @returns {Array<{ id: string, providers: string[] }>} List produced by `listHarnesses`.
       */
      listHarnesses() { return runtime.listHarnesses(); }, /**
       * List fallback harness ids from runtime configuration.
       *
       * @access public
       * @returns {string[]} List produced by `fallbackHarnesses`.
       */
      fallbackHarnesses() { return runtime.harnessFallback(); }, /**
       * Defer dialog diagnosis to the runtime's adapter registry.
       *
       * @access public
       * @param {string} harnessId - Harness id supplied to `diagnoseFor`.
       * @param {string} output - Output supplied to `diagnoseFor`.
       * @returns {{ category: string, reasoning: string, remedy?: string[] } | null} Structured output from `diagnoseFor`.
       */
      diagnoseFor(harnessId, output) { return runtime.diagnoseFor(harnessId, output); }
    }));

    // Expose guarded session push to plugins: `sumo.push(sessionId, text)` routes through the
    // orchestrator's control path (which owns live session handles). Must be registered BEFORE
    // start() so plugins can call it during activation if needed.
    runtime.extendFacade('push',async (/** @type {string} */ _pluginId, /** @type {unknown} */ sessionId, /** @type {unknown} */ text) => {
      if (typeof sessionId !== 'string' || typeof text !== 'string') {
        return { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'push: sessionId and text are required' };
      }
      return orchestrator.control(sessionId, 'send', { text });
    });

    const entry = /** @type {ProjectEntry} */ ({ key, runtime, orchestrator, db, state: 'starting', inflight: 0 });
    // readyPromise NEVER rejects — it records the outcome on `entry.state` (review: a rejecting
    // readyPromise that `readyWithin` races a timeout against would be an unhandled rejection that can
    // crash the daemon). Callers inspect `state`, not the promise's rejection.
    entry.readyPromise = (async () => {
      try {
        await runtime.start();
        entry.state = 'ready';
      } catch (err) {
        entry.state = 'failed';
        entry.error = err;
      }
    })();
    projects.set(key, entry);
    armIdle(entry);
    return entry;
  }

  /**
   * (Re)arm a project's idle-eviction timer; fires only when no steer is in flight.
   *
   * @access public
   * @param {ProjectEntry} entry - Warm project runtime whose eviction timer should be reset.
   * @returns {void} The previous timer is replaced unless eviction is disabled.
   */
  function armIdle(entry) {
    if (projectIdleMs <= 0 || disposing) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { void evict(entry); }, projectIdleMs);
    entry.idleTimer.unref();
  }

  /**
   * Evict an idle project runtime (separate from daemon storage idle); a no-op if busy or gone.
   *
   * @access public
   * @param {ProjectEntry} entry - Warm project runtime selected for idle cleanup.
   * @returns {Promise<void>} Resolves after the runtime stops or the eviction is skipped.
   */
  async function evict(entry) {
    if (entry.inflight > 0) { armIdle(entry); return; }
    // Never tear down a runtime mid-activation (review): a readiness timeout can drop inflight to 0
    // while `runtime.start()` is still running. Re-arm and let it finish.
    if (entry.state === 'starting') { armIdle(entry); return; }
    if (projects.get(entry.key) !== entry) return;
    projects.delete(entry.key);
    clearTimeout(entry.idleTimer);
    try { entry.orchestrator.stop(); } catch { /* best-effort */ }
    try { await entry.runtime.stop(); } catch { /* best-effort */ }
  }

  /**
   * Resolve the Sumo session id + basic capabilities for an inbound steer request.
   * Uses the harness-native session id (populated by the adapter's `toNativeRequest`) to look up
   * the `ses:` doc via `correlate`. Best-effort: returns empty objects when correlation fails —
   * a steer that precedes `system:init` (no ses: doc yet) just gets no identity, not an error.
   *
   * @access public
   * @param {IdentityRequest} req - Harness request containing the native session id to correlate.
   * @param {import('sumo/db').SumoDb} db - Database client used by the operation.
   * @returns {Promise<{ sessionId?: string, can: Record<string, unknown> }>} Correlated Sumo session id and known steering capabilities.
   */
  async function resolveSteerIdentity(req, db) {
    if (!req.nativeSessionId) return { can: {} };
    const result = await correlate(db, { harness: req.harness, signals: { nativeId: req.nativeSessionId } });
    if (!result.ok) return { can: {} };
    const corr = /** @type {import('zod').infer<typeof import('sumo/agent-artifacts').Correlation>} */ (result.value);
    const sumoId = corr.sumoId;
    const doc = /** @type {SessionDoc|undefined} */ (await db.get(key(sumoId)));
    const recordedCapabilities = doc?.ext?.capabilities && typeof doc.ext.capabilities === 'object'
      ? /** @type {Record<string, unknown>} */ (doc.ext.capabilities)
      : {};
    const can = doc
      ? {
          ...recordedCapabilities,
          canSendKey: Boolean(recordedCapabilities.canSendKey ?? doc.ext?.canSendKey),
          canInjectContext: Boolean(recordedCapabilities.canInjectContext ?? doc.ext?.canInjectContext ?? doc.observationSource),
          observationSource: recordedCapabilities.observationSource ?? doc.observationSource
        }
      : {};
    return { sessionId: sumoId, can };
  }

  /**
   * The `onSteer` handler wired into `start`. Resolves the project, waits for readiness within
   * the budget, then drives the steering waterfall and returns the harness-agnostic decision.
   *
   * @access public
   * @param {SteerRequest} req - Harness-agnostic steer request received from a native hook.
   * @returns {Promise<SteerDecision>} Steering decision returned to the daemon host.
   */
  async function onSteer(req) {
    if (disposing) throw new SumoError({ name: 'cli', method: 'onSteer', code: 'SUMO_RUNTIME_STARTING', message: 'steering host is shutting down' });
    const entry = ensureProject(req.cwd);
    entry.inflight++;
    clearTimeout(entry.idleTimer); // do not evict while a steer is in flight
    try {
      await readyWithin(entry, readyBudgetMs);
      const { sessionId, can } = await resolveSteerIdentity(req, entry.db);
      if (sessionId && can.steeringVerified === false) {
        return { event: { action: req.action, payload: req.payload ?? {}, ...(req.ext !== undefined ? { ext: req.ext } : {}), sessionId, can } };
      }
      return await entry.runtime.steer(req.action, {
        payload: req.payload ?? {},
        ...(req.ext !== undefined ? { ext: req.ext } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}), can
      });
    } finally {
      entry.inflight--;
      armIdle(entry);
    }
  }

  /**
   * Await a project's activation within a bounded budget; surface a coded, retryable error otherwise.
   *
   * @access public
   * @param {ProjectEntry} entry - Warm project runtime whose activation is required.
   * @param {number} budgetMs - Maximum milliseconds to wait for activation.
   * @returns {Promise<void>} Resolves when the runtime is ready, or throws a coded startup error.
   */
  async function readyWithin(entry, budgetMs) {
    if (entry.state === 'ready') return;
    if (entry.state === 'failed') throw new SumoError({ name: 'cli', method: 'readyWithin', code: 'SUMO_RUNTIME_STARTING', message: 'project runtime failed to start: {reason}', vars: { reason: entry.error?.message ?? 'unknown error' } });
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    const timeout = /** @type {Promise<void>} */ (new Promise((resolve) => {
      timer = setTimeout(resolve, budgetMs);
      timer.unref();
    }));
    // readyPromise never rejects (it records on `state`); race it against the budget, then inspect state.
    await Promise.race([entry.readyPromise, timeout]);
    if (timer) clearTimeout(timer);
    const state = /** @type {ProjectEntry['state']} */ (/** @type {unknown} */ (entry.state));
    if (state === 'ready') return;
    if (state === 'failed') throw new SumoError({ name: 'cli', method: 'readyWithin', code: 'SUMO_RUNTIME_STARTING', message: 'project runtime failed to start: {reason}', vars: { reason: entry.error?.message ?? 'unknown error' } });
    throw new SumoError({ name: 'cli', method: 'readyWithin', code: 'SUMO_RUNTIME_STARTING', message: 'project runtime not ready within budget' });
  }

  /**
   * Tear down every project runtime (call on daemon close).
   *
   * @access public
   * @returns {Promise<void>} Resolves after all warm runtimes have been asked to stop.
   */
  async function dispose() {
    disposing = true;
    const entries = [...projects.values()];
    projects.clear();
    for (const entry of entries) {
      clearTimeout(entry.idleTimer);
      try { entry.orchestrator.stop(); } catch { /* best-effort */ }
      try { await entry.runtime.stop(); } catch { /* best-effort */ }
    }
  }

  /**
   * The `onSession` handler wired into `start` (). Resolves the session's project from
   * the `ses:` doc (written by the harness at spawn-time), then routes the action to the orchestrator's
   * `control()` method. Returns a `Result` object; throws a coded `SumoError` on infrastructure errors.
   * Distinct coded fails (per the plan's adversarial review corrections):
   *  - `SUMO_SESSION_UNKNOWN` — no `ses:` doc found for the id
   *  - `SUMO_SESSION_DEAD`    — doc present but no live handle in the orchestrator
   *  - `SUMO_RUNTIME_STARTING` — project not ready within the readiness budget
   *
   * @access public
   * @param {SessionControlRequest} req - Session control request routed through the owning project runtime.
   * @returns {Promise<ControlResult>} Result returned by the orchestrator control path.
   */
  async function onSession(req) {
    if (disposing) throw new SumoError({ name: 'cli', method: 'onSession', code: 'SUMO_RUNTIME_STARTING', message: 'steering host is shutting down' });

    // spawn/resume create a new session — no ses: doc exists yet; cwd comes from the request or payload.
    if (req.action === 'spawn' || req.action === 'resume') {
      const payload = /** @type {Record<string, unknown>} */ (req.payload ?? {});
      const cwd = req.cwd ?? (typeof payload.cwd === 'string' ? payload.cwd : undefined) ?? process.cwd();
      const entry = ensureProject(cwd);
      entry.inflight++;
      clearTimeout(entry.idleTimer);
      try {
        await readyWithin(entry, readyBudgetMs);
        return await entry.orchestrator.control('', req.action, req.payload ?? {});
      } finally {
        entry.inflight--;
        armIdle(entry);
      }
    }

    // Step 1: resolve the cwd from the ses: doc, unless the caller supplied it as a fast-path hint.
    let cwd = req.cwd;
    if (!cwd) {
      const lookupDb = openDb();
      const doc = /** @type {SessionDoc|undefined} */ (await lookupDb.get(key(req.sessionId)));
      if (!doc) throw new SumoError({ name: 'cli', method: 'onSession', code: 'SUMO_SESSION_UNKNOWN', message: 'session {id} not found in registry', vars: { id: req.sessionId } });
      cwd = doc.cwd;
      if (!cwd) throw new SumoError({ name: 'cli', method: 'onSession', code: 'SUMO_SESSION_UNKNOWN', message: 'session {id} has no cwd in ses: doc', vars: { id: req.sessionId } });
    }

    // Step 2: find or warm the project.
    const entry = ensureProject(cwd);
    entry.inflight++;
    clearTimeout(entry.idleTimer);
    try {
      await readyWithin(entry, readyBudgetMs);
      // Step 3: route to the orchestrator's control method.
      const result = await entry.orchestrator.control(req.sessionId, req.action, req.payload ?? {});
      if (result && !result.ok && result.code === 'SUMO_SESSION_DEAD') {
        throw new SumoError({ name: 'cli', method: 'onSession', code: 'SUMO_SESSION_DEAD', message: result.reason ?? `session ${req.sessionId} has no live handle` });
      }
      return result;
    } finally {
      entry.inflight--;
      armIdle(entry);
    }
  }

  return {
    onSteer, onSession, dispose
  };
}
