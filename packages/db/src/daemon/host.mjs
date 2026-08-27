/**
 * The single-owner daemon (specs 01/02, ). It opens the one `classic-level` handle, exposes
 * standard KV over `many-level` (the package owns socket framing, iterator backpressure, reconnect,
 * and the LevelDB lock-race), and carries the three custom event ops — `append`/`subscribe`/`search`
 * — over a thin push control channel framed with `node:readline`. It holds NO workflow policy and
 * NO harness knowledge: storage + eventing only.
 *
 * @module sumo/db/daemon/host
 */

import net from 'node:net';
import fs from 'node:fs';
import readline from 'node:readline';
import { ClassicLevel } from 'classic-level';
import { ManyLevelHost } from 'many-level';
import { paths, ensureHome, securePath } from '../paths.mjs';
import { createEventLog, matchesFilter, getMaybe } from '../eventlog.mjs';
import { createSearch } from '../search.mjs';
import { startSweeper } from '../sweeper.mjs';
import { ControlRequest } from '../schema.mjs';
import { isLockError, SumoError } from '../errors.mjs';
import { PREFIX, prefixRange, ttlKey, evtRangeSince } from '../keyspace.mjs';
import { redactRawValue } from '../redaction.mjs';

/**
 * @typedef {import('zod').input<typeof import('../schema.mjs').EventInput>} EventInputRecord
 * @typedef {import('zod').infer<typeof import('../schema.mjs').Event>} StoredEvent
 * @typedef {import('zod').infer<typeof import('../schema.mjs').EventFilter>} EventFilterRecord
 * @typedef {import('zod').infer<typeof ControlRequest>} ControlRequestRecord
 * @typedef {import('zod').infer<typeof import('../schema.mjs').SteerRequest>} SteerRequestRecord
 * @typedef {import('zod').infer<typeof import('../schema.mjs').SessionRequest>} SessionRequestRecord
 * @typedef {import('../client.mjs').SumoDb} SumoDb
 */

/**
 * @typedef {object} DaemonStartOptions
 * @property {string} [home] - Sumo home directory; defaults through `ensureHome`.
 * @property {string} [dbPath] - LevelDB directory override.
 * @property {string} [socket] - KV socket override; the control socket is derived alongside it.
 * @property {number} [idleShutdownMs] - Milliseconds with no external clients before shutdown; `0` disables.
 * @property {number} [sweepIntervalMs] - TTL sweeper interval in milliseconds.
 * @property {(req: SteerRequestRecord) => unknown|Promise<unknown>} [onSteer] - Optional hosted steering handler.
 * @property {(req: SessionRequestRecord) => unknown|Promise<unknown>} [onSession] - Optional hosted session-control handler.
 * @property {{ start?: (db: SumoDb) => unknown|Promise<unknown>, stop?: () => unknown|Promise<unknown> }} [service] - Optional daemon-owned worker lifecycle.
 */

/**
 * Serialize any caught error as a full `SumoError` body for the control channel (wraps non-SumoErrors).
 *
 * @access private
 * @param {unknown} err - Error value being sent over the control channel.
 * @param {import('sumo/error').SumoErrorArgs & Record<string, unknown>} ctx - Error context used when wrapping non-Sumo errors.
 * @returns {Record<string, unknown>} Serialized `SumoError` body for a control-channel failure response.
 */
function wireError(err, ctx) {
  return (err instanceof SumoError ? err : SumoError.wrap(err, ctx)).toJSON();
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000; // 30 min (locked decision; 0 disables)

/**
 * A connected subscriber on the control channel. The daemon only sends it wake-up signals
 * (`{ sub, seq }`); the client reads the events itself from its watermark, so the daemon holds no
 * per-subscriber event buffer — just the filter that decides which wake-ups this subscriber gets.
 * @typedef {{
 *   id: string,
 *   socket: import('node:net').Socket,
 *   send: (line: string) => void,
 *   filter?: EventFilterRecord
 * }} Sub - Subscriber connection tracked by the daemon control channel.
 */

/**
 * Start the daemon. Resolves once both sockets are listening; rejects with a `SUMO_DB_LOCKED`-coded
 * error if another daemon already owns the store.
 * `onSteer` is the ONE composition boundary by which a layer co-hosts steering in this process WITHOUT the
 * daemon gaining harness/workflow knowledge (, spec 12): the daemon routes the generic `steer`
 * control op to it and passes the result back verbatim. A bare storage daemon leaves it undefined and
 * answers `steer` with `SUMO_BAD_OP`. The handler may throw a coded `SumoError` (e.g.
 * `SUMO_RUNTIME_STARTING`); the code is preserved on the wire.
 * `service` is a second composition boundary (alongside `onSteer`/`onSession`): a hosted long-lived
 * worker the daemon OWNS the lifecycle of — `start(inProcessClient)` after the sockets are listening,
 * `stop()` BEFORE the DB closes on every close path (explicit or idle). The daemon stays agnostic about
 * what it does (e.g. transcript ingestion lives in `sumo/agent-artifacts`, not here — that would cycle
 * the dependency); it only guarantees the ordering so the worker never writes to a closed DB.
 *
 * @access public
 * @param {DaemonStartOptions} [opts={}] - Daemon host configuration and optional co-hosted handlers.
 * @returns {Promise<{ paths: ReturnType<typeof paths>, close: () => Promise<void>, onClose: (fn: (reason: string) => void) => void, inProcessClient: () => SumoDb }>} Running daemon handle.
 */
export async function start(opts = {}) {
 const onSteer = opts.onSteer;
 const onSession = opts.onSession;
 const service = opts.service;
 const home = ensureHome(opts.home);
 const p = paths(home, { dbPath: opts.dbPath, socket: opts.socket });
 const idleMs = opts.idleShutdownMs ?? DEFAULT_IDLE_MS;

 const db = /** @type {import('../eventlog.mjs').AbstractDb} */ (/** @type {unknown} */ (new ClassicLevel(p.db, { valueEncoding: 'json' })));
 try {
 await db.open();
 } catch (err) {
 if (isLockError(err)) throw new SumoError({ name: 'db', method: 'start', code: 'SUMO_DB_LOCKED', message: 'another sumo daemon owns {db}', vars: { db: p.db }, cause: err });
 throw err;
 }

 const log = createEventLog(db);
 await log.ready();
 const search = createSearch(db);
 await search.rebuild();
 /** @type {Promise<unknown>} serialize all daemon-owned writes that affect TTL/event invariants */
 let writeTail = Promise.resolve();

 /**
 * Serialize daemon-owned writes that affect TTL pointers, event sequence assignment, or event
 * broadcasts so invariants stay race-free behind the single LevelDB owner.
 *
 * @access public
 * @template T
 * @param {() => Promise<T>} fn - Write operation to append to the daemon write chain.
 * @returns {Promise<T>} Promise resolving with the operation result.
 */
 function serializeWrite(fn) {
 const run = writeTail.then(fn);
 writeTail = run.catch(() => {});
 return run;
 }

 // ── subscriber registry ──────────────────────────────────────────────────────────────────
 /** @type {Map<string, Sub>} */
 const subs = new Map();
 /**
 * In-process subscribers (the co-hosted runtime's `db.subscribe`, spec 12). They are woken by the
 * same `broadcast` as socket subscribers but never touch a socket, so they do NOT count toward the
 * `conns` idle accounting — the daemon's idle-shutdown stays governed by EXTERNAL clients only.
 * @type {Set<(event: StoredEvent, updated: boolean) => void>}
 */
 const localWakers = new Set();
 /** @type {Set<import('node:net').Socket>} */
 const controlSockets = new Set();

 /**
 * Broadcast a wake-up. The signal is just the new `seq` (spec 01 §"Delivery model") — never the
 * payload — so there is nothing to buffer for a slow subscriber, and a coalesced/missed wake only
 * costs latency: the client's next watermark read catches up. Called only after the event's batch
 * write has committed (downstream of `await log.append`), so a client reading on the wake-up is
 * guaranteed to find the event.
 *
 * @access public
 * @param {StoredEvent} event - Stored event that should wake matching subscribers.
 * @param {{ updated?: boolean }} opts - Whether this is an enrichment of an existing sequence.
 * @returns {void} Broadcasts wake-up signals in place.
 */
 function broadcast(event, { updated = false } = {}) {
 for (const sub of subs.values()) {
 if (matchesFilter(sub.filter, event)) sub.send(JSON.stringify({ sub: sub.id, seq: event.seq, ...(updated ? { updated: true }: {}) }));
 }
 // Wake in-process subscribers too (they re-read from their own watermark, like socket clients).
 for (const wake of localWakers) wake(event, updated);
 }

 /**
 * The single observable-write path: append idempotently, and on a genuinely new event index it
 * and broadcast it. Used by both the `append` control op and the TTL sweeper.
 *
 * @access public
 * @param {EventInputRecord} eventInput - Validated event input to append or dedupe.
 * @returns {Promise<{ seq: number, deduped: boolean, enriched: boolean, event: StoredEvent }>} Append result returned by the event log.
 */
 async function appendEvent(eventInput) {
 const result = await log.append(eventInput);
 search.index(result.event);
 if (!result.deduped || result.enriched) broadcast(result.event, { updated: result.deduped });
 return result;
 }

 /**
 * Append one event under the daemon write serializer and return the append metadata.
 *
 * @access public
 * @param {EventInputRecord} eventInput - Event input accepted by the append control op.
 * @returns {Promise<{ seq: number, deduped: boolean, enriched: boolean, event: StoredEvent }>} Serialized append result.
 */
 async function emit(eventInput) {
 return serializeWrite(async () => {
 const ext = eventInput.ext ?? {};
 if (!Object.hasOwn(ext, 'native')) return appendEvent(eventInput);

 // Parser passthroughs carry their original record only until they cross the daemon boundary.
 // Persist that evidence under the raw namespace (where redaction is enforced) and remove it
 // from plugin-visible event metadata before the event log sees it.
 const { native, ...safeExt } = ext;
 const rawRef = eventInput.rawRef ?? `raw:event:${eventInput.dedupe}`;
 const redactedNative = redactRawValue(native);
 const existing = await getMaybe(db, rawRef);
 if (existing === undefined) {
 await db.put(rawRef, redactedNative);
 } else if (!(Array.isArray(existing) ? existing: [existing]).some((record) => JSON.stringify(record) === JSON.stringify(redactedNative))) {
 const records = Array.isArray(existing) ? existing: [existing];
 await db.put(rawRef, [...records, redactedNative]);
 }
 return appendEvent({ ...eventInput, ext: safeExt, rawRef });
 });
 }

 /**
 * Find existing TTL pointer records for a key so put/delete can replace or remove retention state
 * atomically with the value update.
 *
 * @access public
 * @param {string} key - Store key whose TTL pointer records should be deleted.
 * @returns {Promise<Array<{ type: 'del', key: string }>>} Batch delete operations for matching TTL pointers.
 */
 async function ttlPointerDeletesFor(key) {
 /** @type {Array<{ type: 'del', key: string }>} */
 const ops = [];
 for await (const [pointerKey, targetKey] of db.iterator(prefixRange(PREFIX.ttl))) {
 if (targetKey === key) ops.push({ type: 'del', key: pointerKey });
 }
 return ops;
 }

 /**
 * Store one value through the daemon write serializer, redacting raw payloads and replacing any
 * existing TTL pointer for the same key.
 *
 * @access public
 * @param {string} key - Store key to write.
 * @param {unknown} value - JSON value to persist.
 * @param {number|undefined} ttlMs - Optional retention period in milliseconds.
 * @returns {Promise<void>} Promise resolving after the batch write commits.
 */
 async function putValue(key, value, ttlMs) {
 return serializeWrite(async () => {
 const stored = key.startsWith(PREFIX.raw) ? redactRawValue(value): value;
 /** @type {Array<{ type: 'del', key: string } | { type: 'put', key: string, value: unknown }>} */
 const ops = await ttlPointerDeletesFor(key);
 ops.push({ type: 'put', key, value: stored });
 if (ttlMs !== undefined) ops.push({ type: 'put', key: ttlKey(Date.now() + ttlMs, key), value: key });
 await db.batch(/** @type {Array<import('abstract-level').AbstractBatchOperation<import('../eventlog.mjs').AbstractDb, string, unknown>>} */ (/** @type {unknown} */ (ops)));
 });
 }

 /**
 * Delete one value and any TTL pointer for it under the daemon write serializer.
 *
 * @access public
 * @param {string} key - Store key to delete.
 * @returns {Promise<void>} Promise resolving after the batch delete commits.
 */
 async function delValue(key) {
 return serializeWrite(async () => {
 const ops = await ttlPointerDeletesFor(key);
 ops.push({ type: 'del', key });
 await db.batch(ops);
 });
 }

 /**
 * Atomic read-merge-write inside the single write serializer (so two concurrent merges to one key
 * can't lost-update each other). `patch` wins per-key; keys present on the stored value but absent
 * from `patch` are preserved; plain objects (e.g. `ext`) deep-merge, while arrays and scalars from
 * `patch` REPLACE the stored value wholesale (no index-merge). A merge into a missing key writes the
 * patch as-is. Existing TTL pointers are left untouched, so a merge preserves a key's retention
 * rather than making it immortal. Storage-generic: holds no schema/harness knowledge .
 *
 * @access public
 * @param {string} key - Store key to merge.
 * @param {Record<string, unknown>} patch - Patch object whose fields win over the stored document.
 * @returns {Promise<void>} Promise resolving after the merged document is persisted.
 */
 async function mergeValue(key, patch) {
 return serializeWrite(async () => {
 const existing = await getMaybe(db, key);
 const merged = existing === undefined ? patch: mergePatch(existing, patch);
 const stored = key.startsWith(PREFIX.raw) ? redactRawValue(merged): merged;
 await db.put(key, stored);
 });
 }

 // ── lifecycle: idle-shutdown + graceful close ────────────────────────────────────────────
 let conns = 0;
 /** @type {ReturnType<typeof setTimeout>|undefined} */
 let idleTimer;
 let closing = false;
 /** @type {((reason: string) => void)|null} */
 let onIdle = null;

 /**
 * Arm idle shutdown only when no client connections remain and shutdown is enabled.
 *
 * @access public
 * @returns {void} Schedules or skips the idle timer in place.
 */
 function armIdle() {
 if (idleMs <= 0 || conns > 0 || closing) return;
 clearTimeout(idleTimer);
 idleTimer = setTimeout(() => { if (conns === 0) close('idle'); }, idleMs);
 idleTimer.unref();
 }
 /**
 * Count one external client connection and cancel any pending idle shutdown.
 *
 * @access public
 * @returns {void} Updates connection accounting in place.
 */
 function trackOpen() { conns++; clearTimeout(idleTimer); }
 /**
 * Release one external client connection and re-arm idle shutdown if the daemon is idle.
 *
 * @access public
 * @returns {void} Updates connection accounting in place.
 */
 function trackClose() { conns = Math.max(0, conns - 1); armIdle(); }

 const sweeper = startSweeper(db, { emit: appendEvent, intervalMs: opts.sweepIntervalMs, runExclusive: serializeWrite });

 /**
 * Close hosted services, sockets, subscribers, and the LevelDB handle in daemon-safe order.
 *
 * @access public
 * @param {string} reason - Shutdown reason reported to the close observer.
 * @returns {Promise<void>} Promise resolving after daemon resources are closed.
 */
 async function close(reason) {
 if (closing) return;
 closing = true;
 clearTimeout(idleTimer);
 // Stop the injected service BEFORE the DB closes — it writes through the in-process client, so it
 // must wind down its watchers/tails first (fixes the after-DB-close ordering bug for every path).
 try { await service?.stop?.(); } catch { /* best-effort */ }
 sweeper.stop();
 kvServer.close();
 ctlServer.close();
 for (const socket of controlSockets) socket.destroy();
 for (const sub of subs.values()) sub.socket.destroy();
 await db.close().catch(() => {});
 try { fs.unlinkSync(p.pid); } catch { /* already gone */ }
 onIdle?.(reason);
 }

 // ── KV transport: many-level host, one rpc stream per guest connection ─────────────────────
 // many-level's published types require a buffer-encoded abstract-level db; classic-level satisfies
 // this at runtime (verified) but its concrete type is structurally stricter, so cast at the boundary.
 const host = new ManyLevelHost(/** @type {import('abstract-level').AbstractLevel<Buffer, string, unknown>} */ (/** @type {unknown} */ (db)));
 const kvServer = net.createServer((socket) => {
 trackOpen();
 socket.on('close', trackClose);
 socket.on('error', () => {});
 const rpc = host.createRpcStream();
 socket.pipe(rpc).pipe(socket);
 });

 // ── control channel: append / subscribe / unsubscribe / search ─────────────────────────────
 const ctlServer = net.createServer((socket) => {
 trackOpen();
 controlSockets.add(socket);
 socket.on('error', () => {});
 /**
 * Send one control-channel response line.
 *
 * @access public
 * @param {string} line - Serialized JSON response line.
 * @returns {void} Writes to the socket when it is still open.
 */
 function send(line) {
 if (!socket.destroyed) socket.write(line + '\n');
 }
 const rl = readline.createInterface({ input: socket });

 socket.on('close', () => {
 controlSockets.delete(socket);
 for (const [id, sub] of subs) if (sub.socket === socket) subs.delete(id);
 trackClose();
 });

 rl.on('line', (line) => { handleLine(line, socket, send).catch(() => {}); });
 });

 /**
 * Parse and execute one control-channel request line.
 *
 * @access public
 * @param {string} line - Raw JSONL control-channel request line.
 * @param {import('node:net').Socket} socket - Client socket that owns subscriptions registered by this request.
 * @param {(line: string) => void} send - Response writer for this socket.
 * @returns {Promise<void>} Promise resolving after a response has been written.
 */
 async function handleLine(line, socket, send) {
 /** @type {ControlRequestRecord} */
 let req;
 try {
 const raw = JSON.parse(line);
 req = ControlRequest.parse(raw);
 } catch (err) {
 send(JSON.stringify({ id: requestIdFrom(line), ok: false, error: wireError(err, { name: 'db', method: 'control', code: 'SUMO_BAD_MESSAGE', message: 'malformed control-channel message' }) }));
 return;
 }
 try {
 if (req.op === 'append') {
 const { seq, deduped } = await emit(req.event);
 send(JSON.stringify({ id: req.id, ok: true, seq, deduped }));
 } else if (req.op === 'put') {
 await putValue(req.key, req.value, req.ttlMs);
 send(JSON.stringify({ id: req.id, ok: true }));
 } else if (req.op === 'del') {
 await delValue(req.key);
 send(JSON.stringify({ id: req.id, ok: true }));
 } else if (req.op === 'mergeDoc') {
 await mergeValue(req.key, req.patch);
 send(JSON.stringify({ id: req.id, ok: true }));
 } else if (req.op === 'subscribe') {
 // Register the filter for wake-ups, then ack. The client reads the backlog (since→head)
 // itself via the KV guest and re-reads on each wake-up — the daemon never reads or buffers
 // events on the subscriber's behalf.
 /** @type {Sub} */
 const sub = { id: req.id, socket, send, filter: req.filter };
 subs.set(req.id, sub);
 send(JSON.stringify({ id: req.id, ok: true }));
 } else if (req.op === 'unsubscribe') {
 subs.delete(req.id);
 send(JSON.stringify({ id: req.id, ok: true }));
 } else if (req.op === 'search') {
 const hits = await search.query(req.query, { limit: req.limit });
 send(JSON.stringify({ id: req.id, ok: true, hits }));
 } else if (req.op === 'steer') {
 // Storage daemon stays harness-agnostic: route to the injected steering host (spec 12). A bare
 // daemon with no host answers SUMO_BAD_OP. The handler's own error code (e.g.
 // SUMO_RUNTIME_STARTING) is preserved rather than flattened to SUMO_INTERNAL.
 if (!onSteer) {
 send(JSON.stringify({ id: req.id, ok: false, error: new SumoError({ name: 'db', method: 'steer', code: 'SUMO_BAD_OP', message: 'steering is not hosted by this daemon' }).toJSON() }));
 } else {
 try {
 const result = await onSteer(req);
 send(JSON.stringify({ id: req.id, ok: true, result }));
 } catch (err) {
 send(JSON.stringify({ id: req.id, ok: false, error: wireError(err, { name: 'db', method: 'steer', code: 'SUMO_INTERNAL', message: 'steering failed' }) }));
 }
 }
 } else if (req.op === 'session') {
 // Cross-process session control (): route to the injected session host. A bare daemon
 // with no host answers SUMO_BAD_OP. The handler returns a Result object or throws a coded error.
 if (!onSession) {
 send(JSON.stringify({ id: req.id, ok: false, error: new SumoError({ name: 'db', method: 'session', code: 'SUMO_BAD_OP', message: 'session control is not hosted by this daemon' }).toJSON() }));
 } else {
 try {
 const result = await onSession(req);
 send(JSON.stringify({ id: req.id, ok: true, result }));
 } catch (err) {
 send(JSON.stringify({ id: req.id, ok: false, error: wireError(err, { name: 'db', method: 'session', code: 'SUMO_INTERNAL', message: 'session control failed' }) }));
 }
 }
 } else if (req.op === 'shutdown') {
 send(JSON.stringify({ id: req.id, ok: true }));
 setImmediate(() => { close('requested').catch(() => {}); });
 }
 } catch (err) {
 send(JSON.stringify({ id: req.id, ok: false, error: wireError(err, { name: 'db', method: 'control', code: 'SUMO_INTERNAL', message: 'internal daemon error' }) }));
 }
 }

 /**
 * An in-process `SumoDb` facade for a co-hosted plugin runtime (spec 12, boundary preserved).
 * It calls the daemon's own storage/event functions directly — no socket, no extra hop — so it does
 * NOT register a `conns` connection and cannot defeat idle-shutdown. The shape matches
 * the socket `SumoDb` exactly, so `plugin({ db })` cannot tell the difference.
 *
 * @access public
 * @returns {SumoDb} Daemon-backed database facade for co-hosted services.
 */
 function inProcessClient() {
 return {
 /**
 * Read from the daemon-owned store without crossing the socket boundary.
 *
 * @access public
 * @param {string} key - Store key to read.
 * @returns {Promise<unknown|undefined>} Stored value, or `undefined` when the key is absent.
 */
 get(key) { return getMaybe(db, key); }, /**
 * Write through the same serialized path as socket clients.
 *
 * @access public
 * @param {string} key - Store key to write.
 * @param {unknown} value - JSON value to persist.
 * @param {{ ttlMs?: number }} o - Optional retention settings.
 * @returns {Promise<void>} Promise resolving after the value is persisted.
 */
 async put(key, value, o = {}) { await putValue(key, value, o.ttlMs); }, /**
 * Merge a document through the daemon write lock.
 *
 * @access public
 * @param {string} key - Store key to merge.
 * @param {Record<string, unknown>} patch - Patch object whose fields should win.
 * @returns {Promise<void>} Promise resolving after the document is merged.
 */
 async mergeDoc(key, patch) { await mergeValue(key, patch); }, /**
 * Delete through the daemon write lock.
 *
 * @access public
 * @param {string} key - Store key to delete.
 * @returns {Promise<void>} Promise resolving after the value is deleted.
 */
 async del(key) { await delValue(key); }, /**
 * Iterate the daemon store directly for co-hosted services.
 *
 * @access public
 * @param {string} prefix - Key prefix to scan.
 * @param {{ limit?: number, reverse?: boolean }} opts - Scan limit and ordering options.
 * @returns {AsyncIterable<[string, unknown]>} Iterator over matching key/value pairs.
 */
 async *scan(prefix, { limit, reverse } = {}) {
 const range = prefixRange(prefix);
 yield* db.iterator({ ...range, ...(limit != null ? { limit }: {}), ...(reverse ? { reverse }: {}) });
 }, /**
 * Append through the event log and return the assigned sequence.
 *
 * @access public
 * @param {EventInputRecord} event - Event input to append to the daemon event log.
 * @returns {Promise<number>} Assigned event sequence number.
 */
 async append(event) { return (await emit(/** @type {EventInputRecord} */ (event))).seq; }, /**
 * Subscribe a co-hosted service using the same replay/wake contract as socket clients.
 *
 * @access public
 * @param {{ since?: number, filter?: EventFilterRecord } | undefined} opts - Subscription watermark and optional event filter.
 * @param {(event: StoredEvent) => void} handler - Callback invoked for matching stored events.
 * @returns {Promise<() => void>} Unsubscribe callback for this in-process subscriber.
 */
 async subscribe(opts, handler) {
 const { since = 0, filter } = opts ?? {};
 // Same watermark-drain contract as the socket client: read evt: from the watermark to head,
 // emit matching events, advance past every event read (so nothing re-delivers); each wake-up
 // re-runs the drain, self-coalescing if one is already in flight.
 let watermark = since;
 let draining = false;
 let again = false;
 /**
 * Drain all events from the local watermark; wake-ups coalesce into one extra pass.
 *
 * @access public
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
 async function drain() {
 if (draining) { again = true; return; }
 draining = true;
 try {
 do {
 again = false;
 for await (const [, raw] of db.iterator(evtRangeSince(watermark))) {
 const event = /** @type {StoredEvent} */ (/** @type {unknown} */ (raw)); // iterator types values as string; JSON-decoded at runtime
 watermark = event.seq;
 if (matchesFilter(filter, event)) handler(event);
 }
 } while (again);
 } finally {
 draining = false;
 }
 }
 /**
 * Schedule a best-effort drain when the daemon appends a new event.
 *
 * @access public
 * @param {StoredEvent} event - Appended or enriched event supplied by the daemon.
 * @param {boolean} updated - Whether the event reused an existing sequence.
 * @returns {void} Starts a best-effort drain without awaiting it.
 */
 function wake(event, updated) {
 if (updated && event.seq <= watermark) {
 if (matchesFilter(filter, event)) handler(event);
 return;
 }
 drain().catch(() => {});
 }
 localWakers.add(wake);
 // Initial backlog flush. If it throws, remove the waker so it can't leak (review Part 1).
 try {
 await drain();
 } catch (err) {
 localWakers.delete(wake);
 throw err;
 }
 /**
 * Unsubscribe this local in-process client from daemon event wakeups.
 *
 * @access private
 * @returns {void} Removes the local wake callback.
 */
 return () => { localWakers.delete(wake); };
 }, /**
 * Search directly against the daemon-owned search index.
 *
 * @access public
 * @param {string} query - Search query text.
 * @param {{ limit?: number }} opts - Search options.
 * @returns {Promise<Array<{ docref: string, score: number }>>} Matching search hits ordered by relevance.
 */
 search(query, { limit } = {}) { return search.query(query, { limit }); }, /**
 * Refuse steering through an in-process storage facade; callers must use the hosted control channel.
 *
 * @access public
 * @returns {Promise<never>} Always rejects with `SUMO_BAD_OP`.
 */
 async steer() { throw new SumoError({ name: 'db', method: 'inProcessClient', code: 'SUMO_BAD_OP', message: 'in-process client does not call steer' }); }, /**
 * Refuse session control through an in-process storage facade; callers must use the hosted control channel.
 *
 * @access public
 * @returns {Promise<never>} Always rejects with `SUMO_BAD_OP`.
 */
 async session() { throw new SumoError({ name: 'db', method: 'inProcessClient', code: 'SUMO_BAD_OP', message: 'in-process client does not call session' }); }, /**
 * Stop the daemon gracefully.
 *
 * @access public
 * @returns {Promise<void>} Promise resolving after shutdown.
 */
 async shutdown() { await close('requested'); }, /**
 * Leave daemon ownership with the host process.
 *
 * @access public
 * @returns {Promise<void>} Resolves without closing the daemon.
 */
 async close() { /* the runtime does not own the daemon; nothing to close */ }
 };
 }

 // ── bind sockets (we hold the DB lock, so any leftover socket files are stale) ─────────────
 for (const s of [p.kvSock, p.ctlSock]) { try { fs.unlinkSync(s); } catch { /* not present */ } }
 await listen(kvServer, p.kvSock);
 await listen(ctlServer, p.ctlSock);
 securePath(p.kvSock);
 securePath(p.ctlSock);
 fs.writeFileSync(p.pid, String(process.pid), { mode: 0o600 });
 securePath(p.pid); // writeFileSync mode is umask-masked and won't reset a pre-existing file
 armIdle();

 // Start the injected service now that storage is listening; a failure must not crash daemon startup,
 // but it MUST be surfaced — a silent swallow would leave the daemon running with ingestion disabled
 // and no observable indication (sumo doctor / logs would show nothing wrong).
 if (service?.start) {
 try { await service.start(inProcessClient()); } catch (err) {
 // eslint-disable-next-line no-console
 console.error(`[sumo daemon] service.start failed — daemon is running but its co-hosted service did not start: ${err?.message ?? err}`);
 }
 }

 return {
 paths: p, /**
 * Close this daemon explicitly.
 *
 * @access public
 * @returns {Promise<void>} Promise resolving after explicit shutdown completes.
 */
 close() { return close('explicit'); }, /**
 * Register a callback for daemon shutdown.
 *
 * @access public
 * @param {(reason: string) => void} fn - Callback invoked with the shutdown reason.
 * @returns {void} Stores the shutdown observer.
 */
 onClose(fn) { onIdle = fn; }, /** A `SumoDb` facade backed by this daemon's storage in-process (spec 12 co-hosting). */
 inProcessClient
 };
}

/**
 * Listen on a Unix socket and resolve after the server is bound.
 *
 * @access private
 * @param {import('node:net').Server} server - Server to bind.
 * @param {string} sockPath - Unix socket path to listen on.
 * @returns {Promise<void>} Promise resolving after the server starts listening.
 */
function listen(server, sockPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => { server.off('error', reject); resolve(); });
  });
}

/**
 * Check whether a value can participate in document deep-merge semantics.
 *
 * @access private
 * @param {unknown} v - Candidate merge value.
 * @returns {boolean} Whether the value is a non-array object.
 */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Patch-wins deep merge for documents (the `mergeDoc` semantics). Plain objects merge recursively;
 * arrays and scalars from `patch` replace the base value wholesale (no lodash index-merge). The
 * dangerous keys `__proto__`/`prototype`/`constructor` are skipped so a crafted patch can't walk the
 * prototype chain.
 *
 * @access private
 * @param {unknown} base - Existing stored document value.
 * @param {unknown} patch - Patch value to apply.
 * @returns {unknown} Merged document value, or `patch` when either side is not mergeable.
 */
function mergePatch(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const baseObject = /** @type {Record<string, unknown>} */ (base);
  const patchObject = /** @type {Record<string, unknown>} */ (patch);
  const out = { ...baseObject };
  for (const k of Object.keys(patchObject)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
    const pv = patchObject[k];
    out[k] = isPlainObject(pv) && isPlainObject(out[k]) ? mergePatch(out[k], pv) : pv;
  }
  return out;
}

/**
 * Best-effort extraction of a request id from a malformed control-channel line.
 *
 * @access private
 * @param {string} line - Raw JSONL control-channel line.
 * @returns {string|null} Request id when the line contains one.
 */
function requestIdFrom(line) {
  try {
    const raw = JSON.parse(line);
    return typeof raw?.id === 'string' ? raw.id : null;
  } catch {
    return null;
  }
}
