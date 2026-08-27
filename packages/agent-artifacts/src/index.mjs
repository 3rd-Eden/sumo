/**
 * `sumo/agent-artifacts` — the on-disk acquisition + correlation layer (spec 09).
 *
 * It acquires harness artifacts from the filesystem (live tail / completed import / export), delegates
 * parsing to `sumo/transcript`, and appends normalized events to the daemon with a `dedupe` key
 * computed identically to the live harness source (so the two collapse, ). It also correlates
 * native artifacts back to Sumo session ids, and ingests plans/config snapshots as linked summaries.
 *
 * A pure sensor (§3c): it acquires + appends; it does not parse formats (§3d) or dedupe/merge ().
 * The `adapters` registry is keyed by harness id, mirroring `sumo/transcript`'s `adapters`.
 *
 * @module sumo/agent-artifacts
 */

export { Artifacts } from './base/Artifacts.mjs';
export { ok, fail, isResult, CAP_UNSUPPORTED, AMBIGUOUS, Correlation, AcquireSummary, ArtifactRef } from './base/schema.mjs';
export { correlate } from './correlate.mjs';
export { plan, parse } from './plan.mjs';
export { snapshot } from './snapshot.mjs';
export { tail } from './tail.mjs';
export { watcher } from './ingest-service.mjs';

import { ClaudeArtifacts } from './adapters/claude-code/index.mjs';
import { CopilotArtifacts } from './adapters/copilot/index.mjs';
import { CodexArtifacts } from './adapters/codex/index.mjs';
import { CursorArtifacts } from './adapters/cursor/index.mjs';
import { OpenCodeArtifacts } from './adapters/opencode/index.mjs';

export { ClaudeArtifacts, CopilotArtifacts, CodexArtifacts, CursorArtifacts, OpenCodeArtifacts };

/**
 * The acquirer registry, keyed by harness id. Values are classes; instantiate per harness.
 * @type {Record<string, new () => import('./base/Artifacts.mjs').Artifacts>}
 */
export const adapters = {
  'claude-code': ClaudeArtifacts,
  copilot: CopilotArtifacts,
  codex: CodexArtifacts,
  cursor: /** @type {new () => import('./base/Artifacts.mjs').Artifacts} */ (CursorArtifacts),
  opencode: /** @type {new () => import('./base/Artifacts.mjs').Artifacts} */ (OpenCodeArtifacts)
};
