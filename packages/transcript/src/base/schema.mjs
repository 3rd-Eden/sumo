/**
 * The `sumo/transcript` output contract (CONVENTIONS §3): the normalized event a parser yields.
 *
 * This is the zod schema at the base's public entry — every event a subclass emits is `.parse()`-ed
 * through it before it leaves the parser. It is a *precursor* to `sumo/db`'s `EventInput`: the field
 * names mirror it (`type`/`payload`/`ext`/`sessionId`/`ts`) so the consumer drops the event straight
 * into `db.append` after computing the required `dedupe` key and stamping `source`. The parser
 * deliberately omits `dedupe` (the consumer/daemon computes it, ) and `source` (the consumer knows
 * whether the event came from the live stream or an on-disk file; omitting it keeps `stream()` and
 * `file()` output identical for the dedup-identity property).
 *
 * @module sumo/transcript/schema
 */

import { z } from 'zod';

/** A JSON object bag (normalized `payload`, adapter-specific `ext`) — mirrors `sumo/db`. */
const JsonObject = z.record(z.string(), z.unknown());

/**
 * The `07` event types a transcript parser actually emits as a *recognized* (normalized) event.
 * Anything else MUST be a `<domain>.raw:<native>` passthrough ( / §3e) — the refinement below
 * enforces that a parser never silently invents a top-level type.
 *
 * This is the EMITTED set, not the whole `07` catalog. `session.plan` and `session.output` are valid
 * `07` types but are intentionally absent: no captured transcript stream contains a plan or
 * raw-output-chunk construct, so the parser does not emit them (capture-first — no unproven mapping).
 * Plan files are ingested by `agent-artifacts` (spec 09), not here. Add a type back here only with a
 * real fixture that exercises it.
 */
export const TYPES = new Set([
  'session.started',
  'session.message',
  'session.tool',
  'session.reasoning',
  'session.ended',
  'session.turn-started',
  'session.approval-requested',
  'session.final-answer',
  'session.child-work-opened',
  'session.child-work-closed'
]);

/** `<domain>.raw:<native>` — the lossless passthrough type for an un-normalized record (07).
 * End-anchored and whitespace-free so the guard can't be slipped a multi-line or malformed type. */
const PASSTHROUGH = /^[a-z][a-z-]*\.raw:\S+$/;

/**
 * @typedef {object} NormalizedEventInput
 * @property {string} type - a `TYPES` member, or a `<domain>.raw:<native>` passthrough.
 * @property {Record<string, unknown>} [payload] - normalized cross-harness fields (empty for passthrough).
 * @property {Record<string, unknown>} [ext] - preserved native source (`ext.native`) + harness specifics.
 * @property {string} [id] - the surfaced natural id for THIS event (block/tool id, else `<recordId>#<i>`).
 * @property {string} [sessionId]
 * @property {number} [ts] - epoch ms, when the native record carries one.
 */

/** The validated normalized event (defaults applied). */
export const EventSchema = z
  .object({
    type: z.string().min(1), payload: JsonObject.default({}), ext: JsonObject.default({}), id: z.string().min(1).optional(), sessionId: z.string().optional(), ts: z.number().int().nonnegative().optional()
  })
  .refine((e) => TYPES.has(e.type) || PASSTHROUGH.test(e.type), {
    message: 'type must be a known 07 type or a <domain>.raw:<native> passthrough', path: ['type']
  });
