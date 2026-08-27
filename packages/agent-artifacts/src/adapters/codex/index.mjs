/**
 * Codex acquirer. On-disk rollout: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (tail + import via
 * the `codex` parser's `.file()`). The `~/.codex/history.jsonl` index (`{session_id, ts, text}`) is a
 * separate cwd/command index. Correlation signals come from the `session_meta` record.
 *
 * @module sumo/agent-artifacts/adapters/codex
 */

import os from 'node:os';
import path from 'node:path';

import { Artifacts } from '../../base/Artifacts.mjs';

/**
 * @typedef {{ id?: string, cwd?: string }} CodexSessionMeta
 * @typedef {{ type?: string, payload?: CodexSessionMeta, timestamp?: string }} CodexArtifactRecord
 * @typedef {{ transcriptPath?: string, records?: CodexArtifactRecord[] }} CodexSignalsInput
 */

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
 * CodexArtifacts implementation.
 *
 * @access public
 * @class
 */ export class CodexArtifacts extends Artifacts {
  id = 'codex';
  can = { tail: true, import: true };

  /** Config file(s) this harness reads — snapshotted (redacted) at session start. */
  configFiles = ['~/.codex/config.toml'];

  /**
   * Transcript root: `~/.codex/sessions` (the dated `YYYY/MM/DD/rollout-*.jsonl` tree lives under it).
 *
 * @access public
 * @returns {string|null} Transcript root directory for Codex rollout sessions.
  */
  transcriptRoot() {
    return path.join(os.homedir(), '.codex', 'sessions');
  }

  /**
   * Correlation signals from the rollout's `session_meta` record (id + cwd + timestamp); the window
   * spans all dated records.
 *
 * @access public
 * @param {CodexSignalsInput} ctx - Transcript records used to derive correlation signals.
 * @returns {Record<string, unknown>} Native id, cwd, and observed time window when available.
  */
  signals({ records = [] } = {}) {
    const meta = records.find((record) => record.type === 'session_meta')?.payload ?? {};
    const times = records.map((record) => isoMs(record.timestamp)).filter((n) => n != null);
    return {
      ...(meta.id ? { nativeId: meta.id } : {}),
      ...(meta.cwd ? { cwd: meta.cwd } : {}),
      ...(times.length ? { tsStart: Math.min(...times), tsEnd: Math.max(...times) } : {})
    };
  }
}
