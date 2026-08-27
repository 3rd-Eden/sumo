/**
 * Cursor hook install/reconcile (spec 05/12/13). Writes Sumo's hook config into `.cursor/hooks.json`
 * so matched hooks forward into `sumo forward cursor <event>`. The native config shape is verified from
 * Cursor's official hook docs + the captured `.cursor/hooks.json`: `{ version: 1, hooks: {
 * <event>: [ { command } ] } }` — a FLAT command list per event (no nested `hooks[]` array, unlike
 * Claude/Codex). Same install contract: idempotent, foreign-preserving, reversible, Sumo-owned via a
 * trailing shell-comment sentinel.
 *
 * @module sumo/harness/install/cursor
 */

import path from 'node:path';

import { readJson, writeJsonIfChanged } from './json.mjs';

export const SUMO_CURSOR_PREFIX = 'sumo forward cursor';
export const SUMO_CURSOR_SENTINEL = '# sumo-managed:cursor';

/**
 * @typedef {{ event: string, safety?: boolean }} CursorHookSpec
 * @typedef {Record<string, unknown> & { command?: string }} CursorHookEntry
 * @typedef {Record<string, CursorHookEntry[]>} CursorHookConfig
 * @typedef {Record<string, unknown> & { version?: number, hooks?: CursorHookConfig }} CursorHooksFile
 * @typedef {{ ok: true, changed: boolean, path: string } | { ok: false, code: string, reason: string }} CursorInstallResult
 */

/** @type {string[]} Cursor's documented hook surface; non-headless events simply never fire when unavailable. */
export const DEFAULT_CURSOR_HOOKS = [
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'subagentStart',
  'subagentStop',
  'sessionStart',
  'sessionEnd',
  'beforeShellExecution',
  'beforeMCPExecution',
  'afterShellExecution',
  'afterMCPExecution',
  'afterFileEdit',
  'beforeReadFile',
  'beforeTabFileRead',
  'afterTabFileEdit',
  'beforeSubmitPrompt',
  'afterAgentResponse',
  'afterAgentThought',
  'stop',
  'preCompact',
  'workspaceOpen'
];

/**
 * Build the command string written into Cursor hook config.
 *
 * @access private
 * @param {string} event - Cursor hook event forwarded to Sumo.
 * @param {boolean|undefined} safety - Whether forwarding should fail closed.
 * @param {string|undefined} bin - Optional command prefix replacing `sumo forward cursor`.
 * @returns {string} Shell command written into Cursor hook config.
 */
function commandFor(event, safety, bin) {
  const head = bin ? `${bin} ${event}` : `${SUMO_CURSOR_PREFIX} ${event}`;
  return `${head}${safety ? ' --safety' : ''} ${SUMO_CURSOR_SENTINEL}`;
}

/**
 * Test whether a Cursor hook command is owned by Sumo.
 *
 * @access private
 * @param {unknown} entry - Hook command entry from `.cursor/hooks.json`.
 * @returns {boolean} True when the command carries Sumo's Cursor sentinel.
 */
function isSumoCommand(entry) {
  const record = entry && typeof entry === 'object' ? /** @type {CursorHookEntry} */ (entry) : {};
  return typeof record.command === 'string' && record.command.includes(SUMO_CURSOR_SENTINEL);
}

/**
 * Reconcile Sumo's hooks into a `.cursor/hooks.json` object (`{ version:1, hooks: { <event>: [ { command } ] } }`).
 *
 * @access public
 * @param {unknown} config - Existing parsed `.cursor/hooks.json` value.
 * @param {Array<string|CursorHookSpec>} events - Desired Sumo-managed Cursor events.
 * @param {{ bin?: string }} opts - Optional command override.
 * @returns {CursorHooksFile} New hook config with Sumo-owned commands replaced.
 */
export function reconcileCursorHooks(config, events = DEFAULT_CURSOR_HOOKS, opts = {}) {
  const next = /** @type {CursorHooksFile} */ (structuredClone(config && typeof config === 'object' ? config : {}));
  next.version = next.version ?? 1;
  const hookCfg = next.hooks && typeof next.hooks === 'object' ? next.hooks : /** @type {CursorHookConfig} */ ({});
  next.hooks = hookCfg;

  for (const event of Object.keys(hookCfg)) {
    if (Array.isArray(hookCfg[event])) hookCfg[event] = hookCfg[event].filter((e) => !isSumoCommand(e));
  }
  for (const event of events) {
    const ev = typeof event === 'string' ? { event } : event;
    const foreign = Array.isArray(hookCfg[ev.event]) ? hookCfg[ev.event] : [];
    hookCfg[ev.event] = [...foreign, { command: commandFor(ev.event, ev.safety, opts.bin) }];
  }
  for (const event of Object.keys(hookCfg)) {
    if (Array.isArray(hookCfg[event]) && hookCfg[event].length === 0) delete hookCfg[event];
  }
  return next;
}

/**
 * Remove every Sumo-owned Cursor hook command, preserving foreign config.
 *
 * @access public
 * @param {unknown} config - Existing parsed `.cursor/hooks.json` value.
 * @returns {CursorHooksFile} New hook config containing only foreign commands.
 */
export function stripCursorHooks(config) {
  const next = /** @type {CursorHooksFile} */ (structuredClone(config && typeof config === 'object' ? config : {}));
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((e) => !isSumoCommand(e));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  return next;
}

/**
 * Resolve the project-local Cursor hooks config path.
 *
 * @access public
 * @param {string} projectDir - Filesystem location used by `cursorHooksPath`.
 * @returns {string} Absolute path to the project-local Cursor hooks file.
 */
export function cursorHooksPath(projectDir) {
  return path.join(projectDir, '.cursor', 'hooks.json');
}

/**
 * Read, reconcile, and write `.cursor/hooks.json`.
 *
 * @access public
 * @param {{ projectDir: string, events?: Array<string|{ event: string, safety?: boolean }>, bin?: string }} opts - Install options for the Cursor hook file.
 * @returns {CursorInstallResult} Install result for the Cursor hook file.
 */
export function installCursorHooks({ projectDir, events = DEFAULT_CURSOR_HOOKS, bin }) {
  const file = cursorHooksPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = reconcileCursorHooks(r.value, events, bin ? { bin } : {});
  const changed = writeJsonIfChanged(file, r, after);
  return { ok: true, changed, path: file };
}

/**
 * Remove Sumo-owned Cursor hooks from the project config.
 *
 * @access public
 * @param {{ projectDir: string }} opts - Options read by this operation.
 * @returns {CursorInstallResult} Uninstall result including whether the file changed.
 */
export function uninstallCursorHooks({ projectDir }) {
  const file = cursorHooksPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = stripCursorHooks(r.value);
  const changed = writeJsonIfChanged(file, r, after);
  return { ok: true, changed, path: file };
}
