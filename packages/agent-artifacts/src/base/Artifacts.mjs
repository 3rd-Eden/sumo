/**
 * `sumo/agent-artifacts` base class (the unified adapter idiom, CONVENTIONS §3a/§4).
 *
 * An acquirer is the **on-disk source** for one harness: it does the I/O + bookkeeping (tail a live
 * file, import a completed file/export), delegates parsing to that harness's `sumo/transcript` parser,
 * and appends the normalized events to the daemon — computing the `dedupe` key the *same way* the live
 * harness source does (via the shared `forEvent`, ) so the two collapse. It is a pure sensor
 * (§3c): it acquires + appends, it does not parse formats (§3d) and does not dedupe/merge (the daemon
 * does, ).
 *
 * Subclasses set `id` / `can` / `config` / `transcriptComplete` instance props and (optionally)
 * `entry`/path helpers. The base owns the parser composition, the import loop, the tail loop, and the
 * append-with-dedupe path.
 *
 * @module sumo/agent-artifacts/base/Artifacts
 */

import { z } from 'zod';
import { adapters, raw } from 'sumo/transcript';
import { forEvent } from 'sumo/db/dedupe';
import { key } from 'sumo/db';
import { withDefined } from 'sumo/util';
import { logError } from 'sumo/log';

import { ok, fail, isResult, CAP_UNSUPPORTED, AcquireSummary } from './schema.mjs';
import { SumoError } from 'sumo/error';
import { tail } from '../tail.mjs';

/**
 * @typedef {import('sumo/transcript').NormalizedEventInput} NormalizedEventInput
 * @typedef {import('sumo/transcript').Parser & { can: { stream: boolean, file: boolean } }} TranscriptParser
 * @typedef {new () => TranscriptParser} TranscriptParserClass
 * @typedef {{ append: (event: Record<string, unknown>) => Promise<unknown>, mergeDoc?: (key: string, patch: Record<string, unknown>) => Promise<unknown> }} ArtifactDb
 * @typedef {{ db: ArtifactDb, sessionId?: string }} ImportContext
 * @typedef {{ db: ArtifactDb, sessionId?: string, signal?: AbortSignal, fromStart?: boolean, startOffset?: number, onProgress?: (offset: number) => void|Promise<void> }} TailContext
 * @typedef {{ db: ArtifactDb, sessionId?: string }} IngestContext
 * @typedef {{ type: string, payload?: Record<string, unknown>, ext?: Record<string, unknown>, id?: string, sessionId?: string, ts?: number }} ParserEventLike
 * @typedef {Iterable<NormalizedEventInput> | import('./schema.mjs').Result} ParserOutput
 * @typedef {{ transcriptPath?: string, records?: Record<string, unknown>[] }} SignalContext
 */

/**
 * Artifacts implementation.
 *
 * @access public
 * @class
 */
export class Artifacts {
 /** @type {string} the harness id; MUST match a `sumo/transcript` parser key. */
 id = '';

 /** @type {{ tail: boolean, import: boolean }} which acquisition modes this harness supports. */
 can = { tail: false, import: false };

 /** @type {import('zod').ZodTypeAny} per-acquirer config contract (most need none). */
 config = z.object({});

 /** @type {boolean} whether the on-disk transcript is complete (false for Cursor — honored, spec 04). */
 transcriptComplete = true;

 /**
 * The directory under which this harness writes its on-disk transcripts (recursively, `*.jsonl`).
 * Returns `null` by default (not auto-tailed); tail-capable adapters override, resolving the same env
 * conventions the harness path derivation uses (e.g. `$CLAUDE_CONFIG_DIR`). The always-on ingestion
 * service watches this root to auto-consume transcripts of sessions Sumo did not stream directly.
 *
 * @access public
 * @returns {string|null} String null returned by `transcriptRoot`.
 */
 transcriptRoot() {
 return null;
 }

 /**
 * Extract durable correlation signals from an on-disk transcript head. Concrete acquirers override
 * this when their transcript format carries cwd/native ids; the default is deliberately empty.
 *
 * @access public
 * @param {SignalContext} [_ctx] - Transcript context available during correlation.
 * @returns {Record<string, unknown>} Structured output from `signals`.
 */
 signals(_ctx = {}) {
 return {};
 }

 /** @type {import('sumo/transcript').Parser|null} */ #parserInstance = null;
 #pos = 0;

 /**
 * The composed transcript parser for this harness (lazy: `id` is a subclass field set after super).
 *
 * @access public
 * @returns {TranscriptParser} Transcript parser instance for this harness.
 */
 get parser() {
 if (!this.#parserInstance) {
 const Parser = /** @type {Record<string, TranscriptParserClass>} */ (/** @type {unknown} */ (adapters))[this.id];
 if (!Parser) throw new SumoError({ name: 'agent-artifacts', method: 'parser', code: 'SUMO_NO_PARSER', message: `no transcript parser registered for harness '${this.id}'` });
 this.#parserInstance = new Parser();
 }
 return this.#parserInstance;
 }

 /**
 * Which parser entry point this source feeds on-disk records into. Default derives from the parser's
 * declared `can`: `.file` when the harness has on-disk JSONL, else `.stream` (OpenCode, whose
 * export is replayed SSE-shaped records — `file:false`). An adapter may override.
 *
 * @access public
 * @returns {'file' | 'stream'} 'file' 'stream' returned by `entry`.
 */
 get entry() {
 return this.parser.can?.file ? 'file': 'stream';
 }

 // ── Acquisition ──────────────────────────────────────────────────────────────────────────────

 /**
 * Import a completed transcript / export: parse every record via the delegated parser, append the
 * normalized events to the daemon (source `'transcript'`), and emit one `transcript.ingested`.
 *
 * @access public
 * @param {Array<unknown>} records - already-decoded on-disk records (the caller `JSON.parse`d lines).
 * @param {ImportContext} ctx - Daemon client and correlated session id.
 * @returns {Promise<import('./schema.mjs').Result>} Promise that resolves with the shared Result returned by `import`.
 */
 async import(records, { db, sessionId } = /** @type {ImportContext} */ ({})) {
 if (!this.can.import) return fail(CAP_UNSUPPORTED, `${this.id}: import unsupported`);
 const count = await this.#ingest(/** @type {Array<Record<string, unknown>>} */ (/** @type {unknown} */ (records)), { db, sessionId });
 await db.append(this.#artifactEvent('transcript.ingested', { count }, sessionId));
 return ok(AcquireSummary.parse({ harness: this.id, sessionId, count, transcriptComplete: this.transcriptComplete !== false }));
 }

 /**
 * Tail a live append-only transcript: each appended line is parsed and its events appended as they
 * arrive (the daemon collapses against the live-stream source). CapabilitySchema-gated on `can.tail`.
 *
 * @access public
 * @param {string} path - the transcript file to tail.
 * @param {TailContext} ctx - Execution context for the operation.
 * @returns {import('./schema.mjs').Result<import('../tail.mjs').TailHandle>} Tail handle wrapped in a Result.
 */
 tail(path, { db, sessionId, signal, fromStart, startOffset, onProgress } = /** @type {TailContext} */ ({})) {
 if (!this.can.tail) return fail(CAP_UNSUPPORTED, `${this.id}: live tail unsupported (no on-disk transcript)`);
 // On tail-discovery we know the on-disk path for this session — the owner for harnesses the harness
 // layer can't derive (Codex's date-tree, Cursor). Record it on the `ses:` doc through the daemon's
 // atomic merge (never a client read-modify-write — that would race the harness's `harnessSessionId`
 // write and drop it). Requires a CORRELATED Sumo id: `key(native)` would miss the registry.
 if (sessionId && typeof db?.mergeDoc === 'function') {
 // try/catch guards a synchronous throw; .catch guards async rejection — either way a failed
 // metadata write must never prevent the tail from starting (best-effort, like the harness side).
 try {
 void Promise.resolve(db.mergeDoc(key(sessionId), { transcriptPath: path })).catch((error) => {
 logError(error, { source: 'sumo/agent-artifacts', harness: this.id, sessionId, transcriptPath: path, operation: 'mergeDoc' });
 });
 } catch (error) {
 logError(error, { source: 'sumo/agent-artifacts', harness: this.id, sessionId, transcriptPath: path, operation: 'mergeDoc' });
 }
 }
 let ingestTail = Promise.resolve();
 const self = this;

 /**
 * Serialize live-tail ingestion so appended transcript records preserve their event order.
 *
 * @access public
 * @param {Record<string, unknown>} record - Record to normalize.
 * @returns {Promise<void>} Resolves after this record has been durably ingested.
 */
 function enqueueIngest(record) {
 ingestTail = ingestTail
 .catch(() => {})
 .then(() => self.#ingest([record], { db, sessionId }))
 .then(() => {});
 return ingestTail;
 }
 const handle = tail(path, async (line) => {
 let record;
 try {
 record = JSON.parse(line);
 } catch {
 await enqueueIngest({ __sumoMalformedJsonl: line });
 return;
 }
 await enqueueIngest(record);
 }, {
 signal,
 ...withDefined({}, { fromStart, startOffset, onProgress })
 }
 );
 return ok(handle);
 }

 // ── Internals ────────────────────────────────────────────────────────────────────────────────

 /**
 * Parse + append every record's events; returns the count appended.
 *
 * @access public
 * @param {Array<Record<string, unknown>>} records - Records supplied to `ingest`.
 * @param {IngestContext} opts - Persistence context used while ingesting records.
 * @returns {Promise<number>} Count of normalized events appended to the daemon.
 */
 async #ingest(records, { db, sessionId }) {
 let count = 0;
 for (const record of records) {
 if (typeof record.__sumoMalformedJsonl === 'string') {
 await db.append(this.#toInput(raw('session', 'malformed-jsonl', { line: record.__sumoMalformedJsonl }), sessionId));
 count++;
 continue;
 }
 const out = /** @type {ParserOutput} */ (this.parser[this.entry](record));
 if (isResult(out)) continue; // capability gap (shouldn't happen — entry derives from can)
 for (const evt of /** @type {Iterable<NormalizedEventInput>} */ (out)) {
 await db.append(this.#toInput(evt, sessionId));
 count++;
 }
 }
 return count;
 }

 /**
 * Map one parser `EventSchema` → a `sumo/db` `EventInput`, deriving `dedupe` via the shared
 * `forEvent` (identical to the harness base) and tagging `source:'transcript'` so provenance
 * is visible while the key still collapses against the live source.
 *
 * @access public
 * @param {ParserEventLike} evt - Parser event to convert into a daemon append input.
 * @param {string|undefined} sessionId - Correlated Sumo session id fallback.
 * @returns {Record<string, unknown>} Daemon append input for the normalized transcript event.
 */
 #toInput(evt, sessionId) {
 // Dedupe key: derived from `evt` + the correlated Sumo fallback, identical to the harness base
 // so live ↔ file collapse. Stamped `sessionId`: the Sumo spine: native → `ext` (§3c).
 const ext = evt.sessionId
 ? { ...(evt.ext ?? {}), nativeSessionId: evt.sessionId }
: (evt.ext ?? {});
 return withDefined({
 dedupe: forEvent(evt, { sessionId, position: this.#pos++ }), type: evt.type, payload: evt.payload ?? {}, ext, source: 'transcript', adapter: this.id
 }, { sessionId, ts: evt.ts });
 }

 /**
 * Build a synthesized artifact event (`transcript.ingested` etc.) — id-less → content-hash key.
 *
 * @access public
 * @param {string} type - Event name or type handled by `artifactEvent`.
 * @param {Record<string, unknown>} payload - Payload consumed by `artifactEvent`.
 * @param {string|undefined} sessionId - Optional correlated Sumo session id for the artifact event.
 * @returns {Record<string, unknown>} Daemon append input for the synthesized artifact event.
 */
 #artifactEvent(type, payload, sessionId) {
 const evt = withDefined({ type, payload }, { sessionId });
 return withDefined({
 dedupe: forEvent(evt, { sessionId, position: this.#pos++ }), type, payload, ext: {}, source: 'transcript', adapter: this.id
 }, { sessionId });
 }
}
