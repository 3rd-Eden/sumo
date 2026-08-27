/**
 * Extract canonical target file paths from a normalized tool steer event.
 *
 * Canonical means: `caseFold(path.resolve(repoRoot, raw))` so relative/absolute/`..`/symlink
 * forms of the same file all collapse to one key. `caseFold` is applied only on case-insensitive
 * filesystems (darwin default APFS) to avoid false-collisions on case-sensitive Linux.
 *
 * New files don't exist on disk yet, so `fs.realpath` is skipped; we resolve + normalize without
 * following the link. Symlinks that exist are NOT followed here — following would create a hidden
 * dependency on the symlink target's claim, which is confusing and rarely right.
 *
 * Bash heuristics: `mv A B` (claim both), `cp A B` (claim B — destination), `rm A` (claim A),
 * redirect `> B` (claim B). Conservative: unknown Bash patterns produce no files rather than a
 * false claim, which is the safer degradation.
 *
 * @module roundtable/files
 */

import path from 'node:path';
import os from 'node:os';

const IS_DARWIN = os.platform() === 'darwin';

/**
 * Case-fold a path on case-insensitive FS (darwin), leave it alone on Linux.
 *
 * @access private
 * @param {string} p - P supplied to `caseFold`.
 * @returns {string} String returned by `caseFold`.
 */
function caseFold(p) {
  return IS_DARWIN ? p.toLowerCase() : p;
}

/**
 * Resolve and canonicalize one raw path string relative to `repoRoot`.
 *
 * @access private
 * @param {string} raw - Raw consumed by `canonicalize`.
 * @param {string} repoRoot - Repo root supplied to `canonicalize`.
 * @returns {string} String returned by `canonicalize`.
 */
function canonicalize(raw, repoRoot) {
  return caseFold(path.resolve(repoRoot, raw));
}

/**
 * Extract canonical write-class target paths from a normalized `tool` steer event.
 * Returns an empty array for unknown tools or tools that don't touch the filesystem.
 *
 * @access public
 * @param {{ payload: { tool?: { name?: string, input?: unknown } } }} event - the SteerEvent
 * @param {string} repoRoot - the project working directory (from steer request `cwd`)
 * @returns {string[]} List produced by `extractFiles`.
 */
export function extractFiles(event, repoRoot) {
  const tool = event?.payload?.tool;
  if (!tool || typeof tool.name !== 'string') return [];
  const { name, input } = tool;
  const data = /** @type {Record<string, unknown>} */ (input);
  const root = repoRoot ?? process.cwd();

  // Edit / Write / NotebookEdit: single `file_path` or `path` input field.
  if (name === 'Edit' || name === 'Write' || name === 'str_replace_editor' ||
      name === 'NotebookEdit' || name === 'str_replace_based_edit_tool') {
    const p = data?.file_path ?? data?.path;
    return typeof p === 'string' ? [canonicalize(p, root)] : [];
  }

  // MultiEdit: array of `{ file_path, ... }` objects.
  if (name === 'MultiEdit' || name === 'multi_edit') {
    const edits = data?.edits;
    if (!Array.isArray(edits)) return [];
    return edits
      .map((e) => e?.file_path ?? e?.path)
      .filter((p) => typeof p === 'string')
      .map((p) => canonicalize(p, root));
  }

  // Bash: conservative heuristics for the most common write patterns.
  if (name === 'Bash' || name === 'bash' || name === 'computer' || name === 'run_terminal_cmd') {
    const cmd = typeof input === 'string' ? input : data?.command ?? data?.cmd ?? '';
    if (typeof cmd !== 'string') return [];
    return extractBashFiles(cmd, root);
  }

  return [];
}

/**
 * Heuristic extraction of write-class paths from a Bash command string.
 * Conservative: returns [] rather than guessing when the pattern is ambiguous.
 *
 * @access private
 * @param {string} cmd - Cmd supplied to `extractBashFiles`.
 * @param {string} root - Root supplied to `extractBashFiles`.
 * @returns {string[]} List produced by `extractBashFiles`.
 */
function extractBashFiles(cmd, root) {
  const results = new Set();

  // stdout redirect: `... > /path/to/file`
  for (const m of cmd.matchAll(/>\s*([^\s|&;><]+)/g)) {
    results.add(canonicalize(m[1], root));
  }

  // mv src dest — claim both
  const mv = cmd.match(/^\s*mv\s+\S+\s+(\S+)/);
  if (mv) {
    const parts = cmd.trim().replace(/^mv\s+/, '').split(/\s+/);
    if (parts.length === 2) {
      results.add(canonicalize(parts[0], root));
      results.add(canonicalize(parts[1], root));
    }
  }

  // cp src dest — claim destination only (src is read, not written)
  const cp = cmd.match(/^\s*cp\s+(?:-\S+\s+)*(\S+)\s+(\S+)/);
  if (cp) results.add(canonicalize(cp[2], root));

  // rm path(s)
  const rm = cmd.match(/^\s*rm\s+(?:-\S+\s+)*(.+)/);
  if (rm) {
    for (const tok of rm[1].split(/\s+/).filter(Boolean)) {
      if (!tok.startsWith('-')) results.add(canonicalize(tok, root));
    }
  }

  return [...results];
}
