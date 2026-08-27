/**
 * Claude Code adapter — `pipe` kind. Driven as a streaming stdin/stdout subprocess in stream-json
 * mode (`--input-format stream-json` + `--replay-user-messages`, `--output-format stream-json`), so
 * prompts are written to stdin as JSON user messages and `read()` normalizes the JSONL output via the
 * `claude-code` transcript parser. `overlaps` is `natural-id`: Claude writes the same turns to both
 * the stream and `~/.claude/projects/*.jsonl`, sharing a `uuid`, so the daemon collapses them ().
 *
 * @module sumo/harness/adapters/claude-code
 */

import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { Harness } from '../base/Harness.mjs';
import { Pipe } from '../transport/Pipe.mjs';
import { ok } from '../base/schema.mjs';
import { probeBinary, spawnCollect } from '../base/probe.mjs';
import { toNativeRequestClaudeShaped, toObservationClaudeShaped, toNativeResponseClaudeShaped } from '../hooks/claude-shaped.mjs';
import { claudeSettingsPath, SUMO_HOOK_SENTINEL } from '../install/claude.mjs';

const CONFIG = z.object({
  bin: z.string().default('claude'),
  cwd: z.string().optional(),
  mode: z.enum(['default', 'interactive']).optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional()
});

const CLAUDE_STREAM_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--replay-user-messages'];
const STREAM_ARG_PROBE_MS = 1_000;
const MODEL_COMMANDS = [
  ['models', '--format', 'json'],
  ['models'],
  ['model', 'list', '--format', 'json'],
  ['model', 'list']
];
const ANSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Normalize Claude runtime model rows.
 *
 * @access public
 * @param {unknown} input - Native model-list output.
 * @returns {Array<{ id: string, name?: string, raw: unknown }>} Normalized models.
 */
export function models(input) {
  if (typeof input === 'string') {
    try {
      return models(JSON.parse(input));
    } catch {
      return input
        .replace(ANSI, '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
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
  }

  const rows = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (input).data)
      ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (input).data)
      : [];

  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => {
      const r = /** @type {Record<string, unknown>} */ (row);
      const id = typeof r.id === 'string' ? r.id : '';
      return {
        id,
        ...(typeof r.display_name === 'string' ? { name: r.display_name } : {}),
        ...(typeof r.displayName === 'string' ? { name: r.displayName } : {}),
        ...(typeof r.name === 'string' ? { name: r.name } : {}),
        raw: row
      };
    })
    .filter((row) => row.id);
}

/**
 * Check Claude accepts the exact headless argv Sumo will use, without submitting a prompt.
 *
 * @access private
 * @param {string} bin - Bin supplied to `probeStreamArgs`.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>} Promise resolving to the `probeStreamArgs` result.
 */
function probeStreamArgs(bin) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess|undefined} */
    let proc;
    try {
      proc = spawn(bin, CLAUDE_STREAM_ARGS, {
        stdio: ['pipe', 'ignore', 'pipe']
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: /** @type {Error} */ (err).message
      });
      return;
    }

    let stderr = '';
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    /**
     * Resolve the probe once the binary rejects args, exits, errors, or stays alive long enough.
     *
     * @access private
     * @param {{ ok: true } | { ok: false, reason: string }} result - Result inspected by `done`.
     * @returns {void} Completes without producing a value.
     */
    function done(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc?.kill('SIGKILL'); } catch {}
      resolve(result);
    }

    proc.stderr?.on('data', (d) => {
      stderr += d;
      if (/unknown option|invalid|unexpected argument/i.test(stderr)) {
        done({
          ok: false,
          reason: stderr.trim().split('\n')[0]
        });
      }
    });
    proc.on('error', (err) => done({
      ok: false,
      reason: err.message
    }));
    proc.on('close', (code) => {
      if (code === 0) {
        done({
          ok: true
        });
      } else {
        done({
          ok: false,
          reason: stderr.trim().split('\n')[0] || `exit ${code}`
        });
      }
    });
    timer = setTimeout(() => done({
      ok: true
    }), STREAM_ARG_PROBE_MS);
  });
}

/**
 * Claude implementation.
 *
 * @access public
 * @class
 */
export class Claude extends Harness {
 id = 'claude-code';

 can = {
 stream: true,
 injectStdin: true,
 hooks: true,
 defer: true,
 key: true,
 capture: true,
 cancel: true,
 resume: true,
 providers: ['anthropic']
 };

 /**
 * Known dialog patterns for Claude Code's interactive TUI.
 * Patterns that identify Claude readiness and approval prompts.
 *
 * @type {Array<{ pattern: RegExp, category: 'option_dialog'|'fatal', reasoning: string, remedy?: string[] }>}
 */
 static patterns = [
 {
 pattern: /yes,\s*i\s+accept/i,
 category: 'option_dialog',
 reasoning: 'Claude CLI showing bypass-permissions dialog requiring selection',
 remedy: ['Enter']
 },
 {
 pattern: /do you want to proceed\?[\s\S]*yes,\s*and don't ask again/i,
 category: 'option_dialog',
 reasoning: 'Claude CLI asking MCP tool approval requiring confirmation',
 remedy: ['2', 'Enter']
 }
 ];

 /**
 * Diagnose TUI pane output for known blocking dialogs.
 * Diagnose common Claude output conditions.
 *
 * @access public
 * @param {string|null} output - captured pane text
 * @returns {{ category: 'option_dialog'|'fatal', reasoning: string, remedy?: string[] } | null} Structured output from `diagnose`.
 */
 static diagnose(output) {
 if (!output) return null;
 for (const { pattern, category, reasoning, remedy } of Claude.patterns) {
 if (pattern.test(output)) {
 return {
 category,
 reasoning,
 ...(remedy ? {
 remedy
 }: {})
 };
 }
 }
 return null;
 }

 config = CONFIG;

 // Live stream and on-disk transcript carry the same turns (shared uuid) → dedup expected.
 overlaps = {
 stream: true,
 transcript: true
 };

 transport = new Pipe({
 command: typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin: 'claude',
 args: CLAUDE_STREAM_ARGS,
 cwd: typeof this.ctx.config.cwd === 'string' ? this.ctx.config.cwd: undefined,
 mode: this.ctx.config.mode === 'interactive' || this.ctx.config.mode === 'default' ? this.ctx.config.mode: undefined
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
 const file = claudeSettingsPath(cwd);
 try {
 if (readFileSync(file, 'utf8').includes(SUMO_HOOK_SENTINEL)) {
 return { ok: true, diagnostics: [] };
 }
 return {
 ok: false,
 diagnostics: [{ code: 'SUMO_STEERING_UNVERIFIED', message: `Claude steering disabled: no Sumo-managed hooks found in ${file}` }]
 };
 } catch (err) {
 const code = /** @type {{ code?: string }} */ (err)?.code === 'ENOENT' ? 'SUMO_STEERING_UNVERIFIED': 'SUMO_VERIFY_FAILED';
 return {
 ok: false,
 diagnostics: [{ code, message: `Claude steering disabled: could not verify ${file}: ${/** @type {Error} */ (err).message}` }]
 };
 }
 }

 /**
 * List Claude models through the installed Claude runtime when it exposes a model-list command.
 *
 * @access public
 * @returns {Promise<{ status: 'available'|'unavailable', models: Array<object>, reason?: string }>} Model list result.
 */
 async list() {
 const bin = typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin: 'claude';
 const probe = await probeBinary(bin);
 if (!probe.available) {
 return {
 status: 'unavailable',
 models: [],
 reason: probe.reason ?? `binary '${bin}' unavailable`
 };
 }

 const reasons = [];
 for (const args of MODEL_COMMANDS) {
 const { code, out } = await spawnCollect(bin, args);
 if (code !== 0) {
 reasons.push(out.trim() || `claude ${args.join(' ')} exited ${code}`);
 continue;
 }

 const rows = models(out);
 if (rows.length) {
 return {
 status: 'available',
 models: rows
 };
 }

 reasons.push(`claude ${args.join(' ')} returned no models`);
 }

 return {
 status: 'unavailable',
 models: [],
 reason: reasons.find(Boolean) ?? 'claude model list unavailable'
 };
 }

 /**
 * Pre-open hook: inject runtime opts into spawn args before the process starts.
 * @param {string} _prompt - Prompt supplied to `levels`.
 * @param {{ cwd?: string, model?: string, reasoningEffort?: string, resume?: string }} [opts]
 */
 /** Claude supports low|medium|high; higher levels (e.g. xhigh) map down to high. */
 static #effortMap = {
 low: 'low',
 medium: 'medium',
 high: 'high',
 xhigh: 'high'
 };

 /**
 * Switch Claude's pipe transport between headless JSON and interactive TUI launch modes.
 *
 * @access public
 * @param {string} _prompt - Prompt supplied to `prepare`.
 * @param {{ cwd?: string, mode?: string, model?: string, reasoningEffort?: string, resume?: string }} opts - Options read by this operation.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async prepare(_prompt, opts = {}) {
 const transport = /** @type {import('../transport/Pipe.mjs').Pipe} */ (this.transport);
 // Interactive (tmux) mode launches the REAL Claude TUI, not the headless `-p` stream-json pipe
 // () — swap the base args to empty so only the TUI-valid flags below are added.
 const interactive = opts.mode === 'interactive';
 if (interactive) transport.setBaseArgs([]);
 if (opts.cwd) transport.setCwd(opts.cwd);
 if (opts.model) transport.addArgs(['--model', opts.model]);
 // `--reasoning-effort` is a headless stream-json flag; the interactive TUI does not take it.
 const configEffort = this.ctx.config.reasoningEffort;
 const effort = opts.reasoningEffort ?? (typeof configEffort === 'string' ? configEffort: undefined);
 const effortMap = /** @type {Record<string, string>} */ (Claude.#effortMap);
 if (effort && !interactive) transport.addArgs(['--reasoning-effort', effortMap[String(effort)] ?? 'high']);
 if (opts.resume) transport.addArgs(['--resume', opts.resume]);
 }

 /**
 * One-shot submit: write the single prompt, then signal end-of-input. Claude's `-p` stream-json
 * mode is non-interactive — it completes the turn and exits only once stdin reaches EOF. Without
 * the EOF the subprocess lingers on open stdin, the read loop never ends (`frames` stays open),
 * and the session is force-killed at the caller's deadline (recorded `session.dead`) instead of
 * completing gracefully (`session.ended`). This is the real lifecycle a mock transport hides.
 *
 * @access public
 * @param {Record<string, unknown>} _session - Session supplied to `start`.
 * @param {string} prompt - Prompt supplied to `start`.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async start(_session, prompt) {
 await this.write({
 kind: 'prompt',
 text: prompt
 });
 /** @type {Pipe} */ (this.transport).endInput();
 }

 /**
 * WRITE (act): a Sumo intention → stdin bytes. Claude stream-json input accepts a `user` message;
 * a slash command is sent the same way (Claude interprets a leading `/`). Returns a `Result` (§3b).
 *
 * @access public
 * @param {import('../base/schema.mjs').HarnessAction} action - Action supplied to `write`.
 * @returns {Promise<import('../base/schema.mjs').Result>} Promise that resolves with the shared Result returned by `write`.
 */
 async write(action) {
 if (action.kind === 'prompt' || action.kind === 'command') {
 const text = action.kind === 'prompt' ? action.text: action.line;
 const transport = /** @type {Pipe} */ (this.transport);
 // Interactive (tmux) mode: type the prompt TEXT into the pane (Pipe.send adds Enter) — the TUI is
 // not a stream-json stdin reader, so the headless envelope must NOT be sent there ().
 if (transport.interactive) {
 await transport.send(text);
 return ok();
 }
 const line = JSON.stringify({
 type: 'user',
 message: {
 role: 'user',
 content: text
 }
 }) + '\n';
 await transport.send(line);
 return ok();
 }
 if (action.kind === 'raw') {
 await /** @type {Pipe} */ (this.transport).send(action.bytes);
 return ok();
 }
 return ok();
 }

 // ── Hook surface (spec 12). Verified against real captured Claude payloads (see the committed
 // fixtures + PROVENANCE under packages/harness/test/fixtures/hook/claude-code). Claude is the
 // rich harness: it natively supports pre-tool deny + the stop gate, so no degradation is needed.
 /** @type {Record<string, {kind: 'observe'|'decide', action?: string}>} */
 hookEvents = {
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
 },
 SubagentStop: {
 kind: 'decide',
 action: 'finish'
 },
 SessionStart: {
 kind: 'observe'
 },
 Notification: {
 kind: 'observe'
 }
 };

 /**
 * Parse a native Claude hook payload (Claude-shaped) into the normalized steer request.
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
 * Translate `{event}|{deny}` into Claude's native response (verified: campsite-rule).
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
 * Normalize an observation hook into a `07` event that collapses with the transcript copy.
 *
 * @access public
 * @param {string} nativeEvent - Native hook event name.
 * @param {Record<string, unknown>} payload - Payload consumed by `toObservation`.
 * @returns {import('sumo/transcript').NormalizedEventInput | null} Normalized observation event, when supported.
 */
 toObservation(nativeEvent, payload = {}) {
 return toObservationClaudeShaped('claude-code', nativeEvent, payload);
 }

 /**
 * Pre-flight: probe that the claude binary is installed and responsive.
 *
 * @access public
 * @returns {Promise<{ status: 'available'|'unavailable'|'unknown', version?: string|null, reason?: string, bin?: string }>} Availability state for Claude.
 */
 async available() {
 const bin = typeof this.ctx.config.bin === 'string' ? this.ctx.config.bin: 'claude';
 const result = await probeBinary(bin);
 if (!result.available) {
 return {
 status: 'unavailable',
 reason: result.reason
 };
 }
 const stream = await probeStreamArgs(bin);
 return stream.ok
 ? {
 status: 'available',
 version: result.version,
 bin
 }
: {
 status: 'unavailable',
 reason: `stream-json argv unsupported: ${stream.reason}`
 };
 }

 /**
 * Native interactive resume (the real TUI): `claude --resume <nativeId>`. Used by `sumo attach`.
 *
 * @access public
 * @param {string} nativeId - Harness-native session id.
 * @returns {string[]|null} Native CLI arguments for interactive resume.
 */
 interactiveResumeArgv(nativeId) {
 return nativeId ? ['--resume', nativeId]: null;
 }

 /**
 * Claude's on-disk transcript is a pure function of (nativeId, cwd): under the Claude config dir
 * (`$CLAUDE_CONFIG_DIR`, else `~/.claude`), `projects/<encoded-cwd>/<nativeId>.jsonl`, where the cwd
 * is encoded by replacing every non-alphanumeric char with `-` (verified against real on-disk paths).
 *
 * @access public
 * @param {string} nativeId - Identifier used by `transcriptPathFor`.
 * @param {string} cwd - Filesystem location used by `transcriptPathFor`.
 * @returns {string|undefined} String undefined returned by `transcriptPathFor`.
 */
 transcriptPathFor(nativeId, cwd) {
 if (!nativeId || !cwd) return undefined;
 const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
 return path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`);
 }
}
