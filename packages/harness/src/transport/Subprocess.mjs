/**
 * The shared child-process core both stdio transports compose (`Pipe`, `CodexAppServer`). It owns the
 * verified `node:child_process` pitfalls — the part that is genuinely identical whether the bytes on
 * the wire are newline-JSON or JSON-RPC — so neither transport re-implements process lifecycle:
 *
 *  - backpressure-aware stdin writes (await `drain` when the kernel buffer is full);
 *  - `detached`/`unref` backgrounding so a spawned harness does not pin the parent's event loop;
 *  - `exit`/`close` `(code, signal)` captured into `health`;
 *  - graceful quit → SIGTERM → SIGKILL escalation on `close()`.
 *
 * It is transport-agnostic: it surfaces raw stdout chunks via `chunks()`; framing (lines vs RPC) is
 * the composing transport's job. Discovered by the build, not designed up front — it was lifted only
 * once two of three transports turned out to be stdio subprocesses (the plan's discovery pass).
 *
 * @module sumo/harness/transport/Subprocess
 */

import { spawn } from 'node:child_process';

import { AsyncQueue } from './_queue.mjs';

/** Cap on the rolling stderr buffer — keeps enough for classification without unbounded growth. */
const STDERR_LIMIT = 16 * 1024;

/**
 * @typedef {object} SubprocessOptions
 * @property {string} command
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {Record<string,string>} [env]
 * @property {boolean} [detached] - background the child (also `unref`s it) so it outlives the parent loop
 */

/**
 * Provide the Subprocess implementation.
 *
 * @access public
 * @class
 */
export class Subprocess {
  /** @type {import('node:child_process').ChildProcess | null} */ #child = null;
  /** @type {AsyncQueue<Buffer>} */ #stdout = new AsyncQueue();
  /** @type {SubprocessOptions} */ #opts;
  /** @type {{ alive: boolean, code: number|null, signal: NodeJS.Signals|null, heartbeat: number }} */
  #health = { alive: false, code: null, signal: null, heartbeat: 0 };
  /** Rolling stderr buffer for post-mortem classification (bounded to STDERR_LIMIT). */
  #stderr = '';
  /** The OS-level spawn error (ENOENT = binary not found, EACCES = permission denied, …). */
  /** @type {Error|null} */
  #spawnError = null;
  /** Last stdin stream error, used to convert broken writes into rejected operations. */
  /** @type {Error|null} */
  #stdinError = null;

  /**
   * Create an instance.
   *
   * @access public
   * @param {SubprocessOptions} opts - Options read by this operation.
   */
  constructor(opts) {
    this.#opts = opts;
  }

  /**
   * Spawn the child and begin pumping stdout into the queue. Idempotent within one transport.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  start() {
    if (this.#child) return;
    const { command, args = [], cwd, env, detached = false } = this.#opts;
    const child = spawn(command, args, {
      cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'], detached
    });
    this.#child = child;
    this.#health.alive = true;
    if (detached) child.unref();

    child.stdout.on('data', (d) => {
      this.#health.heartbeat = this.#health.heartbeat + 1;
      this.#stdout.push(/** @type {Buffer} */ (d));
    });
    // Drain stderr into a bounded rolling buffer for post-mortem classification.
    // A full pipe would deadlock the child; the cap prevents unbounded growth.
    child.stderr.on('data', (d) => {
      this.#stderr = (this.#stderr + d.toString('utf8')).slice(-STDERR_LIMIT);
    });
    child.stdin.on('error', (err) => {
      this.#stdinError = err;
    });
    child.on('error', (err) => {
      this.#spawnError = err;
      this.#health.alive = false;
      this.#stdout.close();
    });
    child.on('close', (code, signal) => {
      this.#health.alive = false;
      this.#health.code = code;
      this.#health.signal = signal;
      this.#stdout.close();
    });
  }

  /**
   * Execute `pid`.
   *
   * @access public
   * @returns {number|undefined} Number undefined returned by `pid`.
   */
  get pid() {
    return this.#child?.pid;
  }

  /**
   * Liveness for stall detection. `heartbeat` increments on every stdout chunk.
 *
 * @access public
 * @returns {{ alive: boolean, code: number|null, signal: NodeJS.Signals|null, heartbeat: number }} Current subprocess liveness and exit state.
 */
  get health() {
    return this.#health;
  }

  /**
   * Post-mortem evidence for failure classification: stderr text, the spawn error (ENOENT etc.),
   * and process exit code/signal. Populated during and after the subprocess lifetime.
   *
   * @access public
   * @returns {{ stderr: string, spawnError: Error|null, exitCode: number|null, signal: string|null }} Structured output from `evidence`.
   */
  get evidence() {
    return {
      stderr: this.#stderr, spawnError: this.#spawnError, exitCode: this.#health.code, signal: this.#health.signal
    };
  }

  /**
   * Raw stdout chunks; the composing transport frames them. Ends when the child closes.
 *
 * @access public
 * @returns {AsyncIterableIterator<Buffer>} Raw stdout chunks from the child process.
 */
  chunks() {
    return this.#stdout[Symbol.asyncIterator]();
  }

  /**
   * Write to stdin, awaiting `drain` when the kernel buffer is full (backpressure). Resolves once the
   * bytes are accepted; rejects only on a programmer error (writing to a dead child).
   *
   * @access public
   * @param {string|Buffer} bytes - Bytes supplied to `write`.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  write(bytes) {
    const child = this.#child;
    if (!child || !child.stdin || !child.stdin.writable) {
      return Promise.reject(this.#stdinError ?? new Error('Subprocess.write: child stdin is not writable'));
    }
    return new Promise((resolve, reject) => {
      const stdin = child.stdin;
      if (!stdin) {
        reject(new Error('Subprocess.write: child stdin is not writable'));
        return;
      }
      let settled = false;
      /**
       * Resolve or reject the write once.
       *
       * @access public
       * @param {Error|undefined|null} err - Optional write failure.
       * @returns {void} Completes without producing a value.
       */
      const done = (err) => {
        if (settled) return;
        settled = true;
        stdin.off('error', onError);
        if (err) reject(err);
        else resolve();
      };
      /**
       * Forward a stdin error into the shared write completion path.
       *
       * @access public
       * @param {Error} err - Stdin error.
       * @returns {void} Completes without producing a value.
       */
      const onError = (err) => done(err);
      stdin.once('error', onError);
      try {
        stdin.write(bytes, (err) => done(err));
      } catch (err) {
        done(err);
      }
    });
  }

  /**
   * Signal end-of-input by closing the child's stdin (EOF). A one-shot harness (Claude `-p`
   * stream-json) completes its turn and exits only once stdin reaches EOF; without this the child
   * lingers on an open pipe and never closes stdout, so the read loop cannot end naturally.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  endInput() {
    try {
      this.#child?.stdin?.end();
    } catch {
      // stdin already closed/destroyed — nothing to signal
    }
  }

  /**
   * Graceful shutdown: SIGTERM, then SIGKILL after `timeoutMs` if the child has not closed. Resolves
   * once the child is gone (or was never started).
   *
   * @access public
   * @param {{ timeoutMs?: number }} opts - Options read by this operation.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  close({ timeoutMs = 2000 } = {}) {
    const child = this.#child;
    if (!child || !this.#health.alive) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, timeoutMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  /**
   * Send a signal to the child without tearing it down (e.g. SIGINT to interrupt generation).
   *
   * @access public
   * @param {NodeJS.Signals} sig - Sig supplied to `signal`.
   * @returns {void} Completes without producing a value.
   */
  signal(sig) {
    try {
      this.#child?.kill(sig);
    } catch {
      // already gone
    }
  }

  /**
   * Forced, immediate kill.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  kill() {
    try {
      this.#child?.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}
