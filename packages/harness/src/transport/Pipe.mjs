/**
 * The `pipe`-kind transport (Claude Code, Cursor): a subprocess driven over stdin/stdout with
 * newline-JSON framing. It composes `Subprocess` for the verified process lifecycle and adds only the
 * pipe-specific concerns: line framing of stdout into JSON frames, stdin `send`, a rolling raw
 * snapshot for `capture()`, and — in interactive mode — a tmux pane for `key()`/`capture()`.
 *
 * Two launch modes (the committed tmux architecture, spec 04):
 *  - `'default'`: plain `Subprocess` stdio. Clean newline-JSON `frames()`; `send()` writes stdin;
 *    `capture()` returns the rolling raw stdout snapshot. This is the 1.0 read/write path.
 *  - `'interactive'`: the harness runs inside a tmux pane for human takeover. `frames()` is EMPTY by
 *    design — pane output is not a clean event source; live events come from the transcript (09).
 *    `key()`/`capture()` drive the pane via tmux. The base records `observationSource:'transcript-file'`.
 *
 * @module sumo/harness/transport/Pipe
 */

import { Transport } from './Transport.mjs';
import { Subprocess } from './Subprocess.mjs';
import { AsyncQueue } from './_queue.mjs';
import { tmuxSpawn, tmuxSendKeys, tmuxCapture, tmuxKill } from './tmux.mjs';
import { ok, fail } from '../base/schema.mjs';

/** Cap on the rolling raw-output snapshot kept for `capture()` (default mode). */
const SNAPSHOT_LIMIT = 64 * 1024;

/**
 * Provide the Pipe implementation.
 *
 * @access public
 * @class
 * @typedef {object} PipeOptions
 * @property {string} command
 * @property {string[]} [args]
 * @property {string} [cwd]
 * @property {Record<string,string>} [env]
 * @property {'default'|'interactive'} [mode]
 * @property {string} [session] - tmux session name (interactive mode); defaults to a derived name
 */
export class Pipe extends Transport {
  kind = 'pipe';

  /** @type {PipeOptions} */ #opts;
  /** @type {Subprocess|null} */ #proc = null;
  /** @type {AsyncQueue<Record<string, unknown>>} */ #frames = new AsyncQueue();
  #snapshot = '';
  #buf = '';
  #session = '';
  #interactive = false;

  /**
   * Create an instance.
   *
   * @access public
   * @param {PipeOptions} opts - Options read by this operation.
   */
  constructor(opts) {
    super();
    this.#opts = opts;
    this.#interactive = opts.mode === 'interactive';
    // tmux session names cannot contain `.` or `:` and a `/` breaks pane targeting — the command is
    // often an absolute binary path (e.g. `~/.local/.../2.1.191`), so derive the name from a sanitized
    // basename rather than the raw command.
    const base = String(opts.command).split('/').pop() || 'harness';
    this.#session = opts.session ?? `sumo-${base.replace(/[^a-zA-Z0-9]+/g, '-')}-${process.pid}`;
  }

  /**
   * Execute `interactive`.
   *
   * @access public
   * @returns {boolean} Whether `interactive` matched the expected condition.
   */
  get interactive() {
    return this.#interactive;
  }

  /**
   * Execute `args`.
   *
   * @access public
   * @returns {string[]} List produced by `args`.
   */
  get args() {
    return [...(this.#opts.args ?? [])];
  }

  /**
   * Append spawn args before `open()`. Used by positional-prompt harnesses (Cursor) whose first
   * prompt is a CLI argument rather than a channel write — the adapter injects it in `prepare()`.
   *
   * @access public
   * @param {string[]} extra - Additional metadata.
   * @returns {void} Completes without producing a value.
   */
  addArgs(extra) {
    this.#opts = { ...this.#opts, args: [...(this.#opts.args ?? []), ...extra] };
  }

  /**
   * Override the cwd before `open()`. Used when runtime `opts.cwd` should override `config.cwd`.
   *
   * @access public
   * @param {string} dir - Filesystem location used by `setCwd`.
   * @returns {void} Completes without producing a value.
   */
  setCwd(dir) {
    this.#opts = { ...this.#opts, cwd: dir };
  }

  /**
   * Set the effective launch mode before `open()` — the base resolves `opts.mode ?? config.mode`, which
   * the construction-time `config.mode` could not see. Recomputes the interactive (tmux) decision so the
   * transport's real behavior matches the capabilities the base advertises ().
   *
   * @access public
   * @param {'default'|'interactive'} mode - Mode supplied to `setMode`.
   * @returns {void} Completes without producing a value.
   */
  setMode(mode) {
    this.#interactive = mode === 'interactive';
  }

  /**
   * Replace the base spawn args before `open()` (NOT additive — unlike `addArgs`). A pipe harness is
   * launched headless (`-p`/stream-json) by default; interactive (tmux) mode needs the harness's real
   * TUI instead, so the adapter swaps in the interactive base args here and then `addArgs` layers on
   * `--model`/`--resume`. Keeping this separate from `addArgs` preserves those extras' ordering.
   *
   * @access public
   * @param {string[]} args - Argument object accepted by `setBaseArgs`.
   * @returns {void} Completes without producing a value.
   */
  setBaseArgs(args) {
    this.#opts = { ...this.#opts, args: [...args] };
  }

  /**
   * Start either the headless subprocess or the interactive tmux session.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async open() {
    const { command, args = [], cwd, env } = this.#opts;
    if (this.#interactive) {
      await tmuxSpawn({ session: this.#session, command, args, cwd });
      // No stdout pump: pane output is not framed (observationSource = transcript-file). frames() ends.
      this.#frames.close();
      return;
    }
    this.#proc = new Subprocess({ command, args, cwd, env });
    this.#proc.start();
    this.#pump();
  }

  /**
 * Read raw stdout chunks, keep the rolling snapshot, and split newline-JSON into frames. Non-JSON
 * lines are surfaced as raw frames so the harness can retain them under a redacted raw reference.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async #pump() {
    const proc = /** @type {Subprocess} */ (this.#proc);
    for await (const chunk of proc.chunks()) {
      const text = chunk.toString('utf8');
      this.#snapshot = (this.#snapshot + text).slice(-SNAPSHOT_LIMIT);
      this.#buf += text;
      let i;
      while ((i = this.#buf.indexOf('\n')) >= 0) {
        const line = this.#buf.slice(0, i).trim();
        this.#buf = this.#buf.slice(i + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          frame = { __sumoRawStdout: line };
        }
        this.#frames.push(frame);
      }
    }
    const trailing = this.#buf.trim();
    if (trailing) {
      try {
        this.#frames.push(JSON.parse(trailing));
      } catch {
        this.#frames.push({ __sumoRawStdout: trailing });
      }
    }
    this.#buf = '';
    this.#frames.close();
  }

  /**
   * Expose parsed newline-JSON frames from the headless subprocess.
   *
   * @access public
   * @returns {AsyncIterableIterator<Record<string, unknown>>} Parsed newline-JSON frames.
   */
  frames() {
    return this.#frames[Symbol.asyncIterator]();
  }

  /**
   * Report liveness for the active pipe transport mode.
   *
   * @access public
   * @returns {{ alive: boolean, heartbeat?: number, code?: number|null, signal?: NodeJS.Signals|null }} Current process or tmux-pane health.
   */
  get health() {
    if (this.#interactive) return { alive: true };
    return this.#proc ? this.#proc.health : { alive: false };
  }

  /**
   * Post-mortem evidence for failure classification. Combines the subprocess's stderr + OS errors
   * with the rolling stdout snapshot (which captures non-JSON lines like error banners / budget messages
   * that Pipe's pump drops from `frames()`). Only meaningful in default (non-interactive) mode.
   *
   * @access public
   * @returns {{ stderr: string, snapshot: string, spawnError: Error|null, exitCode: number|null, signal: string|null }} Structured output from `evidence`.
   */
  get evidence() {
    const sub = this.#proc?.evidence ?? { stderr: '', spawnError: null, exitCode: null, signal: null };
    return { ...sub, snapshot: this.#snapshot };
  }

  /**
   * Execute `pid`.
   *
   * @access public
   * @returns {number|null} Number null returned by `pid`.
   */
  get pid() {
    return this.#proc?.pid ?? null;
  }

  /**
   * Write bytes to the harness. Default mode: stdin. Interactive mode: typed into the pane literally,
   * followed by Enter (human-takeover semantics).
   *
   * @access public
   * @param {string|Buffer} bytes - Bytes supplied to `send`.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async send(bytes) {
    if (this.#interactive) {
      await tmuxSendKeys(this.#session, bytes.toString(), { literal: true });
      await tmuxSendKeys(this.#session, 'Enter');
      return;
    }
    await /** @type {Subprocess} */ (this.#proc).write(bytes);
  }

  /**
   * Signal end-of-input (close stdin → EOF). Default mode only — interactive mode has no stdin pipe
   * (tmux drives the pane). A one-shot pipe harness (Claude `-p`) calls this after the prompt so the
   * subprocess completes the turn and exits, ending `frames()` instead of lingering on open stdin.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  endInput() {
    if (this.#interactive) return;
    /** @type {Subprocess} */ (this.#proc)?.endInput();
  }

  /**
   * Inject a key. Interactive (tmux) only — the base gates this via the session's `canSendKey`, so it
   * is never reached in default mode.
   *
   * @access public
   * @param {string} name - a tmux key name (Enter/Escape/C-c/…)
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async key(name) {
    await tmuxSendKeys(this.#session, name);
  }

  /**
   * Raw output snapshot. Interactive: the tmux pane. Default: the rolling stdout buffer.
   *
   * @access public
   * @returns {Promise<string>} Promise resolving to the `capture` result.
   */
  async capture() {
    return this.#interactive ? tmuxCapture(this.#session) : this.#snapshot;
  }

  /**
   * Interrupt the active work. Interactive: sends `C-c` to the tmux pane (generation halts, session
   * stays live). Default (headless `-p`): sends SIGINT to the subprocess — note that headless sessions
   * exit on SIGINT, so the session will end rather than stay live for the next prompt. Both behaviors
   * stop the in-flight work; only interactive mode preserves the session.
   *
   * @access public
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `interrupt`.
   */
  async interrupt() {
    if (this.#interactive) {
      await tmuxSendKeys(this.#session, 'C-c');
      return ok();
    }
    if (!this.#proc || !this.#proc.health.alive) return fail('SUMO_SESSION_DEAD', 'no active process to interrupt');
    this.#proc.signal('SIGINT');
    return ok();
  }

  /**
   * Close the owned transport process/session gracefully.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async close() {
    if (this.#interactive) {
      await tmuxKill(this.#session);
      return;
    }
    await /** @type {Subprocess} */ (this.#proc)?.close();
  }

  /**
   * Force-stop the owned transport process/session.
   *
   * @access public
   * @returns {void} Completes without producing a value.
   */
  kill() {
    if (this.#interactive) {
      void tmuxKill(this.#session);
      return;
    }
    this.#proc?.kill();
  }
}
