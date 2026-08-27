/**
 * Correlation: map an acquired on-disk artifact back to a Sumo session id ().
 *
 * Under spawn-only, the native↔Sumo mapping is a **recorded fact** — the spawn-time writer records the
 * native id / cwd / transcript path on the session document (`ses:<id>`, spec 04). This module is a
 * pure *reader* of those docs (it never writes them). The recorded lookup is the primary path; a
 * `cwd`/project + timestamp-window **heuristic** is the fallback, used only for *foreign* imports —
 * transcripts of sessions Sumo did not spawn (whose docs carry no recorded native id).
 *
 * @module sumo/agent-artifacts/correlate
 */

import { ok, fail, CAP_UNSUPPORTED, AMBIGUOUS, Correlation } from './base/schema.mjs';

/**
 * @typedef {Record<string, unknown> & {
 *   id: string,
 *   harness?: string,
 *   harnessSessionId?: string,
 *   transcriptPath?: string,
 *   cwd?: string,
 *   createdAt?: number,
 *   ext?: { project?: string } & Record<string, unknown>
 * }} SessionDoc
 * @typedef {{ nativeId?: string, cwd?: string, project?: string, tsStart?: number, tsEnd?: number }} CorrelationSignals
 * @typedef {{ harness: string, transcriptPath?: string, signals?: CorrelationSignals }} CorrelateOptions
 */

/**
 * Read every `ses:` document from the daemon.
 *
 * @access private
 * @param {import('sumo/db').SumoDb} db - Client used by `sessionDocs` to read or write Sumo state.
 * @returns {Promise<SessionDoc[]>} Session documents currently stored in the daemon.
 */
async function sessionDocs(db) {
  /** @type {SessionDoc[]} */
  const docs = [];
  for await (const [, doc] of db.scan('ses:')) docs.push(/** @type {SessionDoc} */ (doc));
  return docs;
}

/**
 * Test whether a timestamp is inside the correlation window.
 *
 * @access private
 * @param {number|Date|string|undefined} t - Timestamp from a session document.
 * @param {number|Date|string|undefined} start - Optional lower timestamp bound.
 * @param {number|Date|string|undefined} end - Optional upper timestamp bound.
 * @returns {boolean} True when the timestamp is within the optional bounds.
 */
function inWindow(t, start, end) {
  if (t == null) return false;
  if (start != null && t < start) return false;
  if (end != null && t > end) return false;
  return true;
}

/**
 * Resolve the Sumo session id for an acquired artifact.
 *
 * @access public
 * @param {import('sumo/db').SumoDb} db - Daemon client used to read recorded session documents.
 * @param {CorrelateOptions} opts - Harness identity plus recorded and heuristic correlation signals.
 * @returns {Promise<import('./base/schema.mjs').Result<import('zod').infer<typeof Correlation>>>} Correlated Sumo session id or a failed Result.
 */
export async function correlate(db, { harness, transcriptPath, signals = {} }) {
  const docs = await sessionDocs(db);

  // Recorded (primary): an exact recorded fact wins — native id or transcript path on the session doc.
  // Always scoped to the SAME harness: a Codex import must never match a Claude/Cursor session that
  // happens to share a cwd/path/id (cwd collisions are common — same project dir).
  const recorded = docs.find((d) => d.harness === harness &&
      ((signals.nativeId && d.harnessSessionId === signals.nativeId) ||
        (transcriptPath && d.transcriptPath === transcriptPath)));
  if (recorded) {
    return ok(Correlation.parse({
        sumoId: recorded.id, native: { ...(recorded.harnessSessionId ?? signals.nativeId ? { id: recorded.harnessSessionId ?? signals.nativeId } : {}), harness },
        ...(transcriptPath ? { transcriptPath } : {}), via: 'recorded'
      }));
  }

  // Heuristic (foreign imports only): match on cwd/project within the transcript's time window, and
  // only against docs with NO recorded native id (a spawned session would have matched above).
  const { cwd, project, tsStart, tsEnd, nativeId } = signals;
  if (cwd === undefined && project === undefined) {
    return fail(CAP_UNSUPPORTED, `${harness}: no correlation signal (no recorded mapping; no cwd/project from path or records)`);
  }
  const candidates = docs.filter((d) => d.harness === harness &&
      !d.harnessSessionId &&
      ((cwd !== undefined && d.cwd === cwd) || (project !== undefined && d.ext?.project === project)) &&
      inWindow(d.createdAt, tsStart, tsEnd));
  if (candidates.length === 1) {
    const d = candidates[0];
    return ok(Correlation.parse({
        sumoId: d.id, native: { ...(nativeId ? { id: nativeId } : {}), harness },
        ...(transcriptPath ? { transcriptPath } : {}), via: 'heuristic'
      }));
  }
  if (candidates.length > 1) {
    return fail(AMBIGUOUS, `${harness}: ${candidates.length} candidate sessions match cwd/project within the time window`);
  }
  return fail(CAP_UNSUPPORTED, `${harness}: no session matches the imported transcript (foreign-import correlation found nothing)`);
}
