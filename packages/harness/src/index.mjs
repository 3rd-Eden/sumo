/**
 * `sumo/harness` — the control adapter layer. It spawns and drives the agentic coding adapters and
 * turns their live output into normalized events (the live-stream source; the on-disk source is
 * `agent-artifacts`, spec 09). Built as a multi-harness batch so the base spans real divergence
 * (/): a `pipe` kind (Claude, Cursor) and a `server` kind (Codex), with the transport as a
 * swappable class prop and every per-harness difference a declared `can` flag — never a base
 * assumption.
 *
 * Authors extend `Harness`, declare `id`/`can`/`config`/`transport`/`overlaps`, and implement `write`
 * (and optionally `read`/`prepare`/`start`). The base owns Session construction, the read loop,
 * dedupe, event append, lifecycle, and capability degradation. Registration is the plugin verb
 * `sumo.harness(id, (hctx) => new Cls(hctx))`.
 *
 * @module sumo/harness
 */

export { Harness } from './base/Harness.mjs';
export { Claude } from './adapters/claude-code.mjs';
export { Cursor } from './adapters/cursor.mjs';
export { Codex } from './adapters/codex.mjs';
export { Copilot } from './adapters/copilot.mjs';

import { Claude } from './adapters/claude-code.mjs';
import { Cursor } from './adapters/cursor.mjs';
import { Codex } from './adapters/codex.mjs';
import { Copilot } from './adapters/copilot.mjs';
import {
  installClaudeHooks, uninstallClaudeHooks, reconcileClaudeSettings, stripSumoHooks, claudeSettingsPath, DEFAULT_CLAUDE_HOOKS, SUMO_COMMAND_PREFIX, SUMO_HOOK_SENTINEL
} from './install/claude.mjs';
import {
  installCodexHooks, uninstallCodexHooks, reconcileCodexHooks, stripCodexHooks, codexHooksPath, codexHooksEnabled, DEFAULT_CODEX_HOOKS, SUMO_CODEX_SENTINEL
} from './install/codex.mjs';
import {
  installCursorHooks, uninstallCursorHooks, reconcileCursorHooks, stripCursorHooks, cursorHooksPath, DEFAULT_CURSOR_HOOKS, SUMO_CURSOR_SENTINEL
} from './install/cursor.mjs';
import {
  installCopilotHooks, uninstallCopilotHooks, reconcileCopilotHooks, stripCopilotHooks, copilotHooksPath, DEFAULT_COPILOT_HOOKS, SUMO_COPILOT_SENTINEL
} from './install/copilot.mjs';

/** The harness adapter registry, keyed on harness id. */
export const adapters = {
  'claude-code': Claude, cursor: Cursor, codex: Codex, copilot: Copilot
};

/** Install/uninstall helpers for the claude-code harness. */
export const claude = {
  install: installClaudeHooks, uninstall: uninstallClaudeHooks, reconcile: reconcileClaudeSettings, strip: stripSumoHooks, path: claudeSettingsPath, DEFAULT_HOOKS: DEFAULT_CLAUDE_HOOKS, COMMAND_PREFIX: SUMO_COMMAND_PREFIX, HOOK_SENTINEL: SUMO_HOOK_SENTINEL
};

/** Install/uninstall helpers for the codex harness. */
export const codex = {
  install: installCodexHooks, uninstall: uninstallCodexHooks, reconcile: reconcileCodexHooks, strip: stripCodexHooks, path: codexHooksPath, hooksEnabled: codexHooksEnabled, DEFAULT_HOOKS: DEFAULT_CODEX_HOOKS, SENTINEL: SUMO_CODEX_SENTINEL
};

/** Install/uninstall helpers for the cursor harness. */
export const cursor = {
  install: installCursorHooks, uninstall: uninstallCursorHooks, reconcile: reconcileCursorHooks, strip: stripCursorHooks, path: cursorHooksPath, DEFAULT_HOOKS: DEFAULT_CURSOR_HOOKS, SENTINEL: SUMO_CURSOR_SENTINEL
};

/** Install/uninstall helpers for the copilot harness. */
export const copilot = {
  install: installCopilotHooks, uninstall: uninstallCopilotHooks, reconcile: reconcileCopilotHooks, strip: stripCopilotHooks, path: copilotHooksPath, DEFAULT_HOOKS: DEFAULT_COPILOT_HOOKS, SENTINEL: SUMO_COPILOT_SENTINEL
};
