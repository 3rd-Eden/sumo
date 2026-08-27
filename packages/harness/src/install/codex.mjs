/**
 * Codex hook install/reconcile (spec 05/12/13). Writes Sumo's hook config into Codex's
 * `.codex/hooks.json` so matched hooks forward into `sumo forward codex <event>`. The native config
 * shape is verified from captured adapter behavior and a real Codex 0.142
 * project-local hook run. Same install contract as Claude: idempotent, foreign-preserving, reversible,
 * Sumo-owned via a trailing shell-comment sentinel.
 *
 * Current Codex exposes a stable `hooks` feature that is enabled by default. If a user's config
 * explicitly disables `[features] hooks = false`, install reports a warning instead of silently
 * mutating the global `$CODEX_HOME/config.toml`.
 *
 * @module sumo/harness/install/codex
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { readJson, writeJsonIfChanged } from './json.mjs';

export const SUMO_CODEX_PREFIX = 'sumo forward codex';
/** Unambiguous Sumo-owned marker — a trailing shell comment (bin-independent, foreign-safe). */
export const SUMO_CODEX_SENTINEL = '# sumo-managed:codex';

/**
 * @typedef {{ event: string, matcher?: string, safety?: boolean, timeout?: number }} CodexHookSpec
 * @typedef {Record<string, unknown> & { type?: string, command?: string, timeout?: number }} CodexCommandHook
 * @typedef {Record<string, unknown> & { matcher?: string, hooks?: CodexCommandHook[] }} CodexHookEntry
 * @typedef {Record<string, CodexHookEntry[]>} CodexHookConfig
 * @typedef {Record<string, unknown> & { hooks?: CodexHookConfig }} CodexHooksFile
 * @typedef {{ ok: true, changed: boolean, path: string } | { ok: false, code: string, reason: string }} CodexUninstallResult
 * @typedef {{ ok: true, changed: boolean, path: string, featureEnabled: boolean|null, warnings: string[] } | { ok: false, code: string, reason: string }} CodexInstallResult
 */

/** @type {CodexHookSpec[]} The default Codex hook set across Codex's documented lifecycle surface. */
export const DEFAULT_CODEX_HOOKS = [
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact' }, { event: 'PreToolUse' }, { event: 'PermissionRequest' }, { event: 'PostToolUse' }, { event: 'PreCompact', matcher: 'manual|auto' }, { event: 'PostCompact', matcher: 'manual|auto' }, { event: 'UserPromptSubmit' }, { event: 'SubagentStart' }, { event: 'SubagentStop' }, { event: 'Stop', timeout: 30 }
];

/**
 * Build the command string written into Codex hook config.
 *
 * @access private
 * @param {string} event - Codex hook event forwarded to Sumo.
 * @param {boolean|undefined} safety - Whether forwarding should fail closed.
 * @param {string|undefined} bin - Optional command prefix replacing `sumo forward codex`.
 * @returns {string} Shell command written into Codex hook config.
 */
function commandFor(event, safety, bin) {
  const head = bin ? `${bin} ${event}` : `${SUMO_CODEX_PREFIX} ${event}`;
  return `${head}${safety ? ' --safety' : ''} ${SUMO_CODEX_SENTINEL}`;
}

/**
 * Test whether a Codex hook config entry is owned by Sumo.
 *
 * @access private
 * @param {unknown} entry - Hook-group entry from `.codex/hooks.json`.
 * @returns {boolean} True when a nested command carries Sumo's Codex sentinel.
 */
function isSumoEntry(entry) {
  const record = entry && typeof entry === 'object' ? /** @type {CodexHookEntry} */ (entry) : {};
  return Array.isArray(record.hooks) && record.hooks.some((h) => typeof h.command === 'string' && h.command.includes(SUMO_CODEX_SENTINEL));
}

/**
 * Reconcile Sumo's hooks into a `.codex/hooks.json` object (`{ hooks: { <event>: [ … ] } }`).
 *
 * @access public
 * @param {unknown} config - Existing parsed `.codex/hooks.json` value.
 * @param {CodexHookSpec[]} hooks - Desired Sumo-managed Codex hook specs.
 * @param {{ bin?: string }} opts - Optional command override.
 * @returns {CodexHooksFile} New hook config with Sumo-owned entries replaced.
 */
export function reconcileCodexHooks(config, hooks = DEFAULT_CODEX_HOOKS, opts = {}) {
  const next = /** @type {CodexHooksFile} */ (structuredClone(config && typeof config === 'object' ? config : {}));
  const hookCfg = next.hooks && typeof next.hooks === 'object' ? next.hooks : /** @type {CodexHookConfig} */ ({});
  next.hooks = hookCfg;

  for (const event of Object.keys(hookCfg)) {
    if (Array.isArray(hookCfg[event])) hookCfg[event] = hookCfg[event].filter((e) => !isSumoEntry(e));
  }
  for (const h of hooks) {
    const foreign = Array.isArray(hookCfg[h.event]) ? hookCfg[h.event] : [];
    const entry = {
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: commandFor(h.event, h.safety, opts.bin), ...(h.timeout ? { timeout: h.timeout } : {}) }]
    };
    hookCfg[h.event] = [...foreign, entry];
  }
  for (const event of Object.keys(hookCfg)) {
    if (Array.isArray(hookCfg[event]) && hookCfg[event].length === 0) delete hookCfg[event];
  }
  if (Object.keys(hookCfg).length === 0) delete next.hooks;
  return next;
}

/**
 * Remove every Sumo-owned Codex hook entry, preserving foreign config.
 *
 * @access public
 * @param {unknown} config - Existing parsed `.codex/hooks.json` value.
 * @returns {CodexHooksFile} New hook config containing only foreign entries.
 */
export function stripCodexHooks(config) {
  const next = /** @type {CodexHooksFile} */ (structuredClone(config && typeof config === 'object' ? config : {}));
  if (!next.hooks || typeof next.hooks !== 'object') return next;
  for (const event of Object.keys(next.hooks)) {
    if (!Array.isArray(next.hooks[event])) continue;
    next.hooks[event] = next.hooks[event].filter((e) => !isSumoEntry(e));
    if (next.hooks[event].length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

/**
 * Resolve the project-local Codex hooks config path.
 *
 * @access public
 * @param {string} projectDir - Filesystem location used by `codexHooksPath`.
 * @returns {string} Absolute path to the project-local Codex hooks file.
 */
export function codexHooksPath(projectDir) {
  return path.join(projectDir, '.codex', 'hooks.json');
}

/**
 * Resolve `config.toml` under `$CODEX_HOME` (else `~/.codex`).
 *
 * @access public
 * @param {NodeJS.ProcessEnv} env - Environment variables used by the operation.
 * @returns {string} Absolute path to Codex's user config file.
 */
export function codexConfigTomlPath(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

/**
 * Is Codex hook execution enabled? Current Codex uses `features.hooks`; `codex_hooks` is accepted as
 * a legacy key for older installs. If neither key is present, current Codex defaults hooks to enabled.
 *
 * @access public
 * @param {NodeJS.ProcessEnv} env - Environment variables used by the operation.
 * @returns {boolean|null} `true` when hooks are enabled, `false` when disabled, or `null` when unreadable.
 */
export function codexHooksEnabled(env = process.env) {
  let toml;
  try {
    toml = fs.readFileSync(codexConfigTomlPath(env), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return true;
    throw err;
  }
  try {
    const parsed = /** @type {Record<string, unknown>} */ (TOML.parse(toml));
    const features = parsed.features && typeof parsed.features === 'object' ? /** @type {Record<string, unknown>} */ (parsed.features) : {};
    if (typeof features.hooks === 'boolean') return features.hooks;
    if (typeof features.codex_hooks === 'boolean') return features.codex_hooks;
  } catch {
    return null;
  }
  return true;
}

/**
 * Read → reconcile → write `.codex/hooks.json`. Returns `changed` + a `featureEnabled` flag/warning so
 * the caller can tell the user to enable Codex's stable `hooks` feature if it is explicitly disabled.
 *
 * @access public
 * @param {{ projectDir: string, hooks?: CodexHookSpec[], bin?: string, env?: NodeJS.ProcessEnv }} opts - Install options for Codex hooks.
 * @returns {CodexInstallResult} Install result plus feature-state warnings for disabled hooks.
 */
export function installCodexHooks({ projectDir, hooks = DEFAULT_CODEX_HOOKS, bin, env = process.env }) {
  const file = codexHooksPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = reconcileCodexHooks(r.value, hooks, bin ? { bin } : {});
  const changed = writeJsonIfChanged(file, r, after);
  const featureEnabled = codexHooksEnabled(env);
  /** @type {string[]} */
  let warnings = [];
  if (featureEnabled === false) {
    warnings = ['Codex hooks require the stable `hooks` feature: remove `[features] hooks = false` or set `[features]\\nhooks = true` in ~/.codex/config.toml'];
  } else if (featureEnabled === null) {
    warnings = ['Could not verify Codex hooks feature status; ensure the `hooks` feature is enabled'];
  }
  return { ok: true, changed, path: file, featureEnabled, warnings };
}

/**
 * Remove Sumo-owned Codex hooks from the project config.
 *
 * @access public
 * @param {{ projectDir: string }} opts - Options read by this operation.
 * @returns {CodexUninstallResult} Uninstall result including whether the file changed.
 */
export function uninstallCodexHooks({ projectDir }) {
  const file = codexHooksPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = stripCodexHooks(r.value);
  const changed = writeJsonIfChanged(file, r, after);
  return { ok: true, changed, path: file };
}
