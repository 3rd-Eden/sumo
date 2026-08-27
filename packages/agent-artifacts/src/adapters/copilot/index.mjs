/**
 * Copilot acquirer. On-disk transcript: `$COPILOT_HOME/session-state/<sessionId>/events.jsonl`,
 * else `~/.copilot/session-state/<sessionId>/events.jsonl`
 * (tail + import via the `copilot` parser's `.file()`). Plans live alongside the transcript as
 * `plan.md`, and `workspace.yaml` in the same directory carries cwd/repo/session metadata that helps
 * correlation when the live harness has not already recorded the `ses:` doc.
 *
 * @module sumo/agent-artifacts/adapters/copilot
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { Artifacts } from '../../base/Artifacts.mjs';

/**
 * @typedef {{ created_at?: string, updated_at?: string, id?: string, cwd?: string }} CopilotWorkspace
 * @typedef {{ sessionId?: string, context?: { cwd?: string } }} CopilotStartData
 * @typedef {{ type?: string, data?: CopilotStartData, timestamp?: string }} CopilotArtifactRecord
 * @typedef {{ transcriptPath?: string, records?: CopilotArtifactRecord[] }} CopilotSignalsInput
 */

/**
 * Resolve the Copilot state/config home used by the CLI.
 *
 * @access private
 * @returns {string} String returned by `copilotHome`.
 */
function copilotHome() {
  return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

/**
 * Parse an ISO timestamp to epoch milliseconds.
 *
 * @access private
 * @param {unknown} iso - Iso supplied to `isoMs`.
 * @returns {number|undefined} Number undefined returned by `isoMs`.
 */
function isoMs(iso) {
  const n = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Read the sibling `workspace.yaml` next to a Copilot `events.jsonl`. Returns `{}` on missing/invalid.
 *
 * @access private
 * @param {string|undefined} transcriptPath - Transcript path supplied to `readWorkspace`.
 * @returns {Record<string, unknown>} Structured output from `readWorkspace`.
 */
function readWorkspace(transcriptPath) {
  if (!transcriptPath) return {};
  const workspace = path.join(path.dirname(transcriptPath), 'workspace.yaml');
  try {
    return /** @type {CopilotWorkspace} */ (parseYaml(fs.readFileSync(workspace, 'utf8')) ?? {});
  } catch {
    return {};
  }
}

/**
 * Copilot artifact acquirer for persisted session-state files.
 *
 * @access public
 * @class
 * @augments {Artifacts}
 */
export class CopilotArtifacts extends Artifacts {
  /** @type {'copilot'} Artifact adapter id. */
  id = 'copilot';
  /** @type {{ tail: true, import: true }} Capabilities backed by real Copilot session-state files. */
  can = { tail: true, import: true };

  /**
   * Plan-file glob: one optional `plan.md` per session-state directory.
   *
  * @access public
   * @returns {string} Glob pointing at Copilot session plan files.
   */
  get planGlob() {
    return path.join(copilotHome(), 'session-state', '*', 'plan.md');
  }

  /**
   * Config file(s) this harness reads — snapshotted (redacted) at session start.
  *
  * @access public
   * @returns {string[]} Config files that should be snapshotted for Copilot sessions.
   */
  get configFiles() {
    return [path.join(copilotHome(), 'config.json')];
  }

  /**
   * Transcript root: `$COPILOT_HOME/session-state`, else `~/.copilot/session-state`.
   *
   * @access public
   * @returns {string} String returned by `transcriptRoot`.
   */
  transcriptRoot() {
    return path.join(copilotHome(), 'session-state');
  }

  /**
   * Correlation signals from the transcript head + sibling workspace metadata:
   * - `session.start.data.sessionId` / session-dir name → native id
   * - `session.start.data.context.cwd` or `workspace.yaml#cwd` → cwd
   * - event timestamps / `workspace.yaml.created_at`+`updated_at` → time window
   *
  * @access public
   * @param {CopilotSignalsInput} ctx - Transcript head and sibling workspace metadata.
   * @returns {{ nativeId?: string, cwd?: string, tsStart?: number, tsEnd?: number }} Structured output from `signals`.
   */
  signals({ transcriptPath, records = [] } = {}) {
    const workspace = readWorkspace(transcriptPath);
    const start = records.find((record) => record.type === 'session.start')?.data ?? {};
    const context = start.context ?? {};
    const times = records.map((record) => isoMs(record.timestamp)).filter((n) => n != null);
    const dirId = transcriptPath ? path.basename(path.dirname(transcriptPath)) : undefined;
    const wsCreated = isoMs(workspace.created_at);
    const wsUpdated = isoMs(workspace.updated_at);
    const tsStart = times.length ? Math.min(...times) : wsCreated;
    const tsEnd = times.length ? Math.max(...times) : wsUpdated;
    const nativeId = typeof start.sessionId === 'string'
      ? start.sessionId
      : typeof workspace.id === 'string'
        ? workspace.id
        : dirId;
    const cwd = typeof context.cwd === 'string'
      ? context.cwd
      : typeof workspace.cwd === 'string'
        ? workspace.cwd
        : undefined;
    return {
      ...(nativeId ? { nativeId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(tsStart != null ? { tsStart } : {}),
      ...(tsEnd != null ? { tsEnd } : {})
    };
  }
}
