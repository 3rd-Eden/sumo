/**
 * Orchestrator contracts: the shared `Result` shape (defined locally per the §3b convention — the
 * convention is the shape, not the import source) and the orchestrator's own config schema with the
 * spec-10 defaults. The orchestrator validates its OWN config; surfacing it through the global
 * `sumo/config` block is a separate wiring step.
 *
 * @module sumo/orchestrator/schema
 */
import { z } from 'zod';
import { ok, fail, isResult, CAP_UNSUPPORTED } from 'sumo/error';

export { ok, fail, isResult, CAP_UNSUPPORTED };

/**
 * @template [T=unknown]
 * @typedef {import('sumo/error').Result<T>} Result
 */

/**
 * Silence thresholds (ms) escalate idle → stall: a session goes `idle` after a short quiet, then
 * `stalled` after a long quiet (the actionable nudge→reap trigger).
 */
const Timeouts = z.object({
  idle: z.number().int().positive().default(120_000), // 2m — soft "agent is quiet" signal
  stall: z.number().int().positive().default(600_000), // 10m — actionable: nudge → shutdown → reap
  shutdown: z.number().int().positive().default(60_000), // 1m — grace after nudge before forced end
  rapidDeath: z.number().int().positive().default(15_000), // 15s — startup-crash window → breaker
  nudge: z.boolean().default(true) // tier-1 stall nudge before reap
});

const Rate = z.object({
  windowMs: z.number().int().positive().default(60_000), max: z.number().int().positive().default(30) // spawns per window (global; also per-plugin)
});

const Guards = z.object({
  maxAgents: z.number().int().positive().default(8), // concurrent live sessions
  maxRounds: z.number().int().positive().default(7), // spawns per spawnKey loop budget
  rapidDeathThreshold: z.number().int().positive().default(3), // consecutive rapid deaths → trip
  rate: Rate.default(Rate.parse({}))
});

// `.default({})` substitutes the literal `{}` (skipping inner field defaults), so each nested default
// is the schema parsed against `{}` — the fully-populated object.
export const OrchestratorConfig = z
  .object({
    timeouts: Timeouts.default(Timeouts.parse({})), guards: Guards.default(Guards.parse({})),
    // Ordered fallback harness ids tried when the requested harness fails with a fallback-eligible code.
    // An empty list disables automatic failover. Populated from `harness.fallback` in sumo.yml or
    // auto-derived from the registered adapters by the caller.
    fallback: z.array(z.string()).default([])
  })
  .default(() => ({ timeouts: Timeouts.parse({}), guards: Guards.parse({}), fallback: [] }));
