/**
 * Codex transcript parser. The 1.0 read surface (spec 05) is `codex app-server` JSON-RPC notifications
 * (`thread/*`, `turn/*`, `item/*`); the on-disk surface is `~/.codex/sessions/.../rollout-*.jsonl`
 * (`{ type, timestamp, payload }` with `session_meta` / `response_item` / `event_msg`).
 *
 * Verified from real captures: tool calls share `call_id` across both surfaces (collapse works); plain
 * messages do not share a natural id (stream `item.id` vs rollout `response_item` with none). Codex
 * `turn/*` is turn-level (NOT session lifecycle) and `tokenUsage` is usage with no `07` home → both
 * pass through until `07` adds `turn.*` / `session.usage` (see 07 open questions).
 *
 * @module sumo/transcript/adapters/codex
 */

import { z } from 'zod';
import { defined, textOf, tsMs, withDefined } from 'sumo/util';
import { Parser } from '../../base/Parser.mjs';
import { raw } from '../../base/helpers.mjs';

/**
 * @typedef {import('../../base/schema.mjs').NormalizedEventInput} NormalizedEventInput
 * @typedef {Record<string, unknown>} JsonRecord
 * @typedef {{ code: string, retryable: boolean, fallback: boolean, reason?: string }} CodexClassification
 */

/**
 * CodexTranscript implementation.
 *
 * @access public
 * @class
 */
export class CodexTranscript extends Parser {
  id = 'codex';
  can = { stream: true, file: true };
  config = z.object({});

  /**
   * Live JSON-RPC notification: `{ jsonrpc, method, params }`.
   *
   * @access public
   * @param {Record<string, unknown>} frame - Frame consumed by `onStream`.
   * @returns {Generator<unknown, void, unknown>} Generated normalized records.
   */
  *onStream(frame) {
    const method = typeof frame?.method === 'string' ? frame.method : undefined;
    const p = objectValue(frame?.params);
    const sessionId = streamSessionId(p);

    if (!method) {
      yield raw('session', 'rpc', frame);
      return;
    }
    if (method === 'thread/started') {
      const t = objectValue(p.thread);
      const nativeSessionId = stringValue(t.sessionId);
      yield withDefined({
        type: 'session.started', payload: defined({ harness: 'codex', sessionId: nativeSessionId, cwd: t.cwd }), ext: { native: frame }
      }, { id: t.id, sessionId: nativeSessionId });
      return;
    }
    // turn/started on the main thread → session.turn-started (lets the orchestrator reset turn state).
    // Non-main thread child-work promotion needs a captured fixture before it becomes a normalized claim.
    if (method === 'turn/started') {
      const turnId = objectValue(p.turn).id;
      yield withDefined({
        type: 'session.turn-started', payload: defined({ turnId }), ext: { native: frame }
      }, { sessionId });
      return;
    }
    if (method === 'turn/completed') {
      // Main thread turn/completed → passthrough (base activity)
      yield withCodexClassification(raw('session', method, frame, { sessionId }), objectValue(p.turn).error);
      return;
    }
    if (method === 'error') {
      yield withCodexClassification(raw('session', method, frame, { sessionId }), p.error);
      return;
    }
    if (method === 'item/started') {
      const item = objectValue(p.item);
      yield raw('session', method, frame, { sessionId, id: stringValue(item.id) });
      return;
    }
    if (method === 'item/commandExecution/requestApproval') {
      yield withDefined({
        type: 'session.approval-requested', payload: withDefined({
          requestId: frame.id, tool: 'commandExecution', command: p.command, cwd: p.cwd, reason: p.reason, itemId: p.itemId, turnId: p.turnId, availableDecisions: p.availableDecisions
        }, { proposedExecpolicyAmendment: p.proposedExecpolicyAmendment }), ext: { native: frame }
      }, { sessionId });
      return;
    }
    if (method === 'item/completed') {
      const item = objectValue(p.item);
      // final_answer: emit both session.message (assistant text) AND session.final-answer (signal) —
      // additive/lossless: the completion signal supplements the message, never replaces it.
      if (item.type === 'agentMessage' && item.phase === 'final_answer') {
        const text = item.text;
        yield withDefined({ type: 'session.message', payload: { role: 'assistant', text, phase: item.phase }, ext: { native: frame, item } }, { id: item.id, sessionId });
        yield withDefined({ type: 'session.final-answer', payload: { text, phase: item.phase }, ext: { native: frame, item } }, { id: item.id, sessionId });
        return;
      }
      const ev = codexItemEvent(item);
      if (ev) {
        yield withDefined({ ...ev, ext: { native: frame, item } }, { sessionId });
        return;
      }
      yield raw('session', `item.${String(item.type ?? 'unknown')}`, frame, { sessionId, id: stringValue(item.id) });
      return;
    }
    // item/agentMessage/delta, thread/tokenUsage/updated, status, … → passthrough
    yield raw('session', method, frame, { sessionId });
  }

  /**
   * On-disk rollout record: `{ type, timestamp, payload }`.
   * Note: only `session_meta` carries the session id; `response_item`/`event_msg` records do not, and
   * the parser is stateless per-record by design (it does not carry state across a file's records). So
   * normalized events from those records have no `sessionId` — `agent-artifacts` (spec 09), which knows
   * the file→session mapping by correlation, attaches it before `db.append`. This is the same
   * stateless boundary the stream side honors; it is not a gap the pure parser can or should close.
   *
   * @access public
   * @param {Record<string, unknown>} record - Record consumed by `onFile`.
   * @returns {Generator<unknown, void, unknown>} Generated normalized records.
   */
  *onFile(record) {
    const type = typeof record?.type === 'string' ? record.type : undefined;
    const p = objectValue(record?.payload);
    const ts = tsMs(record?.timestamp);

    if (type === 'session_meta') {
      yield withDefined({
        type: 'session.started', payload: defined({ harness: 'codex', sessionId: p.id, cwd: p.cwd }), ext: { native: record }
      }, { id: p.id, sessionId: p.id, ts });
      return;
    }
    if (type === 'response_item') {
      if (p.type === 'message') {
        const text = textOf(p.content);
        yield withDefined({ type: 'session.message', payload: defined({ role: p.role, text, phase: p.phase }), ext: { native: record } }, { ts });
        if (p.role === 'assistant' && p.phase === 'final_answer') {
          yield withDefined({ type: 'session.final-answer', payload: { text, phase: p.phase }, ext: { native: record } }, { ts });
        }
        return;
      }
      const ev = codexResponseItemEvent(p);
      if (ev) {
        yield withDefined({ ...ev, ext: { native: record } }, { ts });
        return;
      }
      yield raw('session', `response_item.${p.type ?? 'unknown'}`, record, { ts });
      return;
    }
    // event_msg (task_started/task_complete/token_count/…), turn_context, … → passthrough
    yield raw('session', `${type ?? 'unknown'}${typeof p.type === 'string' ? `.${p.type}` : ''}`, record, { ts });
  }
}

/**
 * Read the live Codex session/thread id from a JSON-RPC params object.
 *
 * @access private
 * @param {Record<string, unknown>} params - Params supplied to `streamSessionId`.
 * @returns {string|undefined} Thread id used as the normalized session id, when present.
 */
function streamSessionId(params) {
  return stringValue(params.threadId) ?? stringValue(objectValue(params.thread).id);
}

/**
 * Attach a Codex error classification to a normalized event when one can be derived.
 *
 * @access private
 * @param {import('../../base/schema.mjs').NormalizedEventInput} event - Normalized event to annotate.
 * @param {unknown} error - Error value normalized or reported by `withCodexClassification`.
 * @returns {import('../../base/schema.mjs').NormalizedEventInput} Normalized event with Codex classification metadata.
 */
function withCodexClassification(event, error) {
  const classification = classifyCodexError(error);
  if (!classification) return event;
  return {
    ...event, payload: { ...(event.payload ?? {}), sumoCode: classification.code, retryable: classification.retryable, fallback: classification.fallback }, ext: { ...(event.ext ?? {}), classification }
  };
}

/**
 * Map known Codex error payloads to Sumo diagnostic classification metadata.
 *
 * @access private
 * @param {unknown} error - Error value normalized or reported by `classifyCodexError`.
 * @returns {CodexClassification|null} Classification metadata, or null when the error is not recognized.
 */
function classifyCodexError(error) {
  const err = objectValue(error);
  const message = String(err.message ?? '');
  const info = String(err.codexErrorInfo ?? '');
  const details = String(err.additionalDetails ?? '');
  const text = `${message}\n${info}\n${details}`;
  if (info === 'usageLimitExceeded' || /usage limit|purchase more credits|rate limit/i.test(message)) {
    return { code: 'SUMO_RATE_LIMITED', retryable: true, fallback: true, reason: message };
  }
  if (/failed to resolve external api key auth|provider auth command|auth provider command/i.test(text)) {
    return { code: 'SUMO_AUTH_REQUIRED', retryable: false, fallback: true, reason: details || message };
  }
  return null;
}

/**
 * Map a live `item` (from `item/completed`) to a normalized event, or null.
 *
 * @access private
 * @param {Record<string, unknown>} item - Item consumed by `codexItemEvent`.
 * @returns {NormalizedEventInput|null} Normalized event for recognized live items, otherwise null.
 */
function codexItemEvent(item) {
  const type = item?.type;
  if (type === 'userMessage') {
    return /** @type {NormalizedEventInput} */ (withDefined({ type: 'session.message', payload: { role: 'user', text: textOf(item.content) } }, { id: item.id }));
  }
  if (type === 'reasoning') {
    return /** @type {NormalizedEventInput} */ (withDefined({ type: 'session.reasoning', payload: { text: textOf(item.summary) } }, { id: item.id }));
  }
  if (type === 'commandExecution') {
    // Codex emits a start-shaped command item before there is an outcome; wait for the completed item
    // so Sumo records one actionable tool event with output and exit status for downstream plugins.
    if (item.aggregatedOutput === undefined && item.exitCode === undefined && item.status === undefined) return null;
    const input = defined({ command: item.command, cwd: item.cwd });
    return {
      type: 'session.tool', payload: { tool: defined({ name: item.tool ?? type, input, output: item.aggregatedOutput, exitCode: item.exitCode, status: item.status }) },
      ...defined({ id: item.id })
    };
  }
  return null;
}

/**
 * Map a rollout `response_item` payload to a normalized event, or null.
 *
 * @access private
 * @param {Record<string, unknown>} p - P supplied to `codexResponseItemEvent`.
 * @returns {NormalizedEventInput|null} Normalized event for recognized rollout response items, otherwise null.
 */
function codexResponseItemEvent(p) {
  switch (p.type) {
    case 'reasoning':
      return { type: 'session.reasoning', payload: { text: textOf(p.summary) } };
    case 'function_call':
      return { type: 'session.tool', payload: { tool: { name: p.name, input: p.arguments } }, ...defined({ id: p.call_id }) };
    case 'function_call_output':
      return { type: 'session.tool', payload: { tool: { output: p.output } }, ...defined({ id: p.call_id }) };
    default:
      return null;
  }
}

/**
 * Treat plain JSON objects as records and every other native value as an empty object.
 *
 * @access private
 * @param {unknown} value - Native value to inspect.
 * @returns {JsonRecord} Record view used for optional Codex payload fields.
 */
function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {JsonRecord} */ (value) : {};
}

/**
 * Return a native field only when it is already a string.
 *
 * @access private
 * @param {unknown} value - Native field value to inspect.
 * @returns {string|undefined} String value, or `undefined` for absent/non-string fields.
 */
function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}
