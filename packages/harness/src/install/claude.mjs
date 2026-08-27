/**
 * Claude Code hook install/reconcile (spec 05 install-and-verify, spec 12, spec 13). Writes Sumo's
 * native hook config into Claude's `settings.json` so matched hooks forward into
 * `sumo forward claude-code <event>`. Obeys the install contract (CLAUDE.md / S-...): reconcile
 * idempotently, preserve foreign config, mark Sumo-owned entries, and be reversible.
 *
 * Sumo OWNS exactly the hook entries whose command begins with `sumo forward ` — that prefix is the
 * marker (no extra fields that Claude's schema might reject). Reconcile and uninstall touch only those;
 * any hand-authored or third-party hook is preserved verbatim.
 *
 * These are PURE functions over a settings object so they are exhaustively unit-testable; the I/O
 * (read/merge/write `.claude/settings.json`) is a thin wrapper (`installClaudeHooks`).
 *
 * @module sumo/harness/install/claude
 */

import path from 'node:path';

import { readJson, writeJsonIfChanged } from './json.mjs';

/** The default Sumo hook command prefix. */
export const SUMO_COMMAND_PREFIX = 'sumo forward claude-code';
/**
 * The unambiguous Sumo-owned marker: a trailing SHELL COMMENT appended to every command we write. The
 * shell ignores it at execution time, and no foreign hook command would contain this exact sentinel —
 * so reconcile/uninstall manage ONLY our entries, independent of the invoking `bin`. (The
 * old `includes('forward claude-code')` substring could false-positive a foreign command.)
 */
export const SUMO_HOOK_SENTINEL = '# sumo-managed:claude-code';

/**
 * @typedef {{ event: string, matcher?: string, safety?: boolean }} ClaudeHookSpec
 * @typedef {Record<string, unknown> & { type?: string, command?: string }} ClaudeCommandHook
 * @typedef {Record<string, unknown> & { matcher?: string, hooks?: ClaudeCommandHook[] }} ClaudeHookEntry
 * @typedef {Record<string, ClaudeHookEntry[]>} ClaudeHookConfig
 * @typedef {Record<string, unknown> & { hooks?: ClaudeHookConfig }} ClaudeSettings
 * @typedef {{ ok: true, changed: boolean, path: string } | { ok: false, code: string, reason: string }} HookInstallResult
 */

/** @type {ClaudeHookSpec[]} The default hook set Sumo installs for Claude. */
export const DEFAULT_CLAUDE_HOOKS = [
  { event: 'PreToolUse' }, // decide/tool
  { event: 'PostToolUse' }, // observe
  { event: 'UserPromptSubmit' }, // decide/prompt
  { event: 'Stop' }, // decide/finish (stop gate)
  { event: 'SessionStart' } // observe
];

/**
 * Build the Sumo command string for an event (+ the per-hook safety flag → fail-closed when down).
 *  `bin` lets an install target a non-default invocation (e.g. an absolute `node …/cli.mjs` in tests);
 *  it must still END with the `sumo forward claude-code` marker so reconcile/uninstall own the entry.
 *
 * @access private
 * @param {string} event - Claude hook event forwarded to Sumo.
 * @param {boolean|undefined} safety - Whether the hook should fail closed when forwarding fails.
 * @param {string|undefined} bin - Optional command prefix replacing the default `sumo forward claude-code`.
 * @returns {string} Shell command written into Claude settings.
 */
function commandFor(event, safety, bin) {
  const head = bin ? `${bin} ${event}` : `${SUMO_COMMAND_PREFIX} ${event}`;
  return `${head}${safety ? ' --safety' : ''} ${SUMO_HOOK_SENTINEL}`;
}

/**
 * Is this Claude hook-group entry Sumo-owned (any inner command carries our sentinel comment)?
 *
 * @access private
 * @param {unknown} entry - Hook-group entry from a user settings file.
 * @returns {boolean} True when any nested command carries Sumo's Claude sentinel.
 */
function isSumoEntry(entry) {
  const record = entry && typeof entry === 'object' ? /** @type {ClaudeHookEntry} */ (entry) : {};
  return Array.isArray(record.hooks) && record.hooks.some((h) => typeof h.command === 'string' && h.command.includes(SUMO_HOOK_SENTINEL));
}

/**
 * Reconcile Sumo's hooks into a Claude settings object. Returns a NEW object (no mutation). Idempotent:
 * reconciling an already-reconciled settings yields an equivalent result. Foreign hooks are preserved;
 * stale Sumo entries (e.g. an event no longer in the spec) are dropped.
 *
 * @access public
 * @param {unknown} settings - Existing parsed `settings.json` value, or an empty object for a missing file.
 * @param {ClaudeHookSpec[]} hooks - Desired Sumo-managed Claude hook specs.
 * @param {{ bin?: string }} opts - `bin` overrides the default `sumo forward claude-code` invocation.
 * @returns {ClaudeSettings} New settings object with Sumo-owned hooks replaced and foreign hooks preserved.
 */
export function reconcileClaudeSettings(settings, hooks = DEFAULT_CLAUDE_HOOKS, opts = {}) {
  const next = /** @type {ClaudeSettings} */ (structuredClone(settings && typeof settings === 'object' ? settings : {}));
  const hookCfg = (next.hooks && typeof next.hooks === 'object') ? next.hooks : /** @type {ClaudeHookConfig} */ ({});
  next.hooks = hookCfg;

  // Group desired Sumo hooks by event.
  /** @type {Map<string, ClaudeHookSpec[]>} */
  const byEvent = new Map();
  for (const h of hooks) {
    if (!byEvent.has(h.event)) byEvent.set(h.event, []);
    byEvent.get(h.event)?.push(h);
  }

  // 1. Drop ALL existing Sumo-owned entries everywhere (so reconcile is a clean replace of our own).
  for (const event of Object.keys(hookCfg)) {
    if (!Array.isArray(hookCfg[event])) continue;
    hookCfg[event] = hookCfg[event].filter((entry) => !isSumoEntry(entry));
  }

  // 2. Add the desired Sumo entries, preserving foreign entries already present.
  for (const [event, list] of byEvent) {
    const foreign = Array.isArray(hookCfg[event]) ? hookCfg[event] : [];
    const sumoEntries = list.map((h) => ({
      ...(h.matcher !== undefined ? { matcher: h.matcher } : {}), hooks: [{ type: 'command', command: commandFor(event, h.safety, opts.bin) }]
    }));
    hookCfg[event] = [...foreign, ...sumoEntries];
  }

  // 3. Tidy: drop event arrays we emptied (no foreign, no Sumo), and an empty `hooks` block.
  for (const event of Object.keys(hookCfg)) {
    if (Array.isArray(hookCfg[event]) && hookCfg[event].length === 0) delete hookCfg[event];
  }
  if (Object.keys(hookCfg).length === 0) delete next.hooks;
  return next;
}

/**
 * Remove every Sumo-owned hook entry, restoring the settings to its pre-install (foreign-only) shape.
 *
 * @access public
 * @param {unknown} settings - Existing parsed `settings.json` value.
 * @returns {ClaudeSettings} New settings object with only Sumo-owned hook entries removed.
 */
export function stripSumoHooks(settings) {
  const next = /** @type {ClaudeSettings} */ (structuredClone(settings && typeof settings === 'object' ? settings : {}));
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
 * The settings file Sumo writes (project-scoped, consent-gated).
 *
 * @access public
 * @param {string} projectDir - Filesystem location used by `claudeSettingsPath`.
 * @returns {string} Absolute path to the project-scoped Claude settings file.
 */
export function claudeSettingsPath(projectDir) {
  return path.join(projectDir, '.claude', 'settings.json');
}

/**
 * Read → reconcile → write `.claude/settings.json` for a project. Idempotent and reversible
 * (`uninstallClaudeHooks`). Returns whether the file content changed (so a re-run reports a no-op).
 *
 * @access public
 * @param {{ projectDir: string, hooks?: Array<{ event: string, matcher?: string, safety?: boolean }>, bin?: string }} opts - Options read by this operation.
 * @returns {HookInstallResult} Install result including whether the settings file changed.
 */
export function installClaudeHooks(opts) {
  const { projectDir, hooks = DEFAULT_CLAUDE_HOOKS, bin } = opts;
  const file = claudeSettingsPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = reconcileClaudeSettings(r.value, hooks, bin ? { bin } : {});
  const changed = writeJsonIfChanged(file, r, after);
  return { ok: true, changed, path: file };
}

/**
 * Remove Sumo's hooks from a project's `.claude/settings.json`, preserving foreign config.
 *
 * @access public
 * @param {{ projectDir: string }} opts - Options read by this operation.
 * @returns {HookInstallResult} Uninstall result including whether the settings file changed.
 */
export function uninstallClaudeHooks(opts) {
  const { projectDir } = opts;
  const file = claudeSettingsPath(projectDir);
  const r = readJson(file);
  if (!r.ok) return r;
  const after = stripSumoHooks(r.value);
  const changed = writeJsonIfChanged(file, r, after);
  return { ok: true, changed, path: file };
}
