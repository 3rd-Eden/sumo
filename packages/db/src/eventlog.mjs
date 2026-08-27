/**
 * The append-only `evt:<seq>` event log with idempotent `dedupe`→`seen:` merge-append
 * (specs 01/02, /).
 *
 * This module is **transport-free**: it operates on any `abstract-level` database, so the same
 * logic runs against `classic-level` in the daemon and `memory-level` in tests. Atomicity of
 * "read `meta:seq` → assign → write" is guaranteed by the daemon being the sole writer (): the
 * monotonic `seq` lives in memory here and appends are serialized through a promise chain, so no
 * cross-process coordination is needed.
 *
 * @module sumo/db/eventlog
 */

import { EventInput, Event } from './schema.mjs';
import { mergeEvent } from './dedupe.mjs';
import { evtKey, seenKey, metaSeqKey, evtRangeSince, prefixRange, PREFIX } from './keyspace.mjs';
import stringify from 'safe-stable-stringify';

/**
 * Any `abstract-level` database (the storage modules are backend-agnostic: `classic-level` in the
 * daemon, `memory-level` in tests).
 * @typedef {import('abstract-level').AbstractLevel<object, string, unknown>} AbstractDb
 * @typedef {import('zod').input<typeof EventInput>} EventInputRecord
 * @typedef {import('zod').infer<typeof Event>} StoredEvent
 * @typedef {import('zod').infer<typeof import('./schema.mjs').EventFilter>} EventFilterRecord
 * @typedef {{ seq: number, deduped: boolean, enriched: boolean, event: StoredEvent }} AppendResult
 * @typedef {{ append: (input: EventInputRecord, opts?: { now?: number }) => Promise<AppendResult>, backlog: (since: number) => AsyncIterable<StoredEvent>, current: () => number|undefined, ready: () => Promise<void> }} EventLog
 */

/**
 * `db.get` that resolves to `undefined` for a missing key instead of throwing `LEVEL_NOT_FOUND`
 * (abstract-level surfaces absence as a thrown error).
 *
 * @access public
 * @param {AbstractDb} db - Database client used by the operation.
 * @param {string} key - Key used by `getMaybe`.
 * @returns {Promise<unknown|undefined>} Stored value, or `undefined` when the key is absent.
 */
export async function getMaybe(db, key) {
  try {
    return await db.get(key);
  } catch (err) {
    if (err?.code === 'LEVEL_NOT_FOUND') return undefined;
    throw err;
  }
}

/**
 * Does an event match a subscription filter (`type`/`sessionId`/`source`)? Shared by the daemon
 * (deciding which subscribers to wake) and the client (filtering the events it reads on each
 * wake-up), so both sides apply identical semantics and a woken client never emits the wrong events.
 *
 * @access public
 * @param {EventFilterRecord|undefined} filter - Optional subscription filter.
 * @param {StoredEvent} event - Stored event record tested against the filter.
 * @returns {boolean} Whether `matchesFilter` matched the expected condition.
 */
export function matchesFilter(filter, event) {
  if (!filter) return true;
  if (filter.type && !filter.type.includes(event.type)) return false;
  if (filter.sessionId && event.sessionId !== filter.sessionId) return false;
  if (filter.source && (!event.source || !filter.source.includes(event.source))) return false;
  return true;
}

/**
 * Recover the last assigned `seq` on startup (crash recovery): from `meta:seq`, falling back to the
 * highest `evt:` key, else 0.
 *
 * @access public
 * @param {AbstractDb} db - Database client used by the operation.
 * @returns {Promise<number>} Promise that resolves with the process-style status code from `recoverSeq`.
 */
export async function recoverSeq(db) {
  const metaSeq = await getMaybe(db, metaSeqKey);
  if (typeof metaSeq === 'number') return metaSeq;
  for await (const [key] of db.iterator({ ...prefixRange(PREFIX.evt), reverse: true, limit: 1 })) {
    return Number(key.slice(PREFIX.evt.length));
  }
  return 0;
}

/**
 * Create an event-log bound to a database. The returned object owns the in-memory `seq` counter and
 * serializes appends so seq assignment is race-free.
 *
 * @access public
 * @param {AbstractDb} db - opened with `valueEncoding: 'json'`
 * @returns {EventLog} Event log operations bound to the supplied database.
 */
export function createEventLog(db) {
  let seq = 0;
  let recovered = false;
  /** @type {Promise<void>|undefined} */
  let recovery;
  /** @type {Promise<unknown>} Pending append chain used to serialize event writes. */
  let tail = Promise.resolve();

  /**
   * Recover the current event sequence exactly once before appends or reads depend on it.
   *
   * @access public
   * @returns {Promise<void>} Promise that resolves when the operation completes.
   */
  async function ensureReady() {
    if (!recovered) {
      recovery ??= recoverSeq(db).then((s) => { seq = s; recovered = true; });
      await recovery;
    }
  }

  /**
   * Append one parsed event inside the serialized write path.
   *
   * @access public
   * @param {EventInputRecord} input - Validated input for the operation.
   * @param {number} now - Now supplied to `doAppend`.
   * @returns {Promise<AppendResult>} Assigned seq, duplicate flag, and stored event record.
   */
  async function doAppend(input, now) {
    const event = EventInput.parse(input);

 const existingSeq = await getMaybe(db, seenKey(event.dedupe));
 if (typeof existingSeq === 'number') {
 // Already seen: enrich the stored event from this (possibly richer) duplicate, keep its seq.
 const storedKey = evtKey(existingSeq);
 const stored = /** @type {StoredEvent} */ (await db.get(storedKey));
 const enriched = /** @type {StoredEvent} */ (mergeEvent(stored, event));
 const changed = stringify(stored) !== stringify(enriched);
 if (changed) await db.put(storedKey, enriched);
 return { seq: existingSeq, deduped: true, enriched: changed, event: enriched };
 }

 // Unseen: assign the next seq and append atomically (evt + seen index + meta:seq).
 const assigned = seq + 1;
 const stored = Event.parse({ ...event, seq: assigned, ts: event.ts ?? now });
 await db.batch([
 { type: 'put', key: evtKey(assigned), value: stored }, { type: 'put', key: seenKey(event.dedupe), value: assigned }, { type: 'put', key: metaSeqKey, value: assigned }
 ]);
 seq = assigned;
 return { seq: assigned, deduped: false, enriched: false, event: stored };
 }

  /**
   * Append an event idempotently. Duplicates (same `dedupe`) collapse to the existing seq and
   * enrich the stored event instead of appending a second copy.
   *
   * @access public
   * @param {EventInputRecord} input - Event input parsed before being stored.
   * @param {{ now?: number }} opts - Options read by this operation.
   * @returns {Promise<AppendResult>} Assigned seq, duplicate flag, and stored event record.
   */
  async function append(input, { now = Date.now() } = {}) {
    await ensureReady();
    const run = tail.then(() => doAppend(input, now));
    tail = run.catch(() => {}); // keep the chain alive if one append rejects
    return run;
  }

  /**
   * Stream stored events strictly after the `since` watermark, in seq order (backlog flush).
   *
 * @access public
 * @param {number} since - Since numeric value used by `backlog`.
 * @returns {AsyncIterable<StoredEvent>} Stored events after the watermark.
 */
async function* backlog(since) {
    for await (const [, value] of db.iterator(evtRangeSince(since))) yield /** @type {StoredEvent} */ (/** @type {unknown} */ (value));
  }

  return {
    append, backlog, /**
     * Read the last assigned event sequence number.
     *
     * @access public
     * @returns {number|undefined} Current in-memory sequence number, once recovered.
     */
    current() { return seq; }, ready: ensureReady
  };
}
