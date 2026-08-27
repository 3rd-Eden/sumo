/**
 * Keyspace layout for the single LevelDB store (spec 01 §"Keyspace layout").
 *
 * LevelDB keys are byte-ordered, so structure is encoded into the keyspace and range scans serve
 * as indexes. Fixed-width zero-padded numeric segments (`seq20`/`idx10`/`expiresAt13`) make lexical
 * key order equal numeric order — this is what turns "all events since N" into one range scan.
 *
 * @module sumo/db/keyspace
 */

import { SumoError } from 'sumo/error';

/**
 * @typedef {{ gte?: string, gt?: string, lt?: string, reverse?: boolean, limit?: number }} KeyRange
 */

/** Stable prefixes for each logical keyspace partition. */
export const PREFIX = Object.freeze({
  meta: 'meta:', ses: 'ses:', evt: 'evt:', seen: 'seen:', txn: 'txn:', raw: 'raw:', ttl: 'ttl:', kv: 'kv:', claim: 'claim:', fts: 'idx:fts:'
});

/**
 * Zero-pad a non-negative integer to a fixed width so lexical order equals numeric order.
 *
 * @access public
 * @param {number} n - non-negative integer
 * @param {number} width - target digit width
 * @returns {string} String returned by `pad`.
 */
export function pad(n, width) {
  if (!Number.isInteger(n) || n < 0) throw new SumoError({ name: 'db', method: 'pad', code: 'SUMO_BAD_KEY_SEGMENT', message: 'key segment must be a non-negative integer, got {n}', vars: { n } });
  const s = String(n);
  if (s.length > width) throw new SumoError({ name: 'db', method: 'pad', code: 'SUMO_BAD_KEY_SEGMENT', message: 'value {n} exceeds {width}-digit key width', vars: { n, width } });
  return s.padStart(width, '0');
}

/**
 * Format an event sequence number for lexical sorting.
 *
 * @access public
 * @param {number} seq - Seq numeric value used by `seq20`.
 * @returns {string} String returned by `seq20`.
 */
export function seq20(seq) {
  return pad(seq, 20);
}

/**
 * Format a per-session index for lexical sorting.
 *
 * @access public
 * @param {number} idx - Idx supplied to `idx10`.
 * @returns {string} String returned by `idx10`.
 */
export function idx10(idx) {
  return pad(idx, 10);
}

/**
 * Format an epoch-millisecond expiry timestamp for lexical sorting.
 *
 * @access public
 * @param {number} ms - Ms supplied to `expiresAt13`.
 * @returns {string} String returned by `expiresAt13`.
 */
export function expiresAt13(ms) {
  return pad(ms, 13);
}

export const metaSeqKey = `${PREFIX.meta}seq`;
export const metaVersionKey = `${PREFIX.meta}version`;

/**
 * Session document key.
 *
 * @access public
 * @param {string} id - Identifier used by `key`.
 * @returns {string} String returned by `key`.
 */
export function key(id) {
  return `${PREFIX.ses}${id}`;
}

/**
 * Event log document key.
 *
 * @access public
 * @param {number} seq - Seq numeric value used by `evtKey`.
 * @returns {string} String returned by `evtKey`.
 */
export function evtKey(seq) {
  return `${PREFIX.evt}${seq20(seq)}`;
}

/**
 * Dedupe index key.
 *
 * @access public
 * @param {string} dedupe - Dedupe supplied to `seenKey`.
 * @returns {string} String returned by `seenKey`.
 */
export function seenKey(dedupe) {
  return `${PREFIX.seen}${dedupe}`;
}

/**
 * Normalized transcript event key.
 *
 * @access public
 * @param {string} sessionId - Identifier used by `txnKey`.
 * @param {number} idx - Idx supplied to `txnKey`.
 * @returns {string} String returned by `txnKey`.
 */
export function txnKey(sessionId, idx) {
  return `${PREFIX.txn}${sessionId}:${idx10(idx)}`;
}

/**
 * Raw artifact key.
 *
 * @access public
 * @param {string} sessionId - Identifier used by `rawKey`.
 * @param {number} idx - Idx supplied to `rawKey`.
 * @returns {string} String returned by `rawKey`.
 */
export function rawKey(sessionId, idx) {
  return `${PREFIX.raw}${sessionId}:${idx10(idx)}`;
}

/**
 * TTL index key pointing at a key to expire.
 *
 * @access public
 * @param {number} expiresAt - epoch ms
 * @param {string} targetKey - the key to expire
 * @returns {string} String returned by `ttlKey`.
 */
export function ttlKey(expiresAt, targetKey) {
  return `${PREFIX.ttl}${expiresAt13(expiresAt)}:${targetKey}`;
}

/**
 * Plugin-scoped key/value key.
 *
 * @access public
 * @param {string} plugin - Plugin supplied to `kvKey`.
 * @param {string} ns - Ns supplied to `kvKey`.
 * @param {string} key - Key used by `kvKey`.
 * @returns {string} String returned by `kvKey`.
 */
export function kvKey(plugin, ns, key) {
  return `${PREFIX.kv}${plugin}:${ns}:${key}`;
}

/**
 * Exclusive upper bound for a prefix range scan: increments the last byte of the prefix so the
 * range `[prefix, upperBound(prefix))` covers exactly the keys under `prefix`, regardless of suffix.
 *
 * @access public
 * @param {string} prefix - Prefix used by `upperBound`.
 * @returns {string|undefined} String undefined returned by `upperBound`.
 */
export function upperBound(prefix) {
  if (prefix.length === 0) return undefined;
  const last = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

/**
 * abstract-level iterator range options covering all keys under `prefix`.
 *
 * @access public
 * @param {string} prefix - Prefix used by `prefixRange`.
 * @returns {{ gte: string, lt?: string }} Inclusive lower-bound range covering the prefix.
 */
export function prefixRange(prefix) {
  return { gte: prefix, lt: upperBound(prefix) };
}

/**
 * Range covering events strictly after the `since` watermark (resumable backlog scan).
 *
 * @access public
 * @param {number} since - last-seen seq (0 = from the beginning)
 * @returns {{ gt: string, lt?: string }} Exclusive event-log range after the watermark.
 */
export function evtRangeSince(since) {
  return { gt: evtKey(since), lt: upperBound(PREFIX.evt) };
}

/**
 * Range covering TTL pointers due at or before `now`. `ttl:<now>:<key>` sorts before the first key
 * of timestamp `now+1`, so an exclusive upper bound of `ttl:<now+1>` includes everything due.
 *
 * @access public
 * @param {number} now - epoch ms
 * @returns {{ gte: string, lt: string }} Range covering TTL pointers due at or before `now`.
 */
export function ttlDueRange(now) {
  return { gte: PREFIX.ttl, lt: `${PREFIX.ttl}${expiresAt13(now + 1)}` };
}
