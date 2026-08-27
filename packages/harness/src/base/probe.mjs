/**
 * Lightweight binary availability probes for harness adapters.
 *
 * Two-phase check that separates "binary on PATH" from "binary is alive" by running a real version
 * probe without a shell.
 *
 * These probes are intentionally cheap and non-blocking: a 5-second timeout prevents an unresponsive
 * binary from hanging the caller. Probe results are not cached — callers decide on caching policy.
 *
 * @module sumo/harness/base/probe
 */

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

const DEFAULT_VERSION_ARGS = ['--version'];
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Synchronously check whether a binary name resolves to an executable on PATH.
 * Generalizes Cursor's `resolveCursorBin` pattern (`cursor.mjs:29-40`) to any binary.
 *
 * @access public
 * @param {string} name - binary name (no path separators)
 * @returns {string|null} String null returned by `whichSync`.
 */
export function whichSync(name) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      const full = path.join(dir, name);
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // not on this PATH entry
    }
  }
  return null;
}

/**
 * Spawn a command, collect stdout+stderr, resolve with `{ code, out }` on exit or timeout kill.
 * Used by harness `available()` implementations for auth/status probes that must not hang.
 *
 * @access public
 * @param {string} bin - Bin supplied to `spawnCollect`.
 * @param {string[]} args - Argument object accepted by `spawnCollect`.
 * @param {number} timeoutMs - Timeout ms numeric value used by `spawnCollect`.
 * @returns {Promise<{ code: number|null, out: string }>} Promise resolving to the `spawnCollect` result.
 */
export function spawnCollect(bin, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let out = '';
    let proc;
    try { proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve({ code: 1, out: '' }); }
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });

    /**
     * Resolve the collection promise once the child exits, errors, or times out.
     *
     * @access public
     * @param {number|null} code - Code used in the generated output.
     * @returns {void} Completes without producing a value.
     */
    function done(code) {
      clearTimeout(t);
      resolve({ code, out });
    }
    proc.on('close', done);
    proc.on('error', () => done(1));
    const t = setTimeout(() => { proc.kill(); done(null); }, timeoutMs);
  });
}

/**
 * Probe a binary: check it is on PATH, then run a version smoke test to verify it actually works.
 * Returns the parsed version string if successful.
 * A stale shim or broken installation may be on PATH but fail at runtime. The `--version` call is the
 * cheapest live check.
 *
 * @access public
 * @param {string} bin - binary name or absolute path
 * @param {{ versionArgs?: string[], timeoutMs?: number }} opts - Options read by this operation.
 * @returns {Promise<{ available: boolean, version: string|null, reason?: string }>} Promise resolving to the `probeBinary` result.
 */
export async function probeBinary(bin, { versionArgs = DEFAULT_VERSION_ARGS, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  // Phase 1: is the binary on PATH?
  const resolved = bin.includes('/') ? bin : (whichSync(bin) ?? null);
  if (!resolved) {
    return { available: false, version: null, reason: `binary '${bin}' not found on PATH` };
  }

  // Phase 2: verify that the resolved binary can execute.
  return new Promise((resolve) => {
    execFile(resolved, versionArgs, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // Any execution failure becomes an unavailable result rather than escaping the probe.
        return resolve({ available: false, version: null, reason: err.message });
      }
      const out = (stdout || stderr || '').trim().split('\n')[0];
      resolve({ available: true, version: out || null });
    });
  });
}
