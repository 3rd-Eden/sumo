/**
 * Claude Code acquirer. On-disk transcript: `~/.claude/projects/<enc>/<uuid>.jsonl` (tail + import via
 * the `claude-code` parser's `.file()`). Plans: `~/.claude/plans/*.md` (markdown headings, no
 * frontmatter). Correlation signals come from the in-record `cwd`/`sessionId`/`timestamp`.
 *
 * @module sumo/agent-artifacts/adapters/claude-code
 */

import os from 'node:os';
import path from 'node:path';

import { Artifacts } from '../../base/Artifacts.mjs';

/**
 * @typedef {{ sessionId?: string, cwd?: string, timestamp?: string }} ClaudeArtifactRecord
 * @typedef {{ transcriptPath?: string, records?: ClaudeArtifactRecord[] }} ClaudeSignalsInput
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
 * ClaudeArtifacts implementation.
 *
 * @access public
 * @class
 */ export class ClaudeArtifacts extends Artifacts {
  id = 'claude-code';
  can = { tail: true, import: true };

  /** Plan-file glob (markdown, no frontmatter — summarized by `parse`). */
  planGlob = '~/.claude/plans/*.md';

  /**
   * Transcript root: `$CLAUDE_CONFIG_DIR/projects` (else `~/.claude/projects`) — matches the harness's
   *  own `transcriptPathFor` base, so recorded paths and tail-discovered paths agree.
 *
 * @access public
 * @returns {string|null} Transcript root directory for Claude Code sessions.
  */
  transcriptRoot() {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(base, 'projects');
  }

  /** Config file(s) this harness reads — snapshotted (redacted) at session start. */
  configFiles = ['~/.claude/settings.json'];

  /**
   * Correlation signals from the on-disk records: Claude writes `cwd`/`sessionId`/`timestamp` on each
   * record, so the native id + cwd + time window are read directly.
 *
 * @access public
 * @param {ClaudeSignalsInput} ctx - Transcript records used to derive correlation signals.
 * @returns {Record<string, unknown>} Native id, cwd, and observed time window when available.
  */
  signals({ records = [] } = {}) {
    // sessionId and cwd are NOT guaranteed on the same record — Claude writes `sessionId` from the
    // first record (e.g. a `queue-operation`) but `cwd` only appears on the user/assistant records. So
    // resolve each from the first record that carries it, independently.
    const nativeId = records.find((record) => typeof record.sessionId === 'string')?.sessionId;
    const cwd = records.find((record) => typeof record.cwd === 'string')?.cwd;
    const times = records.map((record) => isoMs(record.timestamp)).filter((n) => n != null);
    return {
      ...(nativeId ? { nativeId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(times.length ? { tsStart: Math.min(...times), tsEnd: Math.max(...times) } : {})
    };
  }
}
