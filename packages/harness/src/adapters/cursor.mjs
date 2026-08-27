/**
 * Cursor adapter — `pipe` kind, the near-twin of Claude with one real divergence: the Cursor CLI has
 * no stdin streaming input (`--input-format` does not exist), so the FIRST prompt is a positional CLI
 * argument injected at spawn via `prepare()`, not a channel write. `read()` normalizes its stream-json
 * output via the `cursor` transcript parser. `transcriptComplete` is false (Cursor may omit tool
 * outputs, spec 04); `overlaps` is `divergent` (on-disk text diverges from the live stream).
 *
 * The binary was renamed from `cursor-agent` to `agent`; `resolveCursorBin()` prefers `agent` on PATH
 * and falls back to the legacy `cursor-agent` (the two are API-compatible). An explicit `config.bin`
 * always wins.
 *
 * @module sumo/harness/adapters/cursor
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { Harness } from '../base/Harness.mjs';
import { Pipe } from '../transport/Pipe.mjs';
import { ok, fail, CAP_UNSUPPORTED } from '../base/schema.mjs';
import { probeBinary, spawnCollect, whichSync } from '../base/probe.mjs';
import { SumoError } from 'sumo/error';
import { cursorHooksPath, SUMO_CURSOR_SENTINEL } from '../install/cursor.mjs';

/**
 * Resolve the Cursor CLI binary: prefer the current `agent`, fall back to the legacy `cursor-agent`.
 * Scans `PATH` for an executable of each name in order; returns the legacy name if neither is found so
 * the spawn surfaces a clear "command not found" rather than a silent mis-resolution.
 *
 * @access public
 * @returns {string} String returned by `resolveCursorBin`.
 */
export function resolveCursorBin() {
  for (const name of ['agent', 'cursor-agent']) {
    if (whichSync(name)) return name;
  }
  return 'cursor-agent';
}

/**
 * Detect Cursor's desktop launcher, which opens the GUI and is not an automation harness.
 *
 * @access public
 * @param {string} bin - Cursor binary path or command name.
 * @returns {boolean} Whether `isCursorDesktopBin` matched the expected condition.
 */
export function isCursorDesktopBin(bin) {
  return path.basename(bin) === 'cursor';
}

const DESKTOP_BIN_REASON = 'Cursor desktop launcher is not supported for automation; use `agent` or `cursor-agent`';
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;

const CONFIG = z.object({
  bin: z.string().optional(), // unset → resolveCursorBin() (agent → cursor-agent); set → honored verbatim
  cwd: z.string().optional(),
  mode: z.enum(['default', 'interactive']).optional(),
  model: z.string().optional()
});

/**
 * Parse Cursor's `agent models` output into normalized model rows.
 *
 * @access public
 * @param {string} text - Command output to parse.
 * @returns {Array<{ id: string, raw: unknown }>} Parsed models.
 */
export function models(text) {
  const clean = text.replace(ANSI, '').replace(/\r/g, '');
  if (/no models available/i.test(clean)) return [];
  return clean
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^loading models/i.test(line))
    .map((line) => line.replace(/^[›>*\-\s]+/, '').replace(/^\d+\.\s+/, '').trim())
    .map((line) => line.split(/\s{2,}|\s+-\s+|\s+—\s+/)[0]?.trim())
    .filter((id) => id && !/\s/.test(id))
    .map((id) => ({
      id,
      raw: {
        line: id
      }
    }));
}

/**
 * Cursor implementation.
 *
 * @access public
 * @class
 */
export class Cursor extends Harness {
  id = 'cursor';

  // Cursor supports multiple underlying providers (OpenAI models and Anthropic models).
  // This makes it the universal fallback for failover routing (the reference implementation forProvider pattern).
  can = {
    stream: true,
    injectStdin: false,
    hooks: true,
    key: true,
    capture: true,
    cancel: true,
    resume: true,
    providers: ['openai', 'anthropic']
  };

  /**
   * Cursor has no known blocking interactive dialogs in headless (-p) mode.
   * Cursor currently exposes no output-diagnostic parser and therefore returns null.
   *
   * @access public
   * @param {string|null} _output - Output supplied to `diagnose`.
   * @returns {null} Null returned by `diagnose`.
   */
  static diagnose(_output) {
    return null;
  }

  config = CONFIG;

  // Cursor's on-disk text diverges from the live stream → no parser-level identity (documented).
  overlaps = {
    stream: true,
    transcript: true
  };

  // Cursor may omit some records (e.g. tool outputs) from its transcript.
  transcriptComplete = false;

  transport = new Pipe({
    command: typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : resolveCursorBin(),
    args: ['-p', '--force', '--output-format', 'stream-json'],
    cwd: typeof this.ctx.config.cwd === 'string' ? this.ctx.config.cwd : undefined,
    mode: this.ctx.config.mode === 'interactive' || this.ctx.config.mode === 'default' ? this.ctx.config.mode : undefined
  });

  /**
   * Verify project-local Sumo hook installation for this spawn.
   *
   * @access public
   * @param {{ cwd?: string }} opts - Spawn options containing the effective cwd.
   * @returns {{ ok: boolean, diagnostics: Array<{ code: string, message: string }> }} Verification result.
   */
  verifySteering(opts = {}) {
    const configCwd = this.ctx.config.cwd;
    const cwd = opts.cwd ?? (typeof configCwd === 'string' ? configCwd : process.cwd());
    const file = cursorHooksPath(cwd);
    try {
      if (readFileSync(file, 'utf8').includes(SUMO_CURSOR_SENTINEL)) {
        return { ok: true, diagnostics: [] };
      }
      return {
        ok: false,
        diagnostics: [{ code: 'SUMO_STEERING_UNVERIFIED', message: `Cursor steering disabled: no Sumo-managed hooks found in ${file}` }]
      };
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code === 'ENOENT' ? 'SUMO_STEERING_UNVERIFIED' : 'SUMO_VERIFY_FAILED';
      return {
        ok: false,
        diagnostics: [{ code, message: `Cursor steering disabled: could not verify ${file}: ${/** @type {Error} */ (err).message}` }]
      };
    }
  }

  /**
   * List models from Cursor Agent.
   *
   * @access public
   * @returns {Promise<{ status: 'available'|'unavailable', models: Array<object>, reason?: string }>} Model list result.
   */
  async list() {
    const bin = typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : resolveCursorBin();
    if (isCursorDesktopBin(bin)) {
      return {
        status: 'unavailable',
        models: [],
        reason: DESKTOP_BIN_REASON
      };
    }
    const { code, out } = await spawnCollect(bin, ['models']);
    if (code !== 0) {
      return {
        status: 'unavailable',
        models: [],
        reason: out.trim() || `cursor models exited ${code}`
      };
    }
    const rows = models(out);
    return rows.length
      ? {
          status: 'available',
          models: rows
        }
      : {
          status: 'unavailable',
          models: [],
          reason: 'no models available'
        };
  }

  // ── Hook surface (spec 12). Headless `cursor-agent -p` emits a SUBSET (verified from real captures):
  //    `sessionStart`, `beforeShellExecution`, `afterShellExecution`, `afterFileEdit`. DECISION steering
  //    is supported on `beforeShellExecution` (and `beforeMCPExecution`) — its deny RESPONSE schema is
  //    verified from Cursor's official hook docs: `{ permission:'deny', agent_message }` (primary
  //    source). `beforeSubmitPrompt`/`afterAgentResponse`/`stop` are NOT emitted headless, so the
  //    campsite-verified `stop` gate is interactive-only and is deliberately UNMAPPED here (declared,
  //    not faked — §3a/§3f): an unmapped event falls back to observation.
  /** @type {Record<string, {kind: 'observe'|'decide', action?: string}>} */
  hookEvents = {
    sessionStart: {
      kind: 'observe'
    },
    beforeShellExecution: {
      kind: 'decide',
      action: 'tool'
    },
    beforeMCPExecution: {
      kind: 'decide',
      action: 'tool'
    },
    afterShellExecution: {
      kind: 'observe'
    },
    afterFileEdit: {
      kind: 'observe'
    }
  };

  /**
   * Parse a Cursor hook payload into the normalized steer request (shell/MCP carry a bare `command`).
   *
   * @access public
   * @param {string} nativeEvent - Native hook event name.
   * @param {Record<string, unknown>} payload - Payload consumed by `toNativeRequest`.
   * @returns {{ action: string, payload: object, ext: object }} Normalized steering request.
   */
  toNativeRequest(nativeEvent, payload = {}) {
    const ext = {
      native: payload
    };
    if (nativeEvent === 'beforeShellExecution' || nativeEvent === 'beforeMCPExecution') {
      return {
        action: 'tool',
        payload: {
          tool: {
            name: 'shell',
            input: {
              command: payload.command
            }
          }
        },
        ext
      };
    }
    return {
      action: 'tool',
      payload: {},
      ext
    };
  }

  /**
   * Translate `{event}|{deny}` into Cursor's native hook response (verified from Cursor's official hook
   * docs): a shell/MCP deny is `{ permission:'deny', agent_message }`; the absence of a deny IS allow →
   * write nothing (Cursor proceeds). Cursor's snake_case field names differ from Claude's (§3a: shared
   * intent, per-harness delivery).
   *
   * @access public
   * @param {{ event?: Record<string, unknown>, deny?: string }} decision - Decision object to translate.
   * @param {string} nativeEvent - Native hook event name.
   * @returns {{ stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }} List produced by `toNativeResponse`.
   */
  toNativeResponse(decision, nativeEvent) {
    const denied = decision && typeof decision === 'object' && 'deny' in decision;
    if ((nativeEvent === 'beforeShellExecution' || nativeEvent === 'beforeMCPExecution') && denied) {
      return {
        stdout: JSON.stringify({
          permission: 'deny',
          agent_message: decision.deny
        }),
        exitCode: 0,
        diagnostics: []
      };
    }
    return {
      stdout: '',
      exitCode: 0,
      diagnostics: []
    };
  }

  /**
   * Normalize a Cursor hook payload into a `07` event. Cursor's shell hooks carry a bare `command`
   * (no tool id), so a shell observation has no natural id (the caller gives it a unique key — distinct
   * executions must not collapse). Cursor's on-disk text already diverges from the live stream.
   *
   * @access public
   * @param {string} nativeEvent - Native hook event name.
   * @param {Record<string, unknown>} payload - Payload data to process.
   * @returns {import('sumo/transcript').NormalizedEventInput | null} Import('sumo/transcript') normalized event input null returned by `toObservation`.
   */
  toObservation(nativeEvent, payload = {}) {
    if (nativeEvent === 'beforeShellExecution' || nativeEvent === 'afterShellExecution' || nativeEvent === 'beforeMCPExecution') {
      /** @type {{name: string, input: { command: unknown }, output?: unknown}} */
      const tool = { name: 'shell', input: { command: payload.command } };
      if (payload.output !== undefined) tool.output = payload.output;
      return { type: 'session.tool', payload: { tool }, ext: {} };
    }
    if (nativeEvent === 'afterFileEdit') {
      return { type: 'session.tool', payload: { tool: { name: 'edit', input: { path: payload.file_path ?? payload.path } } }, ext: {} };
    }
    if (nativeEvent === 'sessionStart') {
      const cwd = Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : payload.cwd;
      return {
        type: 'session.started',
        payload: { harness: 'cursor', ...(typeof cwd === 'string' && cwd ? { cwd } : {}) },
        ext: {},
        ...(typeof payload.conversation_id === 'string' && payload.conversation_id ? { id: payload.conversation_id } : {})
      };
    }
    return null; // unknown / headless-absent → caller surfaces a lossless passthrough (§3e)
  }

  /**
   * Pre-open hook: Cursor takes the prompt positionally. Resume flags (if supported) must go BEFORE
   * the positional prompt arg — `addArgs` appends in order, so call resume first, then the prompt.
   *
   * @access public
   * @param {string} prompt - Prompt supplied to `prepare`.
   * @param {{ cwd?: string, mode?: string, model?: string, resume?: string }} opts - Options read by this operation.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async prepare(prompt, opts = {}) {
    const bin = typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : resolveCursorBin();
    if (isCursorDesktopBin(bin)) {
      throw new SumoError({
        name: 'harness',
        method: 'cursor.prepare',
        code: 'SUMO_BACKEND_UNAVAILABLE',
        message: DESKTOP_BIN_REASON
      });
    }
    const transport = /** @type {Pipe} */ (this.transport);
    // Interactive (tmux) mode launches the real `cursor-agent` TUI, not the headless `-p` stream-json
    // pipe (): swap to empty base args, and DON'T pass the prompt positionally — it is typed into
    // the pane by `start()`/`write()` instead (interactive Cursor accepts follow-ups; headless can't).
    const interactive = opts.mode === 'interactive';
    if (interactive) transport.setBaseArgs([]);
    if (opts.cwd) transport.setCwd(opts.cwd);
    if (opts.model) transport.addArgs(['--model', opts.model]);
    if (opts.resume) transport.addArgs(['--resume', opts.resume]);
    if (!interactive) transport.addArgs([prompt]);
  }

  /**
   * Headless: the first prompt was delivered positionally at spawn (nothing to submit). Interactive:
   * type the first prompt into the pane.
   *
   * @access public
   * @param {Record<string, unknown>} _session - Session supplied to `start`.
   * @param {string} prompt - Prompt supplied to `start`.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async start(_session, prompt) {
    if (/** @type {Pipe} */ (this.transport).interactive) {
      await this.write({
        kind: 'prompt',
        text: prompt
      });
    }
  }

  /**
   * Pre-flight: three-layer availability check — binary, auth, quota.
   * None of the layers make a model call or consume credits.
   * Layer 1 — binary: `resolveCursorBin()` finds `agent` or `cursor-agent` on PATH.
   * Layer 2 — auth: `<bin> status --format json` (no network). Exit code is authoritative;
   *   the command can crash (SIGSEGV / keychain errors) so non-zero without a clear auth
   *   signal is treated as unavailable.
   * Layer 3 — quota: reads the JWT from the Cursor IDE's SQLite database, calls
   *   cursor.com/api/usage-summary (the same endpoint the dashboard uses). Checks
   *   `individualUsage.overall.remaining` — 0 means exhausted. Requires Node >=22.13.0
   *   (package.json engines floor) for `node:sqlite`. Failure is best-effort: if the
   *   SQLite read or HTTP call fails, this layer is skipped and the result is available.
   *
   * @access public
   * @returns {Promise<{ status: 'available'|'unavailable'|'unknown', version?: string|null, reason?: string, bin?: string }>} Availability state for Cursor.
   */
  async available() {
    const bin = typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : resolveCursorBin();
    if (isCursorDesktopBin(bin)) {
      return {
        status: 'unavailable',
        reason: DESKTOP_BIN_REASON
      };
    }

    // Layer 1: binary on PATH
    const probe = await probeBinary(bin, {
      versionArgs: ['--version']
    });
    if (!probe.available) {
      return {
        status: 'unavailable',
        reason: probe.reason
      };
    }

    // Layer 2: auth (no network, no model call)
    const { code: statusCode, out: statusOut } = await spawnCollect(bin, ['status', '--format', 'json']);
    /** @type {{ isAuthenticated?: boolean, message?: string }|undefined} */
    let authStatus;
    try { authStatus = /** @type {{ isAuthenticated?: boolean, message?: string }} */ (JSON.parse(statusOut)); } catch { /* non-JSON */ }

    if (authStatus?.isAuthenticated === false) {
      return {
        status: 'unavailable',
        reason: `not authenticated: ${authStatus.message ?? 'run `' + bin + ' login`'}`
      };
    }
    if (!(authStatus?.isAuthenticated === true && statusCode === 0)) {
      return {
        status: 'unavailable',
        reason: `status check failed (exit ${statusCode}): ${statusOut.slice(0, 200)}`
      };
    }

    // Layer 3: quota via /api/usage-summary (one HTTP GET, no model call)
    // JWT lives in the Cursor IDE's SQLite database — same store cursor-credits uses.
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const dbPath = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'
      );
      const db = new DatabaseSync(dbPath);
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get();
      db.close();
      const jwt = typeof row?.value === 'string' ? row.value : undefined;
      if (jwt) {
        const payload = /** @type {Record<string, unknown>} */ (JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()));
        const subject = typeof payload.sub === 'string' ? payload.sub : '';
        const userId = subject.split('|').pop();
        const sessionToken = `${userId}%3A%3A${jwt}`;
        const res = await fetch('https://cursor.com/api/usage-summary', {
          headers: {
            Cookie: `WorkosCursorSessionToken=${sessionToken}`
          }
        });
        if (res.ok) {
          const data = /** @type {Record<string, unknown>} */ (await res.json());
          if (data.isUnlimited) {
            return {
              status: 'available',
              version: probe.version,
              bin
            };
          }
          const individualUsage = data.individualUsage && typeof data.individualUsage === 'object'
            ? /** @type {{ overall?: { enabled?: boolean, remaining?: number, used?: unknown, limit?: unknown } }} */ (data.individualUsage)
            : {};
          const overall = individualUsage.overall;
          if (overall?.enabled && overall.remaining !== undefined && overall.remaining <= 0) {
            return {
              status: 'unavailable',
              reason: `individual quota exhausted (${overall.used}/${overall.limit} used)`
            };
          }
        }
      }
    } catch { /* best-effort — quota check failure does not block the binary/auth result */ }

    return {
      status: 'available',
      version: probe.version,
      bin
    };
  }

  /**
   * Native interactive resume (the real TUI): `cursor-agent --resume <chatId>`. Used by `sumo attach`.
   *
   * @access public
   * @param {string} nativeId - Harness-native chat id.
   * @returns {string[]|null} Native CLI arguments for interactive resume.
   */
  interactiveResumeArgv(nativeId) {
    return nativeId ? ['--resume', nativeId] : null;
  }

  /**
   * Headless Cursor has no stdin streaming, so a follow-up prompt is unsupported — declared, not faked
   * (§3a). Interactive (tmux) mode CAN take follow-ups: the prompt text is typed into the pane.
   *
   * @access public
   * @param {import('../base/schema.mjs').HarnessAction} action - Action supplied to `write`.
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `write`.
   */
  async write(action) {
    if (action.kind === 'prompt' || action.kind === 'command') {
      const transport = /** @type {Pipe} */ (this.transport);
      if (transport.interactive) {
        await transport.send(action.kind === 'prompt' ? action.text : action.line);
        return ok();
      }
      return fail(CAP_UNSUPPORTED, 'cursor: no stdin streaming — follow-up prompts are unsupported in headless mode (prompt is positional at spawn)');
    }
    return ok();
  }
}
