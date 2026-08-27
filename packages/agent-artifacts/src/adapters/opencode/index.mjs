/**
 * OpenCode acquirer. OpenCode has no on-disk JSONL (SQLite store), so there is **no live tail** —
 * `can.tail` is false. Acquisition is **import only**, from an export of SSE-shaped event records; the
 * base feeds them through the parser's `.stream()` entry (OpenCode's parser is `file:false`, so the
 * inherited `entry` getter already returns `'stream'`).
 *
 * Caveat (capture gap): the committed fixtures are SSE *bus events*; a real `opencode export` payload
 * has not been captured, so the export shape is replay-proven only for SSE-shaped records.
 *
 * @module sumo/agent-artifacts/adapters/opencode
 */

import { Artifacts } from '../../base/Artifacts.mjs';

/**
 * @typedef {{ id?: string, directory?: string }} OpenCodeSessionInfo
 * @typedef {{ type?: string, properties?: { info?: OpenCodeSessionInfo } }} OpenCodeArtifactRecord
 * @typedef {{ transcriptPath?: string, records?: OpenCodeArtifactRecord[] }} OpenCodeSignalsInput
 */

/**
 * OpenCodeArtifacts implementation.
 *
 * @access public
 * @class
 */
export class OpenCodeArtifacts extends Artifacts {
  id = 'opencode';
  can = { tail: false, import: true };

  /** Config file(s) this harness reads — snapshotted (redacted) at session start. */
  configFiles = ['~/.config/opencode/opencode.jsonc', '~/.opencode/opencode.jsonc'];

  /**
   * Correlation signals from the export's `session.created` event (`properties.info`): id + directory.
  *
  * @access public
   * @param {OpenCodeSignalsInput} ctx - Export records used to derive correlation signals.
   * @returns {Record<string, unknown>} Native id and cwd when present in the export metadata.
   */
  signals({ records = [] } = {}) {
    const info = records.find((record) => record.type === 'session.created')?.properties?.info ?? {};
    return {
      ...(info.id ? { nativeId: info.id } : {}),
      ...(info.directory ? { cwd: info.directory } : {})
    };
  }
}
