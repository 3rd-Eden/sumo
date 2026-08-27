/**
 * `server`-kind transport for GitHub Copilot — wraps `@github/copilot-sdk`, which manages the
 * `copilot` CLI subprocess and speaks JSON-RPC on our behalf. The SDK's `CopilotClient` is the
 * per-transport lifecycle owner; the `CopilotSession` is the per-session channel.
 *
 * @module sumo/harness/transport/CopilotServer
 */

import { Transport } from './Transport.mjs';
import { AsyncQueue } from './_queue.mjs';
import { ok, fail } from '../base/schema.mjs';
import { whichSync } from '../base/probe.mjs';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * @typedef {object} CopilotServerOptions
 * @property {string} [command]
 * @property {string} [cwd]
 * @property {Record<string,string>} [env]
 * @property {string} [model]
 * @property {string} [reasoningEffort]
 * @property {string} [resume]
 * @property {boolean} [enableFileHooks]
 * @property {(event: CopilotEvent) => void} [onEvent]
 *
 * @typedef {Record<string, unknown>} CopilotEvent
 * @typedef {{ kind: string, feedback?: string, reason?: string }} CopilotPermissionDecision
 * @typedef {{ success?: boolean }} CopilotPermissionResponse
 * @typedef {object} CopilotPermissions
 * @property {(opts: { required: boolean }) => Promise<unknown>} setRequired - Enable SDK permission mediation.
 * @property {(opts: { approveAllToolPermissionRequests: boolean, approveAllReadPermissionRequests: boolean }) => Promise<unknown>} configure - Configure SDK approval defaults.
 * @property {(opts: { requestId: string, result: CopilotPermissionDecision }) => Promise<CopilotPermissionResponse>} handlePendingPermissionRequest - Resolve a pending SDK permission request.
 * @typedef {object} CopilotSessionHandle
 * @property {string} [sessionId] - Native Copilot session id.
 * @property {{ permissions: CopilotPermissions }} rpc - SDK JSON-RPC namespaces used by this transport.
 * @property {(handler: (event: CopilotEvent) => void) => void} on - Subscribe to SDK session events.
 * @property {(text: string) => Promise<unknown>} send - Send user text into the session.
 * @property {() => Promise<unknown>} abort - Abort the active turn.
 * @property {() => Promise<unknown>} disconnect - Disconnect the session.
 * @typedef {object} CopilotClientHandle
 * @property {() => Promise<void>} start - Start the SDK runtime client.
 * @property {(config: Record<string, unknown>) => Promise<CopilotSessionHandle>} createSession - Create a new SDK session.
 * @property {(sessionId: string, config: Record<string, unknown>) => Promise<CopilotSessionHandle>} resumeSession - Resume an existing SDK session.
 * @property {() => Promise<void>} stop - Stop the SDK runtime client.
 * @property {() => void} [forceStop] - Force-stop helper exposed by some SDK versions.
 */

/**
 * SDK-backed Copilot server transport. It opens a real `@github/copilot-sdk` client/session, exposes SDK events as harness frames, and routes prompt/cancel effectors through the live session object.
 *
 * @access public
 * @class
 * @augments {Transport}
 */
export class CopilotServer extends Transport {
  /** @type {'server'} Transport kind consumed by harness capability derivation. */
  kind = 'server';

  /** @type {CopilotServerOptions} */ #opts;
  /** @type {CopilotClientHandle|null} */ #client = null;
  /** @type {CopilotSessionHandle|null} */ #session = null;
  /** @type {AsyncQueue<CopilotEvent>} */ #frames = new AsyncQueue();
  #sessionId = '';
  #alive = false;
  #heartbeat = 0;

  /**
   * Create an instance.
   *
   * @access public
   * @param {CopilotServerOptions} opts - Options read by this operation.
   */
  constructor(opts = {}) {
    super();
    this.#opts = opts;
  }

  /**
   * Native Copilot session id returned by the SDK after create/resume.
   *
   * @access public
   * @returns {string} String returned by `sessionId`.
   */
  get sessionId() {
    return this.#sessionId;
  }

  /**
   * Set the native session id to resume before `open()`.
   *
   * @access public
   * @param {string} id - Identifier used by `resume`.
   * @returns {void} Completes without producing a value.
   */
  set resume(id) {
    this.#opts = { ...this.#opts, resume: id };
  }

  /**
   * Set the working directory passed into the SDK client before `open()`.
   *
   * @access public
   * @param {string} dir - Filesystem location used by `cwd`.
   * @returns {void} Completes without producing a value.
   */
  set cwd(dir) {
    this.#opts = { ...this.#opts, cwd: dir };
  }

  /**
   * Select the model for the Copilot session before `open()`.
   *
   * @access public
   * @param {string} id - Identifier used by `model`.
   * @returns {void} Completes without producing a value.
   */
  set model(id) {
    this.#opts = { ...this.#opts, model: id };
  }

  /**
   * Select the Copilot reasoning effort for the session before `open()`.
   *
   * @access public
   * @param {string} level - Level supplied to `reasoningEffort`.
   * @returns {void} Completes without producing a value.
   */
  set reasoningEffort(level) {
    this.#opts = { ...this.#opts, reasoningEffort: level };
  }

  /**
   * Start the real Copilot runtime client and create or resume a session.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async open() {
    const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
    const { command = 'copilot', cwd, env, model, reasoningEffort, resume, enableFileHooks = true } = this.#opts;
    const runtimePath = resolveCopilotRuntime(command, env);

    const client = /** @type {CopilotClientHandle} */ (/** @type {unknown} */ (new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: runtimePath }),
      ...(cwd ? { workingDirectory: cwd } : {}),
      ...(env ? { env } : {})
    })));
    this.#client = client;

    await client.start();
    this.#alive = true;

    const sessionConfig = {
      ...(cwd ? { workingDirectory: cwd } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}), enableFileHooks
    };

    /** @type {CopilotSessionHandle} */
    let session;
    if (resume) {
      session = await client.resumeSession(resume, {
        ...sessionConfig, onPermissionRequest: holdPermissionRequest
      });
      this.#sessionId = resume;
    } else {
      session = await client.createSession({
        ...sessionConfig, onPermissionRequest: holdPermissionRequest
      });
      this.#sessionId = session.sessionId ?? '';
    }
    this.#session = session;

    if (!this.#sessionId) {
      await this.#cleanup();
      throw new Error('copilot: session created but returned no sessionId');
    }

    await session.rpc.permissions.setRequired({ required: true });
    await session.rpc.permissions.configure({
      approveAllToolPermissionRequests: false, approveAllReadPermissionRequests: false
    });

    session.on((event) => {
      try {
        this.#opts.onEvent?.(event);
      } catch {}
      this.#heartbeat++;
      this.#frames.push(event);
    });
  }

  /**
   * Expose SDK session events as parser frames.
   *
   * @access public
   * @returns {AsyncIterableIterator<object>} Async iterator produced by `frames`.
   */
  frames() {
    return this.#frames[Symbol.asyncIterator]();
  }

  /**
   * Lightweight liveness descriptor used by harness sessions and cleanup tests.
   *
   * @access public
   * @returns {{ alive: boolean, heartbeat: number }} Structured output from `health`.
   */
  get health() {
    return { alive: this.#alive, heartbeat: this.#heartbeat };
  }

  /**
   * Route a server-kind effector through the Copilot SDK session.
   *
   * @access public
   * @param {string} method - Method supplied to `request`.
   * @param {{ prompt?: string }} params - Parameters passed to the operation.
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `request`.
   */
  async request(method, params = {}) {
    if (!this.#session || !this.#alive) return fail('SUMO_SESSION_DEAD', 'copilot: no active session');
    if (method === 'session/send') {
      try {
        await this.#session.send(params.prompt ?? '');
        return ok();
      } catch (err) {
        return fail('SUMO_SESSION_DEAD', `copilot session/send failed: ${/** @type {Error} */ (err).message}`);
      }
    }
    return fail('SUMO_NOT_IMPLEMENTED', `copilot: unsupported method '${method}'`);
  }

  /**
   * Abort the active Copilot turn while leaving the session object reusable.
   *
   * @access public
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `interrupt`.
   */
  async interrupt() {
    if (!this.#session || !this.#alive) return fail('SUMO_SESSION_DEAD', 'copilot: no active session');
    try {
      await this.#session.abort();
      return ok({ interrupted: true });
    } catch (err) {
      return ok({ interrupted: false, reason: /** @type {Error} */ (err).message });
    }
  }

  /**
   * Reply to a pending Copilot SDK permission request.
   *
   * @access public
   * @param {{ requestId?: string, decision?: string, reason?: string }} decision - Decision object to translate.
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `respondApproval`.
   */
  async respondApproval(decision = {}) {
    if (!this.#session || !this.#alive) return fail('SUMO_SESSION_DEAD', 'copilot: no active session');
    const requestId = decision.requestId;
    if (!requestId) return fail('SUMO_INVALID_ARGUMENT', 'copilot approval response requires requestId');
    try {
      const result = await this.#session.rpc.permissions.handlePendingPermissionRequest({
        requestId, result: toCopilotPermissionDecision(decision)
      });
      return ok({ applied: Boolean(result?.success) });
    } catch (err) {
      return fail('SUMO_SESSION_DEAD', `copilot approval write failed: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * Disconnect the session and stop the SDK client gracefully.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async close() {
    this.#alive = false;
    await this.#cleanup();
    this.#frames.close();
  }

  /**
   * Force-stop the SDK client if the SDK exposes a force stop helper.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  kill() {
    this.#alive = false;
    if (this.#client) {
      try {
        this.#client.forceStop?.();
      } catch {}
      this.#client = null;
    }
    this.#session = null;
    this.#frames.close();
  }

  /**
   * Best-effort SDK session/client cleanup shared by graceful close and failed open.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async #cleanup() {
    if (this.#session) {
      try { await this.#session.disconnect(); } catch {}
      this.#session = null;
    }
    if (this.#client) {
      try { await this.#client.stop(); } catch {}
      this.#client = null;
    }
  }

  /**
   * Copilot SDK hides subprocess stderr today, so lifecycle evidence is intentionally empty.
   *
   * @access public
   * @returns {{ stderr: string, snapshot: string, spawnError: null, exitCode: null, signal: null }} Structured output from `evidence`.
   */
  get evidence() {
    return { stderr: '', snapshot: '', spawnError: null, exitCode: null, signal: null };
  }
}

/**
 * Resolve the real GitHub Copilot CLI runtime used by `@github/copilot-sdk`.
 * The workspace can have a `copilot` shim earlier on PATH. For the default
 * Copilot adapter path, prefer the npm package installed with the SDK and only fall back to PATH when
 * it is not a private shim path. Explicit config/env overrides are honored.
 *
 * @access public
 * @param {string} command - Command supplied to `resolveCopilotRuntime`.
 * @param {Record<string,string|undefined>} env - Environment variables used by the operation.
 * @returns {string} String returned by `resolveCopilotRuntime`.
 */
export function resolveCopilotRuntime(command = 'copilot', env = process.env) {
  const configured = env.SUMO_COPILOT_BIN || command;
  if (configured && configured !== 'copilot') {
    return configured.includes('/') ? configured : (whichSync(configured) ?? configured);
  }

  const packaged = packagedCopilotBin();
  if (packaged) return packaged;

  const found = whichSync('copilot');
  if (found && !isPrivateShimPath(found)) return found;

  throw new Error(
    'copilot: default PATH resolves to a private shim and no packaged @github/copilot binary was found; ' +
    'install dependencies or set SUMO_COPILOT_BIN to the npm-installed Copilot CLI'
  );
}

/**
 * Resolve `@github/copilot` from the SDK dependency tree and return its declared bin.
 *
 * @access private
 * @returns {string|null} String null returned by `packagedCopilotBin`.
 */
function packagedCopilotBin() {
  try {
    const sdkMain = require.resolve('@github/copilot-sdk');
    const sdkRequire = createRequire(sdkMain);
    const copilotPackage = sdkRequire.resolve('@github/copilot/package.json');
    const pkg = JSON.parse(readFileSync(copilotPackage, 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.copilot;
    if (!bin) return null;
    const resolved = path.join(path.dirname(copilotPackage), bin);
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Detect whether a resolved Copilot path points inside a private shim directory.
 *
 * @access private
 * @param {string} file - Resolved file path to inspect.
 * @returns {boolean} Whether the path is inside a hidden shim directory.
 */
function isPrivateShimPath(file) {
  const parts = file.split(path.sep);
  return parts.includes('shims') && parts.some((part) => part.startsWith('.') && part !== '.');
}

/**
 * Keep permission requests pending so Sumo's orchestrator can decide through `respondApproval()`.
 *
 * @access private
 * @returns {{ kind: 'no-result' }} Structured output from `holdPermissionRequest`.
 */
function holdPermissionRequest() {
  return { kind: 'no-result' };
}

/**
 * Translate a Sumo permission decision into Copilot SDK syntax.
 *
 * @access public
 * @param {{ decision?: string, reason?: string }} decision - Decision object to translate.
 * @returns {{ kind: string, feedback?: string }} Structured output from `toCopilotPermissionDecision`.
 */
export function toCopilotPermissionDecision(decision) {
  if (decision.decision === 'accept' || decision.decision === 'approve' || decision.decision === 'allow') {
    return { kind: 'approve-once' };
  }
  if (decision.decision === 'acceptForSession' || decision.decision === 'approveForSession') {
    return { kind: 'approve-for-session' };
  }
  if (decision.decision === 'cancel') {
    return { kind: 'cancelled', ...(decision.reason ? { reason: decision.reason } : {}) };
  }
  return { kind: 'reject', ...(decision.reason ? { feedback: decision.reason } : {}) };
}
