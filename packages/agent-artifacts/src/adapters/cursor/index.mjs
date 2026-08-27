/**
 * Cursor acquirer. On-disk transcript: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`
 * (tail + import via the `cursor` parser's `.file()`). Plans: `.cursor/plans/*.plan.md` (YAML
 * frontmatter). `transcriptComplete` is **false** — Cursor may omit tool outputs (honored, spec 04).
 *
 * Cursor's on-disk records are bare `{ role, message }` with no cwd/id/timestamp, so correlation
 * signals are read from the **transcript path** (the `<id>` is the session id; `<slug>` the project).
 *
 * @module sumo/agent-artifacts/adapters/cursor
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { Artifacts } from '../../base/Artifacts.mjs';

const PATH_RE = /\/projects\/([^/]+)\/agent-transcripts\/([^/]+)\//;

/**
 * @typedef {{ transcriptPath?: string, records?: Record<string, unknown>[] }} CursorSignalsInput
 */

/**
 * Recover the real cwd from a Cursor project `<slug>`. The slug IS the cwd with every run of
 * non-alphanumerics collapsed to `-` (e.g. `private-tmp` → `/private/tmp`), but the encoding is LOSSY:
 * a `-` may be a path separator OR a literal hyphen in a segment name (`sumo-cursor-cap-9623` is one
 * dir, not four). So decode by greedy longest-existing-prefix on disk: at each position, take the
 * longest run of `-`-joined tokens that names an existing directory, then continue from there. Returns
 * `undefined` for slugs that are not paths (numeric window ids, `empty-window`) or that no longer exist
 * on disk (deleted project) — the caller then skips scoping, which is the safe default.
 *
 * @access public
 * @param {string} slug - Slug supplied to `decodeCursorSlug`.
 * @returns {string|undefined} String undefined returned by `decodeCursorSlug`.
 */
export function decodeCursorSlug(slug) {
  if (!slug || /^\d+$/.test(slug) || slug === 'empty-window') return undefined;
  const tokens = slug.split('-');
  let dir = '';
  let i = 0;
  while (i < tokens.length) {
    let matchedTo = -1;
    let matchedPath = '';
    for (let j = i; j < tokens.length; j++) {
      const candidate = `${dir}/${tokens.slice(i, j + 1).join('-')}`;
      let isDir = false;
      try { isDir = fs.statSync(candidate).isDirectory(); } catch { isDir = false; }
      if (isDir) { matchedTo = j; matchedPath = candidate; } // keep the LONGEST existing prefix
    }
    if (matchedTo === -1) return undefined; // this segment resolves to nothing on disk → unscopeable
    dir = matchedPath;
    i = matchedTo + 1;
  }
  return dir || undefined;
}

/**
 * CursorArtifacts implementation.
 *
 * @access public
 * @class
 */
export class CursorArtifacts extends Artifacts {
  id = 'cursor';
  can = { tail: true, import: true };
  transcriptComplete = false;

  /** Plan-file glob (YAML frontmatter — summarized by `parse`). */
  planGlob = '.cursor/plans/*.plan.md';

  /** Config file(s) this harness reads — snapshotted (redacted) at session start. */
  configFiles = ['~/.cursor/cli-config.json'];

  /**
   * Transcript root: `~/.cursor/projects` (the `<slug>/agent-transcripts/<id>/<id>.jsonl` tree).
  *
  * @access public
   * @returns {string|null} Transcript root directory for Cursor session files.
   */
  transcriptRoot() {
    return path.join(os.homedir(), '.cursor', 'projects');
  }

  /**
   * Correlation signals from the path (records carry none): `<id>` → native session id, `<slug>` →
   * project. No in-record timestamps, so the time window is left open (cwd/project match carries it).
  *
  * @access public
   * @param {CursorSignalsInput} ctx - Transcript path used to derive correlation signals.
   * @returns {Record<string, unknown>} Native id, project slug, and decoded cwd when available.
   */
  signals({ transcriptPath } = {}) {
    const m = transcriptPath ? PATH_RE.exec(transcriptPath) : null;
    if (!m) return {};
    // The `<slug>` is the cwd path-encoded; decode it on disk so foreign Cursor sessions can be
    // project-scoped like Claude/Codex (whose records carry cwd directly).
    const cwd = decodeCursorSlug(m[1]);
    return { project: m[1], nativeId: m[2], ...(cwd ? { cwd } : {}) };
  }
}
