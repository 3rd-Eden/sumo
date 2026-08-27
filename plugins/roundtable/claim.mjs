/**
 * In-process FCFS file-claim arbitration.
 *
 * All `before('tool')` hooks for a project funnel through the SINGLE steer-host runtime on ONE
 * event loop, so a synchronous check-and-set here (no await before the decision) is atomic by
 * construction — no DB compare-and-set needed.
 *
 * The in-process claim map is the LOCK AUTHORITY. The durable room doc (via `store.merge`) is a
 * display projection written asynchronously after the decision — it may lag, but the lock cannot
 * be wrong because of it.
 *
 * Claim lifecycle:
 *  - Acquired: holder `sessionId` owns the file until release.
 *  - TTL: each claim has a timestamp; the background reaper releases claims silent > `claimTtlMs`.
 *  - Released: on `session.dead`/`session.ended`, on holder moving off the file, or on TTL expiry.
 *
 * @module roundtable/claim
 */

/**
 * @typedef {{ holder: string, since: number }} Claim
 */

/**
 * @typedef {{ ok: true }} ClaimAcquired
 * @typedef {{ ok: false, code: 'SUMO_CLAIM_HELD', reason: string, holder: string, since: number }} ClaimHeld
 * @typedef {{ ok: true, acquired: string[] }} ClaimBatchAcquired
 * @typedef {ClaimHeld & { file: string }} ClaimBatchHeld
 * @typedef {object} ClaimRegistry
 * @property {(file: string, sessionId: string) => ClaimAcquired|ClaimHeld} acquire - Reserve one file for a session when no other holder owns it.
 * @property {(files: string[], sessionId: string) => ClaimBatchAcquired|ClaimBatchHeld} acquireAll - Reserve every requested file or release partial reservations.
 * @property {(file: string, sessionId: string, opts?: { force?: boolean }) => void} release - Drop one claim when the caller owns it or forces cleanup.
 * @property {(sessionId: string) => void} releaseAll - Drop every claim held by one session.
 * @property {(now: number) => Array<{ file: string, holder: string }>} findExpired - List stale claims without mutating the registry.
 * @property {(file: string) => void} expireConfirmed - Remove a claim after the holder is confirmed gone.
 * @property {(sessionId: string) => void} refreshAll - Renew timestamps for every claim held by one session.
 * @property {() => Record<string, Claim>} snapshot - Copy current claims into a durable projection shape.
 */

/**
 * Create a claim registry for one project runtime.
 *
 * @access public
 * @param {{ claimTtlMs: number }} opts - Claim timeout in milliseconds before the reaper probes a holder.
 * @returns {ClaimRegistry} In-memory file-claim registry scoped to the activated project runtime.
 */
export function createClaimRegistry({ claimTtlMs }) {
  /** @type {Map<string, Claim>} canonical file path → claim */
  const claims = new Map();

  /**
   * Attempt to acquire a claim for `file` on behalf of `sessionId`.
   * Synchronous — MUST NOT yield before returning (atomicity by single event loop).
   *
   * @access public
   * @param {string} file - Canonical file path to reserve.
   * @param {string} sessionId - Session attempting to hold the file.
   * @returns {ClaimAcquired|ClaimHeld} Successful reservation or the existing holder blocking it.
   */
  function acquire(file, sessionId) {
    const existing = claims.get(file);
    if (!existing || existing.holder === sessionId) {
      claims.set(file, { holder: sessionId, since: Date.now() });
      return { ok: true };
    }
    return { ok: false, code: 'SUMO_CLAIM_HELD', reason: `held by ${existing.holder}`, holder: existing.holder, since: existing.since };
  }

  /**
   * Attempt to acquire all files at once (all-or-nothing).
   * If any file is held by another session, releases partials and returns the first blocker.
   * Synchronous — MUST NOT yield.
   *
   * @access public
   * @param {string[]} files - Canonical file paths that must be reserved as one batch.
   * @param {string} sessionId - Session attempting to hold every file.
   * @returns {ClaimBatchAcquired|ClaimBatchHeld} Reserved file list or the first blocking holder.
   */
  function acquireAll(files, sessionId) {
    const acquired = [];
    for (const file of files) {
      const result = acquire(file, sessionId);
      if (!result.ok) {
        // Release the ones we just claimed (atomic rollback).
        for (const f of acquired) release(f, sessionId);
        return { ok: false, code: result.code, reason: result.reason, file, holder: result.holder, since: result.since };
      }
      acquired.push(file);
    }
    return { ok: true, acquired };
  }

  /**
   * Release a claim. Only releases if `sessionId` is the current holder (or `force` is set).
   *
   * @access public
   * @param {string} file - Canonical file path to release.
   * @param {string} sessionId - Session expected to own the claim.
   * @param {{ force?: boolean }} opts - Cleanup mode that can bypass the holder check.
   * @returns {void} The claim map is updated in place.
   */
  function release(file, sessionId, { force = false } = {}) {
    const existing = claims.get(file);
    if (existing && (existing.holder === sessionId || force)) {
      claims.delete(file);
    }
  }

  /**
   * Release all claims held by `sessionId` (called on session.dead/session.ended).
   *
   * @access public
   * @param {string} sessionId - Session whose claims should be removed.
   * @returns {void} The registry no longer contains claims for the session.
   */
  function releaseAll(sessionId) {
    for (const [file, claim] of claims) {
      if (claim.holder === sessionId) claims.delete(file);
    }
  }

  /**
   * Find claims whose holder has been silent longer than `claimTtlMs`, WITHOUT removing them.
   * The reaper dispatches probes for each candidate; only `expireConfirmed` actually removes
   * a claim once the holder is confirmed dead (or the probe is skipped for non-drivable sessions).
   *
   * @access public
   * @param {number} now - Millisecond timestamp used to compare claim age.
   * @returns {Array<{ file: string, holder: string }>} Stale claim candidates requiring probe or cleanup.
   */
  function findExpired(now) {
    const expired = [];
    for (const [file, claim] of claims) {
      if (now - claim.since > claimTtlMs) {
        expired.push({ file, holder: claim.holder });
      }
    }
    return expired;
  }

  /**
   * Unconditionally remove a claim (called when a holder is confirmed dead: probe timed out, or
   * non-drivable session passed TTL with no activity). Only `releaseAll` / `release` should
   * be used for known-alive sessions.
   *
   * @access public
   * @param {string} file - Canonical file path whose stale claim should be deleted.
   * @returns {void} The confirmed stale claim is removed from the map.
   */
  function expireConfirmed(file) {
    claims.delete(file);
  }

  /**
   * Refresh the `since` timestamp for all claims held by `sessionId`, resetting the TTL.
   *
   * @access public
   * @param {string} sessionId - Session whose held claims should be renewed.
   * @returns {void} Matching claims keep their holders and receive the current timestamp.
   */
  function refreshAll(sessionId) {
    const now = Date.now();
    for (const [file, claim] of claims) {
      if (claim.holder === sessionId) claims.set(file, { holder: sessionId, since: now });
    }
  }

  /**
   * Snapshot the current claims as a plain object (for room doc writes).
   *
   * @access public
   * @returns {Record<string, Claim>} Plain object keyed by canonical file path.
   */
  function snapshot() {
    /** @type {Record<string, Claim>} */
    const out = {};
    for (const [file, claim] of claims) out[file] = { ...claim };
    return out;
  }

  return { acquire, acquireAll, release, releaseAll, findExpired, expireConfirmed, refreshAll, snapshot };
}
