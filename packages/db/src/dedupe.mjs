/**
 * Dedupe-key derivation and the idempotent merge-enrichment rule (specs 01/02, /).
 *
 * Every event carries a required `dedupe` key. The daemon keeps a `seen:<dedupe>` index so the same
 * logical event arriving from two sources (e.g. a harness's live stream AND its on-disk transcript)
 * collapses to one `evt:<seq>` — and the richer copy *enriches* the stored one. This is both the
 * dedup guarantee and the multi-source enrichment mechanism.
 *
 * @module sumo/db/dedupe
 */

import { createHash } from 'node:crypto';
import stringify from 'safe-stable-stringify';
import defaultsDeep from 'lodash.defaultsdeep';

/**
 * A source-preferred natural dedupe key, prefixed by the id type/source so keys from different
 * sources never collide: `join('uuid', 'abc-123') === 'uuid:abc-123'`.
 *
 * @access public
 * @param {string} prefix - id type/source (e.g. 'uuid', 'github')
 * @param {string} id - the natural id
 * @returns {string} String returned by `join`.
 */
export function join(prefix, id) {
  return `${prefix}:${id}`;
}

/**
 * Map a normalized `07` event type to its short dedupe-key prefix. This mapping is the **single
 * source of truth** shared by the two sources that must produce identical keys for the same logical
 * turn: the live-stream source (`sumo/harness`) and the on-disk source (`sumo/agent-artifacts`,
 * spec 09). Keeping it here — beside `join`/`forContent` — guarantees the two cannot
 * drift apart (CONVENTIONS §3a anti-drift; ).
 *
 * @access public
 * @param {string} type - a normalized `07` event type.
 * @returns {string} String returned by `rename`.
 */
export function rename(type) {
  if (type === 'session.message') return 'msg';
  if (type === 'session.tool') return 'call';
  if (type === 'session.reasoning') return 'reason';
  if (type === 'session.started' || type === 'session.ended') return 'session';
  if (type.includes('.raw:')) return 'raw';
  return type;
}

/**
 * Derive the `dedupe` key for one normalized event, exactly as both sources must: a
 * source-preferred natural id scoped by the effective session identity when the event carries one,
 * else a content hash anchored to the effective session id and a monotonic position. The `sessionId` option is the per-source fallback
 * (`evt.sessionId ?? sessionId`) — a parser may emit an event with no `sessionId`, and the consumer
 * (harness or agent-artifacts) supplies the correlated session id. Mirrors the harness base's
 * `toEvent` so the live and on-disk sources collapse on identical keys.
 *
 * @access public
 * @param {{ id?: string, type: string, payload?: object, sessionId?: string }} evt - Evt supplied to `forEvent`.
 * @param {{ sessionId?: string, position?: number }} [opts] - Optional fallback correlation and monotonic position.
 * @returns {string} String returned by `forEvent`.
 */
export function forEvent(evt, { sessionId, position } = /** @type {{ sessionId?: string, position?: number }} */ ({ position: 0 })) {
 // The caller's correlated Sumo id is authoritative when present: it is the one identity shared by
 // the live harness and the file acquirer. Parser-native ids remain the scope for uncorrelated input.
 const sid = sessionId ?? evt.sessionId;
 return evt.id
 ? join(rename(evt.type), `${sid ?? 'unscoped'}:${evt.id}`)
: forContent({ sessionId: sid, kind: evt.type, payload: evt.payload ?? {}, position: position ?? 0 });
}

/**
 * A content-hash dedupe key for events with no natural id. The monotonic `position` keeps
 * genuinely-distinct-but-identical events (the agent says "ok" twice) from collapsing.
 *
 * @access public
 * @param {{ sessionId?: string, kind: string, payload?: unknown, position: number }} parts - Parts supplied to `forContent`.
 * @returns {string} String returned by `forContent`.
 */
export function forContent({ sessionId, kind, payload, position }) {
  const canonical = stringify([sessionId ?? null, kind, payload ?? null, position]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Merge a duplicate event into the already-stored one (spec 02 merge rule, fill-missing semantics):
 * **fill gaps, never overwrite present values.** A field absent on the stored event and present on
 * the duplicate is filled in; a field present on both is left as the stored value (first-writer
 * wins); `ext` sub-objects deep-merge so each source contributes its harness-specific keys. The
 * stored event's identity fields (`seq`/`ts`/`dedupe`) are always present and so are preserved.
 *
 * @access public
 * @param {Record<string, unknown>} stored - the event already in the log
 * @param {Record<string, unknown>} incoming - the duplicate carrying possibly-richer fields
 * @returns {Record<string, unknown>} Structured output from `mergeEvent`.
 */
export function mergeEvent(stored, incoming) {
  // defaultsDeep keeps every value already present on `stored` and recursively fills the rest from
  // `incoming` — exactly fill-gaps-never-overwrite, with deep union for nested objects like `ext`.
  return defaultsDeep(structuredClone(stored), incoming);
}
