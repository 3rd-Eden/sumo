/**
 * TTL sweeper (spec 01 §"Retention / TTL"). Writing a value with `ttlMs` also writes a
 * `ttl:<expiresAt13>:<targetKey>` pointer (daemon-side, see host.mjs). The daemon periodically
 * scans `ttl:` up to `now` and deletes both the pointer and its target, then emits `ttl.swept`.
 * This is the ONLY place data is removed by age (CONVENTIONS §3e).
 *
 * @module sumo/db/sweeper
 */

import { ttlDueRange } from './keyspace.mjs';

const DEFAULT_INTERVAL_MS = 60 * 1000;

/**
 * @typedef {import('zod').input<typeof import('./schema.mjs').EventInput>} EventInputRecord
 * @typedef {{ sweepOnce: (now?: number) => Promise<number>, stop: () => void }} TtlSweeper
 */

/**
 * Start the TTL sweeper timer.
 *
 * @access public
 * @param {import('./eventlog.mjs').AbstractDb} db - Database client used by the operation.
 * @param {{ emit: (event: EventInputRecord) => Promise<unknown>, intervalMs?: number, runExclusive?: <T>(fn: () => Promise<T>) => Promise<T> }} opts - Emitter, interval, and write-serializer dependencies.
 * @returns {TtlSweeper} Timer handle and one-shot sweep operation.
 */
export function startSweeper(db, { emit, intervalMs = DEFAULT_INTERVAL_MS, runExclusive = (fn) => fn() }) {
  let sweepCounter = 0;

  /**
   * Run one sweep pass. Deletes every pointer+target due at or before `now`; emits `ttl.swept` with
   * the count when anything was removed.
   *
   * @access public
   * @param {number} now - epoch ms
   * @returns {Promise<number>} Number of expired values removed by this sweep.
   */
  async function sweepOnce(now = Date.now()) {
    return runExclusive(async () => {
      /** @type {Array<{ type: 'del', key: string }>} */
      const ops = [];
      for await (const [pointerKey, targetKey] of db.iterator(ttlDueRange(now))) {
        if (typeof targetKey !== 'string') continue;
        ops.push({ type: 'del', key: pointerKey });
        ops.push({ type: 'del', key: targetKey });
      }
      if (ops.length === 0) return 0;
      await db.batch(ops);
      const count = ops.length / 2;
      await emit({ dedupe: `ttl.swept:${sweepCounter++}`, type: 'ttl.swept', payload: { kind: 'ttl', count } });
      return count;
    });
  }

  const timer = setInterval(() => { sweepOnce().catch(() => {}); }, intervalMs);
  timer.unref();

  return {
    sweepOnce, /**
     * Stop the TTL sweeper interval.
     *
     * @access public
     * @returns {void} Completes without producing a value.
     */
    stop() { return clearInterval(timer); }
  };
}
