/**
 * Zod contracts + the shared outcome envelope for `sumo/agent-artifacts` (CONVENTIONS §3/§3b).
 *
 * This layer is a sensor: it acquires on-disk artifacts, delegates parsing to `sumo/transcript`, and
 * appends to the daemon. The schemas here describe the small surface this layer owns — the artifact
 * reference it links, the correlation result, and the acquire summary — not the event vocabulary
 * (that is `07`, owned by `sumo/db`'s `EventInput`).
 *
 * @module sumo/agent-artifacts/base/schema
 */

import { z } from 'zod';
import { ok, fail, isResult, CAP_UNSUPPORTED } from 'sumo/error';

export { ok, fail, isResult, CAP_UNSUPPORTED };

/**
 * The shared outcome envelope (CONVENTIONS §3b aligned #1). Defined locally — the convention is the
 * *shape* `{ ok:false, code, reason }`, not the import source (matches `sumo/transcript`'s base).
 *
 * @template [T=unknown]
 * @typedef {import('sumo/error').Result<T>} Result
 */

/** Returned by correlation when the heuristic finds more than one candidate session (never guesses). */
export const AMBIGUOUS = 'SUMO_AMBIGUOUS';

/** A correlation result: how an acquired artifact maps back to a Sumo session id (). */
export const Correlation = z.object({
  sumoId: z.string(), native: z.object({ id: z.string().optional(), harness: z.string() }), transcriptPath: z.string().optional(), via: z.enum(['recorded', 'heuristic'])
});

/** A summary of one acquire (import or a tail batch): what reached the daemon. */
export const AcquireSummary = z.object({
  harness: z.string(), sessionId: z.string().optional(), count: z.number().int().nonnegative(), transcriptComplete: z.boolean()
});

/** The link+summary a plan/config artifact is reduced to (large-file rule, spec 09 — never copied). */
export const ArtifactRef = z.object({
  kind: z.enum(['plan', 'config']), path: z.string().optional(), rawRef: z.string().optional(), summary: z.record(z.string(), z.unknown()).default({})
});
