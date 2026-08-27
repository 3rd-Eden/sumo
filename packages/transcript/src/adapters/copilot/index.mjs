/**
 * Copilot transcript parser. The read surface is the `@github/copilot-sdk` session event stream —
 * typed `SessionEvent` objects pushed via `session.on(handler)`. Copilot CLI also persists the same
 * event family under `~/.copilot/session-state/<id>/events.jsonl`, so `file()` reuses the same
 * normalization path as `stream()`.
 *
 * Key normalised mappings:
 * - `assistant.message`        → `session.message` (role: assistant; `data.messageId` as natural id)
 * - `user.message`             → `session.message` (role: user)
 * - `tool.execution_start`     → `session.tool` (started; `data.toolCallId` as natural id)
 * - `tool.execution_complete`  → `session.tool` (with output/error; shared natural id → dedup)
 * - `permission.requested`     → `session.approval-requested` (SDK pending-permission RPC)
 * - Everything else            → `session.raw:<type>` (lossless passthrough)
 *
 * @module sumo/transcript/adapters/copilot
 */

import { z } from 'zod';
import { defined, tsMs } from 'sumo/util';
import { Parser } from '../../base/Parser.mjs';
import { raw } from '../../base/helpers.mjs';

/**
 * @typedef {import('../../base/schema.mjs').NormalizedEventInput} NormalizedEventInput
 * @typedef {Record<string, unknown>} JsonRecord
 * @typedef {{ code: string, retryable: boolean, fallback: boolean, reason: string }} CopilotClassification
 */

/**
 * Parser for live and persisted Copilot SDK session events.
 *
 * @access public
 * @class
 * @augments {Parser}
 */
export class CopilotTranscript extends Parser {
  /** @type {'copilot'} Parser id used in transcript provenance. */
  id = 'copilot';
  /** @type {{ stream: true, file: true }} Copilot exposes the same event family live and on disk. */
  can = { stream: true, file: true };
  /** @type {import('zod').ZodTypeAny} Empty parser config contract. */
  config = z.object({});

  /**
   * Live SDK session event: `{ type: string, id: string, data: object, timestamp: string, ... }`.
   * Events are the result of the SDK's `session.on(handler)` subscription.
   *
   * @access public
   * @param {Record<string, unknown>} frame - Frame consumed by `onStream`.
   * @returns {Generator<NormalizedEventInput, void, unknown>} Normalized transcript events for the Copilot frame.
   */
  *onStream(frame) {
    const type = stringValue(frame.type);
    const data = recordValue(frame.data);
    const eventId = stringValue(frame.id);
    const ts = tsMs(frame?.timestamp);
    const sessionId = stringValue(frame.sessionId);
    const baseMeta = defined({ ts, sessionId });
    const meta = eventMeta({ ts, sessionId, id: eventId });

    switch (type) {
      case 'assistant.turn_start': {
        yield {
          type: 'session.turn-started', payload: defined({ turnId: data.turnId }), ext: { native: frame },
          ...baseMeta
        };
        return;
      }
      case 'assistant.message': {
        const messageId = stringValue(data.messageId);
        yield {
          type: 'session.message', payload: { role: 'assistant', text: data.content }, ext: { native: frame },
          ...eventMeta({ ts, sessionId, id: messageId })
        };
        return;
      }
      case 'user.message': {
        yield {
          type: 'session.message', payload: { role: 'user', text: data.content }, ext: { native: frame },
          ...meta
        };
        return;
      }
      case 'tool.execution_start': {
        const toolCallId = stringValue(data.toolCallId);
        yield {
          type: 'session.tool', payload: {
            tool: defined({
              name: data.toolName, input: data.arguments
            })
          }, ext: { native: frame },
          ...eventMeta({ ts, sessionId, id: toolCallId })
        };
        return;
      }
      case 'tool.execution_complete': {
        const toolCallId = stringValue(data.toolCallId);
        const result = data.result;
        const error = data.error;
        yield {
          type: 'session.tool', payload: {
            tool: defined({
              name: data.toolName, output: result, error, success: data.success
            })
          }, ext: { native: frame },
          ...eventMeta({ ts, sessionId, id: toolCallId })
        };
        return;
      }
      case 'session.started':
      case 'session.resumed':
      case 'session.start':
      case 'session.resume': {
        const context = recordValue(data.context);
        yield {
          type: 'session.started', payload: defined({
            sessionId: data.sessionId, harness: 'copilot', cwd: data.workingDirectory ?? context.cwd
          }), ext: { native: frame },
          ...baseMeta
        };
        return;
      }
      case 'session.error': {
        yield withCopilotClassification(raw('session', type, frame, meta), data);
        return;
      }
      case 'permission.requested': {
        const requestId = stringValue(data.requestId);
        yield {
          type: 'session.approval-requested', payload: defined({
            requestId: data.requestId, permissionRequest: data.permissionRequest, prompt: data.prompt, resolvedByHook: data.resolvedByHook
          }), ext: { native: frame },
          ...eventMeta({ ts, sessionId, id: requestId ?? eventId })
        };
        return;
      }
      default:
        yield raw('session', type ?? 'unknown', frame, meta);
    }
  }

  /**
   * Normalize one persisted Copilot `events.jsonl` record.
   *
   * @access public
   * @param {Record<string, unknown>} record - Record to normalize.
   * @returns {Generator<NormalizedEventInput, void, unknown>} Normalized transcript events for the persisted record.
   */
  *onFile(record) {
    yield* this.onStream(record);
  }
}

/**
 * Read an object value from a Copilot frame without assuming the SDK payload shape.
 *
 * @access private
 * @param {unknown} value - Frame field that may contain a JSON object.
 * @returns {JsonRecord} Object record, or an empty record when the field is absent or scalar.
 */
function recordValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {JsonRecord} */ (value) : {};
}

/**
 * Read a string value from a Copilot frame field.
 *
 * @access private
 * @param {unknown} value - Frame field whose string value should become metadata.
 * @returns {string|undefined} The string value, or `undefined` when the field has another type.
 */
function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build common event metadata, omitting absent fields.
 *
 * @access private
 * @param {{ ts?: number, sessionId?: string, id?: string }} args - Argument object accepted by `eventMeta`.
 * @returns {{ ts?: number, sessionId?: string, id?: string }} Metadata fields safe to spread onto a normalized event.
 */
function eventMeta({ ts, sessionId, id }) {
  return defined({ ts, sessionId, id });
}

/**
 * Attach Copilot provider-error classification to a raw event when the real error shape warrants it.
 *
 * @access private
 * @param {NormalizedEventInput} event - Raw normalized event to enrich.
 * @param {unknown} error - Copilot error payload from the SDK event.
 * @returns {NormalizedEventInput} Event with Sumo retry/fallback fields when classification matched.
 */
function withCopilotClassification(event, error) {
  const classification = classifyCopilotError(error);
  if (!classification) return event;
  return {
    ...event, payload: { ...event.payload, sumoCode: classification.code, retryable: classification.retryable, fallback: classification.fallback }, ext: { ...event.ext, classification }
  };
}

/**
 * Classify a Copilot SDK error payload from captured/live output.
 *
 * @access private
 * @param {unknown} error - Copilot error payload from `session.error`.
 * @returns {CopilotClassification|null} Sumo classification for known Copilot failure modes.
 */
function classifyCopilotError(error) {
  const record = recordValue(error);
  const errorType = String(record.errorType ?? '');
  const message = String(record.message ?? '');
  if (errorType === 'quota') {
    return { code: 'SUMO_BUDGET_EXHAUSTED', retryable: false, fallback: true, reason: message };
  }
  return null;
}
