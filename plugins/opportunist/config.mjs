/**
 * Configuration and command-input schemas for `opportunist`.
 *
 * @module sumo/plugins/opportunist/config
 */
import { z } from 'zod';
import { RESOLUTION_STATUSES } from './prompt.mjs';

/** Portable model tiers accepted by Sumo's harness model resolver. */
export const MODEL_TIERS = Object.freeze(['fast', 'balanced', 'powerful']);

/** Minimal plugin config. */
export const OpportunistConfig = z.object({
  enabled: z.boolean().default(true),
  harness: z.string().min(1).nullable().default(null),
  tier: z.enum(MODEL_TIERS).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  prompts: z.object({
    triage: z.string().min(1).nullable().default(null),
    repair: z.string().min(1).nullable().default(null)
  }).default({ triage: null, repair: null })
});

/** Input schema for `opportunist-findings`. */
export const FindingsInput = z.object({
  state: z.enum(['open', 'running', 'resolved']).optional(),
  sessionId: z.string().optional()
});

/** Input schema for `opportunist-resolve`. */
export const ResolveInput = z.object({
  id: z.string().min(1),
  status: z.enum(RESOLUTION_STATUSES),
  evidence: z.string().min(1)
});
