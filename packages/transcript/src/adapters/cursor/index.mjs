/**
 * Cursor transcript parser. Live `cursor-agent -p --output-format stream-json` mirrors Claude's
 * `{ type, message:{ content[] } }` envelope; the on-disk
 * `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` is a barer `{ role, message:{ content[] } }`
 * (no `type`). Both delegate the message body to `blocks.mjs`.
 *
 * Dedup note (verified from real captures): Cursor messages carry no id on either surface, and the
 * on-disk text is query-wrapped, so stream↔file do not collapse from the parser alone — surfaced in
 * the conformance suite; cross-source collapse is the daemon/correlation layer's job (spec 09).
 *
 * @module sumo/transcript/adapters/cursor
 */

import { z } from 'zod';
import { defined } from 'sumo/util';
import { Parser } from '../../base/Parser.mjs';
import { normalizeMessage } from '../../base/blocks.mjs';
import { raw } from '../../base/helpers.mjs';

/**
 * @typedef {{
 *   type?: string,
 *   subtype?: string,
 *   session_id?: string,
 *   cwd?: string,
 *   is_error?: boolean,
 *   timestamp_ms?: number,
 *   role?: string,
 *   message?: { role?: string, content?: unknown, id?: string }
 * }} CursorRecord
 */

/**
 * CursorTranscript implementation.
 *
 * @access public
 * @class
 */
export class CursorTranscript extends Parser {
  id = 'cursor';
  can = { stream: true, file: true };
  config = z.object({});

  /**
   * Live stream-json frame: `{ type: system|assistant|user|result, message?, session_id }`.
   *
   * @access public
   * @param {Record<string, unknown>} frame - Frame consumed by `onStream`.
   * @returns {Generator<import('../../base/schema.mjs').NormalizedEventInput, void, unknown>} Generated normalized records.
   */
  *onStream(frame) {
    const record = /** @type {CursorRecord} */ (frame);
    const type = record.type;
    if (type === 'system' && frame.subtype === 'init') {
      yield {
        type: 'session.started',
        payload: defined({ sessionId: record.session_id, harness: 'cursor', cwd: record.cwd }),
        ext: { native: frame },
        ...defined({ id: record.session_id, sessionId: record.session_id })
      };
      return;
    }
    if (type === 'assistant' || type === 'user') {
      yield* normalizeMessage(record.message ?? {}, {
        sessionId: record.session_id,
        idBase: record.message?.id,
        ts: record.timestamp_ms,
        native: frame
      });
      return;
    }
    if (type === 'result') {
      yield {
        type: 'session.ended',
        payload: defined({ outcome: record.subtype, isError: record.is_error }),
        ext: { native: frame },
        ...defined({ sessionId: record.session_id })
      };
      return;
    }
    yield raw('session', type ?? 'unknown', frame, { sessionId: record.session_id });
  }

  /**
   * On-disk record: `{ role, message:{ content[] } }` — no `type`; the role lives on the record.
   *
   * @access public
   * @param {Record<string, unknown>} record - Record consumed by `onFile`.
   * @returns {Generator<import('../../base/schema.mjs').NormalizedEventInput, void, unknown>} Generated normalized records.
   */
  *onFile(record) {
    const entry = /** @type {CursorRecord} */ (record);
    if (typeof entry.role === 'string' && entry.message) {
      // Cursor puts `role` on the record, not inside `message`; thread it into the message body so
      // block normalization carries the role.
      const message = { role: entry.role, ...entry.message };
      yield* normalizeMessage(message, { idBase: entry.message?.id, native: record });
      return;
    }
    yield raw('session', entry.type ?? entry.role ?? 'unknown', record);
  }
}
