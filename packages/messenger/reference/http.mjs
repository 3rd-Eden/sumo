/**
 * Reference HTTP messenger.
 *
 * This module is the reference implementation for `sumo/messenger`. It demonstrates how a real
 * messenger adapter should use the package: extend `Messenger`, declare honest capabilities, implement
 * medium primitives, let the base class bind public work methods, and communicate with a concrete
 * external medium. The medium here is a local HTTP API, but the adapter is intentionally production
 * shaped: it accepts work through HTTP, writes replies/status/reviews/claim markers back through HTTP,
 * and exposes proof-of-life routes for distributed coordination.
 *
 * The file lives in `packages/messenger/reference` because it is teaching material and a reference
 * adapter, not hidden package internals. Tests use it through the same public adapter registration
 * path a product plugin would use.
 *
 * @module sumo/messenger/reference/http
 */

import http from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';

import { Messenger } from '../src/base/Messenger.mjs';
import { ok, fail } from '../src/schema.mjs';

/**
 * Runtime configuration accepted by {@link HttpMessenger}.
 *
 * @type {import('zod').ZodObject<{
 *   baseUrl: import('zod').ZodString,
 *   agent: import('zod').ZodOptional<import('zod').ZodString>,
 *   claimTtlMs: import('zod').ZodDefault<import('zod').ZodNumber>,
 *   heartbeatMs: import('zod').ZodDefault<import('zod').ZodNumber>,
 *   settleMs: import('zod').ZodDefault<import('zod').ZodNumber>,
 *   pollMs: import('zod').ZodOptional<import('zod').ZodNumber>
 * }>}
 */
export const HttpMessengerConfig = z.object({
  baseUrl: z.string().url(), agent: z.string().optional(), claimTtlMs: z.number().int().positive().default(300_000), heartbeatMs: z.number().int().positive().default(60_000), settleMs: z.number().int().nonnegative().default(0), pollMs: z.number().int().nonnegative().optional()
});

/**
 * @typedef {import('../src/schema.mjs').WorkSchema} WorkSchema
 * @typedef {import('../src/schema.mjs').ClaimState} ClaimState
 * @typedef {Record<string, unknown> & { type?: 'claim'|'release'|'restart', agent?: string, ts: number }} MediumMarker
 * @typedef {WorkSchema & {
 *   externalId: string,
 *   ext: Record<string, unknown>,
 *   replies: MediumMarker[],
 *   statuses: MediumMarker[],
 *   reviews: MediumMarker[],
 *   reactions: MediumMarker[],
 *   claims: MediumMarker[],
 *   pulses: MediumMarker[]
 * }} HttpWork
 * @typedef {{ status: number, body: Record<string, unknown> }} RouteResult
 * @typedef {{ baseUrl: string, postWork: (item: Record<string, unknown>) => Promise<Record<string, unknown>>, getWork: (id: string) => HttpWork|undefined, close: () => Promise<void> }} HttpMessengerServer
 */

/**
 * Messenger adapter backed by a simple HTTP work API `HttpMessenger` is intentionally small, but it is not a mock. It follows the same design contract expected of external messengers such as GitHub: read work from the medium, post effects to the medium, and let the shared `Messenger` base handle redaction, idempotent ingress, bound work methods, claim lifecycle events, local claim mirror updates, and daemon event emission.
 *
 * @access public
 * @class
 * @augments {Messenger}
 */
export class HttpMessenger extends Messenger {
  /** @type {string} Public adapter id used in event provenance and provider registration. */
  id = 'http-reference';

  /**
   * Declared capabilities backed by the HTTP routes in this reference medium.
   *
   * @type {import('../src/schema.mjs').MessengerCan}
   */
  can = { reply: true, claim: true, status: true, review: true, react: true, distributed: true };

  /** @type {typeof HttpMessengerConfig} Zod contract for adapter configuration. */
  config = HttpMessengerConfig;

  /**
   * Resolve the configured base URL for every HTTP operation.
   *
   * @access public
   * @returns {string} String returned by `validates`.
   */
  get #baseUrl() {
    return /** @type {z.infer<typeof HttpMessengerConfig>} */ (this.ctx?.config).baseUrl;
  }

  /**
   * Read work items from the HTTP medium and yield raw work records for the Messenger base.
   * The base class validates these records, mints stable Sumo work ids, deduplicates already-seen
   * items, emits `work.appeared`, and binds public work methods such as `reply()` and `claim()`.
   *
   * @access public
   * @returns {AsyncGenerator<import('../src/schema.mjs').WorkSchema>} Work items read from the HTTP medium.
   */
  async *work() {
    /** @type {Set<string>} */
    const seen = new Set();
    while (!this.ctx?.signal?.aborted) {
      let items;
      try {
        ({ items } = /** @type {{ items: WorkSchema[] }} */ (await this.#json('GET', '/work')));
      } catch (e) {
        if (this.ctx?.signal?.aborted && isAbortError(e)) break;
        throw e;
      }
      for (const item of items) {
        if (seen.has(item.externalId)) continue;
        seen.add(item.externalId);
        yield {
          externalId: item.externalId, title: item.title, body: item.body, kind: item.kind, cwd: item.cwd, ext: item.ext
        };
      }
      const pollMs = /** @type {z.infer<typeof HttpMessengerConfig>} */ (this.ctx?.config).pollMs;
      if (pollMs === undefined) break;
      await sleep(pollMs, this.ctx?.signal);
    }
  }

  /**
   * Post a reply to the HTTP work thread.
   * The Messenger base calls this after applying shared reply redaction. Returning a Result keeps
   * medium failures operational instead of throwing through plugin handlers.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @param {string} text - Reply text after base-level redaction.
   * @returns {Promise<import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `say`.
   */
  async say(ref, text) {
    return this.#result('POST', `/work/${encodeURIComponent(ref.externalId)}/replies`, { text });
  }

  /**
   * Read, set, or clear a claim marker on the HTTP medium.
   * This method implements the `Messenger.mark()` primitive. The base uses it for optimistic
   * read-after-write claiming, heartbeat/release behavior, and event emission.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @param {string|null} who - `undefined` reads current claim, string claims for an agent, `null` releases.
   * @returns {Promise<import('../src/schema.mjs').ClaimState|undefined|import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `mark`.
   */
  async mark(ref, who) {
    try {
      const id = encodeURIComponent(ref.externalId);
      if (who === undefined) {
        const state = /** @type {{ claim?: ClaimState }} */ (await this.#json('GET', `/work/${id}/claim?ttlMs=${this.claimTtlMs}`));
        return state.claim ?? undefined;
      }
      if (who === null) return this.#result('POST', `/work/${id}/releases`, {});
      return this.#result('POST', `/work/${id}/claims`, { agent: who });
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `http-reference: mark ${ref.externalId} failed - ${e?.message ?? e}`);
    }
  }

  /**
   * Post a status update for a work item.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @param {object|string} status - Status payload supplied by a plugin or orchestrator.
   * @returns {Promise<import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `status`.
   */
  async status(ref, status) {
    return this.#result('POST', `/work/${encodeURIComponent(ref.externalId)}/statuses`, status);
  }

  /**
   * Post a review result for a work item.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @param {Record<string, unknown>} review - Review payload such as `{ verdict, text }`.
   * @returns {Promise<import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `review`.
   */
  async review(ref, review) {
    return this.#result('POST', `/work/${encodeURIComponent(ref.externalId)}/reviews`, review);
  }

  /**
   * Post a reaction for a work item.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @param {string} emoji - Medium-native reaction name or emoji.
   * @returns {Promise<import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `react`.
   */
  async react(ref, emoji) {
    return this.#result('POST', `/work/${encodeURIComponent(ref.externalId)}/reactions`, { emoji });
  }

  /**
   * Refresh a claim lease on the HTTP medium.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @param {string} agent - Agent identity whose claim should be refreshed.
   * @returns {Promise<import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `touch`.
   */
  async touch(ref, agent) {
    return this.#result('POST', `/work/${encodeURIComponent(ref.externalId)}/touches`, { agent });
  }

  /**
   * Publish a proof-of-life marker to the HTTP medium.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @param {string} kind - Marker kind, for example `request`, `alive`, or `evict`.
   * @param {Record<string, unknown>} data - Marker payload to persist with the proof-of-life event.
   * @returns {Promise<import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `pulse`.
   */
  async pulse(ref, kind, data) {
    return this.#result('POST', `/work/${encodeURIComponent(ref.externalId)}/pulses`, { kind, data });
  }

  /**
   * Read proof-of-life markers from the HTTP medium.
   *
   * @access public
   * @param {{ externalId: string }} ref - Work reference produced by the Messenger base.
   * @returns {Promise<Array<Record<string, unknown>>>} Stored proof-of-life markers from the medium.
   */
  async pulses(ref) {
    const { items } = /** @type {{ items: Array<Record<string, unknown>> }} */ (await this.#json('GET', `/work/${encodeURIComponent(ref.externalId)}/pulses`));
    return items;
  }

  /**
   * Convert one HTTP request into the shared Result shape.
   *
   * @access public
   * @param {string} method - HTTP method to send.
   * @param {string} pathname - Path relative to the configured base URL.
   * @param {unknown} [body] - Optional JSON request body.
   * @returns {Promise<import('../src/schema.mjs').Result>} Promise that resolves with the shared Result returned by `result`.
   */
  async #result(method, pathname, body) {
    try {
      await this.#json(method, pathname, body);
      return ok();
    } catch (e) {
      return fail('SUMO_MEDIUM_ERROR', `http-reference: ${method} ${pathname} failed - ${e?.message ?? e}`);
    }
  }

  /**
   * Send one JSON request to the reference HTTP medium.
   *
   * @access public
   * @throws {Error} When the medium returns a non-2xx response or invalid JSON.
   * @param {string} method - HTTP method to send.
   * @param {string} pathname - Path relative to the configured base URL.
   * @param {unknown} [body] - Optional JSON request body.
   * @returns {Promise<Record<string, unknown>>} Parsed JSON response object from the reference medium.
   */
  async #json(method, pathname, body) {
    const url = new URL(pathname, this.#baseUrl);
    const res = await fetch(url, {
      method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: this.ctx?.signal
    });
    const json = /** @type {Record<string, unknown>} */ (JSON.parse(await res.text()));
    if (!res.ok) throw new Error(String(json.reason ?? res.statusText));
    return json;
  }
}

/**
 * Read-only reference HTTP messenger This variant is a real adapter shape, not a test double: it ingests work from the same HTTP medium as {@link HttpMessenger}, but declares every mutating capability unsupported. It is useful for deployments that should observe an HTTP work feed without posting replies, claims, reviews, status, reactions, or proof-of-life markers.
 *
 * @access public
 * @class
 * @augments {HttpMessenger}
 */
export class ReadOnlyHttpMessenger extends HttpMessenger {
  /** @type {string} Public adapter id for read-only HTTP reference usage. */
  id = 'http-reference-readonly';

  /**
   * Honest read-only capability descriptor. The inherited read path still works; all write-bound
   * methods degrade through the base `Messenger` capability gates.
   * @type {import('../src/schema.mjs').MessengerCan}
   */
  can = { reply: false, claim: false, status: false, review: false, react: false, distributed: false };
}

/**
 * Start the local HTTP medium used by the reference messenger.
 * The returned server is a real TCP HTTP server with routes for work ingestion, replies, claims,
 * statuses, reviews, reactions, heartbeats, and proof-of-life markers. It is intentionally useful
 * outside tests: plugin authors can run it to see how a messenger adapter interacts with a concrete
 * medium.
 *
 * @access public
 * @param {{ host?: string, port?: number }} opts - Optional server binding options.
 * @returns {Promise<HttpMessengerServer>} Running server handle with HTTP helpers for reference usage.
 */
export async function createHttpMessengerServer({ host = '127.0.0.1', port = 0 } = {}) {
  /** @type {Map<string, HttpWork>} */
  const works = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(/** @type {string} */ (req.url), 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const body = await readJson(req);
      const result = route({ method: /** @type {string} */ (req.method), parts, query: url.searchParams, body, works });
      send(res, result.status, result.body);
    } catch (e) {
      send(res, 500, { ok: false, reason: e?.message ?? String(e) });
    }
  });

  server.listen(port, host);
  await once(server, 'listening');
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const baseUrl = `http://${address.address}:${address.port}`;

  return {
    baseUrl,
    /**
     * Add or replace one work item through the public HTTP route.
     *
     * @access public
     * @param {Record<string, unknown>} item - Work item with at least `externalId`, plus optional title/body/kind/cwd/ext.
     * @returns {Promise<Record<string, unknown>>} Stored public work representation returned by the HTTP route.
     */
    async postWork(item) {
      const res = await fetch(new URL('/work', baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(item)
      });
      return /** @type {Record<string, unknown>} */ (await res.json());
    },
    /**
     * Inspect one stored work item.
     *
     * @access public
     * @param {string} id - Medium `externalId` for the work item.
     * @returns {HttpWork|undefined} Stored medium record when the id exists.
     */
    getWork(id) {
      return works.get(id);
    },
    /**
     * Stop the HTTP server.
     *
     * @access public
     * @returns {Promise<void>} Resolves after the TCP server stops accepting connections.
     */
    close() {
      return /** @type {Promise<void>} */ (new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
    }
  };
}

/**
 * Read and parse a JSON request body.
 *
 * @access private
 * @param {http.IncomingMessage} req - Incoming HTTP request.
 * @returns {Promise<Record<string, unknown>>} Parsed JSON body, or an empty object when the request has no body.
 */
async function readJson(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) return {};
  return /** @type {Record<string, unknown>} */ (JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/**
 * Send one JSON response.
 *
 * @access private
 * @param {http.ServerResponse} res - HTTP response object.
 * @param {number} status - HTTP status code.
 * @param {Record<string, unknown>} body - JSON response body.
 * @returns {void} Completes without producing a value.
 */
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Route one HTTP request against the in-memory medium state.
 *
 * @access private
 * @param {{ method: string, parts: string[], query: URLSearchParams, body: Record<string, unknown>, works: Map<string, HttpWork> }} req - Normalized request.
 * @returns {RouteResult} HTTP status code and JSON response body.
 */
function route({ method, parts, query, body, works }) {
  if (method === 'GET' && parts.length === 1 && parts[0] === 'work') {
    return { status: 200, body: { items: [...works.values()].map(publicWork) } };
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'work') {
    const externalId = typeof body.externalId === 'string' ? body.externalId : undefined;
    if (!externalId) return { status: 400, body: { reason: 'externalId is required' } };
    const existing = works.get(externalId) ?? emptyWork(externalId);
    const next = {
      ...existing,
      externalId,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.body === 'string' ? { body: body.body } : {}),
      ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
      ext: isRecord(body.ext) ? body.ext : {}
    };
    works.set(externalId, next);
    return { status: 201, body: publicWork(next) };
  }

  if (parts[0] !== 'work' || parts.length < 3) return { status: 404, body: { reason: 'not found' } };
  const work = works.get(parts[1]);
  if (!work) return { status: 404, body: { reason: `unknown work ${parts[1]}` } };
  const section = parts[2];

  if (method === 'GET' && section === 'claim') {
    return { status: 200, body: { claim: currentClaim(work, Number(query.get('ttlMs') ?? 300_000)) } };
  }
  const collection = collectionFor(work, section);
  if (method === 'GET' && collection) return { status: 200, body: { items: collection } };

  if (method === 'POST' && section === 'replies') return append(work.replies, { text: body.text });
  if (method === 'POST' && section === 'statuses') return append(work.statuses, body);
  if (method === 'POST' && section === 'reviews') return append(work.reviews, body);
  if (method === 'POST' && section === 'reactions') return append(work.reactions, { emoji: body.emoji });
  if (method === 'POST' && section === 'pulses') return append(work.pulses, { kind: body.kind, ...(isRecord(body.data) ? body.data : {}) });
  if (method === 'POST' && section === 'claims') return append(work.claims, { type: 'claim', agent: body.agent });
  if (method === 'POST' && section === 'releases') {
    const cur = currentClaim(work, Number.MAX_SAFE_INTEGER);
    return append(work.claims, { type: 'release', agent: body.agent ?? cur?.agent });
  }
  if (method === 'POST' && section === 'touches') {
    const cur = currentClaim(work, Number.MAX_SAFE_INTEGER);
    if (cur?.agent === body.agent) return append(work.claims, { type: 'claim', agent: body.agent });
    return { status: 200, body: { ok: true } };
  }

  return { status: 404, body: { reason: 'not found' } };
}

/**
 * Test whether a decoded JSON value is an object record.
 *
 * @access private
 * @param {unknown} value - Value decoded from the HTTP request or response body.
 * @returns {value is Record<string, unknown>} True when the value can be safely spread as an object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Select a mutable medium collection by route section.
 *
 * @access private
 * @param {HttpWork} work - Stored work item containing route-backed collections.
 * @param {string} section - URL section after `/work/:id/`.
 * @returns {MediumMarker[]|undefined} Collection for list routes, or `undefined` for unknown sections.
 */
function collectionFor(work, section) {
  switch (section) {
    case 'replies': return work.replies;
    case 'statuses': return work.statuses;
    case 'reviews': return work.reviews;
    case 'reactions': return work.reactions;
    case 'claims': return work.claims;
    case 'pulses': return work.pulses;
    default: return undefined;
  }
}

/**
 * Build an empty work record for the HTTP medium.
 *
 * @access private
 * @param {string} externalId - Stable medium id for the work item.
 * @returns {HttpWork} Empty mutable work record with all medium collections initialized.
 */
function emptyWork(externalId) {
  return { externalId, ext: {}, replies: [], statuses: [], reviews: [], reactions: [], claims: [], pulses: [] };
}

/**
 * Return the public work shape exposed by `GET /work`.
 *
 * @access private
 * @param {HttpWork} work - Stored work state.
 * @returns {WorkSchema} Public work fields consumed by the Messenger base.
 */
function publicWork(work) {
  const { externalId, title, body, kind, cwd, ext } = work;
  return { externalId, title, body, kind, cwd, ext };
}

/**
 * Append a timestamped marker to one medium collection.
 *
 * @access private
 * @param {MediumMarker[]} list - Collection to mutate.
 * @param {Record<string, unknown>} item - Marker payload to append.
 * @returns {{ status: 201, body: Record<string, unknown> }} HTTP creation response for the appended marker.
 */
function append(list, item) {
  const entry = /** @type {MediumMarker} */ ({ ...item, ts: Date.now() });
  list.push(entry);
  return { status: 201, body: entry };
}

/**
 * Sleep until the next poll or until shutdown aborts.
 *
 * @access private
 * @param {number} ms - Delay in milliseconds.
 * @param {AbortSignal|undefined} signal - Optional abort signal from the plugin runtime.
 * @returns {Promise<void>} Resolves on timeout or abort.
 */
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    /**
     * Complete the sleep when the timer fires or the abort signal trips.
     *
     * @access private
     * @returns {void} The timer and abort listener are removed before resolving.
     */
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * Detect abort errors from Node's fetch implementation.
 *
 * @access private
 * @param {unknown} err - Error value thrown by `fetch` or an abortable helper.
 * @returns {boolean} True when the error is one of Node's abort shapes.
 */
function isAbortError(err) {
  return /** @type {Record<string, unknown>} */ (err)?.name === 'AbortError' || /** @type {Record<string, unknown>} */ (err)?.code === 'ABORT_ERR';
}

/**
 * Compute the currently active claim from medium markers.
 *
 * @access private
 * @param {HttpWork} work - Stored work item with claim markers.
 * @param {number} ttlMs - Claim TTL in milliseconds.
 * @returns {ClaimState|undefined} Active claim and staleness metadata, or `undefined` when released.
 */
function currentClaim(work, ttlMs) {
  /** @type {{ agent: string, ts: number, ext: Record<string, unknown> }|undefined} */
  let state;
  for (const marker of work.claims) {
    if (marker.type === 'claim' && typeof marker.agent === 'string') {
      state = { agent: marker.agent, ts: marker.ts, ext: { markerCount: work.claims.length } };
    } else if ((marker.type === 'release' || marker.type === 'restart') && state && (!marker.agent || marker.agent === state.agent)) {
      state = undefined;
    }
  }
  if (!state) return undefined;
  return { ...state, stale: Date.now() - state.ts > ttlMs };
}
