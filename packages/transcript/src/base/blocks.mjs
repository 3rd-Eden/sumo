/**
 * Anthropic-style content-block normalization, shared by the Claude and Cursor adapters (both carry a
 * `message: { role, content }` envelope where `content` is a string or an array of typed blocks). This
 * is the spec-08 "same message blocks, different envelope" hypothesis realized: each adapter handles
 * its own envelope (system/init, result, on-disk record fields) and delegates the message body here.
 *
 * @module sumo/transcript/base/blocks
 */

import { defined, idAt } from 'sumo/util';
import { raw } from './helpers.mjs';

/**
 * @typedef {{
 *   type?: string,
 *   text?: string,
 *   thinking?: string,
 *   name?: string,
 *   input?: Record<string, unknown>,
 *   content?: unknown,
 *   id?: string,
 *   tool_use_id?: string
 * }} MessageBlock
 */

/**
 * Map one content block to a normalized event (without envelope fields). Tool blocks prefer their
 * intrinsic `tool_use` id (stable across stream↔file); other blocks fall back to `<idBase>#<index>`.
 *
 * @access private
 * @param {MessageBlock} block - Block consumed by `blockEvent`.
 * @param {{ role?: string, idBase?: string|null, index: number }} ctx - Execution context for the operation.
 * @returns {import('./schema.mjs').NormalizedEventInput | null} Normalized event for the block, or `null` when the block is unknown.
 */
function blockEvent(block, { role, idBase, index }) {
  switch (block.type) {
    case 'text':
      return { type: 'session.message', payload: defined({ role, text: block.text }), id: idAt(idBase, index) };
    case 'thinking':
      return { type: 'session.reasoning', payload: { text: block.thinking }, id: idAt(idBase, index) };
    case 'tool_use':
      return { type: 'session.tool', payload: { tool: { name: block.name, input: block.input } }, id: block.id };
    case 'tool_result':
      return { type: 'session.tool', payload: { tool: { output: block.content } }, id: block.tool_use_id };
    default:
      return null;
  }
}

/**
 * Normalize an Anthropic-style message into one event per content block. A string `content` is a
 * single `session.message`; an unknown block type surfaces as a `session.raw:block.<type>` passthrough
 * (lossless). Every event carries `ext.native` (the originating record) and, for block events,
 * `ext.block` (the block) — preservation for recognized records too (§3e).
 *
 * @access public
 * @param {{ role?: string, content?: unknown, id?: string }} message - Native message block to normalize.
 * @param {{ sessionId?: string, idBase?: string|null, ts?: number, native?: unknown }} ctx - Execution context for the operation.
 * @returns {Generator<import('./schema.mjs').NormalizedEventInput, void, unknown>} Generated normalized records.
 */
export function* normalizeMessage(message, { sessionId, idBase, ts, native } = {}) {
  const role = message?.role;
  const content = message?.content;

  /**
   * Preserve native payload details while adding shared event metadata.
   *
   * @access public
   * @param {import('./schema.mjs').NormalizedEventInput} ev - Ev supplied to `envelope`.
   * @param {unknown} [block] - Native block to preserve when available.
   * @returns {import('./schema.mjs').NormalizedEventInput} Normalized event decorated with shared envelope metadata.
   */
  function envelope(ev, block) {
    return {
      ...ev, ext: { native, ...defined({ block }) },
      ...defined({ sessionId, ts })
    };
  }

  if (typeof content === 'string') {
    yield envelope({ type: 'session.message', payload: defined({ role, text: content }), ...defined({ id: idBase }) });
    return;
  }
  if (!Array.isArray(content)) {
    // A recognized record whose message body is an unexpected shape (format drift) must STILL surface,
    // never be silently dropped (§3e / ). Emit a lossless passthrough preserving the native record.
    yield raw(
      'session',
      'message',
      native && typeof native === 'object' ? /** @type {Record<string, unknown>} */ (native) : {},
      { sessionId, ts, id: idBase ?? undefined }
    );
    return;
  }

  let i = -1;
  for (const item of content) {
    i++;
    const block = item && typeof item === 'object' ? /** @type {MessageBlock} */ (item) : {};
    const ev = blockEvent(block, { role, idBase, index: i });
    if (ev) {
      yield envelope(ev, block);
    } else {
      const id = idAt(idBase, i);
      yield envelope({ type: `session.raw:block.${block?.type ?? 'unknown'}`, payload: {}, ...defined({ id }) }, block);
    }
  }
}
