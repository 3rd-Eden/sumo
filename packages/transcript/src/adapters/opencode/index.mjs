/**
 * OpenCode transcript parser. OpenCode has no on-disk JSONL (its store is SQLite), so it is
 * stream-only — `can = { stream: true, file: false }`; the base returns `SUMO_CAP_UNSUPPORTED` for
 * `file()`. The live surface is the SSE event bus (spec 05): `{ type, properties }` events
 * (`session.created`, `message.part.updated`, `message.part.delta`, …).
 *
 * Per the delta/finalization rule: a `message.part.updated` is a snapshot (mapped, and repeated
 * updates collapse on `part.id`); a `message.part.delta` is an increment → passthrough.
 *
 * @module sumo/transcript/adapters/opencode
 */

import { z } from 'zod';
import { defined } from 'sumo/util';
import { Parser } from '../../base/Parser.mjs';
import { raw } from '../../base/helpers.mjs';

/**
 * @typedef {import('../../base/schema.mjs').NormalizedEventInput} NormalizedEventInput
 * @typedef {Record<string, unknown>} JsonRecord
 */

/**
 * OpenCodeTranscript implementation.
 *
 * @access public
 * @class
 */
export class OpenCodeTranscript extends Parser {
  id = 'opencode';
  can = { stream: true, file: false };
  config = z.object({});

  /**
   * Live SSE event: `{ type, properties }`.
   *
   * @access public
   * @param {Record<string, unknown>} frame - Frame consumed by `onStream`.
   * @returns {Generator<NormalizedEventInput, void, unknown>} Normalized transcript events for the OpenCode frame.
   */
  *onStream(frame) {
    const type = stringValue(frame.type);
    const props = recordValue(frame.properties);

    if (type === 'session.created') {
      const info = recordValue(props.info);
      const sessionId = stringValue(info.id);
      yield {
        type: 'session.started', payload: defined({ sessionId: info.id, harness: 'opencode', cwd: info.directory }), ext: { native: frame },
        ...defined({ id: sessionId, sessionId })
      };
      return;
    }
    if (type === 'message.part.updated') {
      const part = recordValue(props.part);
      const sessionId = stringValue(part.sessionID);
      const ev = openCodePartEvent(part);
      if (ev) {
        yield { ...ev, ext: { native: frame, part }, ...defined({ sessionId }) };
        return;
      }
      yield raw('session', `part.${part.type ?? 'unknown'}`, frame, { sessionId, id: stringValue(part.id) });
      return;
    }
    // message.part.delta (increment), message.updated, session.status/updated/diff, … → passthrough
    const part = recordValue(props.part);
    const info = recordValue(props.info);
    yield raw('session', type ?? 'unknown', frame, {
      sessionId: stringValue(part.sessionID) ?? stringValue(props.sessionID) ?? stringValue(info.id)
    });
  }
}

/**
 * Read an object field from an OpenCode SSE event.
 *
 * @access private
 * @param {unknown} value - Event field that may contain a JSON object.
 * @returns {JsonRecord} Object record, or an empty object for absent/scalar fields.
 */
function recordValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {JsonRecord} */ (value) : {};
}

/**
 * Read a string field from an OpenCode SSE event.
 *
 * @access private
 * @param {unknown} value - Event field whose string value should be used for routing.
 * @returns {string|undefined} String field value when present.
 */
function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Map an OpenCode message part to a normalized event, or null. Only part types with a committed real
 * fixture are normalized here; everything else (including a `reasoning` part — no fixture is available
 * in the captured corpus) passes through losslessly until a real capture proves the shape, rather than
 * being normalized on an unverified assumption.
 *
 * @access private
 * @param {JsonRecord} part - OpenCode `message.part.updated` payload.
 * @returns {NormalizedEventInput|null} Normalized message/tool event, or `null` for passthrough part types.
 */
function openCodePartEvent(part) {
  switch (part?.type) {
    case 'text':
      return { type: 'session.message', payload: { text: part.text }, ...defined({ id: part.id }) };
    case 'tool': {
      const state = recordValue(part.state);
      return {
        type: 'session.tool', payload: { tool: { name: part.tool, input: state.input } },
        ...defined({ id: part.callID })
      };
    }
    default:
      return null;
  }
}
