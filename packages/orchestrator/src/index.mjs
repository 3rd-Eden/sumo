/**
 * `sumo/orchestrator` — the event reactor and the SOLE actor (§3c). Every other layer surfaces events
 * and exposes effectors; only the orchestrator interprets a surfaced condition and pulls a trigger.
 * It is a privileged consumer of the plugin runtime: it reacts through the runtime's `on()`, guards
 * every spawn through `wrapRun`, contributes the `modify`/`guard`/`surface`/`health` facade verbs, and
 * converts silence into events. It owns MECHANISM (lifecycle, guards, timers, the decision waterfall);
 * workflow POLICY lives in plugins that react to the same stream and override via `modify`.
 *
 * Construct it BEFORE `runtime.start()` (so its handlers + seams are in place when the runtime
 * subscribes), then start the runtime:
 *   const orch = new Orchestrator({ runtime, db });
 *   await runtime.start();
 *
 * @module sumo/orchestrator
 */
import { OrchestratorConfig, ok } from './schema.mjs';
import { createDecisions } from './decisions.mjs';
import { createGuards } from './guards.mjs';
import { createTimers } from './timers.mjs';
import { createDegradation } from './degradation.mjs';
import { health } from './health.mjs';
import { forContent } from 'sumo/db/dedupe';
import { key } from 'sumo/db';

/** Event types that are NOT activity: the orchestrator's own silence events + terminal events +
 *  inferred turn-completion (emitting it must not itself reset the silence epoch, and must not
 *  re-arm another stall cycle — the awaitingNextTurn flag in timers gates the sweep instead).
 *  `session.raw:turn.completed` is the Codex main-thread passthrough; treating it as activity would
 *  clear awaitingNextTurn and re-enable stall for a turn that just completed. */
const NON_ACTIVITY = new Set(['session.idle', 'session.stalled', 'session.ended', 'session.dead', 'session.rapid-death', 'session.turn-completed', 'session.raw:turn.completed']);
/** Classified failure codes that warrant trying a different harness (fallback: true in classify.mjs). */
const FALLBACK_ELIGIBLE_CODES = new Set([
  'SUMO_BACKEND_UNAVAILABLE',
  'SUMO_AUTH_REQUIRED',
  'SUMO_BUDGET_EXHAUSTED',
  'SUMO_RATE_LIMITED',
  'SUMO_OVERLOADED',
  'SUMO_NO_HARNESS',
  'SUMO_SPAWN_FAILED' // unclassified spawn failures also get one retry
]);
/** Prompts core knows are universally safe to dismiss with a keypress. */
const KNOWN_DISMISS = new Set(['upgrade-banner', 'option_dialog']);
/** How long to keep a registry entry after `done()` for a terminal event that may still be in flight. */
const TERMINAL_GRACE_MS = 5_000;

/**
 * @typedef {{ id: string, providers: string[] }} HarnessRow
 */

/**
 * @typedef {import('zod').infer<typeof OrchestratorConfig>} OrchestratorConfigShape
 */

/**
 * @typedef {import('./schema.mjs').Result} ResultShape
 */

/**
 * @typedef {Record<string, unknown> & {
 *   requestId?: string,
 *   availableDecisions?: Array<string|Record<string, unknown>>,
 *   prompt?: string,
 *   agent?: string,
 *   sumoCode?: string,
 *   threadId?: string,
 *   itemId?: string
 * }} EventPayload
 */

/**
 * @typedef {Record<string, unknown> & {
 *   id?: string,
 *   params?: { turn?: { id?: string, status?: string } }
 * }} NativePayload
 */

/**
 * @typedef {Record<string, unknown> & {
 *   type?: string,
 *   sessionId?: string,
 *   source?: string,
 *   payload?: EventPayload,
 *   ext?: Record<string, unknown> & { native?: NativePayload },
 *   seq?: string|number
 * }} OrchestratorEvent
 */

/**
 * @typedef {object} LiveSession
 * @property {string} id - Stable session id.
 * @property {string} [harness] - Harness id that owns the live process.
 * @property {string} [prompt] - Prompt used to start the session.
 * @property {() => Promise<unknown>} done - Resolves when the read loop ends.
 * @property {(opts?: { force?: boolean }|Record<string, unknown>) => Promise<ResultShape|void>} end - End the session.
 * @property {(text: string) => Promise<ResultShape|void>} send - Send text to the session.
 * @property {(name: string) => Promise<ResultShape|void>} key - Send a key press to the session.
 * @property {() => Promise<{ ok: boolean, value?: unknown }>} capture - Capture current session output.
 * @property {() => Promise<ResultShape>} [cancel] - Cancel active work when supported.
 * @property {(decision: Record<string, unknown>) => Promise<ResultShape>} [respondApproval] - Answer a pending approval request.
 */

/**
 * @typedef {object} LiveEntry
 * @property {LiveSession} session - Owned live session handle.
 * @property {string} spawnKey - Guard key reserved for the session.
 * @property {number} startedAt - Creation timestamp in milliseconds.
 * @property {number} lastActivityAt - Last observed activity timestamp in milliseconds.
 * @property {number} epoch - Silence epoch used by timer dedupe.
 * @property {boolean} idleFired - Whether the idle event fired for the current epoch.
 * @property {boolean} stalledFired - Whether the stalled event fired for the current epoch.
 * @property {boolean} terminal - Whether a terminal event has been observed.
 * @property {boolean} done - Whether the session read loop has ended.
 * @property {boolean} released - Whether the guard reservation has been released.
 * @property {ReturnType<typeof setTimeout>|undefined} [shutdownTimer] - Pending forced-shutdown timer.
 * @property {ReturnType<typeof setTimeout>|undefined} [graceTimer] - Pending terminal grace cleanup timer.
 * @property {boolean} finalAnswerSeen - Whether a final answer has been observed in this turn.
 * @property {Set<string>} openChildWork - Child work ids still open for this turn.
 * @property {boolean} awaitingNextTurn - Whether silence detection is paused until new activity.
 * @property {ReturnType<typeof setTimeout>|undefined} [completionTimer] - Pending inferred turn-completion timer.
 * @property {number} turnEpoch - Counter used to dedupe inferred turn-completion events.
 */

/**
 * @typedef {{ ok: true, value: LiveSession } | { ok: false, code: string, reason: string }} RunResult
 */

/**
 * @typedef {object} OrchestratorRuntime
 * @property {{ on: (type: string, fn: (event: OrchestratorEvent) => unknown, opts?: object) => unknown, emit: (type: string, event: OrchestratorEvent) => Promise<unknown>, run: (prompt: unknown, opts?: Record<string, unknown>) => Promise<RunResult> }} sumo - Runtime facade consumed by the orchestrator.
 * @property {(fn: (prompt: unknown, opts: Record<string, unknown>, baseRun: (prompt: unknown, opts: Record<string, unknown>) => Promise<RunResult>, pluginId: string) => Promise<RunResult>) => void} wrapRun - Install the privileged spawn wrapper.
 * @property {(verb: string, handler: (pluginId: string, ...args: Array<unknown>) => unknown, opts?: { staged?: boolean }) => void} extendFacade - Add privileged facade verbs for plugins.
 */

/**
 * @typedef {object} OrchestratorOptions
 * @property {OrchestratorRuntime} runtime - Plugin runtime instance being extended.
 * @property {import('sumo/db').SumoDb} db - Daemon client used for event writes and session patches.
 * @property {unknown} [config] - Raw orchestrator config parsed by `OrchestratorConfig`.
 * @property {(() => HarnessRow[])|null} [listHarnesses] - Lazy harness registry reader.
 * @property {(() => string[])|null} [fallbackHarnesses] - Lazy configured fallback-order reader.
 * @property {((harnessId: string, output: string) => { category?: string, reasoning?: string, remedy?: string[] }|null)|null} [diagnoseFor] - Harness-specific prompt classifier.
 */

/**
 * Select a Codex app-server approval decision from the server-advertised choices.
 *
 * @access private
 * @param {Array<string|Record<string, unknown>>} choices - Server-advertised decision choices.
 * @param {string[]} names - Preferred decision names in priority order.
 * @returns {string|Record<string, unknown>} Matching server decision, or the first preferred name.
 */
function pickApprovalDecision(choices, names) {
  for (const name of names) {
    const direct = choices.find((choice) => choice === name);
    if (direct) return direct;
    const tagged = choices.find((choice) => choice && typeof choice === 'object' && name in /** @type {Record<string, unknown>} */ (choice));
    if (tagged) return tagged;
  }
  return names[0];
}

/**
 * Map an orchestrator approval decision to the concrete session effector payload.
 * Server transports such as Codex require the original request id plus one of the
 * server-advertised decisions; older/generic approval effectors still accept the boolean Result shape.
 *
 * @access private
 * @param {{ action: string, reason?: string }} decision - Decision object to translate.
 * @param {OrchestratorEvent} event - Native approval event that carries request metadata.
 * @returns {Record<string, unknown>} Effector payload accepted by the owned session handle.
 */
function approvalResponse(decision, event) {
  const requestId = event.payload?.requestId ?? event.ext?.native?.id;
  if (requestId !== undefined) {
    const available = event.payload?.availableDecisions ?? [];
    return {
      requestId, decision: decision.action === 'allow'
        ? pickApprovalDecision(available, ['accept', 'acceptForSession', 'acceptWithExecpolicyAmendment'])
        : pickApprovalDecision(available, ['decline', 'cancel'])
    };
  }
  return decision.action === 'allow' ? { ok: true } : { ok: false, reason: decision.reason };
}

/**
 * Orchestrator implementation.
 *
 * @access public
 * @class
 */
export class Orchestrator {
 /** @type {OrchestratorRuntime} */
 #runtime;
 /** @type {import('sumo/db').SumoDb} */
 #db;
 /** @type {OrchestratorConfigShape} */
 #config;
 /** @type {Map<string, LiveEntry>} live-session registry — the ONLY source of Session handles (e.session is undefined) */
 #live = new Map();
 /** @type {import('./guards.mjs').GuardRegistry} */
 #guards;
 /** @type {import('./decisions.mjs').DecisionRegistry} */
 #decisions;
 /** @type {import('./timers.mjs').TimerRegistry} */
 #timers;
 /** @type {import('./degradation.mjs').DegradationTracker} */
 #degradation;
 /** @type {Array<{ code?: string, message: string }>} */
 #diag = [];
 /**
 * Callback that returns all registered harness ids with their `can.providers`.
 * Injected at construction time so the orchestrator can build a provider-compatible fallback chain.
 *
 * @access public
 * @type {() => HarnessRow[]}
 */
 #listHarnesses = () => [];
 /**
 * Callback that returns the resolved configured harness fallback order.
 * Runtime config is resolved during `runtime.start`, so daemon-hosted orchestrators read it lazily.
 *
 * @access public
 * @type {() => string[]}
 */
 #fallbackHarnesses = () => [];

 /**
 * Callback for running harness-specific dialog detection on captured pane output.
 * Called as `diagnoseFor(harnessId, output)` → `{ category, reasoning, remedy? } | null`.
 *
 * @access public
 * @type {(harnessId: string, output: string) => { category?: string, reasoning?: string, remedy?: string[] }|null}
 */
 #diagnoseFor = (harnessId, output) => null;

 /**
 * Create an orchestrator around a runtime and daemon database.
 *
 * @access public
 * @param {OrchestratorOptions} opts - Runtime, database, and optional registry hooks.
 */
 constructor({ runtime, db, config, listHarnesses = null, fallbackHarnesses = null, diagnoseFor = null }) {
 this.#runtime = runtime;
 this.#db = db;
 this.#config = OrchestratorConfig.parse(config ?? {});
 this.#listHarnesses = typeof listHarnesses === 'function' ? listHarnesses : () => [];
 this.#fallbackHarnesses = typeof fallbackHarnesses === 'function' ? fallbackHarnesses : () => this.#config.fallback;
 this.#diagnoseFor = typeof diagnoseFor === 'function' ? diagnoseFor : () => null;

 /**
 * Route collaborator diagnostics into the orchestrator diagnostic buffer.
 *
 * @access public
 * @param {unknown} err - Error value normalized or reported by `onError`.
 * @param {object} meta - Metadata associated with the diagnostic.
 * @returns {void} Records the diagnostic on the orchestrator.
 */
 const onError = (err, meta = {}) => {
 this.#onError(err, /** @type {Record<string, unknown>} */ (meta));
 };
 this.#decisions = createDecisions(onError);
 this.#guards = createGuards(this.#config, onError);
 this.#timers = createTimers({ db, timeouts: this.#config.timeouts, registry: this.#live, onError });
 this.#degradation = createDegradation();

 this.#wireSeams();
 this.#wireHandlers();
 this.#timers.start();
 }

 // ── failover helpers ─────────────────────────────────────────────────────────────────────────────

 /**
 * Build the ordered list of harness candidates for a single spawn attempt. Always starts with
 * `requestedId` (or the runtime default if null). Adds provider-compatible fallbacks from the
 * configured chain, skipping degraded harnesses. Cross-harness failover is disabled when `resuming`.
 *
 * @access public
 * @param {string|null} requestedId - Requested harness id, or null to let the provider choose.
 * @param {boolean} resuming - Whether the caller is resuming a harness-specific session.
 * @returns {Array<string|null>} Ordered harness candidates for one spawn attempt.
 */
 #buildCandidates(requestedId, resuming) {
 // When resuming, only one provider call is allowed (resume ids are harness-specific).
 if (resuming) return [requestedId ?? null];

 // With no explicit harness, delegate selection to the provider. It has the resolved runtime config
 // and can probe availability before spawning.
 if (!requestedId) return [null];

 const configFallback = this.#fallbackHarnesses();
 const all = this.#listHarnesses();

 // Determine which providers the requested harness serves (null = unknown = try all fallbacks).
 const requestedProviders = all.find((h) => h.id === requestedId)?.providers ?? null;

 const fallbackCandidates = configFallback
 .filter((id) => id !== requestedId)
 .filter((id) => !this.#degradation.degraded(id))
 .filter((id) => {
 // Keep fallbacks that serve at least one of the requested harness's providers,
 // OR multi-provider harnesses (Cursor: ['openai','anthropic']) that cover everything.
 if (!requestedProviders) return true;
 const candidateProviders = all.find((h) => h.id === id)?.providers ?? [];
 // A multi-provider harness (len > 1) is always a valid fallback.
 if (candidateProviders.length > 1) return true;
 return candidateProviders.some((p) => requestedProviders.includes(p));
 });

 const candidates = [];
 if (!this.#degradation.degraded(requestedId) || fallbackCandidates.length === 0) {
 candidates.push(requestedId);
 }
 candidates.push(...fallbackCandidates);
 return candidates;
 }

 /**
 * Record the actual vs requested harness on the session doc when a failover occurred.
 * Best-effort: doc patch failure never blocks the session.
 *
 * @access public
 * @param {string} sessionId - Session id whose document should record the failover.
 * @param {string} requestedHarness - Requested harness supplied to `recordFailoverOnSession`.
 * @param {string} actualHarness - Actual harness supplied to `recordFailoverOnSession`.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async #recordFailoverOnSession(sessionId, requestedHarness, actualHarness) {
 try {
 await this.#db.mergeDoc(key(sessionId), { requestedHarness, ext: { failover: true } });
 } catch { /* best-effort */ }
 }

 // ── seams (must run before runtime.start) ────────────────────────────────────────────────────────
 /**
 * Install privileged runtime seams before plugin activation starts.
 *
 * @access public
 * @returns {void} Appends an inferred `session.turn-completed` event when all completion signals agree.
 */
 #wireSeams() {
 // Guard EVERY spawn: the limit check + reservation are synchronous (before the first await), so two
 // concurrent sumo.run calls cannot both pass at the cap.
 this.#runtime.wrapRun(async (prompt, opts = {}, baseRun, pluginId) => {
 const spawnKey = typeof opts.spawnKey === 'string' ? opts.spawnKey: pluginId;

 // ONE reserve per logical request (not per failover attempt) — rate/maxRounds count the request
 // once, not each retry. Failover attempts loop inside this single reservation.
 const reserved = this.#guards.reserve(spawnKey, pluginId);
 if (!reserved.ok) return reserved;

 // Build ordered failover candidate list.
 // `opts.resume` disables cross-harness failover: native resume ids are harness-specific.
 const requestedHarness = typeof opts.harness === 'string' ? opts.harness: null;
 const candidates = this.#buildCandidates(requestedHarness, opts.resume != null);

 /** @type {RunResult|null} */
 let lastFailure = null;
 for (const candidate of candidates) {
 const runOpts = {
 ...opts,
 ...(candidate ? { harness: candidate, __sumoExactHarness: true }: {}),
 rapidDeathMs: typeof opts.rapidDeathMs === 'number' ? opts.rapidDeathMs: this.#config.timeouts.rapidDeath
 };
 const r = await baseRun(prompt, runOpts);

 if (r.ok) {
 // Successful spawn — arm and return. Record a clean start (reset breaker for this candidate).
 if (candidate) this.#degradation.clearFailures(candidate);
 this.#arm(r.value, spawnKey);
 // Record the actual harness on the session doc if it differed from the requested one.
 if (candidate && candidate !== requestedHarness && requestedHarness) {
 void this.#recordFailoverOnSession(r.value.id, requestedHarness, candidate);
 }
 return r;
 }

 // Spawn failed. Check if this failure warrants failover to the next candidate.
 const code = r.code ?? 'SUMO_SPAWN_FAILED';
 lastFailure = r;
 const fallbackEligible = FALLBACK_ELIGIBLE_CODES.has(code);

 if (fallbackEligible && candidate) {
 this.#degradation.recordFailure(candidate);
 await this.surface({ type: 'session.failover', sessionId: undefined },
 'failover to next harness', { from: candidate, code, detail: r.reason }
 ).catch(() => {});
 // Continue to next candidate
 } else {
 // Non-fallback failure (model not found, format error, etc.) — no point trying others.
 break;
 }
 }

 // All candidates exhausted or a non-fallback error — roll back the reservation.
 this.#guards.rollback(spawnKey);
 return lastFailure ?? { ok: false, code: 'SUMO_SPAWN_FAILED', reason: 'no harness available' };
 });

 // Plugin-facing primitives as facade verbs. Registrars stage (roll back with activation); actions
 // are immediate.
 this.#runtime.extendFacade('modify', (pluginId, name, fn, opts) => this.#decisions.register(pluginId, String(name), fn, /** @type {{ priority?: number }|undefined} */ (opts)), { staged: true });
 this.#runtime.extendFacade('guard', (pluginId, name, g) => this.#guards.add(String(name), g), { staged: true });
 this.#runtime.extendFacade('surface', (pluginId, e) => this.surface(/** @type {OrchestratorEvent} */ (e)));
 this.#runtime.extendFacade('health', (pluginId, session) => this.health(/** @type {LiveSession} */ (session)));
 }

 // ── universal handlers (react to events; act only via effectors on owned handles) ────────────────
 /**
 * Register runtime event handlers that enforce orchestrator ownership policy.
 *
 * @access public
 * @returns {void} Completes without producing a value.
 */
 #wireHandlers() {
 const orchestrator = this;
 /**
 * Register a guarded runtime event handler so async failures become diagnostics.
 *
 * @access public
 * @param {string} type - Event name or type handled by `on`.
 * @param {(event: OrchestratorEvent) => unknown} fn - Handler invoked for matching events.
 * @returns {unknown} Runtime unsubscribe or registration value.
 */
 function on(type, fn) {
 return orchestrator.#runtime.sumo.on(type, (e) => Promise.resolve(fn(e)).catch((err) => orchestrator.#onError(err, { where: type })));
 }

 // activity tracking — every session-scoped event except terminal events and the orchestrator's OWN
 // emissions (silence events + `orchestrator.*`), which would otherwise reset the silence epoch and
 // re-fire in a feedback loop. The runtime's SumoEvent does not surface `source`, so filter by type.
 this.#runtime.sumo.on('*', (e) => {
 if (e.sessionId && e.type && !NON_ACTIVITY.has(e.type) && !e.type.startsWith('orchestrator.')) this.#timers.bump(e.sessionId);
 });

 on('session.stalled', (e) => this.#onStalled(e));
 on('session.idle', (e) => this.surface(e, 'session idle'));
 on('session.ended', (e) => { if (e.sessionId) this.#onTerminal(e.sessionId, 'ended', e); });
 on('session.dead', (e) => { if (e.sessionId) this.#onTerminal(e.sessionId, 'dead', e); });
 on('session.rapid-death', (e) => { if (e.sessionId) this.#onTerminal(e.sessionId, 'rapid-death', e); });
 on('session.prompt-detected', (e) => this.#onPromptDetected(e));
 on('session.approval-requested', (e) => this.#onApprovalRequested(e));
 on('messenger.proof-of-life-request', (e) => this.#onProofOfLifeRequest(e));

 // Inferred turn-completion: track open child work and final-answer signals (§3c — adapter surfaces
 // neutral events; orchestrator is the sole actor that synthesizes session.turn-completed).
 on('session.turn-started', (e) => {
 if (!e.sessionId) return;
 const entry = this.#live.get(e.sessionId);
 if (!entry) return;
 if (entry.completionTimer) { clearTimeout(entry.completionTimer); entry.completionTimer = undefined; }
 entry.finalAnswerSeen = false;
 entry.openChildWork.clear();
 entry.awaitingNextTurn = false;
 });
 on('session.child-work-opened', (e) => {
 if (!e.sessionId) return;
 const entry = this.#live.get(e.sessionId);
 if (!entry || entry.done) return;
 const key = e.payload?.threadId ?? e.payload?.itemId;
 if (typeof key === 'string') entry.openChildWork.add(key);
 });
 on('session.child-work-closed', (e) => {
 if (!e.sessionId) return;
 const entry = this.#live.get(e.sessionId);
 if (!entry || entry.done) return;
 const key = e.payload?.threadId ?? e.payload?.itemId;
 if (typeof key === 'string') entry.openChildWork.delete(key);
 this.#checkTurnCompletion(e.sessionId);
 });
 on('session.final-answer', (e) => {
 if (!e.sessionId) return;
 const entry = this.#live.get(e.sessionId);
 if (!entry || entry.done) return;
 entry.finalAnswerSeen = true;
 this.#checkTurnCompletion(e.sessionId);
 });
 }

 // ── lifecycle: arm/disarm/finalize the registry + timers ─────────────────────────────────────────
 /**
 * Add a live session to the registry and bind timer cleanup to its read-loop completion.
 *
 * @access public
 * @param {LiveSession} session - Live session returned by the runtime provider.
 * @param {string} spawnKey - Guard reservation key for the session.
 * @returns {void} Registers the session and binds cleanup to its read loop.
 */
 #arm(session, spawnKey) {
 const now = Date.now();
 this.#live.set(session.id, {
 session, spawnKey, startedAt: now, lastActivityAt: now, epoch: 0, idleFired: false, stalledFired: false, terminal: false, done: false, released: false, shutdownTimer: undefined, graceTimer: undefined,
 // Turn-completion tracking (fed by session.child-work-* and session.final-answer events).
 // openChildWork is a keyed Set (threadId|itemId) so duplicate/out-of-order signals don't drift.
 finalAnswerSeen: false, openChildWork: new Set(), awaitingNextTurn: false, completionTimer: undefined, turnEpoch: 0
 });
 // Disarm timers when the read loop ends, even before the terminal event lands (it is appended
 // fire-and-forget, so done can resolve first.
 Promise.resolve(session.done())
 .then(() => {
 this.#disarmTimers(session.id);
 this.#scheduleGrace(session.id);
 })
 .catch(() => {});
 }

 /**
 * Stop emitting silence for a session + free its concurrency slot (idempotent).
 *
 * @access public
 * @param {string} id - Identifier used by `disarmTimers`.
 * @returns {void} Marks the entry done, clears shutdown state, and releases its guard slot.
 */
 #disarmTimers(id) {
 const entry = this.#live.get(id);
 if (!entry) return;
 entry.done = true;
 if (entry.shutdownTimer) {
 clearTimeout(entry.shutdownTimer);
 entry.shutdownTimer = undefined;
 }
 if (!entry.released) {
 entry.released = true;
 this.#guards.release();
 }
 }

 /**
 * After done, if no terminal event finalizes the entry within the grace window, drop it.
 *
 * @access public
 * @param {string} id - Identifier used by `scheduleGrace`.
 * @returns {void} Schedules grace cleanup when a terminal event has not arrived yet.
 */
 #scheduleGrace(id) {
 const entry = this.#live.get(id);
 if (!entry || entry.graceTimer) return;
 entry.graceTimer = setTimeout(() => this.#finalize(id), TERMINAL_GRACE_MS);
 entry.graceTimer.unref();
 }

 /**
 * Remove a live-registry entry after terminal handling or grace expiry.
 *
 * @access public
 * @param {string} id - Identifier used by `finalize`.
 * @returns {void} Removes the registry entry and clears its grace timer.
 */
 #finalize(id) {
 const entry = this.#live.get(id);
 if (!entry) return;
 if (entry.graceTimer) clearTimeout(entry.graceTimer);
 this.#live.delete(id);
 }

 /**
 * Apply breaker/degradation accounting before finalizing a terminal session.
 *
 * @access public
 * @param {string} id - Identifier used by `onTerminal`.
 * @param {'rapid-death'|'ended'|'dead'} kind - Kind used by `onTerminal`.
 * @param {OrchestratorEvent} event - Terminal event that may carry fallback classification metadata.
 * @returns {void} Applies terminal accounting and finalizes the live registry entry.
 */
 #onTerminal(id, kind, event) {
 const entry = this.#live.get(id);
 if (!entry) return;
 entry.terminal = true;
 this.#disarmTimers(id);
 if (kind === 'rapid-death') {
 this.#guards.recordRapidDeath(entry.spawnKey); // breaker accounting
 // If the crash carried a classified fallback-eligible code, record the degradation so the
 // orchestrator skips this harness on the next spawn attempt within the window.
 const sumoCode = event.payload?.sumoCode;
 if (typeof sumoCode === 'string' && FALLBACK_ELIGIBLE_CODES.has(sumoCode)) {
 const harness = entry.session.harness;
 if (harness) this.#degradation.recordFailure(harness);
 }
 }
 else if (kind === 'ended') this.#guards.recordNormalEnd(entry.spawnKey);
 this.#finalize(id);
 }

 // ── universal condition handlers ─────────────────────────────────────────────────────────────────
 /**
 * Nudge stalled sessions through the owned handle when configured.
 *
 * @access public
 * @param {OrchestratorEvent} e - Stalled event emitted by the silence timer.
 * @returns {Promise<void>} Resolves after the nudge, prompt surface, or reap path completes.
 */
 async #onStalled(e) {
 if (!e.sessionId) return;
 const sessionId = e.sessionId;
 const entry = this.#live.get(sessionId);
 if (!entry || entry.done) return;
 const session = entry.session;
 if (this.#config.timeouts.nudge) {
 await session.send('Are you still working? Please continue, or summarize what is blocking you.');
 }
 // No recovery within `shutdown` → death snapshot, then reap. Activity resume cancels this timer.
 entry.shutdownTimer = setTimeout(async () => {
 const cur = this.#live.get(sessionId);
 if (!cur || cur.done) return;
 // Belt-and-suspenders: only reap if STILL stalled (activity since the nudge cancels the timer in
 // `bump`, but re-verify here so a resumed session is never force-ended).
 if (Date.now() - cur.lastActivityAt < this.#config.timeouts.stall) return;
 let snapshot = null;
 try {
 snapshot = await session.capture(); // death snapshot before the reap
 // Run dialog detection on the snapshot (interactive mode: TUI pane may be waiting on input).
 // The harness's static diagnose is the pure sensor; the orchestrator decides what to do.
 if (snapshot?.ok && typeof snapshot.value === 'string') {
 const diagnosis = session.harness ? this.#diagnoseFor(session.harness, snapshot.value): null;
 if (diagnosis) {
 // Emit session.prompt-detected so #onPromptDetected can dismiss it or surface it.
 this.#runtime.sumo.emit('session.prompt-detected', {
 type: 'session.prompt-detected', sessionId, payload: { prompt: diagnosis.category, reasoning: diagnosis.reasoning, remedy: diagnosis.remedy }
 });
 // Give #onPromptDetected time to act before the reap fires.
 return;
 }
 }
 } catch { /* best-effort */ }
 try {
 await session.end({ force: true });
 } catch { /* best-effort */ }
 await this.surface(e, 'reaped after stall');
 }, this.#config.timeouts.shutdown);
 entry.shutdownTimer.unref();
 }

 /**
 * Resolve detected prompts through policy, dismissing only known-safe prompts automatically.
 *
 * @access public
 * @param {OrchestratorEvent} e - Prompt-detected event emitted by a harness or stall diagnosis.
 * @returns {Promise<void>} Resolves after the prompt is dismissed or surfaced.
 */
 async #onPromptDetected(e) {
 if (!e.sessionId) return;
 const entry = this.#live.get(e.sessionId);
 const session = entry?.session;
 const prompt = typeof e.payload?.prompt === 'string' ? e.payload.prompt: '';
 const base = KNOWN_DISMISS.has(prompt) ? { action: 'dismiss', key: 'Enter' }: { action: 'surface' };
 const decision = await this.#decisions.resolve('prompt', base, e);
 if (decision.action === 'dismiss') {
 if (!session) return void this.surface(e, 'no handle to dismiss prompt');
 const keyName = typeof decision.key === 'string' ? decision.key: 'Enter';
 const dismissed = await session.key(keyName);
 if (dismissed?.ok === false) await this.surface(e, 'prompt dismiss failed', { code: dismissed.code, detail: dismissed.reason });
 } else {
 await this.surface(e, 'prompt needs a human');
 }
 }

 /**
 * Resolve approval requests through policy and answer only with an owned session handle.
 *
 * @access public
 * @param {OrchestratorEvent} e - Approval request event emitted by a harness.
 * @returns {Promise<void>} Resolves after the approval is answered or surfaced.
 */
 async #onApprovalRequested(e) {
 if (!e.sessionId) return;
 const entry = this.#live.get(e.sessionId);
 const session = entry?.session;
 const decision = await this.#decisions.resolve('approval', { action: 'surface' }, e);
 const action = typeof decision.action === 'string' ? decision.action: 'surface';
 if (action === 'allow' || action === 'deny') {
 if (!session || typeof session.respondApproval !== 'function') return void this.surface(e, 'no handle to answer approval');
 const reason = typeof decision.reason === 'string' ? decision.reason: undefined;
 const answered = await session.respondApproval(approvalResponse({ action, reason }, e));
 if (answered.ok === false) await this.surface(e, 'approval response failed', { code: answered.code, detail: answered.reason });
 } else {
 await this.surface(e, 'approval needs a human');
 }
 }

 /**
 * Answer distributed proof-of-life only for sessions owned by this orchestrator.
 *
 * @access public
 * @param {OrchestratorEvent} e - Proof-of-life request from a messenger relay.
 * @returns {Promise<void>} Resolves after the owned-session health answer is surfaced.
 */
 async #onProofOfLifeRequest(e) {
 //: only the orchestrator that OWNS the agent answers. The agent id is the owned session id.
 const agent = typeof e.payload?.agent === 'string' ? e.payload.agent: '';
 const entry = this.#live.get(agent);
 if (!entry) return void this.surface(e, `proof-of-life: '${agent}' is not owned here`);
 const verdict = await this.health(entry.session);
 // Publish-back is a flagged gap (no effector reaches the medium from this event) — surface the
 // ANSWER; do NOT fake `messenger.proof-of-life-response` from core.
 await this.surface(e, 'proof-of-life answer', { agent, verdict });
 }

 /**
 * Record orchestrator diagnostics without interrupting unrelated event handling.
 *
 * @access public
 * @param {unknown} err - Error value normalized or reported by `onError`.
 * @param {Record<string, unknown>} [meta] - Additional diagnostic fields.
 * @returns {void} Appends a normalized diagnostic record.
 */
 #onError(err, meta = {}) {
 const record = err && typeof err === 'object' ? /** @type {{ message?: unknown, code?: unknown }} */ (err): {};
 const message = typeof record.message === 'string' ? record.message: String(err);
 const code = typeof record.code === 'string' ? record.code: undefined;
 this.#diag.push({ ...(code ? { code }: {}), message, ...meta });
 }

 // ── the plugin-facing primitive API (spec 10) ────────────────────────────────────────────────────

 /**
 * Spawn a guarded session (returns the runtime's `Result<Session>`).
 *
 * @access public
 * @param {unknown} prompt - Prompt or provider-native resume input.
 * @param {Record<string, unknown>} opts - Spawn options forwarded to the runtime provider.
 * @returns {Promise<RunResult>} Runtime spawn result containing the owned live session on success.
 */
 run(prompt, opts) {
 return this.#runtime.sumo.run(prompt, opts);
 }

 /**
 * React to the unified stream (alias of the runtime's `on`).
 *
 * @access public
 * @param {string} type - Event name or type handled by `on`.
 * @param {(event: OrchestratorEvent) => unknown} fn - Callback invoked for matching events.
 * @param {Record<string, unknown>} opts - Runtime observer options.
 * @returns {unknown} Runtime observer registration result.
 */
 on(type, fn, opts) {
 return this.#runtime.sumo.on(type, fn, opts);
 }

 /**
 * Resolve a named decision through the override waterfall.
 *
 * @access public
 * @param {string} name - Name used by `modify`.
 * @param {Record<string, unknown>} base - Default decision to thread through overrides.
 * @param {OrchestratorEvent} e - Event context supplied to override functions.
 * @returns {Promise<Record<string, unknown>>} Final decision after plugin overrides.
 */
 modify(name, base, e) {
 return this.#decisions.resolve(name, base, e);
 }

 /**
 * Register a runaway guard.
 *
 * @access public
 * @param {string} name - Name used by `guard`.
 * @param {unknown} g - Candidate synchronous guard function.
 * @returns {void} Registers the guard or records a diagnostic for invalid values.
 */
 guard(name, g) {
 return this.#guards.add(name, g);
 }

 /**
 * The four-signal liveness answer for an OWNED session.
 *
 * @access public
 * @param {LiveSession} session - Owned session handle to inspect.
 * @returns {Promise<import('./schema.mjs').Result>} Liveness Result with signal details.
 */
 health(session) {
 return health(session, this.#live.get(session?.id), this.#config.timeouts);
 }

 /**
 * Route a condition to a human/messenger by emitting a generic attention event. Core stays
 * medium-agnostic; a relay plugin observes `orchestrator.surfaced`.
 *
 * @access public
 * @param {OrchestratorEvent | undefined} e - Event-like value being surfaced.
 * @param {string} [reason='surfaced'] - Reason used in the generated output.
 * @param {Record<string, unknown>} [extra] - Additional metadata.
 * @returns {Promise<import('./schema.mjs').Result>} Promise that resolves with the shared Result returned by `surface`.
 */
 async surface(e, reason = 'surfaced', extra) {
 const sessionId = e?.sessionId;
 const payload = {
 reason,
 ...(e ? { event: { type: e.type, sessionId: e.sessionId, payload: e.payload } }: {}),
 ...(extra ?? {})
 };
 const ref = String(e?.seq ?? forContent({ sessionId, kind: e?.type ?? 'orchestrator.surfaced', payload, position: 0 }));
 try {
 await this.#db.append({
 dedupe: `orch:surfaced:${sessionId ?? 'na'}:${ref}`, type: 'orchestrator.surfaced',
 ...(sessionId ? { sessionId }: {}), source: 'orchestrator', payload
 });
 } catch (err) {
 this.#onError(err, { where: 'surface' });
 }
 return ok();
 }

 /**
 * Schedule an inferred `session.turn-completed` event if the final-answer has been seen and all
 * child work has drained. Uses a ~250ms re-check to let any in-flight child-closed events land.
 *
 * @access public
 * @param {string} sessionId - Identifier used by `checkTurnCompletion`.
 * @returns {void} Completes without producing a value.
 */
 #checkTurnCompletion(sessionId) {
 const entry = this.#live.get(sessionId);
 if (!entry || entry.done || entry.completionTimer) return;
 if (!entry.finalAnswerSeen || entry.openChildWork.size > 0) return;
 entry.completionTimer = setTimeout(() => {
 entry.completionTimer = undefined;
 const cur = this.#live.get(sessionId);
 if (!cur || cur.done) return;
 if (!cur.finalAnswerSeen || cur.openChildWork.size > 0) return;
 cur.awaitingNextTurn = true;
 cur.turnEpoch++;
 void this.#db.append({
 dedupe: `orch:turn-completed:${sessionId}:${cur.turnEpoch}`, type: 'session.turn-completed', sessionId, source: 'orchestrator', payload: { inferred: true }
 }).catch((err) => this.#onError(err, { where: 'turn-completed' }));
 cur.finalAnswerSeen = false;
 cur.openChildWork.clear();
 }, 250);
 entry.completionTimer.unref();
 }

 /**
 * Cross-process session control (). Routes an action to the live `Session` handle held in
 * `#live`. Returns a `Result`; coded fail when the id is absent or the session has ended.
 *
 * @access public
 * @param {string} sessionId - Identifier used by `control`.
 * @param {string} action - 'cancel' | 'send' | 'key' | 'end'
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {Promise<import('./schema.mjs').Result>} Promise that resolves with the shared Result returned by `control`.
 */
 async control(sessionId, action, payload = {}) {
 // spawn/resume create a new session — they have no existing live handle to look up.
 if (action === 'spawn' || action === 'resume') {
 try {
 const { prompt = '', resumeId, ...opts } = payload;
 const runOpts = { ...opts, ...(action === 'resume' && resumeId ? { resume: resumeId }: {}) };
 const r = await this.run(String(prompt), runOpts);
 if (!r.ok) return r;
 return ok({ sessionId: r.value.id });
 } catch (err) {
 const record = err && typeof err === 'object' ? /** @type {{ message?: unknown }} */ (err): {};
 return { ok: false, code: 'SUMO_INTERNAL', reason: typeof record.message === 'string' ? record.message: String(err) };
 }
 }
 const entry = this.#live.get(sessionId);
 if (!entry) return { ok: false, code: 'SUMO_SESSION_DEAD', reason: `session ${sessionId} has no live handle` };
 if (entry.done) return { ok: false, code: 'SUMO_SESSION_DEAD', reason: `session ${sessionId} is done` };
 const session = entry.session;
 try {
 switch (action) {
 case 'cancel': {
 const result = await session.cancel?.();
 return result ?? { ok: false, code: 'SUMO_CAP_UNSUPPORTED', reason: 'cancel not available' };
 }
 case 'send': {
 const result = await session.send(typeof payload.text === 'string' ? payload.text: '');
 return result ?? ok();
 }
 case 'key': {
 const result = await session.key(typeof payload.name === 'string' ? payload.name: 'Enter');
 return result ?? ok();
 }
 case 'end': {
 const result = await session.end(payload);
 return result ?? ok();
 }
 default:
 return { ok: false, code: 'SUMO_BAD_OP', reason: `unknown session action: ${action}` };
 }
 } catch (err) {
 const record = err && typeof err === 'object' ? /** @type {{ code?: unknown, message?: unknown }} */ (err): {};
 const code = typeof record.code === 'string' && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(record.code) ? 'SUMO_SESSION_DEAD': 'SUMO_INTERNAL';
 const reason = typeof record.message === 'string' ? record.message: String(err);
 return { ok: false, code, reason };
 }
 }

 /**
 * Stop the silence sweep (call on shutdown; the interval is unref'd so it won't hold the process).
 *
 * @access public
 * @returns {void} Completes without producing a value.
 */
 stop() {
 this.#timers.stop();
 // Release each entry's guard reservation + clear its timers before dropping it, so a reused
 // orchestrator does not carry a phantom liveCount.
 for (const id of [...this.#live.keys()]) this.#disarmTimers(id);
 for (const entry of this.#live.values()) {
 if (entry.graceTimer) clearTimeout(entry.graceTimer);
 if (entry.completionTimer) clearTimeout(entry.completionTimer);
 // Reap the live transport before dropping the handle. Without this, stopping the orchestrator
 // ORPHANS the harness child process — and a pipe `-p` worker blocks on stdin (never gets EOF), so
 // it never self-exits, leaking the subprocess and keeping the host process alive (the `pnpm test`
 // hang). `end({ force })` calls `transport.kill` synchronously; the returned promise is
 // best-effort and intentionally not awaited so `stop` stays synchronous for its callers.
 try { void entry.session.end({ force: true }).catch(() => {}); } catch { /* best-effort reap */ }
 }
 this.#live.clear();
 }

 /**
 * Execute `diagnostics`.
 *
 * @access public
 * @returns {Array<{ code?: string, message: string }>} List produced by `diagnostics`.
 */
 diagnostics() {
 return this.#diag.slice();
 }
}
