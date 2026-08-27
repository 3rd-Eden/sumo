/**
 * Filesystem locations for the global daemon (one daemon + DB at `~/.sumo`, scope: project — the
 * locked decision). Files under the home are owner-only: dir `0700`, sockets/files `0600` (§12).
 * @module sumo/db/paths
 */

import path from 'node:path';
import fs from 'node:fs';
import { sumoHome as configuredSumoHome } from 'sumo/config';
import { SumoError } from './errors.mjs';

/**
 * @typedef {{ home: string, db: string, kvSock: string, ctlSock: string, pid: string }} DaemonPaths
 */

/**
 * Resolve all daemon paths under a home directory.
 *
 * @access public
 * @param {string} home - Filesystem location used by `paths`.
 * @param {{ dbPath?: string, socket?: string }} [opts] - Explicit storage/socket overrides.
 * @returns {DaemonPaths} Canonical database, socket, and pidfile paths under the Sumo home.
 */
export function paths(home = configuredSumoHome(), opts = {}) {
 const kvSock = opts.socket ?? path.join(home, 'sumo.sock');
 const ctlSock = kvSock.endsWith('.sock') ? `${kvSock.slice(0, -'.sock'.length)}-ctl.sock`: `${kvSock}.ctl`;
 return {
 home, db: (opts.dbPath ?? process.env.SUMO_DB) || path.join(home, 'db'), kvSock, ctlSock, pid: path.join(home, 'sumo.pid')
 };
}

/**
 * Ensure the home directory exists with mode `0700` (tightening it if it pre-existed looser).
 *
 * @access public
 * @param {string} home - Filesystem location used by `ensureHome`.
 * @returns {string} String returned by `ensureHome`.
 */
export function ensureHome(home = configuredSumoHome()) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  return home;
}

/**
 * Tighten a file (socket or pidfile) to owner-only `0600`. This is a security property the spec
 * mandates (§12), so a failure to apply it is a HARD error — we never leave a world/group-readable
 * artifact in place silently. macOS and Linux (the supported platforms, ) both chmod unix sockets.
 *
 * @access public
 * @param {string} target - Target supplied to `securePath`.
 * @returns {void} Completes without producing a value.
 */
export function securePath(target) {
  try {
    fs.chmodSync(target, 0o600);
  } catch (err) {
    throw new SumoError({ name: 'db', method: 'securePath', code: 'SUMO_INSECURE_PERMS', message: 'could not set mode 0600 on {target}', vars: { target }, cause: err });
  }
}
