/**
 * Canonical zod contracts for the storage + event-log layer (specs 01/02). These schemas are the
 * single source of truth; the JSDoc typedefs in the specs are descriptions of them (CONVENTIONS §3).
 *
 * Every boundary where data crosses into the daemon (`append`, control-channel messages) parses
 * through these. The store itself is schemaless — raw adapter documents are stored verbatim — so
 * validation happens here, at the ownership boundary, not in LevelDB.
 *
 * @module sumo/db/schema
 */

import { z } from 'zod';
import { monotonicFactory } from 'ulidx';
import { ErrorSchema } from 'sumo/error';

/** A JSON object bag (normalized `payload`, adapter-specific `ext`). */
const JsonObject = z.record(z.string(), z.unknown());

/** Stable error codes carried on failures, mapping to the `DiagnosticSchema` model (CONVENTIONS §7). */
export const ErrorCode = z.enum([
  'SUMO_DB_LOCKED',
  'SUMO_NO_DAEMON',
  'SUMO_BAD_MESSAGE',
  'SUMO_BAD_OP',
  'SUMO_INSECURE_PERMS',
  'SUMO_INTERNAL',
  // The daemon accepted a `steer` op but no steering host is wired in this process (a bare storage
  // daemon), or the per-project runtime is not ready yet. Both are produced by the injected `onSteer`
  // handler (the composition layer), surfaced through the generic error path (spec 12).
  'SUMO_RUNTIME_STARTING',
  // Session control (): the `ses:` doc for the given id was not found in the registry.
  'SUMO_SESSION_UNKNOWN',
  // The session id is known but has no live handle in the orchestrator (session ended/dead/orphaned).
  'SUMO_SESSION_DEAD'
]);

/** Where an event originated (spec 01 event document `source`). */
export const EventSource = z.enum([
  'hook',
  'transcript',
  'orchestrator',
  'messenger',
  'plugin',
  'session'
]);

/** A redaction descriptor recorded so evidence shape is preserved without the secret (spec 01/§12). */
export const Redaction = z.object({
  offset: z.number().int().nonnegative(), len: z.number().int().nonnegative(), kind: z.string()
});

/**
 * The fields a caller supplies to `append`. The daemon assigns `seq` and stamps `ts` if absent;
 * `dedupe` is REQUIRED (source-preferred natural id, else content hash — see dedupe.mjs).
 */
export const EventInput = z.object({
  dedupe: z.string().min(1), type: z.string().min(1), ts: z.number().int().nonnegative().optional(), sessionId: z.string().optional(), source: EventSource.optional(), adapter: z.string().optional(), payload: JsonObject.default({}), ext: JsonObject.default({}), rawRef: z.string().optional(), redactions: z.array(Redaction).optional()
});

/** The stored event envelope (`evt:<seq>` document): an `EventInput` with the assigned `seq`/`ts`. */
export const Event = EventInput.extend({
  seq: z.number().int().nonnegative(), ts: z.number().int().nonnegative()
});

/** The session document stored at `ses:<id>` (spec 01). Schemaless `ext` carries harness specifics. */
export const SessionSchema = z.object({
  id: z.string(), harness: z.string(), harnessSessionId: z.string().optional(), cwd: z.string().optional(), model: z.string().optional(), pid: z.number().int().optional(), state: z.string(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), transcriptPath: z.string().optional(),
  // Where this session's live events come from: 'event-stream' (headless — the harness read loop is
  // the source, so the always-on transcript tail must NOT double-ingest it) vs 'transcript-file'
  // (interactive/tmux — no live stream, the transcript IS the source and must be ingested).
  observationSource: z.string().optional(), ext: JsonObject.default({})
});

/** `ses_<ulid>` — Crockford base32, 26 chars (spec 04). */
export const ID_REGEXP = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;
export const SessionId = z.string().regex(ID_REGEXP);

const nextUlid = monotonicFactory();
/**
 * Mint a new monotonic session id (`ses_<ulid>`).
 *
 * @access public
 * @returns {string} String returned by `id`.
 */
export function id() {
  return `ses_${nextUlid()}`;
}

/** Daemon-side subscription filter (applied before push): by `type`/`sessionId`/`source`. */
export const EventFilter = z.object({
  type: z.array(z.string()).optional(), sessionId: z.string().optional(), source: z.array(EventSource).optional()
});

// ── Control-channel messages (spec 02 wire protocol) ──────────────────────────────────────────
// Only the custom event ops ride this channel; standard KV (get/put/del/scan) rides many-level.

export const AppendRequest = z.object({
  id: z.string(), op: z.literal('append'), event: EventInput
});

export const PutRequest = z.object({
  id: z.string(), op: z.literal('put'), key: z.string(), value: z.unknown(), ttlMs: z.number().int().nonnegative().optional()
});

export const DelRequest = z.object({
  id: z.string(), op: z.literal('del'), key: z.string()
});

/**
 * Atomic doc-merge: read the value at `key`, deep-merge `patch` on top (patch wins per key, existing
 * keys absent from the patch are preserved), write it back — all inside the daemon's single write
 * serializer, so concurrent merges to the same doc never lost-update each other (the harness records
 * `harnessSessionId` while agent-artifacts records `transcriptPath` on the same `ses:` doc).
 */
export const MergeRequest = z.object({
  id: z.string(), op: z.literal('mergeDoc'), key: z.string(), patch: z.record(z.string(), z.unknown())
});

export const SubscribeRequest = z.object({
  id: z.string(), op: z.literal('subscribe'), since: z.number().int().nonnegative().default(0), filter: EventFilter.optional()
});

export const UnsubscribeRequest = z.object({
  id: z.string(), op: z.literal('unsubscribe')
});

export const SearchRequest = z.object({
  id: z.string(), op: z.literal('search'), query: z.string(), limit: z.number().int().positive().max(1000).default(20)
});

/**
 * Drive a steering decision through the per-project plugin runtime (spec 12). The daemon itself holds
 * NO harness or workflow knowledge (); it routes this op to an injected `onSteer` handler supplied
 * by the composition layer, which owns the project-scoped runtime map. The fields here are all generic
 * strings/bags — `harness`/`action` carry no embedded harness logic — so this contract stays storage-
 * generic. `cwd` is what the daemon resolves config from per-request (spec 06), keying the runtime.
 */
export const SteerRequest = z.object({
  id: z.string(), op: z.literal('steer'), harness: z.string().min(1), cwd: z.string().min(1), action: z.string().min(1), payload: JsonObject.default({}), ext: JsonObject.optional(),
  // The harness-native session id extracted from the hook payload (e.g. Claude `session_id`).
  // The daemon-side steer-host correlates this to the Sumo ULID via the ses: doc index.
  // Optional: a steer may precede a known session (e.g. pre-SessionStart hooks).
  nativeSessionId: z.string().optional()
});

/**
 * Drive a cross-process session control action through the daemon-hosted orchestrator (). The
 * daemon itself holds no workflow knowledge; it routes this op to an injected `onSession` handler
 * supplied by the composition layer (steer-host). `sessionId` identifies the live session handle;
 * `action` is one of: cancel/send/key/end/spawn/resume. `cwd` is OPTIONAL — the handler resolves
 * the project from the `ses:` doc; the caller may supply it as a fast-path shortcut.
 */
export const SessionRequest = z.object({
  id: z.string(), op: z.literal('session'),
  // Empty string = "no existing session" for spawn/resume actions (no ses: doc to look up yet).
  sessionId: z.string(), action: z.string().min(1), payload: JsonObject.default({}), cwd: z.string().optional()
});

/** Request a graceful daemon shutdown after the control response is flushed. */
export const ShutdownRequest = z.object({
  id: z.string(), op: z.literal('shutdown')
});

/** Any control-channel request, discriminated on `op`. */
export const ControlRequest = z.discriminatedUnion('op', [
AppendRequest, PutRequest,
DelRequest, MergeRequest,
SubscribeRequest, UnsubscribeRequest,
SearchRequest, SteerRequest, SessionRequest, ShutdownRequest
]);

export const SearchHit = z.object({
  docref: z.string(), score: z.number()
});

/** Control-channel error bodies are full serialized `SumoError`s (`sumo/error`'s `ErrorSchema`). */
export const ErrorBody = ErrorSchema;

/**
 * Server → client messages on the control channel: op responses, the **wake-up signal**, and errors.
 * The wake-up carries only the new `seq` (spec 01 §"Delivery model") — the client reads the event
 * itself from its watermark — so there is no payload to buffer for a slow subscriber.
 */
export const ControlResponse = z.union([
z.object({ id: z.string(), ok: z.literal(true), seq: z.number().int().nonnegative(), deduped: z.boolean() }),
z.object({ id: z.string(), ok: z.literal(true), hits: z.array(SearchHit) }),
  // `steer` reply: the runtime's harness-agnostic decision (`{ event }` | `{ deny }`), passed through
  // verbatim from the injected `onSteer` handler (spec 12).
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
z.object({ id: z.string(), ok: z.literal(true) }),
z.object({ id: z.string().nullable(), ok: z.literal(false), error: ErrorBody }),
z.object({ sub: z.string(), seq: z.number().int().nonnegative() })
]);

export const STORAGE_VERSION = 1;
