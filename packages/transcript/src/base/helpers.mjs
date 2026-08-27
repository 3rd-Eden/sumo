/**
 * Small shared helpers for the harness adapters: lossless passthrough, per-event id derivation, and
 * text extraction from content arrays. Kept generic (used by all four adapters); the Anthropic
 * content-block mapping that only Claude/Cursor share lives in `blocks.mjs`.
 *
 * @module sumo/transcript/base/helpers
 */

import { defined } from 'sumo/util';

/**
 * A lossless passthrough event for a record the parser does not normalize (§3e / ): the native
 * name namespaced as `<domain>.raw:<native>`, the raw record preserved in `ext.native`, normalized
 * fields empty. `/` in native method names (Codex `turn/started`) is normalized to `.`.
 *
 * @access public
 * @param {string} domain - normalized domain, almost always `session`.
 * @param {string} native - the native event/record name.
 * @param {Record<string, unknown>} record - the raw record, preserved verbatim in `ext.native`.
 * @param {{ sessionId?: string, ts?: number, id?: string }} meta - Metadata associated with the operation.
 * @returns {import('./schema.mjs').NormalizedEventInput} Import(' /schema mjs') normalized event input returned by `raw`.
 */
export function raw(domain, native, record, meta = {}) {
  const nativeName = String(native).replaceAll('/', '.');
  return {
    type: `${domain}.raw:${nativeName}`, payload: {}, ext: { native: record },
    ...defined({ id: meta.id, sessionId: meta.sessionId, ts: meta.ts })
  };
}
