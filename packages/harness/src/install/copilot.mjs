/**
 * GitHub Copilot hook install/reconcile (spec 05/12/13). Copilot CLI supports repository hook files
 * under `.github/hooks/*.json`; Sumo writes `.github/hooks/sumo.json` using GitHub's documented
 * version-1 hook schema and forwards events into `sumo forward copilot <event>`.
 *
 * @module sumo/harness/install/copilot
 */

import path from 'node:path';

import { readJson, writeJsonIfChanged } from './json.mjs';

export const SUMO_COPILOT_PREFIX = 'sumo forward copilot';
/** Unambiguous Sumo-owned marker in shell commands. */
export const SUMO_COPILOT_SENTINEL = '# sumo-managed:copilot';

/**
 * @typedef {{ event: string, matcher?: string, safety?: boolean, timeoutSec?: number }} CopilotHookSpec
 * @typedef {Record<string, unknown> & { command?: string, bash?: string, powershell?: string, matcher?: string, timeoutSec?: number }} CopilotHookEntry
 * @typedef {Record<string, CopilotHookEntry[]>} CopilotHookConfig
 * @typedef {Record<string, unknown> & { version?: number, hooks?: CopilotHookConfig }} CopilotHooksFile
 * @typedef {{ ok: true, changed: boolean, path: string } | { ok: false, code: string, reason: string }} CopilotInstallResult
 */

/** @type {CopilotHookSpec[]} Default Copilot hooks Sumo can currently forward through public paths. */
export const DEFAULT_COPILOT_HOOKS = [
  { event: 'sessionStart' }, { event: 'sessionEnd' }, { event: 'userPromptSubmitted' }, { event: 'preToolUse' }, { event: 'permissionRequest' }, { event: 'postToolUse' }, { event: 'postToolUseFailure' }, { event: 'agentStop' }, { event: 'subagentStart' }, { event: 'subagentStop' }, { event: 'errorOccurred' }, { event: 'preCompact' }, { event: 'notification' }
];

/**
 * Build the command string written into Copilot hook config.
 *
 * @access private
 * @param {string} event - Copilot hook event forwarded to Sumo.
 * @param {boolean|undefined} safety - Whether forwarding should fail closed.
 * @param {string|undefined} bin - Optional command prefix replacing `sumo forward copilot`.
 * @returns {string} Shell command written into Copilot hook config.
 */
function commandFor(event, safety, bin) {
  const head = bin ? `${bin} ${event}` : `${SUMO_COPILOT_PREFIX} ${event}`;
  return `${head}${safety ? ' --safety' : ''} ${SUMO_COPILOT_SENTINEL}`;
}

/**
 * Test whether a Copilot hook command entry is owned by Sumo.
 *
 * @access private
 * @param {unknown} entry - Hook command entry from a Copilot repository hook file.
 * @returns {boolean} True when any shell command field carries Sumo's Copilot sentinel.
 */
function isSumoEntry(entry) {
  const record = entry && typeof entry === 'object' ? /** @type {CopilotHookEntry} */ (entry) : {};
  return ['command', 'bash', 'powershell'].some((field) => {
    const value = record[field];
    return typeof value === 'string' && value.includes(SUMO_COPILOT_SENTINEL);
  });
}

/**
 * Reconcile Sumo's hooks into a Copilot hook file object (`{ version: 1, hooks: { <event>: [...] } }`).
 *
 * @access public
 * @param {unknown} config - Existing parsed Copilot hook-file value.
 * @param {CopilotHookSpec[]} hooks - Desired Sumo-managed Copilot hook specs.
 * @param {{ bin?: string }} opts - Optional command override.
 * @returns {CopilotHooksFile} New hook config with Sumo-owned entries replaced.
 */
export function reconcileCopilotHooks(config, hooks = DEFAULT_COPILOT_HOOKS, opts = {}) {
  const next = /** @type {CopilotHooksFile} */ (structuredClone(config && typeof config === 'object' ? config : {}));
  next.version = next.version ?? 1;
  const hookCfg = next.hooks && typeof next.hooks === 'object' ? next.hooks : /** @type {CopilotHookConfig} */ ({});
  next.hooks = hookCfg;

  for (const event of Object.keys(hookCfg)) {
    if (Array.isArray(hookCfg[event])) hookCfg[event] = hookCfg[event].filter((entry) => !isSumoEntry(entry));
  }

  for (const hook of hooks) {
    const foreign = Array.isArray(hookCfg[hook.event]) ? hookCfg[hook.event] : [];
    const entry = {
      type: 'command', command: commandFor(hook.event, hook.safety, opts.bin),
      ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
      ...(hook.timeoutSec !== undefined ? { timeoutSec: hook.timeoutSec } : {})
    };
    hookCfg[hook.event] = [...foreign, entry];
  }

  for (const event of Object.keys(hookCfg)) {
    if (Array.isArray(hookCfg[event]) && hookCfg[event].length === 0) delete hookCfg[event];
  }
  if (Object.keys(hookCfg).length === 0) delete next.hooks;
  return next;
}

/**
 * Remove every Sumo-owned Copilot hook entry, preserving foreign hook config.
 *
 * @access public
 * @param {unknown} config - Existing parsed Copilot hook-file value.
 * @returns {CopilotHooksFile} New hook config containing only foreign entries.
 */
export function stripCopilotHooks(config) {
  const next = /** @type {CopilotHooksFile} */ (structuredClone(config && typeof config === 'object' ? config : {}));
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((entry) => !isSumoEntry(entry));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

/**
 * Resolve Sumo's repository-local Copilot hook file.
 *
 * @access public
 * @param {string} projectDir - Filesystem location used by `copilotHooksPath`.
 * @returns {string} Absolute path to Sumo's repository-local Copilot hook file.
 */
export function copilotHooksPath(projectDir) {
  return path.join(projectDir, '.github', 'hooks', 'sumo.json');
}

/**
 * Read → reconcile → write `.github/hooks/sumo.json`.
 *
 * @access public
 * @param {{ projectDir: string, hooks?: Array<{ event: string, matcher?: string, safety?: boolean, timeoutSec?: number }>, bin?: string }} opts - Options read by this operation.
 * @returns {CopilotInstallResult} Install result including whether the hook file changed.
 */
export function installCopilotHooks({ projectDir, hooks = DEFAULT_COPILOT_HOOKS, bin }) {
  const file = copilotHooksPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = reconcileCopilotHooks(r.value, hooks, bin ? { bin } : {});
  const changed = writeJsonIfChanged(file, r, after);
  return { ok: true, changed, path: file };
}

/**
 * Remove Sumo-owned Copilot hooks from the project hook file.
 *
 * @access public
 * @param {{ projectDir: string }} opts - Options read by this operation.
 * @returns {CopilotInstallResult} Uninstall result including whether the hook file changed.
 */
export function uninstallCopilotHooks({ projectDir }) {
  const file = copilotHooksPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = stripCopilotHooks(r.value);
  const changed = writeJsonIfChanged(file, r, after);
  return { ok: true, changed, path: file };
}
