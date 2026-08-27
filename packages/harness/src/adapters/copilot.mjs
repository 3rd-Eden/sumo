/**
 * Copilot adapter — `server` kind. Driven via `@github/copilot-sdk`, which wraps the npm-installed
 * Copilot CLI in a JSON-RPC session. The SDK owns the subprocess lifecycle; the adapter routes
 * `session/send` prompts through `CopilotServer.request()` and normalises inbound SDK events via the
 * `copilot` transcript parser.
 *
 * @module sumo/harness/adapters/copilot
 */

import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import { Harness } from '../base/Harness.mjs';
import { CopilotServer, resolveCopilotRuntime } from '../transport/CopilotServer.mjs';
import { ok, fail, CAP_UNSUPPORTED } from '../base/schema.mjs';
import { probeBinary } from '../base/probe.mjs';
import { toNativeRequestCopilot, toNativeResponseCopilot, toObservationCopilot } from '../hooks/copilot.mjs';
import { copilotHooksPath, SUMO_COPILOT_SENTINEL } from '../install/copilot.mjs';

const CONFIG = z.object({
  bin: z.string().default('copilot'),
  cwd: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  onEvent: z.function().optional()
});

/**
 * Normalize Copilot SDK model rows.
 *
 * @access public
 * @param {unknown[]} rows - SDK model rows.
 * @returns {Array<{ id: string, name?: string, description?: string, raw: unknown }>} Normalized model rows.
 */
export function models(rows) {
  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const r = /** @type {Record<string, unknown>} */ (row);
      const id = typeof r.id === 'string' ? r.id : '';
      return {
        id,
        ...(typeof r.name === 'string' ? { name: r.name } : {}),
        ...(typeof r.modelPickerCategory === 'string' ? { description: r.modelPickerCategory } : {}),
        raw: row
      };
    })
    .filter((row) => row.id);
}

/**
 * GitHub Copilot harness adapter backed by the real Copilot SDK server session.
 *
 * @access public
 * @class
 * @augments {Harness}
 */
export class Copilot extends Harness {
  /** @type {'copilot'} Adapter id used in config, provenance, and provider selection. */
  id = 'copilot';

  /** @type {object} Declared live capabilities backed by the Copilot SDK server-session surface. */
  can = {
    stream: true,
    injectStdin: false,
    hooks: true,
    defer: false,
    key: false,
    capture: false,
    approve: true,
    cancel: true,
    resume: true,
    providers: ['openai', 'anthropic']
  };

  /** @type {typeof CONFIG} Runtime configuration contract for the adapter boundary. */
  config = CONFIG;

  /** @type {{ stream: true, transcript: true }} Live SDK events and persisted events overlap. */
  overlaps = {
    stream: true,
    transcript: true
  };

  /** @type {CopilotServer} SDK-backed transport for this adapter instance. */
  transport = new CopilotServer({
    command: typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : 'copilot',
    cwd: typeof this.ctx.config.cwd === 'string' ? this.ctx.config.cwd : undefined,
    model: typeof this.ctx.config.model === 'string' ? this.ctx.config.model : undefined,
    reasoningEffort: typeof this.ctx.config.reasoningEffort === 'string' ? this.ctx.config.reasoningEffort : undefined,
    onEvent: typeof this.ctx.config.onEvent === 'function' ? /** @type {(event: object) => void} */ (this.ctx.config.onEvent) : undefined
  });

  /**
   * Verify repository-local Sumo hook installation for this spawn.
   *
   * @access public
   * @param {{ cwd?: string }} opts - Spawn options containing the effective cwd.
   * @returns {{ ok: boolean, diagnostics: Array<{ code: string, message: string }> }} Verification result.
   */
  verifySteering(opts = {}) {
    const configCwd = this.ctx.config.cwd;
    const cwd = opts.cwd ?? (typeof configCwd === 'string' ? configCwd : process.cwd());
    const file = copilotHooksPath(cwd);
    try {
      if (readFileSync(file, 'utf8').includes(SUMO_COPILOT_SENTINEL)) {
        return { ok: true, diagnostics: [] };
      }
      return {
        ok: false,
        diagnostics: [{ code: 'SUMO_STEERING_UNVERIFIED', message: `Copilot steering disabled: no Sumo-managed hooks found in ${file}` }]
      };
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err)?.code === 'ENOENT' ? 'SUMO_STEERING_UNVERIFIED' : 'SUMO_VERIFY_FAILED';
      return {
        ok: false,
        diagnostics: [{ code, message: `Copilot steering disabled: could not verify ${file}: ${/** @type {Error} */ (err).message}` }]
      };
    }
  }

  /**
   * List models from the Copilot SDK runtime.
   *
   * @access public
   * @returns {Promise<{ status: 'available'|'unavailable', models: Array<object>, reason?: string }>} Model list result.
   */
  async list() {
    let client;
    try {
      const bin = resolveCopilotRuntime(typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : 'copilot');
      const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
      client = new CopilotClient({
        connection: RuntimeConnection.forStdio({
          path: bin
        })
      });
      await client.start();
      const rows = models(await client.listModels());
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
        reason: /** @type {Error} */ (err).message
      };
    } finally {
      try { await client?.stop(); } catch {}
    }
  }

  /**
   * Apply per-run options before the SDK session opens.
   *
   * @access public
   * @param {string} _prompt - Prompt supplied to `prepare`.
   * @param {{ cwd?: string, model?: string, reasoningEffort?: string, resume?: string }} opts - Options read by this operation.
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async prepare(_prompt, opts = {}) {
    const transport = /** @type {CopilotServer} */ (this.transport);
    if (opts.cwd) transport.cwd = opts.cwd;
    if (opts.model) transport.model = opts.model;
    const configEffort = this.ctx.config.reasoningEffort;
    const effort = opts.reasoningEffort ?? (typeof configEffort === 'string' ? configEffort : undefined);
    if (effort) transport.reasoningEffort = effort;
    if (opts.resume) transport.resume = opts.resume;
  }

  /**
   * Submit the initial prompt once the SDK session is open.
   *
   * @access public
   * @param {unknown} _session - Session supplied to `start`.
   * @param {string} prompt - Prompt supplied to `start`.
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `start`.
   */
  async start(_session, prompt) {
    return this.transport.request('session/send', {
      prompt
    });
  }

  /**
   * Send a follow-up prompt/command through the live Copilot session.
   *
   * @access public
   * @param {import('../base/schema.mjs').HarnessAction} action - Action supplied to `write`.
   * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `write`.
   */
  async write(action) {
    const transport = /** @type {CopilotServer} */ (this.transport);
    if (action.kind === 'prompt' || action.kind === 'command') {
      const text = action.kind === 'prompt' ? action.text : action.line;
      return transport.request('session/send', {
        prompt: text ?? ''
      });
    }
    if (action.kind === 'key') {
      return fail(CAP_UNSUPPORTED, 'copilot: no terminal — key injection unsupported');
    }
    return ok();
  }

  // ── Hook surface. GitHub Copilot CLI supports file-backed hooks in `.github/hooks/*.json` and
  //    user-level hook config. Copilot's output schema is adapter-specific, so do not reuse the
  //    Claude/Codex nested hookSpecificOutput response shape.
  /** @type {Record<string, {kind: 'observe'|'decide', action?: string}>} */
  hookEvents = {
    sessionStart: {
      kind: 'observe'
    },
    SessionStart: {
      kind: 'observe'
    },
    sessionEnd: {
      kind: 'observe'
    },
    SessionEnd: {
      kind: 'observe'
    },
    userPromptSubmitted: {
      kind: 'observe'
    },
    UserPromptSubmit: {
      kind: 'observe'
    },
    preToolUse: {
      kind: 'decide',
      action: 'tool'
    },
    PreToolUse: {
      kind: 'decide',
      action: 'tool'
    },
    postToolUse: {
      kind: 'observe'
    },
    PostToolUse: {
      kind: 'observe'
    },
    postToolUseFailure: {
      kind: 'observe'
    },
    PostToolUseFailure: {
      kind: 'observe'
    },
    permissionRequest: {
      kind: 'decide',
      action: 'tool'
    },
    PermissionRequest: {
      kind: 'decide',
      action: 'tool'
    },
    agentStop: {
      kind: 'decide',
      action: 'finish'
    },
    Stop: {
      kind: 'decide',
      action: 'finish'
    },
    subagentStop: {
      kind: 'decide',
      action: 'finish'
    },
    SubagentStop: {
      kind: 'decide',
      action: 'finish'
    },
    subagentStart: {
      kind: 'observe'
    },
    SubagentStart: {
      kind: 'observe'
    },
    errorOccurred: {
      kind: 'observe'
    },
    ErrorOccurred: {
      kind: 'observe'
    },
    preCompact: {
      kind: 'observe'
    },
    PreCompact: {
      kind: 'observe'
    },
    notification: {
      kind: 'observe'
    },
    Notification: {
      kind: 'observe'
    }
  };

  /**
   * Parse a native Copilot hook payload into the normalized Sumo steer request.
   *
   * @access public
   * @param {string} nativeEvent - Native hook event name.
   * @param {Record<string, unknown>} payload - Payload data to process.
   * @returns {{ action: string, payload: object, ext: object }} Structured output from `toNativeRequest`.
   */
  toNativeRequest(nativeEvent, payload = {}) {
    return toNativeRequestCopilot(nativeEvent, payload);
  }

  /**
   * Translate a Sumo decision into Copilot's documented native hook stdout shape.
   *
   * @access public
   * @param {{ event?: Record<string, unknown>, deny?: string, inject?: string }} decision - Decision object to translate.
   * @param {string} nativeEvent - Native hook event name.
   * @param {Record<string, unknown>} payload - Payload data to process.
   * @returns {{ stdout: string, exitCode: number, diagnostics: Array<{ code?: string, message: string }> }} List produced by `toNativeResponse`.
   */
  toNativeResponse(decision, nativeEvent, payload = {}) {
    void payload;
    return toNativeResponseCopilot(decision, nativeEvent);
  }

  /**
   * Normalize a Copilot observation hook into a Sumo event.
   *
   * @access public
   * @param {string} nativeEvent - Native hook event name.
   * @param {Record<string, unknown>} payload - Payload data to process.
   * @returns {import('sumo/transcript').NormalizedEventInput | null} Import('sumo/transcript') normalized event input null returned by `toObservation`.
   */
  toObservation(nativeEvent, payload = {}) {
    return toObservationCopilot(nativeEvent, payload);
  }

  /**
   * Probe the real Copilot CLI and SDK auth state without making a model call.
   *
   * @access public
   * @returns {Promise<{ status: 'available', version?: string|null, bin?: string } | { status: 'unavailable', reason?: string }>} Promise resolving to the `available` result.
   */
  async available() {
    let resolved;
    try {
      resolved = resolveCopilotRuntime(typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin : 'copilot');
    } catch (err) {
      return {
        status: 'unavailable',
        reason: /** @type {Error} */ (err).message
      };
    }
    const bin = resolved;
    const probe = await probeBinary(bin);
    if (!probe.available) {
      return {
        status: 'unavailable',
        reason: probe.reason
      };
    }

    const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
    const configCwd = this.ctx.config.cwd;
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: resolved }),
      ...(typeof configCwd === 'string' ? { workingDirectory: configCwd } : {})
    });

    try {
      await client.start();
      const [status, auth] = await Promise.all([client.getStatus(), client.getAuthStatus()]);
      if (!auth.isAuthenticated) {
        return {
          status: 'unavailable',
          reason: auth.statusMessage || 'copilot is installed but not authenticated'
        };
      }
      return {
        status: 'available',
        version: status.version || probe.version,
        bin: resolved
      };
    } catch (err) {
      return {
        status: 'unavailable',
        reason: /** @type {Error} */ (err).message || 'copilot runtime probe failed'
      };
    } finally {
      try {
        await client.stop();
      } catch {}
    }
  }

  /**
   * Copilot has no separate native TUI resume command in this adapter.
   *
   * @access public
   * @returns {null} Null returned by `of`.
   */
  interactiveResumeArgv() {
    return null;
  }

  /**
   * Copilot session-state is a pure function of the native session id.
   *
   * @access public
   * @param {string} nativeId - Identifier used by `transcriptPathFor`.
   * @returns {string} String returned by `transcriptPathFor`.
   */
  transcriptPathFor(nativeId) {
    const base = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
    return path.join(base, 'session-state', nativeId, 'events.jsonl');
  }
}
