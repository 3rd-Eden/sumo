/**
 * `sumo/harness` contracts (CONVENTIONS §3): the zod schemas + shared envelope for the harness layer.
 *
 * The harness adapter is the control surface — it spawns a harness, drives it, and turns its live
 * frames into normalized events. The schemas here cover the *control* boundary (a `HarnessAction` the
 * author's `write` interprets, a `SpawnRequest`, the per-session `CapabilitiesSchema` descriptor). The
 * *event* boundary is owned downstream: a parser yields `sumo/transcript`'s `EventSchema`, and the
 * base maps it to `sumo/db`'s `EventInput` before append (see `Harness#event`).
 *
 * The `Result` envelope is defined locally (mirroring `sumo/transcript`'s rationale) so the base does
 * not import the plugin runtime just for a shape — the convention is the shape `{ ok, code, reason }`,
 * not the import source (CONVENTIONS §3b).
 *
 * @module sumo/harness/schema
 */

import { z } from 'zod';
import { ok, fail, isResult, CAP_UNSUPPORTED } from 'sumo/error';

export { CapabilitiesSchema } from 'sumo/session';
export { ok, fail, isResult, CAP_UNSUPPORTED };

/**
 * @template [T=unknown]
 * @typedef {import('sumo/error').Result<T>} Result
 */

/** Stable codes this layer surfaces on operational failure (returned as a failed `Result`). */
export const HarnessErrorCode = z.enum([
  'SUMO_CAP_UNSUPPORTED', // an op the session's `can` reports unsupported
  'SUMO_SPAWN_FAILED', // the harness process/connection failed to start (generic / unclassified)
  'SUMO_VERIFY_FAILED', // install-and-verify self-test did not see its signal in time
  'SUMO_SESSION_DEAD', // an op issued against an ended/dead session
  // Classified failure codes (from classify.mjs — more specific than SUMO_SPAWN_FAILED)
  'SUMO_BACKEND_UNAVAILABLE', // binary not on PATH or not executable
  'SUMO_AUTH_REQUIRED', // not logged in / credentials invalid
  'SUMO_BUDGET_EXHAUSTED', // API credits / billing limit reached
  'SUMO_RATE_LIMITED', // API rate limit exceeded (transient)
  'SUMO_MODEL_NOT_FOUND', // model name is invalid or not available
  'SUMO_OVERLOADED' // backend service temporarily overloaded
]);

/**
 * A Sumo intention the author's `write(action)` turns into a harness effect. `kind` selects the
 * effect; the remaining fields carry its argument. Kept permissive (`passthrough`) so an adapter can
 * carry harness-specific extras without a schema change — `write` is an internal boundary the base
 * calls, not untrusted input.
 *
 * @typedef {{ kind: 'prompt', text: string }
 *   | { kind: 'command', line: string }
 *   | { kind: 'key', name: string }
 *   | { kind: 'raw', bytes: string }} HarnessAction
 */
export const HarnessAction = z
  .object({
    kind: z.enum(['prompt', 'command', 'key', 'raw']), text: z.string().optional(), line: z.string().optional(), name: z.string().optional(), bytes: z.string().optional()
  })
  .passthrough();

/**
 * What `run(prompt, opts)` is asked to launch. `cwd` defaults to the process cwd at spawn; `resume`
 * carries a harness-native session/thread id when continuing a prior session (per-adapter mechanics).
 *
 * @typedef {object} SpawnRequest
 * @property {string} prompt
 * @property {string} [cwd]
 * @property {string} [resume]
 * @property {'default'|'interactive'} [mode] - interactive launches the pipe inside a tmux pane (04)
 */
export const SpawnRequest = z.object({
  prompt: z.string(), cwd: z.string().optional(), resume: z.string().optional(), mode: z.enum(['default', 'interactive']).optional(), model: z.string().optional(), reasoningEffort: z.string().optional()
});

/**
 * What an adapter declares it can do (the authoring-time `can`, distinct from the per-session frozen
 * `CapabilitiesSchema`). These gate the `Session` methods the base binds: a method whose `can` is
 * false returns `{ ok:false, code:'SUMO_CAP_UNSUPPORTED' }` rather than throwing or faking (§3a/§4).
 *
 * @typedef {object} HarnessCan
 * @property {boolean} [stream]      - emits a live frame stream `read()` can normalize
 * @property {boolean} [injectStdin] - accepts prompts/commands written to its input
 * @property {boolean} [hooks]       - supports hook-based steering (spec 12)
 * @property {boolean} [defer]       - supports headless pause/resume (Claude)
 * @property {boolean} [key]         - interactive key injection (pipe + tmux)
 * @property {boolean} [capture]     - raw screen snapshot (pipe + tmux)
 * @property {boolean} [approve]     - server-initiated approval responses (server kind)
 * @property {boolean} [cancel]      - can interrupt the active turn without ending the session
 * @property {boolean} [resume]      - can resume a prior session via opts.resume
 * @property {string[]} [providers]  - underlying model providers this harness serves
 *   (e.g. ['anthropic'] for Claude, ['openai'] for Codex, ['openai','anthropic'] for Cursor).
 *   Used by failover routing to pick a provider-compatible fallback (the reference implementation forProvider pattern).
 *   A harness with providers=['openai','anthropic'] (multi-provider, like Cursor) serves as a
 *   universal fallback for either provider.
 */
