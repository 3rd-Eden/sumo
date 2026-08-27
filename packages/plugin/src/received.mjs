/**
 * Builders for the objects handed INTO plugins (spec 03a §§3-6). The producing layer (here, the
 * runtime) binds scoped methods onto each object so the consumer never touches the daemon directly
 * and never names an adapter. Kept as pure builders so they are trivially testable.
 *
 * @module sumo/plugin/received
 */

import { createHash } from 'node:crypto';
import stringify from 'safe-stable-stringify';
import { fail } from './schema.mjs';

/**
 * @typedef {{ append: (event: Record<string, unknown>) => Promise<number>, get: (key: string) => Promise<Record<string, unknown>|undefined> }} EventDb
 * @typedef {(sessionId?: string) => Promise<import('./schema.mjs').Session|undefined>} SessionResolver
 * @typedef {{ seq: number, ts: number, type: string, sessionId?: string, payload?: Record<string, unknown>, ext?: Record<string, unknown>, rawRef?: string }} EventRecord
 */

/**
 * Stable short content hash for a payload, used in derived-event dedupe keys. `safe-stable-stringify`
 * gives key-order-independent JSON so the same logical payload always hashes identically.
 *
 * @access private
 * @param {Record<string, unknown>} payload - Payload data to process.
 * @returns {string} String returned by `payloadHash`.
 */
function payloadHash(payload) {
  return createHash('sha1').update(stringify(payload) ?? '').digest('hex').slice(0, 16);
}

/**
 * Deep-clone a JSON-ish data bag (defaulting to `{}`), tolerating non-cloneable values by falling
 * back to a shallow copy.
 *
 * @access private
 * @param {Record<string, unknown>|undefined} bag - Bag supplied to `cloneBag`.
 * @returns {Record<string, unknown>} Cloned data bag, or an empty object when absent.
 */
function cloneBag(bag) {
  if (!bag || typeof bag !== 'object') return {};
  try {
    return /** @type {Record<string, unknown>} */ (structuredClone(bag));
  } catch {
    return { ...bag };
  }
}

/**
 * Wrap a stored event record (`evt:<seq>` document) as the `SumoEvent` handed to `on(type, fn)`.
 *
 * @access public
 * @param {EventRecord} record - Stored event document from the daemon log.
 * @param {{ db: EventDb, plugin: string, resolveSession?: SessionResolver }} opts - Bound helpers used to decorate the event.
 * @returns {import('./schema.mjs').SumoEvent} Normalized event wrapper handed to plugin observers.
 */
export function toEvent(record, { db, plugin, resolveSession }) {
  // Deep-clone the data bags so each observer gets an isolated view — a nested in-place mutation by
  // one observer can never leak to another concurrent observer (events are JSON-ish, so this is safe).
  const payload = cloneBag(record.payload);
  const ext = cloneBag(record.ext);

  return {
    seq: record.seq, ts: record.ts, type: record.type, sessionId: record.sessionId, payload, ext, /**
     * Emit a derived event (e.g. `test:done`). The runtime supplies the schema-required `dedupe`
     * explicitly — derived from the parent seq + type + a stable payload hash — so re-emitting the
     * same derived event from the same parent collapses idempotently (the daemon enriches, never
     * duplicates). Parent `seq`/`sessionId` are carried in `ext` as provenance.
     *
     * @access public
     * @param {string} type - Event name or type handled by `emit`.
     * @param {Record<string, unknown>} derivedPayload - Derived payload supplied to `emit`.
     * @returns {Promise<number>} Promise that resolves with the process-style status code from `emit`.
     */
    async emit(type, derivedPayload = {}) {
      return db.append({
        dedupe: `plugin:${plugin}:from:${record.seq}:${type}:${payloadHash(derivedPayload)}`, type, source: 'plugin',
        ...(record.sessionId ? { sessionId: record.sessionId } : {}), payload: derivedPayload, ext: { fromSeq: record.seq, fromType: record.type }
      });
    }, /**
     * Resolve the preserved raw adapter record via `rawRef` (redacted at storage time), falling back
     * to the event's `ext` bag when there is no separate raw record. Never fabricates.
     *
     * @access public
     * @returns {Promise<Record<string, unknown>|undefined>} Preserved raw adapter payload when available.
     */
    async raw() {
      if (record.rawRef) return (await db.get(record.rawRef)) ?? ext;
      return ext;
    }, /**
     * Resolve the originating session, if any (built by the harness layer; undefined when none).
     *
     * @access public
     * @returns {Promise<unknown|undefined>} Promise resolving to the `session` result.
     */
    async session() {
      return resolveSession ? resolveSession(record.sessionId) : undefined;
    }
  };
}

/**
 * Decorate a messenger-produced `work` object (built by the adapter via `mctx.work`, already carrying
 * the bound `reply`/`claim`/… effectors) with an `emit` so the `on('work', …)` consumer can append
 * derived events to the one event log — the same capability `toEvent` gives a `SumoEvent`
 * (03a §1/§3). The adapter's bound methods are preserved (a shallow copy adds `emit` without mutating
 * the adapter's original object); `work` carries closures, so it is NOT deep-cloned.
 *
 * @access public
 * @param {import('./schema.mjs').Work} work - Work supplied to `buildWork`.
 * @param {{ db: Pick<EventDb, 'append'>, plugin: string }} deps - Bound event append helper and plugin id.
 * @returns {import('./schema.mjs').Work} Work object with a derived-event emitter attached.
 */
export function buildWork(work, { db, plugin }) {
  return {
    ...work, /**
     * Emit a derived event from this work item. Dedupe is derived from the stable work id + type +
     * payload hash so re-emitting the same derived event collapses idempotently.
     *
     * @access public
     * @param {string} type - Event name or type handled by `emit`.
     * @param {Record<string, unknown>} derivedPayload - Derived payload supplied to `emit`.
     * @returns {Promise<number>} Promise that resolves with the process-style status code from `emit`.
     */
    async emit(type, derivedPayload = {}) {
      return db.append({
        dedupe: `plugin:${plugin}:work:${work.id}:${type}:${payloadHash(derivedPayload)}`, type, source: 'plugin', payload: derivedPayload, ext: { fromWorkId: work.id }
      });
    }
  };
}

/**
 * Build the `SteerEvent` handed to `before(action, fn)`. `can` lets a handler degrade instead of
 * failing; `sessionId` is the correlated Sumo ULID of the requesting session (when known —
 * undefined for hooks that fire before `system:init`). The return value drives the waterfall.
 *
 * @access public
 * @param {{ action: string, payload?: Record<string, unknown>, ext?: Record<string, unknown>, can?: import('sumo/session').CapabilitiesSchema, sessionId?: string, raw?: () => Promise<Record<string, unknown>|undefined> }} spec - Object fields used to build the normalized value.
 * @returns {import('./schema.mjs').SteerEvent} Steering event wrapper handed to `before(...)` handlers.
 */
export function toSteer({ action, payload = {}, ext = {}, can = {}, sessionId, raw }) {
  return {
    action, payload, ext, can, sessionId, raw: raw ?? (async () => undefined)
  };
}

/**
 * Build the `InvocationCtx` second arg for a `command` handler. `print`/`warn` are injected by the
 * surface (CLI stdout, MCP text block, or a test capture). `ask` is the cross-surface human prompt:
 * when the surface injects a real asker it is used; otherwise `ask` returns a `SUMO_NO_INTERACTION`
 * failure `Result` (declare-don't-fake) rather than blocking or pretending.
 *
 * @access public
 * @param {{ surface?: 'cli'|'mcp'|'programmatic', cwd?: string, print?: (text: string) => void, warn?: (d: import('./schema.mjs').Diagnostic) => void, ask?: (prompt: string, opts?: object) => Promise<import('./schema.mjs').Result<string>> }} opts - Options read by this operation.
 * @returns {import('./schema.mjs').InvocationCtx} Invocation context passed as the second command-handler argument.
 */
export function toContext({ surface = 'programmatic', cwd = process.cwd(), print = () => {}, warn = () => {}, ask } = {}) {
  return {
    surface,
    cwd,
    print,
    warn,
    ask: ask ?? (async () => fail('SUMO_NO_INTERACTION', `cannot prompt the user on the '${surface}' surface`))
  };
}
