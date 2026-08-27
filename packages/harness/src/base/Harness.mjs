/**
 * `sumo/harness` base class — the lifted abstraction (the unified adapter idiom, CONVENTIONS §3a/§4;
 * /). It is the one place `extends` appears in an author's world: an adapter declares its
 * `id`/`can`/`config`/`transport`/`overlaps` instance props and (optionally) overrides `read`/`write`,
 * and the base owns everything genuinely shared across the pipe and server kinds:
 *
 *  - `Session` (the Spark) construction + method binding around the author's `transport` + `write`;
 *  - the read loop: drain `transport.frames()` → `read(frame)` → map to `EventInput` → dedupe →
 *    append (via the daemon client in adapter context) + surface on `Session.join()`;
 *  - dedupe-key production (): source-preferred natural id, else content hash + monotonic position;
 *  - lifecycle: `run()` opens the transport, computes + freezes the per-session `CapabilitiesSchema`,
 *    submits the first prompt, and arms activity/stall/idle/rapid-death detection;
 *  - capability degradation: a `Session` method whose capability is false returns
 *    `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }` — never throws, never fakes (§3b).
 *
 * Divergences are NOT base assumptions: they are the swappable `transport` instance (pipe vs server)
 * and the declared `can` flags. The base presence-probes the transport (`typeof transport.request`)
 * and intersects with `can` so an absent effector degrades honestly rather than being assumed.
 *
 * @module sumo/harness/base/Harness
 */

import { adapters, raw } from 'sumo/transcript';
import { forEvent } from 'sumo/db/dedupe';
import { id, key, SessionSchema } from 'sumo/db';
import { SumoError } from 'sumo/error';
import { withDefined } from 'sumo/util';

import { ok, fail, isResult, CAP_UNSUPPORTED } from './schema.mjs';
import { classify } from './classify.mjs';
import { AsyncQueue } from '../transport/_queue.mjs';
import { tmuxAvailable } from '../transport/tmux.mjs';
import { resolve } from '../models.mjs';

/** Default activity thresholds (ms). Large enough not to fire during fast tests; tunable per run. */
const DEFAULTS = {
  idleMs: 30_000,
  stallMs: 120_000,
  rapidDeathMs: 1_000
};

/**
 * @typedef {import('sumo/session').CapabilitiesSchema} Capabilities
 * @typedef {import('sumo/transcript').NormalizedEventInput} NormalizedEventInput
 * @typedef {import('./schema.mjs').HarnessAction} HarnessAction
 * @typedef {import('./schema.mjs').Result} HarnessResult
 * @typedef {Record<string, unknown> & { requestId: number, decision: unknown }} ApprovalDecision
 * @typedef {Record<string, unknown> & { append?: (input: Record<string, unknown>) => Promise<unknown>, put?: (key: string, value: Record<string, unknown>) => Promise<unknown>, mergeDoc?: (key: string, patch: Record<string, unknown>) => Promise<unknown> }} HarnessDb
 * @typedef {{ open: () => Promise<void>, frames: () => AsyncIterable<object>, close: () => Promise<void>, kill: () => Promise<void>|void, setMode: (mode: 'default'|'interactive') => void, health: { alive?: boolean, heartbeat?: number, code?: number|null, signal?: string|null }, key?: (name: string) => Promise<unknown>|unknown, capture?: () => Promise<unknown>|unknown, interrupt?: () => Promise<unknown>|unknown, pid?: number|null, sessionId?: string, evidence?: Record<string, unknown> }} HarnessTransport
 * @typedef {Record<string, unknown> & { mode?: 'default'|'interactive', sessionId?: string, cwd?: string, model?: string, requested?: string, tier?: 'fast'|'balanced'|'powerful', resume?: string, rapidDeathMs?: number }} HarnessRunOptions
 * @typedef {{ config: Record<string, unknown>, store?: Record<string, unknown>, signal?: AbortSignal, db?: HarnessDb, session: (spec: HarnessSessionSpec) => Record<string, unknown> }} HarnessContext
 * @typedef {Record<string, unknown> & { id: string, state: string, capabilities: Capabilities, harness: string, send: (text: string) => Promise<HarnessResult>, command: (line: string) => Promise<HarnessResult>, key: (name: string) => Promise<HarnessResult>, capture: () => Promise<HarnessResult>, join: () => AsyncIterableIterator<Record<string, unknown>>, done: () => Promise<void>, end: (o?: { force?: boolean }) => Promise<HarnessResult>, respondApproval?: (decision: ApprovalDecision) => Promise<HarnessResult>, cancel?: () => Promise<HarnessResult> }} HarnessSessionSpec
 */

/**
 * Harness implementation.
 *
 * @access public
 * @class
 */
export class Harness {
 /** @type {string} the harness id; MUST match a `sumo/transcript` parser key. */
 id = '';

 /** @type {import('./schema.mjs').HarnessCan} declared capabilities (authoring-time). */
 can = {};

 /** @type {import('zod').ZodTypeAny|undefined} per-harness config contract. */
 config = undefined;

 /** @type {HarnessTransport|null} the swappable transport . */
 transport = null;

 /** @type {{ stream?: boolean, transcript?: boolean }} which sources carry the same turns . */
 overlaps = {};

 /** @type {boolean} whether the on-disk transcript is complete (false e.g. for Cursor). */
 transcriptComplete = true;

 /**
 * Create an instance.
 *
 * @access public
 * @param {{ config?: Record<string, unknown>, store?: Record<string, unknown>, signal?: AbortSignal, db?: HarnessDb, session?: (spec: HarnessSessionSpec) => Record<string, unknown> }} ctx - Execution context supplied by the plugin runtime.
 */
 constructor(ctx = {}) {
 /** @type {HarnessContext} */
 this.ctx = {
 ...ctx,
 config: ctx.config ?? {},
 session: ctx.session ?? ((spec) => spec)
 };
 this.#pos = 0;
 }

 /** @type {import('sumo/transcript').Parser|null} */ #parserInstance = null;
 #pos = 0;

 /**
 * The composed transcript parser for this harness (lazy: `id` is a subclass field set after super).
 *
 * @access public
 * @returns {import('sumo/transcript').Parser} Transcript parser for this harness id.
 */
 get parser() {
 if (!this.#parserInstance) {
 const Parser = adapters[this.id];
 if (!Parser) {
 throw new SumoError({
 name: 'harness',
 method: 'transcript',
 code: 'SUMO_NO_PARSER',
 message: `no transcript parser registered for harness '${this.id}'`
 });
 }
 this.#parserInstance = new Parser();
 }
 return this.#parserInstance;
 }

 // ── Author hooks (overridable) ─────────────────────────────────────────────────────────────────

 /**
 * READ (ingest): one inbound transport frame → 0+ normalized events. Default composes the harness's
 * transcript parser; an adapter overrides only for a non-parser framing.
 *
 * @access public
 * @param {Record<string, unknown>} frame - Frame consumed by `read`.
 * @returns {Iterable<NormalizedEventInput>} Normalized events parsed from the inbound frame.
 */
 *read(frame) {
 const out = this.parser.stream(frame);
 yield* /** @type {Iterable<NormalizedEventInput>} */ (out);
 }

 // ── Hook surface (spec 12): shared intent in, per-harness native delivery out ────────────────────

 /**
 * Maps each native hook event NAME to how Sumo treats it: `{ kind: 'observe' }` (feed the event
 * stream, fire-and-forget) or `{ kind: 'decide', action }` (run the `before(action)` waterfall and
 * translate the decision to the native response). Empty by default; a hooks-capable adapter
 * overrides it. An unknown native event is treated as observation (§3e — surfaced, never crashed).
 * @type {Record<string, { kind: 'observe'|'decide', action?: string }>}
 */
 hookEvents = {};

 /**
 * Parse a native hook payload into the normalized steer request (`{ action, payload, ext }`) the
 * runtime's `before(action)` waterfall consumes. Pure (no transport/db). Override per harness.
 *
 * @access public
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {{ action: string, payload: object, ext: object }} Structured output from `toNativeRequest`.
 */
 toNativeRequest(nativeEvent, payload) {
 return {
 action: this.hookEvents[nativeEvent]?.action ?? 'tool',
 payload: {},
 ext: {
 native: payload
 }
 };
 }

 /**
 * Translate the runtime's harness-agnostic decision (`{ event } | { deny }`) into this harness's
 * native hook response. Pure: returns the bytes to write on stdout, the process exit code, and any
 * degradation diagnostics. Base default is a
 * no-op allow (write nothing); a hooks-capable adapter overrides it.
 *
 * @access public
 * @param {{ event?: Record<string, unknown>, deny?: string }} _decision - Decision supplied to `toNativeResponse`.
 * @param {string} _nativeEvent - Event name or type handled by `toNativeResponse`.
 * @param {unknown} _payload - Payload consumed by `toNativeResponse`.
 * @returns {{ stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }} List produced by `toNativeResponse`.
 */
 toNativeResponse(_decision, _nativeEvent, _payload) {
 return {
 stdout: '',
 exitCode: 0,
 diagnostics: []
 };
 }

 /**
 * Normalize an OBSERVATION hook payload into a `07` event (the same shape the transcript parser
 * yields), so a hook-sourced event COLLAPSES with the transcript-sourced one on the shared dedupe key
 * . Returns null when the adapter can't normalize this event — the caller surfaces it as a
 * `<domain>.raw:<native>` passthrough (§3e), never dropped. Carries NO raw native payload in `ext`
 * (the caller stores raw under a redacted `raw:` key + `rawRef`). Override per harness.
 *
 * @access public
 * @param {string} _nativeEvent - Event name or type handled by `toObservation`.
 * @param {unknown} _payload - Payload consumed by `toObservation`.
 * @returns {import('sumo/transcript').NormalizedEventInput | null} Import('sumo/transcript') normalized event input null returned by `toObservation`.
 */
 toObservation(_nativeEvent, _payload) {
 return null;
 }

 /**
 * WRITE (act): a Sumo intention → an external effect. MUST return a `Result | void` (it performs the
 * effect; it never returns raw bytes — §3b). Pipe adapters call `this.transport.send(...)`; server
 * adapters call `this.transport.request(...)`. Abstract: every adapter implements it.
 * @access public
 * @param {HarnessAction} _action - Harness action to perform.
 * @returns {Promise<HarnessResult>|HarnessResult|void} Optional operation result from the adapter.
 */
 // eslint-disable-next-line class-methods-use-this
 write(_action) {
 throw new SumoError({
 name: 'harness',
 method: 'write',
 code: 'SUMO_NOT_IMPLEMENTED',
 message: `harness '${this.id}' does not implement write(action)`
 });
 }

 /**
 * Optional handshake/first-prompt hook (post-open, pre-ready). Default submits the prompt via
 * `write`. Codex's protocol handshake lives in the transport's `open`, so it too uses the default.
 *
 * @access public
 * @param {Record<string, unknown>} _session - Session supplied to `start`.
 * @param {string} prompt - Prompt supplied to `start`.
 * @param {HarnessRunOptions} opts - Spawn options passed through from `run`.
 * @returns {Promise<import('./schema.mjs').Result|void>} Promise that resolves after the prompt is submitted.
 */
 async start(_session, prompt, opts) {
 await this.write({
 kind: 'prompt',
 text: prompt
 });
 }

 // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────

 /**
 * Spawn-and-drive: open the transport, build + freeze the session capability descriptor, start the
 * read loop, submit the first prompt, arm activity detection, and return the bound `Session`. This
 * is the entry point `sumo.run(...)` calls (`adapter.run(prompt, opts)`).
 *
 * @access public
 * @param {string} prompt - Prompt supplied to `run`.
 * @param {HarnessRunOptions} opts - Spawn options for the harness session.
 * @returns {Promise<Record<string, unknown>>} Session handle returned by the configured builder.
 */
 async run(prompt, opts = {}) {
 const transport = this.transport;
 if (!transport) {
 throw new SumoError({
 name: 'harness',
 method: 'transport',
 code: 'SUMO_NO_TRANSPORT',
 message: `harness '${this.id}' has no transport`
 });
 }

 // Resolve the EFFECTIVE launch mode once (): the transport's `#interactive` was locked from
 // `config.mode` at construction and could not see a runtime `opts.mode`. Resolve `opts → config →
 // default`, push it to the transport (so its real behavior matches), and use the SAME value for the
 // capability descriptor below — so the session never advertises interactive key support over a
 // transport that launched headless.
 const configuredMode = this.ctx.config.mode;
 const mode = opts.mode ?? (configuredMode === 'interactive' || configuredMode === 'default' ? configuredMode: 'default');
 opts = {
 ...opts,
 ...(await this.#modelOptions(opts)),
 mode
 };
 transport.setMode(mode);

 // Optional pre-open hook: a positional-prompt harness (Cursor) injects the prompt into spawn args
 // here, before the transport spawns; interactive harnesses also swap their headless args for the
 // real TUI here. Channel-prompt harnesses (Claude stdin, Codex turn/start) submit via `start`.
 const extension = /** @type {{ prepare?: (prompt: string, opts: HarnessRunOptions) => Promise<void>|void }} */ (/** @type {unknown} */ (this));
 if (typeof extension.prepare === 'function') {
 await extension.prepare(prompt, opts);
 }

 // `open` itself can fail after it has started a real process/connection (for example a Codex
 // app-server handshake error). Any failure from open through first prompt submission must reap the
 // transport, otherwise spawn rejects while the harness keeps running.
 try {
 await transport.open();

 // Interactive key/capture genuinely require tmux — probe it once and gate the capability on the
 // real answer (declare-don't-fake), rather than on method presence alone.
 const tmuxOk = mode === 'interactive' ? await tmuxAvailable() : false;
 const capabilities = this.capabilitiesFor(mode, {
 tmuxAvailable: tmuxOk
 });
 const steering = await this.verifySteering(opts, capabilities);
 capabilities.steeringVerified = steering.ok;
 if (steering.ok) {
 capabilities.canDeny = Boolean(this.can.hooks);
 } else {
 capabilities.canDeny = false;
 capabilities.canModifyInput = false;
 capabilities.canAsk = false;
 capabilities.canDefer = false;
 }
 const sessionId = opts.sessionId ?? id();
 this.#sessionId = sessionId;
 this.#nativeIdRecorded = false;

 const queue = /** @type {AsyncQueue<Record<string, unknown>>} */ (new AsyncQueue());
 this.#queue = queue;
 /** @type {(value?: unknown) => void} */
 let resolveDone;
 const donePromise = new Promise((r) => (resolveDone = r));
 this.#startedAt = Date.now();

 await this.#writeSessionDoc(sessionId, opts, capabilities, steering.diagnostics);
 await this.#appendSteeringDiagnostics(sessionId, steering.diagnostics);

 const session = this.#buildSession({
 id: sessionId,
 capabilities,
 queue,
 donePromise
 });

 // Read loop: frames → events → dedupe → append + surface. Runs detached; ends on transport close.
 this.#readLoop(transport, sessionId, queue, capabilities)
 .catch(() => {})
 .finally(() => {
 this.#emitLifecycleClose(sessionId, queue, capabilities, opts);
 queue.close();
 resolveDone();
 });

 // First prompt (handshake already done by transport.open for the server kind).
 await this.start(session, prompt, opts);

 return session;
 } catch (err) {
 try {
 transport.kill();
 } catch { /* best-effort reap — never mask the original failure */ }
 try {
 await transport.close?.();
 } catch { /* best-effort reap — never mask the original failure */ }
 throw err;
 }
 }

 // ── Internals ──────────────────────────────────────────────────────────────────────────────────

 /** @type {string} */ #sessionId = '';
 /** @type {AsyncQueue<Record<string, unknown>>|null} */ #queue = null;
 #startedAt = 0;

 /**
 * Intersect declared `can` with transport presence + launch mode to produce the frozen per-session
 * descriptor (spec 04). `canSendKey` and `observationSource` are independent of each other (the tmux
 * decision): interactive mode gives key/pane control but flips observation to the transcript (09).
 * Interactive key/capture additionally require tmux to actually be present — the caller probes it and
 * passes the result so the descriptor never claims a control surface the machine can't honor ().
 *
 * @access public
 * @param {'default'|'interactive'} mode - Mode supplied to `capabilitiesFor`.
 * @param {{ tmuxAvailable?: boolean }} opts - Options read by this operation.
 * @returns {import('sumo/session').CapabilitiesSchema} Import('sumo/session') capabilities schema returned by `capabilitiesFor`.
 */
 capabilitiesFor(mode = 'default', { tmuxAvailable = false } = {}) {
 const t = this.transport ?? {};
 const can = this.can;
 const interactive = mode === 'interactive';
 // Interactive control runs through a tmux pane; without tmux there is no pane to drive.
 const pane = interactive && tmuxAvailable;
 return {
 canSendKey: Boolean(can.key && typeof (/** @type {Record<string, unknown>} */ (t).key) === 'function' && pane),
 // Default mode captures the rolling stdout snapshot (no tmux); interactive capture needs the pane.
 canCapture: Boolean(can.capture && typeof (/** @type {Record<string, unknown>} */ (t).capture) === 'function' && (!interactive || tmuxAvailable)),
 canApprove: Boolean(can.approve && typeof (/** @type {Record<string, unknown>} */ (t).respondApproval) === 'function'),
 canCancel: Boolean(can.cancel && typeof (/** @type {Record<string, unknown>} */ (t).interrupt) === 'function'),
 canDefer: Boolean(can.defer),
 canInjectContext: Boolean(can.injectStdin),
 observationSource: interactive ? 'transcript-file': 'event-stream',
 transcriptComplete: this.transcriptComplete !== false,
 steeringVerified: false
 };
 }

 /**
 * Spawn-time install-and-verify hook (spec 04). The base default is deliberately unverified; concrete
 * hook-capable adapters prove their project-local Sumo hook install state and return diagnostics
 * when steering must be disabled for this session.
 *
 * @access public
 * @param {HarnessRunOptions} _opts - Spawn options used for the session.
 * @param {Capabilities} _capabilities - Capability descriptor built so far.
 * @returns {{ ok: boolean, diagnostics: Array<{ code: string, message: string }> }} Verification result.
 */
 // eslint-disable-next-line class-methods-use-this
 verifySteering(_opts = {}, _capabilities = {}) {
 return {
 ok: false,
 diagnostics: []
 };
 }

 /**
 * Pre-flight availability check: is the harness binary installed and runnable?
 * Returns `{ status: 'unknown' }` by default — we have not probed.
 * Adapters override with a real probe (`status: 'available' | 'unavailable'`).
 *
 * Callers MUST treat `'unknown'` as "attempt but don't preemptively skip" (declare-don't-fake:
 * a default `true` would claim availability for any harness that forgets to override).
 * @returns {Promise<{ status: 'available'|'unavailable'|'unknown', version?: string|null, reason?: string }>}
 */
 // eslint-disable-next-line class-methods-use-this, require-await
 /**
 * Base implementation for `available`.
 *
 * @access public
 * @returns {Promise<{ status: 'available'|'unavailable'|'unknown', version?: string|null, reason?: string }>} Availability state for this harness.
 */
 async available() {
 return { status: 'unknown' };
 }

 /**
 * The native CLI argv that resumes a session INTERACTIVELY (real TUI, the user's own terminal) — used
 * by `sumo attach` to hand off to the harness's own resume rather than re-implementing a stream-back.
 * Returns `null` by default: a harness with no native interactive resume declares it (don't fake).
 * Adapters override (e.g. Claude `['--resume', id]`, Codex `['resume', id]`).
 *
 * @access public
 * @param {string} _nativeId - the harness-native session id (the `harnessSessionId` on the ses: doc)
 * @returns {string[]|null} Native CLI arguments, or null when unsupported.
 */
 interactiveResumeArgv(_nativeId) {
 return null;
 }

 /**
 * Build the Session (Spark): capability-gated effectors + the ingest stream, bound by the base.
 *
 * @access public
 * @param {{ id: string, capabilities: Capabilities, queue: AsyncQueue<Record<string, unknown>>, donePromise: Promise<void> }} opts - Session construction inputs.
 * @returns {Record<string, unknown>} Session handle returned by the configured builder.
 */
 #buildSession({ id, capabilities, queue, donePromise }) {
 const self = this;
 /** @type {HarnessSessionSpec} */
 const spec = {
 id,
 state: 'running',
 capabilities,
 harness: this.id,
 /**
 * Send a prompt into the running harness session.
 *
 * @access public
 * @param {string} text - Text used in the generated output.
 * @returns {Promise<HarnessResult>} Result of the prompt send operation.
 */
 async send(text) {
 return self.#asResult(self.write({
 kind: 'prompt',
 text
 }));
 },
 /**
 * Send a command line into the running harness session.
 *
 * @access public
 * @param {string} line - Line supplied to `command`.
 * @returns {Promise<HarnessResult>} Result of the command send operation.
 */
 async command(line) {
 return self.#asResult(self.write({
 kind: 'command',
 line
 }));
 },
 /**
 * Send an interactive key press when the session supports key injection.
 *
 * @access public
 * @param {string} name - Name used by `key`.
 * @returns {Promise<HarnessResult>} Result of the key injection operation.
 */
 async key(name) {
 if (!capabilities.canSendKey) return fail(CAP_UNSUPPORTED, `${self.id}: key injection unsupported for this session`);
 return self.#asResult(self.transport?.key?.(name));
 },
 /**
 * Capture the transport pane/snapshot only when this session has that capability.
 *
 * @access public
 * @returns {Promise<HarnessResult>} Result containing the captured pane/snapshot.
 */
 async capture() {
 if (!capabilities.canCapture) return fail(CAP_UNSUPPORTED, `${self.id}: capture unsupported for this session`);
 const snap = await self.transport?.capture?.();
 return ok(snap);
 },
 /**
 * Forward an approval response through the transport.
 *
 * @access public
 * @param {ApprovalDecision} decision - Approval decision to echo back to the transport.
 * @returns {Promise<HarnessResult>} Result of the approval response operation.
 */
 async respondApproval(decision) {
 const transport = /** @type {{ respondApproval?: (decision: ApprovalDecision) => Promise<unknown>|unknown }} */ (self.transport);
 return self.#asResult(transport.respondApproval?.(decision));
 },
 /**
 * Interrupt the active turn without ending the session (declare-don't-fake — §3a/§3b).
 *
 * @access public
 * @returns {Promise<HarnessResult>} Result of the interrupt operation.
 */
 async cancel() {
 return self.#asResult(self.transport?.interrupt?.());
 },
 /**
 * The normalized event stream (the Spark's Duplex read side).
 *
 * @access public
 * @returns {AsyncIterableIterator<Record<string, unknown>>} Async iterator over normalized session events.
 */
 join() {
 return queue[Symbol.asyncIterator]();
 },
 /**
 * Resolves when the session's read loop has ended (transport closed).
 *
 * @access public
 * @returns {Promise<void>} Completion promise for the read loop.
 */
 done() {
 return donePromise;
 },
 /**
 * End the running harness session.
 *
 * @access public
 * @param {{ force?: boolean }} o - Options that configure `end`.
 * @returns {Promise<HarnessResult>} Result of the session close operation.
 */
 async end(o = {}) {
 const transport = self.transport;
 if (!transport) return fail(CAP_UNSUPPORTED, `${self.id}: transport is not available`);
 if (o.force) {
 transport.kill();
 await transport.close();
 } else {
 await transport.close();
 }
 return ok();
 }
 };
 // Approvals/cancel only exist when the session can do them (declare-don't-fake at the surface).
 if (!capabilities.canApprove) delete /** @type {Record<string, unknown>} */ (spec).respondApproval;
 if (!capabilities.canCancel) delete /** @type {Record<string, unknown>} */ (spec).cancel;
 const build = this.ctx.session;
 return build(spec);
 }

 /**
 * Normalize a `write`/effector return (Result | void | Promise) into a `Result`.
 *
 * @access public
 * @param {unknown} ret - Adapter return value to normalize.
 * @returns {Promise<HarnessResult>} Shared success/failure envelope.
 */
 async #asResult(ret) {
 const v = await ret;
 if (isResult(v)) return /** @type {HarnessResult} */ (v);
 return ok();
 }

 /**
 * The read loop: each frame → normalized events → EventInput → dedupe → append + surface.
 *
 * @access public
 * @param {HarnessTransport} transport - Transport supplying inbound frames.
 * @param {string} sessionId - Identifier used by `readLoop`.
 * @param {AsyncQueue<Record<string, unknown>>} queue - Session event queue.
 * @param {Capabilities} capabilities - Frozen per-session capability descriptor.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async #readLoop(transport, sessionId, queue, capabilities) {
 for await (const frame of transport.frames()) {
 this.#lastActivity = Date.now();
 const record = /** @type {Record<string, unknown>} */ (frame);
 const events = typeof record.__sumoRawStdout === 'string'
 ? [raw('session', 'stdout', { line: record.__sumoRawStdout })]
: this.read(record);
 for (const evt of events) {
 if (evt.type === 'session.started' && !this.#nativeIdRecorded) {
 this.#nativeIdRecorded = true;
 const nativeId = evt.payload?.sessionId ?? evt.sessionId;
 // The cwd the harness ACTUALLY ran in is the one the init frame reports (evt.payload.cwd) —
 // authoritative over opts/config, which can diverge from where the transport spawned. For
 // harnesses with a cwd+native-id-derivable transcript path (Claude), record it now; the rest
 // (Codex's date-tree, Cursor) are filled by agent-artifacts on tail-discovery.
 // The cwd the init frame REPORTS is ground truth (where the process actually ran). Reconcile
 // the ses: doc to it (): the spawn-time writer only had the REQUESTED cwd, which can
 // diverge from where the transport launched — a doc that misreports its cwd is worse than one
 // that omits it. Only patch when the frame actually reports a cwd (else keep the recorded one).
 const reportedCwd = evt.payload?.cwd;
 const cwd = reportedCwd ?? /** @type {Record<string, unknown>} */ (this.ctx.config).cwd;
 const transcriptPath = typeof nativeId === 'string' && typeof cwd === 'string' ? this.transcriptPathFor(nativeId, cwd): undefined;
 void this.#patchSessionDoc(withDefined(
 {
 updatedAt: Date.now()
 },
 {
 harnessSessionId: nativeId,
 cwd: typeof reportedCwd === 'string' && reportedCwd ? reportedCwd: undefined,
 transcriptPath
 }
 ));
 }
 const input = this.toEvent(evt, sessionId);
 // Surface the SAME stamping to join: the Sumo id is the spine on the live surface too, with
 // the native id in ext.nativeSessionId — the orchestrator/plugin stream must not see native ids.
 await this.#append(input);
 queue.push(withDefined(
 {
 ...evt,
 ext: input.ext,
 dedupe: input.dedupe
 },
 {
 sessionId: input.sessionId
 }
 ));
 }
 }
 }

 /**
 * Map one parser `NormalizedEventInput` → a `sumo/db` `EventInput` (the explicit field mapping — no
 * payload nesting). The base owns `dedupe`/`source`/`adapter`; the parser owned the rest.
 *
 * @access public
 * @param {import('sumo/transcript').NormalizedEventInput} evt - Evt supplied to `toEvent`.
 * @param {string} sessionId - Identifier used by `toEvent`.
 * @returns {Record<string, unknown>} Structured output from `toEvent`.
 */
 toEvent(evt, sessionId = this.#sessionId) {
 // The dedupe key is derived from `evt` (unchanged) + the Sumo fallback `sessionId` — left exactly
 // as the on-disk source computes it . The *stamped* `sessionId` field is a separate concern:
 // it is the Sumo `ses_<ulid>` spine: with the harness-native id recorded in `ext` (§3c).
 const dedupe = forEvent(evt, {
 sessionId,
 position: this.#pos++
 });
 const ext = evt.sessionId
 ? {
 ...(evt.ext ?? {}),
 nativeSessionId: evt.sessionId
 }
: (evt.ext ?? {});
 return withDefined(
 {
 dedupe,
 type: evt.type,
 payload: evt.payload ?? {},
 ext,
 source: 'session',
 adapter: this.id
 },
 {
 sessionId,
 ts: evt.ts
 }
 );
 }

 /**
 * Hook: the on-disk transcript path for this session, when derivable from the native id + cwd alone.
 * The base can't know any harness's path scheme, so it derives nothing; adapters whose path is a pure
 * function of (nativeId, cwd) override this (Claude). Harnesses whose path isn't so derivable (Codex's
 * date-tree, Cursor) return undefined here and let `sumo/agent-artifacts` record it on tail-discovery.
 *
 * @access public
 * @param {string} _nativeId - Identifier used by `transcriptPathFor`.
 * @param {string} _cwd - Filesystem location used by `transcriptPathFor`.
 * @returns {string|undefined} String undefined returned by `transcriptPathFor`.
 */
 transcriptPathFor(_nativeId, _cwd) {
 return undefined;
 }

 /**
 * Append through the injected daemon client, if any. A configured daemon is the durable source of
 * truth, so its failures stop the loop rather than surfacing an event that was never persisted.
 *
 * @access public
 * @param {Record<string, unknown>} input - Event input to append.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async #append(input) {
 const db = this.ctx.db;
 if (!db?.append) return;
 await db.append(input);
 }

 #lastActivity = 0;
 #nativeIdRecorded = false;

 /**
 * Resolve `opts.model` / `config.model` through this adapter's runtime model catalog.
 *
 * @access private
 * @param {HarnessRunOptions} opts - Spawn options read by the operation.
 * @returns {Promise<Partial<HarnessRunOptions>>} Model fields to merge onto the spawn options.
 */
 async #modelOptions(opts) {
 const configModel = this.ctx.config.model;
 const requested = opts.model ?? (typeof configModel === 'string' ? configModel: undefined);
 const resolved = await resolve(requested, this);
 if (!resolved.ok) {
 throw new SumoError({
 name: 'harness',
 method: 'models.resolve',
 code: resolved.code,
 message: resolved.reason
 });
 }
 return withDefined(
 {},
 {
 model: resolved.model,
 requested: resolved.requested && resolved.requested !== resolved.model ? resolved.requested: undefined,
 tier: resolved.tier
 }
 );
 }

 // ── Session document writer (spec 04 — spawn-time recording) ────────────────────────────────

 /**
 * Write the initial `ses:<id>` document after transport.open. This is the spawn-time half of the
 * correlation spine, so unlike the later best-effort `#patchSessionDoc` it does NOT swallow failures:
 * it runs inside `run`'s reap-on-throw guard, and a session with no doc is an untracked ghost
 * process — worse than a loud spawn rejection. A `SessionSchema.parse` failure is a contract violation
 * (programmer error, §3b); a `db.put` failure is the spine write being lost. Both must surface.
 *
 * @access public
 * @param {string} sessionId - Identifier used by `writeSessionDoc`.
 * @param {HarnessRunOptions} opts - Spawn options used to seed the session document.
 * @param {Capabilities} capabilities - Capability descriptor selected for this session.
 * @param {Array<{ code: string, message: string }>} steeringDiagnostics - Verification diagnostics recorded on the session.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async #writeSessionDoc(sessionId, opts, capabilities, steeringDiagnostics = []) {
 const db = this.ctx.db;
 if (!db?.put) return;
 const now = Date.now();
 // Record the concrete adapter model used for launch, plus the portable tier/request in ext when a
 // user-facing tier or alias was resolved to a provider-specific model id.
 const model = opts.model;
 const configCwd = this.ctx.config.cwd;
 const cwd = opts.cwd ?? (typeof configCwd === 'string' ? configCwd : process.cwd());
 const transport = this.transport;
 const nativeId = typeof transport?.sessionId === 'string' && transport.sessionId ? transport.sessionId: undefined;
 const doc = withDefined(
 {
 id: sessionId,
 harness: this.id,
 cwd,
 state: 'running',
 // Record the observation source so the always-on transcript ingestion service can tell a
 // live-streamed (event-stream) session — which it must NOT double-ingest — from an interactive
 // (transcript-file) one, whose transcript is the only source and DOES need ingesting.
 createdAt: now,
 updatedAt: now,
 ext: withDefined(
 {},
 {
 resumeId: opts.resume,
 requested: opts.requested,
 tier: opts.tier,
 capabilities,
 steeringDiagnostics: steeringDiagnostics.length ? steeringDiagnostics: undefined
 }
 )
 },
 {
 model,
 pid: transport?.pid,
 harnessSessionId: nativeId,
 transcriptPath: nativeId ? this.transcriptPathFor(nativeId, cwd): undefined,
 observationSource: capabilities.observationSource
 }
 );
 // No catch: a parse (contract) or put (spine-write) failure propagates to run's outer catch,
 // which reaps the live transport and rejects the spawn — never a silently dropped doc.
 SessionSchema.parse(doc);
 await db.put(key(sessionId), doc);
 }

 /**
 * Surface spawn-time steering verification failures on the event log for diagnostics tooling.
 *
 * @access private
 * @param {string} sessionId - Session receiving the diagnostic.
 * @param {Array<{ code: string, message: string }>} diagnostics - Verification diagnostics to append.
 * @returns {Promise<void>} Resolves after best-effort append attempts.
 */
 async #appendSteeringDiagnostics(sessionId, diagnostics) {
 for (const diagnostic of diagnostics) {
 await this.#append({
 dedupe: `session:${sessionId}:diagnostic:${diagnostic.code}`,
 type: 'session.diagnostic',
 sessionId,
 source: 'session',
 adapter: this.id,
 payload: diagnostic,
 ext: {
 scope: 'steering'
 }
 });
 }
 }

 /**
 * Merge a patch onto the `ses:<id>` document via the daemon's atomic doc-merge. Going through
 * `mergeDoc` (not a client read-modify-write) is what makes this race-free against the OTHER writer
 * of this same doc — `sumo/agent-artifacts`, which records `transcriptPath` on tail-discovery: the
 * daemon serializes both merges so neither drops the other's field. Best-effort: never crashes.
 *
 * @access public
 * @param {Record<string, unknown>} patch - Session document patch to merge atomically.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async #patchSessionDoc(patch) {
 const db = this.ctx.db;
 if (!db?.mergeDoc) return;
 try {
 await db.mergeDoc(key(this.#sessionId), patch);
 } catch { /* best-effort */ }
 }

 /**
 * On transport close: emit graceful end, crash, or rapid-death as a synthesized session.* event.
 *
 * @access public
 * @param {string} sessionId - Identifier used by `emitLifecycleClose`.
 * @param {AsyncQueue<Record<string, unknown>>} queue - Session event queue to close with a lifecycle event.
 * @param {Capabilities} capabilities - Frozen per-session capabilities.
 * @param {HarnessRunOptions} opts - Spawn options containing lifecycle thresholds.
 * @returns {void} Completes without producing a value.
 */
 #emitLifecycleClose(sessionId, queue, capabilities, opts) {
 const health = /** @type {{ code?: number|null, signal?: string|null }} */ (this.transport?.health ?? {});
 const elapsed = Date.now() - this.#startedAt;
 const rapidDeathMs = opts.rapidDeathMs ?? DEFAULTS.rapidDeathMs;
 const code = health.code ?? null;
 const signal = health.signal ?? null;
 const crashed = (code !== null && code !== 0) || signal !== null;
 let type = 'session.ended';
 if (crashed && elapsed < rapidDeathMs) type = 'session.rapid-death';
 else if (crashed) type = 'session.dead';

 // On crash, classify the failure from transport evidence so the orchestrator can route correctly.
 // `session.rapid-death` and `session.dead` include a `sumoCode` field the orchestrator reads.
 let sumoCode;
 if (crashed) {
 const evidence = this.transport?.evidence;
 if (evidence) sumoCode = classify(evidence).code;
 }

 /** @type {Record<string, unknown>} */
 let payload;
 if (type === 'session.ended') {
 payload = {
 outcome: 'completed'
 };
 } else {
 payload = withDefined(
 {
 code,
 signal
 },
 {
 sumoCode
 }
 );
 if (type === 'session.rapid-death') payload.sinceMs = elapsed;
 }

 const evt = {
 type,
 payload
 };
 // These synthesized lifecycle types are not in the parser's TYPES; carry them as session.*
 // events directly (they originate here, not from a transcript). The Sumo id is supplied via the
 // toEvent param (NOT as evt.sessionId): these events have no harness-native id, so leaving
 // evt.sessionId unset is what keeps toEvent from mislabeling the Sumo id as ext.nativeSessionId.
 const input = this.toEvent({
 ...evt,
 ext: {}
 }, sessionId);
 queue.push(withDefined(
 {
 ...evt,
 ext: input.ext,
 dedupe: input.dedupe
 },
 {
 sessionId: input.sessionId
 }
 ));
 void this.#append(input).catch(() => {});

 void this.#patchSessionDoc({
 state: type === 'session.ended' ? 'ended': 'dead',
 updatedAt: Date.now(),
 ext: {
 endedAt: Date.now()
 }
 });
 }
}
