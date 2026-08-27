/**
 * Claude Code transcript parser. Live `stream-json` (`claude -p --output-format stream-json`) and the
 * on-disk `~/.claude/projects/<enc>/<uuid>.jsonl` diverge in envelope but share the same Anthropic
 * message content blocks — so both delegate the message body to `blocks.mjs`. Verified from real
 * captures: the assistant `message.id` (`msg_…`) is identical across both surfaces (the record `uuid`
 * differs), so the per-event id derives from `message.id`, never the record `uuid`.
 *
 * @module sumo/transcript/adapters/claude-code
 */

import { z } from 'zod';
import { defined, tsMs } from 'sumo/util';
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
 *   message?: { role?: string, content?: unknown, id?: string },
 *   timestamp?: string,
 *   sessionId?: string,
 *   uuid?: string
 * }} ClaudeRecord
 */

/**
 * ClaudeTranscript implementation.
 *
 * @access public
 * @class
 */
export class ClaudeTranscript extends Parser {
  id = 'claude-code';
  can = { stream: true, file: true };
  config = z.object({});

  /**
   * Live `stream-json` frame: `{ type: system|assistant|user|result, ... }`.
   *
   * @access public
   * @param {Record<string, unknown>} frame - Frame consumed by `onStream`.
   * @returns {Generator<import('../../base/schema.mjs').NormalizedEventInput, void, unknown>} Generated normalized records.
   */
  *onStream(frame) {
    const record = /** @type {ClaudeRecord} */ (frame);
    const type = record.type;
    if (type === 'system' && frame.subtype === 'init') {
      yield {
        type: 'session.started',
        payload: defined({ sessionId: record.session_id, harness: 'claude-code', cwd: record.cwd }),
        ext: { native: frame },
        ...defined({ id: record.session_id, sessionId: record.session_id })
      };
      return;
    }
    if (type === 'assistant' || type === 'user') {
      yield* normalizeMessage(record.message ?? {}, {
        sessionId: record.session_id,
        idBase: record.message?.id,
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
   * On-disk record: typed (`assistant`/`user`/`summary`/`attachment`/`last-prompt`/…) + `uuid`/`parentUuid`.
   *
   * @access public
   * @param {Record<string, unknown>} record - Record consumed by `onFile`.
   * @returns {Generator<import('../../base/schema.mjs').NormalizedEventInput, void, unknown>} Generated normalized records.
   */
  *onFile(record) {
    const entry = /** @type {ClaudeRecord} */ (record);
    const type = entry.type;
    if (type === 'assistant' || type === 'user') {
      yield* normalizeMessage(entry.message ?? {}, {
        sessionId: entry.sessionId,
        idBase: entry.message?.id,
        ts: tsMs(entry.timestamp),
        native: record
      });
      return;
    }
    yield raw('session', type ?? 'unknown', record, {
      sessionId: entry.sessionId,
      ts: tsMs(entry.timestamp),
      id: entry.uuid
    });
  }
}
