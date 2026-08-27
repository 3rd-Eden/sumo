/**
 * `sumo/transcript` — per-harness transcript adapters that normalize raw transcript units (live stream
 * frames and on-disk records) into the shared `07` event vocabulary. A focused, pure package (§3d):
 * input is a raw record, output is normalized events; no I/O, tailing, correlation, or storage.
 *
 * The `adapters` registry is keyed by harness id and composed by the harness adapter — there is no
 * public `sumo.transcript()` verb ().
 *
 * @module sumo/transcript
 */

/**
 * Normalized transcript event yielded by parser adapters.
 *
 * @typedef {import('./base/schema.mjs').NormalizedEventInput} NormalizedEventInput
 */

export { Parser, ok, fail, isResult, CAP_UNSUPPORTED } from './base/Parser.mjs';
export { EventSchema, TYPES } from './base/schema.mjs';
export { raw } from './base/helpers.mjs';

import { ClaudeTranscript } from './adapters/claude-code/index.mjs';
import { CodexTranscript } from './adapters/codex/index.mjs';
import { CursorTranscript } from './adapters/cursor/index.mjs';
import { OpenCodeTranscript } from './adapters/opencode/index.mjs';
import { CopilotTranscript } from './adapters/copilot/index.mjs';

export { ClaudeTranscript, CodexTranscript, CursorTranscript, OpenCodeTranscript, CopilotTranscript };

/**
 * The parser registry, keyed by harness id. Composed by the harness adapter () — there is no
 * public `sumo.transcript()` verb. Values are classes; instantiate per harness.
 *
 * @type {Record<string, new () => import('./base/Parser.mjs').Parser>}
 */
export const adapters = {
  'claude-code': ClaudeTranscript, codex: CodexTranscript, cursor: CursorTranscript, opencode: OpenCodeTranscript, copilot: CopilotTranscript
};
