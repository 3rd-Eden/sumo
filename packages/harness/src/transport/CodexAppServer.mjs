/**
 * The `server`-kind transport for Codex — `codex app-server` speaking JSON-RPC 2.0 over stdio
 * ( / ; the stable, supported channel chosen over the experimental `--listen unix://`).
 *
 * It is named concretely, NOT `Server`, on purpose: the `server` kind is sampled here from Codex
 * alone (OpenCode/HTTP+SSE is deferred), so this class owns Codex's JSON-RPC specifics — newline
 * framing, id-correlated `request()`, notification frames, the `initialize`→`thread/start` handshake,
 * and server-initiated approval requests — without pretending that shape is universal. A future
 * `OpenCodeServer` is a sibling transport, not a subclass forced through this one (the plan's
 * thin-server mitigation for the under-sampled kind).
 *
 * Protocol discipline that makes this a `server` and not a `pipe`, despite both being stdio children:
 * messages are correlated request/response, AND the server initiates its own requests (approvals) it
 * blocks on. A `pipe` is a fire-and-forget byte stream; this is not.
 *
 * @module sumo/harness/transport/CodexAppServer
 */

import { Transport } from './Transport.mjs';
import { Subprocess } from './Subprocess.mjs';
import { AsyncQueue } from './_queue.mjs';
import { ok, fail } from '../base/schema.mjs';
import { SumoError } from 'sumo/error';
import { withDefined } from 'sumo/util';

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Treat JSON-RPC object values as records and non-objects as empty records.
 *
 * @access private
 * @param {unknown} value - JSON-RPC value to inspect.
 * @returns {Record<string, unknown>} Record view of the value.
 */
function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * Return a JSON-RPC field only when it is a string.
 *
 * @access private
 * @param {unknown} value - JSON-RPC field to inspect.
 * @returns {string|undefined} String field value, when present.
 */
function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Frame a reply to a server-initiated approval request as a JSON-RPC response. The shape is CAPTURED,
 * not guessed (see `test/fixtures/codex/control/PROVENANCE.md`): the client echoes the request `id`
 * and sets `result.decision` to one of the request's `availableDecisions` (e.g. `'accept'`, `'cancel'`,
 * or `{ acceptWithExecpolicyAmendment: {...} }`). Replying with the bare string or a wrong value does
 * NOT approve — `result.decision` is the verified accepted shape.
 *
 * @access public
 * @param {{ requestId: number, decision: unknown }} reply - Reply supplied to `frameApprovalResponse`.
 * @returns {string} String returned by `frameApprovalResponse`.
 */
export function frameApprovalResponse({ requestId, decision }) {
  return JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { decision } }) + '\n';
}

/**
 * Provide the CodexAppServer implementation.
 *
 * @access public
 * @class
 * @typedef {object} CodexOptions
 * @property {string} [command] - default 'codex'
 * @property {string[]} [args]  - default ['app-server', '--stdio']
 * @property {string} [cwd]
 * @property {Record<string,string>} [env]
 * @property {{ name: string, version: string }} [clientInfo]
 * @property {string} [sandbox]           - thread sandbox mode (e.g. 'read-only')
 * @property {string} [approvalPolicy]    - 'never' | 'on-request' | …
 * @property {string} [resume]            - thread id to resume (open() calls thread/resume instead of thread/start)
 * @property {string[]} [optOutMethods]   - notification method names to suppress via initialize optOutNotificationMethods
 * @property {string} [model]             - model id passed to Codex.
 * @property {string} [reasoningEffort]   - reasoning effort passed to Codex.
 */
export class CodexAppServer extends Transport {
  kind = 'server';

  /** @type {CodexOptions} */ #opts;
  /** @type {Subprocess|null} */ #proc = null;
  /** @type {AsyncQueue<Record<string, unknown>>} */ #frames = new AsyncQueue();
  /** @type {Map<number, (m: { error?: { message?: string }, result?: unknown }) => void>} */ #pending = new Map();
  #buf = '';
  #nextId = 1;
  #threadId = '';
  /** The id of the currently-active turn on the main thread; cleared on turn/completed or interrupt. */
  #activeTurnId = '';

  /**
   * Create an instance.
   *
   * @access public
   * @param {CodexOptions} opts - Options read by this operation.
   */
  constructor(opts = {}) {
    super();
    this.#opts = opts;
  }

  /**
   * The Codex thread id established at handshake; the adapter's `turn/start` targets it.
   *
   * @access public
   * @returns {unknown} Return value from `threadId`.
   */
  get threadId() {
    return this.#threadId;
  }

  /**
   * Set the resume thread id before open() (called by the adapter's prepare()).
   *
   * @access public
   * @param {string} id - Identifier used by `resume`.
   * @returns {void} Completes without producing a value.
   */
  set resume(id) {
    this.#opts = { ...this.#opts, resume: id };
  }

  /**
   * Override the cwd before open() (called by the adapter's prepare()).
   *
   * @access public
   * @param {string} dir - Filesystem location used by `cwd`.
   * @returns {void} Completes without producing a value.
   */
  set cwd(dir) {
    this.#opts = { ...this.#opts, cwd: dir };
  }

  /**
   * Set the model before open() (included in the thread/start handshake).
   *
   * @access public
   * @param {string} id - Identifier used by `model`.
   * @returns {void} Completes without producing a value.
   */
  set model(id) {
    this.#opts = { ...this.#opts, model: id };
  }

  /**
   * Set reasoning effort before open() (included in the thread/start handshake).
   *
   * @access public
   * @param {string} level - Reasoning effort level to send in the handshake.
   * @returns {void} Completes without producing a value.
   */
  set reasoningEffort(level) {
    this.#opts = { ...this.#opts, reasoningEffort: level };
  }

  /**
   * Start the Codex app-server subprocess and perform the thread start/resume handshake.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async open() {
    const {
      command = 'codex', args = ['app-server', '--stdio'], cwd, env, clientInfo = { name: 'sumo', version: '0' }, sandbox = 'read-only', approvalPolicy = 'on-request', resume, optOutMethods, model, reasoningEffort
    } = this.#opts;

    this.#proc = new Subprocess({ command, args, cwd, env });
    this.#proc.start();
    this.#pump();

    // The handshake the CHANNEL owns (not the adapter): bring the app-server to a started thread.
    const initParams = withDefined({ clientInfo }, { optOutNotificationMethods: optOutMethods });
    const init = await this.request('initialize', initParams);
    if (!init.ok) throw new SumoError({ name: 'harness', method: 'CodexAppServer.connect', code: 'SUMO_SPAWN_FAILED', message: `codex initialize failed: ${init.reason}` });

    if (resume) {
      // Resume an existing thread; params shape: { threadId, cwd, approvalPolicy, sandbox } (no `ephemeral`).
      const resumed = await this.request('thread/resume', withDefined({ threadId: resume, cwd, sandbox, approvalPolicy }, { model, reasoningEffort }));
      if (!resumed.ok) throw new SumoError({ name: 'harness', method: 'CodexAppServer.connect', code: 'SUMO_SPAWN_FAILED', message: `codex thread/resume failed: ${resumed.reason}` });
      this.#threadId = stringValue(recordValue(recordValue(resumed.value).thread).id) ?? resume;
    } else {
      const started = await this.request('thread/start', withDefined({ cwd, sandbox, approvalPolicy }, { model, reasoningEffort }));
      if (!started.ok) throw new SumoError({ name: 'harness', method: 'CodexAppServer.connect', code: 'SUMO_SPAWN_FAILED', message: `codex thread/start failed: ${started.reason}` });
      this.#threadId = stringValue(recordValue(recordValue(started.value).thread).id) ?? '';
      if (!this.#threadId) throw new SumoError({ name: 'harness', method: 'CodexAppServer.connect', code: 'SUMO_SPAWN_FAILED', message: 'codex thread/start returned no thread id' });
    }
  }

  /**
   * Read newline-delimited JSON-RPC and route: response → resolve pending; method → inbound frame.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async #pump() {
    const proc = /** @type {Subprocess} */ (this.#proc);
    for await (const chunk of proc.chunks()) {
      this.#buf += chunk.toString('utf8');
      let i;
      while ((i = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, i).trim();
        this.#buf = this.#buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        this.#route(m);
      }
    }
    this.#frames.close();
  }

  /**
   * Execute `route`.
   *
   * @access public
   * @param {Record<string, unknown>} m - M supplied to `route`.
   * @returns {void} Completes without producing a value.
   */
  #route(m) {
    const isResponse = m.id !== undefined && m.method === undefined;
    if (isResponse) {
      const id = typeof m.id === 'number' ? m.id : Number(m.id);
      const waiter = Number.isFinite(id) ? this.#pending.get(id) : undefined;
      if (waiter) {
        this.#pending.delete(id);
        waiter(m);
      }
      return;
    }
    // Track active turn id from the main thread's turn/started notification (fixture-verified: the turn
    // id lives in params.turn.id on the notification, NOT in the turn/start response — turn.jsonl:2).
    const params = recordValue(m.params);
    if (m.method === 'turn/started' && params.threadId === this.#threadId) {
      this.#activeTurnId = stringValue(recordValue(params.turn).id) ?? '';
    } else if (m.method === 'turn/completed' && params.threadId === this.#threadId) {
      this.#activeTurnId = '';
    }
    // Anything with a `method` is inbound: a notification (no id) OR a server-initiated request (id).
    // Both are surfaced as frames so the parser can normalize them; a server-initiated request also
    // carries an id the orchestrator echoes back via respondApproval.
    this.#frames.push(m);
  }

  /**
   * Expose inbound app-server notifications/requests as parser frames.
   *
   * @access public
   * @returns {AsyncIterableIterator<Record<string, unknown>>} Inbound JSON-RPC notifications and server requests.
   */
  frames() {
    return this.#frames[Symbol.asyncIterator]();
  }

  /**
   * Report liveness for the app-server subprocess.
   *
   * @access public
   * @returns {{ alive: boolean, heartbeat?: number }} Current app-server liveness.
   */
  get health() {
    return this.#proc ? { alive: this.#proc.health.alive, heartbeat: this.#proc.health.heartbeat } : { alive: false };
  }

  /**
   * Issue a correlated JSON-RPC request and resolve to a `Result` (the server kind's effector). The
   * raw `result` rides `value`; an `error` or timeout is a failed `Result`, never a throw (§3b).
   *
   * @access public
   * @param {string} method - Method supplied to `request`.
   * @param {Record<string, unknown>} params - Parameters passed to the operation.
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `request`.
   */
  request(method, params = {}) {
    const proc = this.#proc;
    if (!proc || !proc.health.alive) return Promise.resolve(fail('SUMO_SESSION_DEAD', 'codex app-server is not running'));
    const id = this.#nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) resolve(fail('SUMO_VERIFY_FAILED', `codex ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) resolve(fail('SUMO_INTERNAL', `codex ${method}: ${m.error?.message ?? 'error'}`));
        else resolve(ok(m.result));
      });
      proc.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n').catch((err) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(fail('SUMO_SESSION_DEAD', `codex write failed: ${err.message}`));
      });
    });
  }

  /**
   * Reply to a server-initiated approval request (`item/commandExecution/requestApproval`) by echoing
   * its `requestId` with the chosen decision. The response shape is CAPTURED and verified end-to-end
   * against the real app-server (see `frameApprovalResponse` + the control fixture's PROVENANCE).
   *
   * @access public
   * @param {{ requestId: number, decision: unknown }} decision - `decision` is an `availableDecisions`
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `respondApproval`.
   */
  async respondApproval(decision) {
    const proc = this.#proc;
    if (!proc || !proc.health.alive) return fail('SUMO_SESSION_DEAD', 'codex app-server is not running');
    if (decision?.requestId === undefined) return fail('SUMO_INTERNAL', 'respondApproval requires a requestId');
    try {
      await proc.write(frameApprovalResponse(decision));
      return ok();
    } catch (err) {
      return fail('SUMO_SESSION_DEAD', `codex approval write failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * Interrupt the active turn on the main thread without ending the session. Cancel = interrupt
   * the in-flight generation; the thread stays alive for the next prompt (not the same as close/kill).
   * Returns `{ interrupted:false }` if no turn is currently active — cancel is idempotent; there is
   * nothing to interrupt but the capability IS supported. Returning SUMO_CAP_UNSUPPORTED here would be
   * wrong because the capability is real; the state condition is transient, not a missing feature.
   *
   * @access public
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `interrupt`.
   */
  async interrupt() {
    const proc = this.#proc;
    if (!proc || !proc.health.alive) return fail('SUMO_SESSION_DEAD', 'codex app-server is not running');
    if (!this.#activeTurnId) return ok({ interrupted: false });
    const turnId = this.#activeTurnId;
    const result = await this.request('turn/interrupt', { threadId: this.#threadId, turnId });
    if (!result.ok && /no active turn to interrupt/i.test(result.reason ?? '')) {
      this.#activeTurnId = '';
      return ok({ interrupted: false, threadId: this.#threadId, turnId });
    }
    if (!result.ok) return result;
    this.#activeTurnId = '';
    return ok({ interrupted: true, threadId: this.#threadId, turnId, response: result.value ?? null });
  }

  /**
   * Close the app-server subprocess gracefully.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async close() {
    await /** @type {Subprocess} */ (this.#proc)?.close();
  }

  /**
   * Force-stop the app-server subprocess.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  kill() {
    this.#proc?.kill();
  }

  /**
   * Post-mortem evidence for failure classification: subprocess stderr, OS spawn error,
   * and exit code/signal. The Codex transport emits no stdout snapshot (all output is JSON-RPC),
   * so `snapshot` is always empty; `stderr` is the main text evidence.
   *
   * @access public
   * @returns {{ stderr: string, snapshot: string, spawnError: Error|null, exitCode: number|null, signal: string|null }} Structured output from `evidence`.
   */
  get evidence() {
    const sub = this.#proc?.evidence ?? { stderr: '', spawnError: null, exitCode: null, signal: null };
    return { ...sub, snapshot: '' };
  }
}
