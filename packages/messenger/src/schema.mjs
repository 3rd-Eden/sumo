/**
 * `sumo/messenger` contracts (CONVENTIONS §3): the zod schemas + shared envelope for the messenger
 * layer. A messenger adapter is the work surface — it pulls items in from a medium (`*work()`, the
 * named `read`/ingest) and posts effects back (`say`/`mark`/`status`/`review`, the named `write`
 * variants). The schemas here cover that boundary: a raw `WorkSchema` an adapter yields (which the base
 * normalizes into the consumer `Work` object, owned by `sumo/plugin`), the authoring-time `can`, and
 * the `ClaimResult` the inherited claim lifecycle returns.
 *
 * The `Result` envelope is defined locally (mirroring `sumo/harness`'s rationale) so the base does not
 * import the plugin runtime just for a shape — the convention is the shape `{ ok, code, reason }`, not
 * the import source (CONVENTIONS §3b).
 *
 * @module sumo/messenger/schema
 */

import { z } from 'zod';
import { ok, fail, isResult, CAP_UNSUPPORTED } from 'sumo/error';

export { ok, fail, isResult, CAP_UNSUPPORTED };

/**
 * @template [T=unknown]
 * @typedef {import('sumo/error').Result<T>} Result
 */

/** Stable codes this layer surfaces on operational failure (returned as a failed `Result`). */
export const ErrorSchema = z.enum([
  'SUMO_CAP_UNSUPPORTED', // an optional primitive the adapter's `can` reports unsupported
  'SUMO_CLAIM_HELD', // the work is already claimed by another (fresh, non-stale) agent
  'SUMO_CLAIM_LOST', // read-after-write showed another agent is the active claimant (lost the race)
  'SUMO_MEDIUM_ERROR' // the medium (e.g. the `gh` CLI / GitHub API) failed an operation
]);

/**
 * A RAW item an adapter's `*work()` yields (ingress). The base validates it, mints a stable Sumo work
 * id, and builds the consumer `Work` object (the `sumo/plugin` typedef) with bound methods. Kept to
 * the normalized common fields + an `ext` bag for adapter-specific data (CONVENTIONS §3b aligned #3:
 * same envelope as harness events, distinct payload type — divergent #2). `externalId` is the medium's
 * own stable identifier (e.g. `acme/widgets#42`), used to derive a deterministic Sumo work id so
 * re-ingesting the same item is idempotent.
 *
 * @typedef {object} WorkSchema
 * @property {string} externalId       - the medium's stable id for this item
 * @property {string} [title]
 * @property {string} [body]
 * @property {string} [kind]           - adapter-classified kind hint (e.g. 'task'|'planning'); kept in `ext`
 * @property {string} [cwd]            - working-dir hint, if the adapter knows it
 * @property {Record<string, unknown>} [ext] - adapter-specific preserved fields
 */
export const WorkSchema = z
  .object({
    externalId: z.string().min(1), title: z.string().optional(), body: z.string().optional(), kind: z.string().optional(), cwd: z.string().optional(), ext: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough();

/**
 * What an adapter declares it can do (the authoring-time `can`, surfaced to the consumer as
 * `work.can.*`). A primitive whose flag is false degrades to `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }`
 * rather than throwing or faking (§3a/§4).
 *
 * @typedef {object} MessengerCan
 * @property {boolean} [reply]       - post a message back to the item's thread (`say`)
 * @property {boolean} [claim]       - coordinate a claim (`mark` + the inherited lifecycle)
 * @property {boolean} [status]      - publish progress
 * @property {boolean} [review]      - publish a review result
 * @property {boolean} [react]       - react with an emoji/reaction
 * @property {boolean} [distributed] - the medium is shared across machines → proof-of-life plumbing active ()
 */

/**
 * The normalized claim state an adapter's `mark(ref)` read returns (or `undefined` when unclaimed).
 * The base treats it as opaque — it never computes claim history or expiry itself; the adapter owns
 * "who holds it" and "is it stale" so the base stays medium-agnostic.
 *
 * @typedef {object} ClaimState
 * @property {string} agent     - the agent that holds the (last active) claim
 * @property {number} [ts]      - the medium's server timestamp of the claim (ms), for staleness
 * @property {boolean} [stale]  - true when the claim is older than the TTL and thus reclaimable
 * @property {Record<string, unknown>} [ext] - adapter-specific claim detail (e.g. the marker comment id)
 */

/**
 * The result of the inherited `claim(ref, agent)` — the shared `Result` plus a `heldBy` when the claim
 * did not succeed (so a consumer can see who holds it).
 *
 * @typedef {{ ok: true, value: { ref: object } }
 *   | { ok: false, code: string, reason: string, heldBy?: string }} ClaimResult
 */
