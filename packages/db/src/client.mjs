/**
 * `SumoDb` — the client API that hides the daemon and socket entirely (spec 01 §"Client API").
 *
 * Standard KV (`get`/`put`/`del`/`scan`) rides a `many-level` guest (the package owns the socket
 * framing and iterator backpressure). The three custom event ops (`append`/`subscribe`/`search`)
 * ride a thin control channel framed with `node:readline`. A caller cannot tell whether the daemon
 * runs in this process or another — the API is identical.
 *
 * Reconnect (deferred): this client does NOT auto-reconnect. `many-level`'s `retry` is left off,
 * because resuming a dropped connection also requires re-piping the guest stream and re-issuing the
 * `subscribe`, which is more lifecycle plumbing than this layer carries yet. In normal operation a
 * connected client keeps the daemon alive (idle-shutdown only fires with zero clients), so the loss
 * case is a daemon *crash* mid-connection. Recovery is then the caller's job and is lossless by
 * design: persist the last-seen `seq` (the watermark — spec 02 says the client owns this) and, after
 * reopening, `subscribe({ since: watermark })`; the daemon flushes the backlog from that point before
 * going live, so no event is missed.
 *
 * @module sumo/db/client
 */

import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ManyLevelGuest } from 'many-level';
import { DEFAULT_DAEMON_STARTUP_TIMEOUT_MS } from 'sumo/config';
import { sleep, canConnectSocket, waitUntil } from 'sumo/util';
import { paths, ensureHome } from './paths.mjs';
import { getMaybe, matchesFilter } from './eventlog.mjs';
import { prefixRange, evtKey, evtRangeSince } from './keyspace.mjs';
import { SumoError } from './errors.mjs';

/**
 * @typedef {import('abstract-level').AbstractLevel<object, string, unknown>} AbstractDb
 * @typedef {import('zod').input<typeof import('./schema.mjs').EventInput>} EventInputRecord
 * @typedef {import('zod').infer<typeof import('./schema.mjs').Event>} StoredEvent
 * @typedef {import('zod').infer<typeof import('./schema.mjs').EventFilter>} EventFilterRecord
 * @typedef {import('zod').infer<typeof import('./schema.mjs').SearchHit>} SearchHitRecord
 * @typedef {import('zod').infer<typeof import('./schema.mjs').SteerRequest>} SteerRequestRecord
 * @typedef {import('zod').infer<typeof import('./schema.mjs').SessionRequest>} SessionRequestRecord
 * @typedef {{ id: string, ok: true, seq: number, deduped: boolean }} AppendResponse
 * @typedef {{ id: string, ok: true, hits: SearchHitRecord[] }} SearchResponse
 * @typedef {{ id: string, ok: true, result: { event: Record<string, unknown> } | { deny: string } }} SteerResponse
 * @typedef {{ id: string, ok: true, result: { ok: boolean, value?: unknown, code?: string, reason?: string } }} SessionResponse
 * @typedef {{ id: string, ok: true }} AckResponse
 * @typedef {Record<string, unknown> & { sub?: string, seq?: number, updated?: boolean, id?: string|null, ok?: boolean, error?: Record<string, unknown> & { code?: string, message?: string, package?: string } }} ParsedControlMessage
 */

/** The bare storage-only daemon entry. The product overrides this with a steering-capable entry. */
const BARE_DAEMON_MAIN = fileURLToPath(new URL('./daemon/main.mjs', import.meta.url));

/**
 * Which daemon entry autostart spawns. `SUMO_DAEMON_MAIN` lets a higher layer (the `sumo` bin) point
 * at a steering-capable daemon that also serves the `steer` control op (spec 12) — a SUPERSET of the
 * bare storage daemon, so it still satisfies every storage client. Absent the override, the bare
 * storage daemon is spawned (db-internal tests, library consumers).
 *
 * @access private
 * @returns {string} Daemon entrypoint spawned when autostart is enabled.
 */
function daemonMainPath() {
  return process.env.SUMO_DAEMON_MAIN || BARE_DAEMON_MAIN;
}

/**
 * Open a connection to the daemon, auto-starting it if necessary.
 *
 * @access public
 * @param {{ home?: string, dbPath?: string, socket?: string, idleShutdownMs?: number, sweepIntervalMs?: number, autostart?: boolean }} opts - Options read by this operation.
 * @returns {Promise<SumoDb>} Promise resolving to the `open` result.
 */
export async function open(opts = {}) {
  const home = ensureHome(opts.home);
  const p = paths(home, { dbPath: opts.dbPath, socket: opts.socket });
  const autostart = opts.autostart !== false && process.env.SUMO_NO_AUTOSTART !== '1';

  if (!(await canConnectSocket(p.kvSock))) {
    if (!autostart) {
      throw new SumoError({ name: 'db', method: 'open', code: 'SUMO_NO_DAEMON', message: 'no sumo daemon at {sock} and autostart is disabled', vars: { sock: p.kvSock } });
    }
    const env = { ...process.env };
    if (opts.home) env.SUMO_HOME = opts.home;
    if (opts.dbPath) env.SUMO_DB = opts.dbPath;
    if (opts.socket) env.SUMO_SOCKET = opts.socket;
    if (opts.idleShutdownMs !== undefined) env.SUMO_IDLE_MS = String(opts.idleShutdownMs);
    if (opts.sweepIntervalMs !== undefined) env.SUMO_SWEEP_MS = String(opts.sweepIntervalMs);
    const child = /** @type {import('node:child_process').ChildProcess} */ (spawn(process.execPath, [daemonMainPath()], {
      detached: true, stdio: 'ignore', env
    }));
    child.unref();
    try {
      await waitUntil(() => canConnectSocket(p.kvSock), { timeoutMs: DEFAULT_DAEMON_STARTUP_TIMEOUT_MS, intervalMs: 25 });
      await waitUntil(() => canConnectSocket(p.ctlSock), { timeoutMs: DEFAULT_DAEMON_STARTUP_TIMEOUT_MS, intervalMs: 25 });
    } catch {
      throw new SumoError({ name: 'db', method: 'open', code: 'SUMO_NO_DAEMON', message: 'daemon did not become ready in time' });
    }
  }

  return connect(p);
}

/**
 * @typedef {object} SumoDb
 * @property {(key: string) => Promise<unknown|undefined>} get
 * @property {(key: string, value: unknown, opts?: { ttlMs?: number }) => Promise<void>} put
 * @property {(key: string, patch: Record<string, unknown>) => Promise<void>} mergeDoc
 * @property {(key: string) => Promise<void>} del
 * @property {(prefix: string, opts?: { limit?: number, reverse?: boolean }) => AsyncIterable<[string, unknown]>} scan
 * @property {(event: EventInputRecord) => Promise<number>} append
 * @property {(opts: { since?: number, filter?: EventFilterRecord }, handler: (event: StoredEvent) => void) => Promise<() => void>} subscribe
 * @property {(query: string, opts?: { limit?: number }) => Promise<SearchHitRecord[]>} search
 * @property {(req: Omit<SteerRequestRecord, 'id'|'op'>) => Promise<{ event: Record<string, unknown> } | { deny: string }>} steer
 * @property {(req: Omit<SessionRequestRecord, 'id'|'op'>) => Promise<{ ok: boolean, value?: unknown, code?: string, reason?: string }>} session
 * @property {() => Promise<void>} shutdown
 * @property {() => Promise<void>} close
 */

/**
 * Execute `connect`.
 *
 * @access private
 * @param {ReturnType<typeof paths>} p - P supplied to `connect`.
 * @returns {Promise<SumoDb>} Promise resolving to the `connect` result.
 */
async function connect(p) {
  // KV transport
  const guest = new ManyLevelGuest({ valueEncoding: 'json' });
  const kv = /** @type {AbstractDb} */ (/** @type {unknown} */ (guest));
  const gsock = net.connect(p.kvSock);
  await new Promise((resolve, reject) => {
    gsock.once('connect', resolve);
    gsock.once('error', reject);
  });
  gsock.on('error', () => {});
  gsock.pipe(guest.createRpcStream()).pipe(gsock);

  // control channel
  const ctl = net.connect(p.ctlSock);
  await new Promise((resolve, reject) => {
    ctl.once('connect', resolve);
    ctl.once('error', reject);
  });
  const rl = readline.createInterface({ input: ctl });

  /** @type {Map<string, { resolve: (m: unknown) => void, reject: (e: Error) => void }>} */
  const pending = new Map();
  /** @type {Map<string, (message: ParsedControlMessage) => void>} per-subscription wake-up trigger */
  const wakers = new Map();
  let idc = 0;
  let closed = false;

  /**
   * Reject every unresolved control request when the control socket can no longer answer it.
   *
   * @access private
   * @param {unknown} cause - Socket failure or local close reason.
   * @returns {void} Settles all pending requests.
   */
  function rejectPending(cause) {
    const error = cause instanceof Error
      ? cause
      : new SumoError({ name: 'db', method: 'request', code: 'SUMO_NO_DAEMON', message: 'daemon control connection closed' });
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  ctl.on('error', rejectPending);
  ctl.on('close', () => rejectPending(new SumoError({ name: 'db', method: 'request', code: 'SUMO_NO_DAEMON', message: 'daemon control connection closed' })));

  rl.on('line', (line) => {
    /** @type {ParsedControlMessage} */
    let msg;
    try { msg = /** @type {ParsedControlMessage} */ (JSON.parse(line)); } catch { return; }
    if (typeof msg.sub === 'string') { wakers.get(msg.sub)?.(msg); return; }
    if (typeof msg.id !== 'string') return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.ok) waiter.resolve(msg);
    else waiter.reject(msg.error?.package
        ? SumoError.from(msg.error) // full serialized SumoError → rebuilt verbatim (link not re-stamped)
        : new SumoError({ name: 'db', method: 'request', code: msg.error?.code ?? 'SUMO_INTERNAL', message: msg.error?.message ?? 'request failed' }));
  });

  /**
   * Execute `request`.
   *
   * @access private
   * @param {Record<string, unknown> & { id: string }} obj - Obj supplied to `request`.
   * @template T
   * @returns {Promise<T>} Parsed control-channel response for the request id.
   */
  function request(obj) {
    return /** @type {Promise<T>} */ (new Promise((resolve, reject) => {
      if (closed || ctl.destroyed || !ctl.writable) {
        reject(new SumoError({ name: 'db', method: 'request', code: 'SUMO_NO_DAEMON', message: 'daemon control connection is closed' }));
        return;
      }
      pending.set(obj.id, { resolve: /** @type {(m: unknown) => void} */ (resolve), reject });
      try {
        ctl.write(JSON.stringify(obj) + '\n', (error) => {
          if (!error) return;
          const waiter = pending.get(obj.id);
          if (!waiter) return;
          pending.delete(obj.id);
          waiter.reject(error);
        });
      } catch (error) {
        pending.delete(obj.id);
        reject(/** @type {Error} */ (error));
      }
    }));
  }

  return {
    /**
     * Read a key, returning undefined for a missing value.
     *
     * @access public
     * @param {string} key - Key used by `get`.
     * @returns {Promise<unknown|undefined>} Promise resolving to the `get` result.
     */
    async get(key) {
      return getMaybe(kv, key);
    },
    /**
     * Write a value through the daemon control channel.
     *
     * @access public
     * @param {string} key - Key used by `put`.
     * @param {unknown} value - Value to resolve.
     * @param {{ ttlMs?: number }} opts - Options read by this operation.
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async put(key, value, { ttlMs } = {}) {
      const id = String(++idc);
      await request({ id, op: 'put', key, value, ...(ttlMs !== undefined ? { ttlMs } : {}) });
    },
    /**
     * Merge a document value atomically on the daemon owner.
     *
     * @access public
     * @param {string} key - Key used by `mergeDoc`.
     * @param {Record<string, unknown>} patch - Patch supplied to `mergeDoc`.
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async mergeDoc(key, patch) {
      const id = String(++idc);
      await request({ id, op: 'mergeDoc', key, patch });
    },
    /**
     * Delete a key through the daemon owner.
     *
     * @access public
     * @param {string} key - Key used by `del`.
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async del(key) {
      const id = String(++idc);
      await request({ id, op: 'del', key });
    },
    /**
     * Iterate values under a key prefix using the KV socket.
     *
     * @access public
     * @param {string} prefix - Prefix used by `scan`.
     * @param {{ limit?: number, reverse?: boolean }} opts - Options read by this operation.
     * @returns {AsyncIterable<[string, unknown]>} Async iterator produced by `scan`.
     */
    async *scan(prefix, { limit, reverse } = {}) {
      const range = prefixRange(prefix);
      yield* guest.iterator({ ...range, ...(limit != null ? { limit } : {}), ...(reverse ? { reverse } : {}) });
    },
    /**
     * Append an event through the daemon event log.
     *
     * @access public
     * @param {EventInputRecord} event - Event payload validated against the daemon append schema.
     * @returns {Promise<number>} Assigned event sequence number.
     */
    async append(event) {
      const id = String(++idc);
      const res = /** @type {AppendResponse} */ (await request(/** @type {Record<string, unknown> & { id: string }} */ ({ id, op: 'append', event })));
      return res.seq;
    },
    /**
     * Subscribe to daemon events with an initial replay from the requested watermark.
     *
     * @access public
     * @param {{ since?: number, filter?: EventFilterRecord } | undefined} opts - Starting watermark and optional event filter.
     * @param {(event: StoredEvent) => void} handler - Callback invoked for matching stored events.
     * @returns {Promise<() => void>} Unsubscribe function for daemon event wakeups.
     */
    async subscribe(opts, handler) {
      const { since = 0, filter } = opts ?? {};
      const id = String(++idc);
      let watermark = since;
      let draining = false;
      let again = false;

      // Read evt: from the watermark to head via the KV guest, emit matching events, advance the
      // watermark. This is BOTH the initial backlog flush and the live path: each wake-up just
      // re-runs it. The drain is self-coalescing (a wake during a drain re-loops once), and the
      // watermark advances past every event read — matching or not — so nothing is re-delivered and
      // a missed/coalesced wake-up is caught by the next read.
      /**
       * Drain all events from the local watermark; wake-ups coalesce into one extra pass.
       *
       * @access private
       * @returns {Promise<void>} Promise that resolves when the operation completes.
       */
      async function drain() {
        if (draining) { again = true; return; }
        draining = true;
        try {
          do {
            again = false;
            for await (const [, raw] of guest.iterator(evtRangeSince(watermark))) {
              const event = /** @type {StoredEvent} */ (/** @type {unknown} */ (raw)); // guest types values as string; JSON-decoded at runtime
              watermark = event.seq;
              if (matchesFilter(filter, event)) handler(event);
            }
          } while (again);
        } finally {
          draining = false;
        }
      }

      wakers.set(id, (wake) => {
        // An enriched duplicate keeps its original seq, which is already at our watermark. Fetch it
        // directly so subscribers see the richer event; a not-yet-replayed seq is handled by drain.
        if (wake.updated && typeof wake.seq === 'number' && wake.seq <= watermark) {
          getMaybe(/** @type {AbstractDb} */ (/** @type {unknown} */ (guest)), evtKey(wake.seq)).then((raw) => {
            if (raw && matchesFilter(filter, /** @type {StoredEvent} */ (raw))) handler(/** @type {StoredEvent} */ (raw));
          }).catch(() => {});
          return;
        }
        drain().catch(() => {});
      });
      await request({ id, op: 'subscribe', since, ...(filter ? { filter } : {}) });
      await drain(); // initial flush from `since`; wake-ups thereafter resume from the watermark
      /**
       * Unsubscribe this client from daemon event wakeups.
       *
       * @access private
       * @returns {void} Completes without producing a value.
       */
      return () => {
        wakers.delete(id);
        if (!ctl.destroyed) ctl.write(JSON.stringify({ id, op: 'unsubscribe' }) + '\n');
      };
    },
    /**
     * Run a full-text search query through the daemon.
     *
     * @access public
     * @param {string} query - Query supplied to `search`.
     * @param {{ limit?: number }} opts - Options read by this operation.
     * @returns {Promise<SearchHitRecord[]>} Search hits ranked by score.
     */
    async search(query, { limit } = {}) {
      const id = String(++idc);
      const res = /** @type {SearchResponse} */ (await request(/** @type {Record<string, unknown> & { id: string }} */ ({ id, op: 'search', query, ...(limit != null ? { limit } : {}) })));
      return res.hits;
    },
    /**
     * Forward a steering request to the daemon-hosted steering host.
     *
     * @access public
     * @param {Omit<SteerRequestRecord, 'id'|'op'>} req - Steering payload sent through the daemon control channel.
     * @returns {Promise<{ event: Record<string, unknown> } | { deny: string }>} Harness-agnostic steering decision.
     */
    async steer({ harness, cwd, action, payload = {}, ext, nativeSessionId }) {
      // Thin pass-through to the daemon-hosted steering host (spec 12). On a non-ok reply (no host,
      // or runtime not ready), `request` rejects with the daemon's coded SumoError — the caller
      // (`sumo forward`) maps that to its fail-open/closed policy.
      const id = String(++idc);
      const res = /** @type {SteerResponse} */ (await request(/** @type {Record<string, unknown> & { id: string }} */ ({
        id, op: 'steer', harness, cwd, action, payload, ...(ext !== undefined ? { ext } : {}), ...(nativeSessionId !== undefined ? { nativeSessionId } : {})
      })));
      return res.result;
    },
    /**
     * Forward a session-control request to the daemon-hosted orchestrator.
     *
     * @access public
     * @param {Omit<SessionRequestRecord, 'id'|'op'>} req - Session control payload sent through the daemon control channel.
     * @returns {Promise<{ ok: boolean, value?: unknown, code?: string, reason?: string }>} Result returned by the hosted orchestrator.
     */
    async session({ sessionId, action, payload = {}, cwd }) {
      // Thin pass-through to the daemon-hosted session control host (). Returns the Result from
      // the orchestrator's control() method; the daemon maps errors to SumoError codes.
      const id = String(++idc);
      const res = /** @type {SessionResponse} */ (await request(/** @type {Record<string, unknown> & { id: string }} */ ({
        id, op: 'session', sessionId, action, payload, ...(cwd !== undefined ? { cwd } : {})
      })));
      return res.result;
    },
    /**
     * Ask the daemon to stop gracefully.
     *
     * @access public
     * @returns {Promise<void>} Resolves after the daemon acknowledges shutdown.
     */
    async shutdown() {
      const id = String(++idc);
      await request({ id, op: 'shutdown' });
    },
    /**
     * Close sockets and the ManyLevel guest.
     *
     * @access public
     * @returns {Promise<void>} Promise that resolves when the operation completes.
     */
    async close() {
      closed = true;
      rejectPending(new SumoError({ name: 'db', method: 'close', code: 'SUMO_NO_DAEMON', message: 'database client closed' }));
      rl.close();
      ctl.end();
      await guest.close().catch(() => {});
      gsock.destroy();
    }
  };
}
