/**
 * Codex adapter — `server` kind ( / ). Driven over `codex app-server` JSON-RPC 2.0 on stdio
 * via the `CodexAppServer` transport, which owns the `initialize`→`thread/start` handshake in its
 * `open()`. The adapter's job is the per-turn submission (`turn/start`) and normalizing the inbound
 * JSON-RPC notifications via the `codex` transcript parser. Codex surfaces server-initiated approval
 * requests, so `can.approve` is declared and `respondApproval` is bound by the base.
 *
 * `overlaps` is `normalized`: Codex writes rollouts to `~/.codex/sessions/...` with no shared natural
 * id, so live+disk collapse needs the daemon/correlation layer (spec 09), not a parser id ().
 *
 * @module sumo/harness/adapters/codex
 */

import { z } from 'zod';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';

import { Harness } from '../base/Harness.mjs';
import { CodexAppServer } from '../transport/CodexAppServer.mjs';
import { ok, fail, CAP_UNSUPPORTED } from '../base/schema.mjs';
import { classify } from '../base/classify.mjs';
import { probeBinary, spawnCollect } from '../base/probe.mjs';
import { toNativeRequestClaudeShaped, toObservationClaudeShaped, toNativeResponseClaudeShaped } from '../hooks/claude-shaped.mjs';
import { codexHooksEnabled, codexHooksPath, SUMO_CODEX_SENTINEL } from '../install/codex.mjs';

const CONFIG = z.object({
  bin: z.string().default('codex'),
  cwd: z.string().optional(),
  sandbox: z.string().default('read-only'),
  approvalPolicy: z.string().default('on-request'),
  model: z.string().optional(),
  reasoningEffort: z.string().optional()
});

/**
 * Treat JSON-like native values as records and non-objects as empty records.
 *
 * @access private
 * @param {unknown} value - Native value to inspect.
 * @returns {Record<string, unknown>} Record view used for optional fields.
 */
function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * Resolve the Codex CLI without accidentally preferring private PATH shims over the npm-managed binary
 * available in Codex-launched environments. Explicit commands and `SUMO_CODEX_BIN` still win.
 *
 * @access public
 * @param {string} command - Command supplied to `resolveCodexBin`.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} env - Environment variables used by the operation.
 * @returns {string} String returned by `resolveCodexBin`.
 */
export function resolveCodexBin(command = 'codex', env = process.env) {
  if (command !== 'codex') return command;
  if (env.SUMO_CODEX_BIN) return env.SUMO_CODEX_BIN;

  const root = env.CODEX_MANAGED_PACKAGE_ROOT;
  if (root) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.codex;
      if (rel) {
        const candidate = path.join(root, rel);
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Fall through to PATH; availability probing will surface a useful failure if PATH is broken.
    }
  }

  return command;
}

/**
 * Build classifier evidence from a Codex app-server stream error frame.
 *
 * @access private
 * @param {Record<string, unknown>} frame - Frame consumed by `codexErrorEvidence`.
 * @returns {{ stderr: string }} Structured output from `codexErrorEvidence`.
 */
function codexErrorEvidence(frame) {
  const params = recordValue(frame?.params);
  const error = recordValue(params.error);
  const parts = [
    typeof error.message === 'string' ? error.message : '', typeof error.codexErrorInfo === 'string' ? error.codexErrorInfo : '', typeof error.additionalDetails === 'string' ? error.additionalDetails : '', params.willRetry === true ? 'will retry' : ''
  ].filter(Boolean);
  return {
    stderr: parts.join('\n')
  };
}

/**
 * Parse `codex debug models` JSON into Sumo's normalized model rows.
 *
 * @access public
 * @param {string|Record<string, unknown>} input - Raw JSON string or decoded object.
 * @returns {Array<{ id: string, name?: string, description?: string, priority?: number, raw: unknown }>} Normalized model rows.
 */
export function models(input) {
  const data = /** @type {Record<string, unknown>} */ (typeof input === 'string' ? JSON.parse(input) : input);
  const rows = Array.isArray(data.models) ? data.models : [];
  /** @type {Array<{ id: string, name?: string, description?: string, priority?: number, raw: unknown }>} */
  const out = [];
  for (const model of rows) {
    if (!model || typeof model !== 'object') continue;
    const row = /** @type {Record<string, unknown>} */ (model);
    if (row.visibility === 'hide') continue;
    if (typeof row.slug !== 'string' || !row.slug) continue;
    out.push({
      id: row.slug,
      ...(typeof row.display_name === 'string' ? { name: row.display_name } : {}),
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      ...(typeof row.priority === 'number' ? { priority: row.priority } : {}),
      raw: model
    });
  }
  return out;
}

/**
 * Codex implementation.
 *
 * @access public
 * @class
 */
export class Codex extends Harness {
  id = 'codex';

  can = {
    stream: true,
    injectStdin: true,
    hooks: true,
    defer: false,
    key: false,
    capture: false,
    approve: true,
    cancel: true,
    resume: true,
    providers: ['openai']
  };

 /**
 * Known dialog patterns for the Codex interactive TUI.
 * Patterns that identify Codex readiness and approval prompts.
 *
 * @type {Array<{ pattern: RegExp, category: 'option_dialog'|'fatal', reasoning: string, remedy?: string[] }>}
 */
 static patterns = [
 {
 pattern: /choose how you'd like.*to proceed/is,
 category: 'option_dialog',
 reasoning: 'Codex CLI showing model upgrade selection — selecting "Use existing model"',
 remedy: ['Down', 'Enter']
 }, {
 pattern: /invalid model name/i,
 category: 'fatal',
 reasoning: 'Codex CLI received invalid model name — API key may not support the requested model'
 }, {
 pattern: /update available!.*\n.*press enter to continue/is,
 category: 'option_dialog',
 reasoning: 'Codex CLI showing update-available dialog requiring Enter to dismiss',
 remedy: ['Enter']
 }, {
 pattern: /press enter to continue/i,
 category: 'option_dialog',
 reasoning: 'Codex CLI waiting for Enter keypress to continue',
 remedy: ['Enter']
 }
 ];

 /**
 * Diagnose TUI pane output for known blocking dialogs.
 * Diagnose common Codex output conditions.
 *
 * @access public
 * @param {string|null} output - captured pane text
 * @returns {{ category: 'option_dialog'|'fatal', reasoning: string, remedy?: string[] } | null} Structured output from `diagnose`.
 */
 static diagnose(output) {
 if (!output) return null;
 for (const { pattern, category, reasoning, remedy } of Codex.patterns) {
 if (pattern.test(output)) {
 return {
 category,
 reasoning,
 ...(remedy ? { remedy }: {})
 };
 }
 }
 return null;
 }

  config = CONFIG;

  // Same turns reach the live stream and the on-disk rollout, but with no shared natural id.
  overlaps = {
    stream: true,
    transcript: true
  };

  transport = new CodexAppServer({
    command: resolveCodexBin(typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : 'codex'),
    cwd: typeof this.ctx.config.cwd === 'string' ? this.ctx.config.cwd : undefined,
    sandbox: typeof this.ctx.config.sandbox === 'string' ? this.ctx.config.sandbox : 'read-only',
    approvalPolicy: typeof this.ctx.config.approvalPolicy === 'string' ? this.ctx.config.approvalPolicy : 'on-request'
  });

  /**
   * Verify project-local Sumo hook installation and Codex hook feature state for this spawn.
   *
   * @access public
   * @param {{ cwd?: string }} opts - Spawn options containing the effective cwd.
   * @returns {{ ok: boolean, diagnostics: Array<{ code: string, message: string }> }} Verification result.
   */
  verifySteering(opts = {}) {
    const configCwd = this.ctx.config.cwd;
    const cwd = opts.cwd ?? (typeof configCwd === 'string' ? configCwd : process.cwd());
    const diagnostics = [];
    const featureEnabled = codexHooksEnabled(process.env);
    if (featureEnabled !== true) {
      diagnostics.push({
        code: 'SUMO_VERIFY_FAILED',
        message: featureEnabled === false
          ? 'Codex steering disabled: Codex hooks are explicitly disabled in config.toml'
          : 'Codex steering disabled: could not verify Codex hook feature state'
      });
    }
    const file = codexHooksPath(cwd);
    try {
      if (!readFileSync(file, 'utf8').includes(SUMO_CODEX_SENTINEL)) {
        diagnostics.push({ code: 'SUMO_STEERING_UNVERIFIED', message: `Codex steering disabled: no Sumo-managed hooks found in ${file}` });
      }
    } catch (err) {
      diagnostics.push({
        code: /** @type {{ code?: string }} */ (err)?.code === 'ENOENT' ? 'SUMO_STEERING_UNVERIFIED' : 'SUMO_VERIFY_FAILED',
        message: `Codex steering disabled: could not verify ${file}: ${/** @type {Error} */ (err).message}`
      });
    }
    return {
      ok: diagnostics.length === 0,
      diagnostics
    };
  }

  /**
   * List models from Codex's native model catalog.
   *
   * @access public
   * @returns {Promise<{ status: 'available'|'unavailable', models: Array<object>, reason?: string }>} Model list result.
   */
  async list() {
    const bin = resolveCodexBin(typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : 'codex');
    const { code, out } = await spawnCollect(bin, ['debug', 'models']);
    if (code !== 0) {
      return {
        status: 'unavailable',
        models: [],
        reason: out.trim() || `codex debug models exited ${code}`
      };
    }
    try {
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
    } catch (err) {
      return {
        status: 'unavailable',
        models: [],
        reason: `could not parse codex models: ${/** @type {Error} */ (err).message}`
      };
    }
  }

 // ── Hook surface (spec 12). Codex's native hooks are Claude-SHAPED — both the payloads (verified
 // from real captures) AND the decision-response schema: PreToolUse → permissionDecision:'deny';
 // Stop/UserPromptSubmit →
 // decision:'block'+reason). So Codex shares the Claude-shaped translation and supports DECISION
 // steering. Codex hooks require the `codex_hooks` feature in `~/.codex/config.toml` (install
 // preflight checks this). Codex emits no SubagentStop.
 /** @type {Record<string, {kind: 'observe'|'decide', action?: string}>} */
 hookEvents = {
 SessionStart: {
 kind: 'observe'
 },
 PreToolUse: {
 kind: 'decide',
 action: 'tool'
 },
 PostToolUse: {
 kind: 'observe'
 },
 UserPromptSubmit: {
 kind: 'decide',
 action: 'prompt'
 },
 Stop: {
 kind: 'decide',
 action: 'finish'
 }
 };

  /**
   * Parse a Codex (Claude-shaped) hook payload into the normalized steer request.
   *
   * @access public
   * @param {string} nativeEvent - Native hook event name.
   * @param {Record<string, unknown>} payload - Payload consumed by `toNativeRequest`.
   * @returns {{ action: string, payload: object, ext: object }} Normalized steering request.
   */
  toNativeRequest(nativeEvent, payload = {}) {
    return toNativeRequestClaudeShaped(nativeEvent, payload);
  }

 /**
 * Translate `{event}|{deny}` into Codex's native response (verified: captured Codex adapter).
 *
 * @access public
 * @param {{ event?: Record<string, unknown>, deny?: string, inject?: string }} decision - Harness-agnostic steering decision.
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload consumed by `toNativeResponse`.
 * @returns {{ stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }} Native hook response.
 */
 toNativeResponse(decision, nativeEvent, payload = {}) {
 return toNativeResponseClaudeShaped(decision, nativeEvent, payload);
 }

  /**
   * Normalize a Codex observation hook into a `07` event (tool events key on `tool_use_id`).
   *
   * @access public
   * @param {string} nativeEvent - Native hook event name.
   * @param {Record<string, unknown>} payload - Payload consumed by `toObservation`.
   * @returns {import('sumo/transcript').NormalizedEventInput | null} Normalized observation event, when supported.
   */
  toObservation(nativeEvent, payload = {}) {
    return toObservationClaudeShaped('codex', nativeEvent, payload);
  }

  /**
   * Pre-open hook: set runtime opts on the transport before open() runs the handshake.
   *
   * @access public
   * @param {string} _prompt - Prompt supplied to `prepare`.
   * @param {{ cwd?: string, model?: string, reasoningEffort?: string, resume?: string }} opts - Options read by this operation.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async prepare(_prompt, opts = {}) {
    const transport = /** @type {CodexAppServer} */ (this.transport);
    if (opts.cwd) transport.cwd = opts.cwd;
    if (opts.model) transport.model = opts.model;
    const configEffort = this.ctx.config.reasoningEffort;
    const effort = opts.reasoningEffort ?? (typeof configEffort === 'string' ? configEffort : undefined);
    if (effort) transport.reasoningEffort = effort;
    if (opts.resume) transport.resume = opts.resume;
  }

  /**
   * Normalize stream frames and classify Codex app-server error notifications while preserving the
   * native frame losslessly. Lifecycle evidence classification only runs when the subprocess exits;
   * Codex quota errors arrive earlier as live JSON-RPC notifications, so the adapter attaches the same
   * classifier result to the raw event here.
   *
   * @access public
   * @param {Record<string, unknown>} frame - Frame consumed by `read`.
   * @returns {Iterable<import('sumo/transcript').NormalizedEventInput>} Iterable<import('sumo/transcript') normalized event input> returned by `read`.
   */
  *read(frame) {
    for (const event of super.read(frame)) {
      if (frame?.method !== 'error') {
        yield event;
        continue;
      }
      const classification = classify(codexErrorEvidence(frame));
      yield {
        ...event, payload: {
          ...(event.payload ?? {}), sumoCode: classification.code, retryable: classification.retryable, fallback: classification.fallback, reason: classification.reason
        }, ext: { ...(event.ext ?? {}), classification }
      };
    }
  }

  /**
   * Native interactive resume (the real TUI): `codex resume <SESSION_ID>` (a subcommand, not a flag).
   *
   * @access public
   * @param {string} nativeId - Harness-native thread id.
   * @returns {string[]|null} Native CLI arguments for interactive resume.
   */
  interactiveResumeArgv(nativeId) {
    return nativeId ? ['resume', nativeId] : null;
  }

  /**
   * Pre-flight: two-layer availability check — binary then auth.
   * Neither layer triggers a model call or consumes credits.
   * Layer 1 — binary: `probeBinary` checks it is on PATH and responds to `--version`.
   * Layer 2 — auth: `codex login status` (no network). Exit code is authoritative —
   *   a shim or broken install may exit non-zero with an unrelated error, which would
   *   pass a text-only regex check and falsely appear authenticated.
   *
   * @access public
   * @returns {Promise<{ status: 'available'|'unavailable'|'unknown', version?: string|null, reason?: string }>} Availability state for Codex.
   */
  async available() {
    const bin = resolveCodexBin(typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : 'codex');

    // Layer 1: binary
    const probe = await probeBinary(bin);
    if (!probe.available) {
      return {
        status: 'unavailable',
        reason: probe.reason
      };
    }

    // Layer 2: auth (no network, no model call)
    // Exit code 0 + positive "Logged in" text = authenticated; anything else = unavailable.
    const { code, out } = await spawnCollect(bin, ['login', 'status']);
    if (code === 0 && /logged in/i.test(out)) {
      return {
        status: 'available',
        version: probe.version
      };
    }
    return {
      status: 'unavailable',
      reason: out.trim().slice(0, 200) || `exit ${code} — run \`codex login\``
    };
  }

  /**
   * WRITE (act): a prompt is a new turn on the established thread (`turn/start`). The transport's
   * `request` resolves to a `Result`, which is returned directly (§3b). `key`/`capture` are absent on
   * a server kind — the base never routes them here (they degrade via `can`).
   *
   * @access public
   * @param {import('../base/schema.mjs').HarnessAction} action - Action supplied to `write`.
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `write`.
   */
  async write(action) {
    const transport = /** @type {CodexAppServer} */ (this.transport);
    if (action.kind === 'prompt' || action.kind === 'command') {
      const text = action.kind === 'prompt' ? action.text : action.line;
      if (!transport.threadId) return fail('SUMO_SESSION_DEAD', 'codex: no active thread (handshake incomplete)');
      return transport.request('turn/start', {
        threadId: transport.threadId,
        input: [
          {
            type: 'text',
            text
          }
        ]
      });
    }
    if (action.kind === 'key') {
      return fail(CAP_UNSUPPORTED, 'codex: no terminal — key injection unsupported');
    }
    return ok();
  }
}
