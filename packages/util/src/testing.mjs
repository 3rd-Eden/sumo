/**
 * Shared test and script helpers for Sumo's real-daemon test paths.
 *
 * Production code imports `sumo/util`; tests and one-off verification scripts may import this module.
 *
 * @module sumo/util/testing
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open } from 'sumo/db';
export { sleep } from './index.mjs';

/**
 * Create a fresh temporary directory under the OS temp root.
 *
 * @access public
 * @param {string} prefix - Prefix used by `tempDir`.
 * @returns {string} String returned by `tempDir`.
 */
export function tempDir(prefix = 'sumo-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Open an isolated daemon-backed database in a fresh temp Sumo home.
 *
 * @access public
 * @param {{ prefix?: string, idleShutdownMs?: number, openOptions?: Record<string, unknown> }} options - Options read by this operation.
 * @returns {Promise<{ db: import('sumo/db').SumoDb, home: string }>} Promise resolving to the `openTempDb` result.
 */
export async function openTempDb({ prefix = 'sumo-test-', idleShutdownMs = 1000, openOptions = {} } = {}) {
  const home = tempDir(prefix);
  const db = await open({ home, idleShutdownMs, ...openOptions });
  return { db, home };
}

/**
 * Close a temp db context, stop its daemon if it is still alive, and remove the temp home.
 *
 * @access public
 * @param {{ db: { close: () => Promise<void> }, home: string }} ctx - Execution context for the operation.
 * @returns {Promise<void>} Promise that resolves when the operation completes.
 */
export async function closeTempDb({ db, home }) {
  await db.close();
  killDaemon(home);
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

/**
 * Kill the daemon recorded in a temp Sumo home if it is still alive.
 *
 * @access public
 * @param {string} home - Filesystem location used by `killDaemon`.
 * @param {NodeJS.Signals} signal - Abort control used by `killDaemon`.
 * @returns {void} Completes without producing a value.
 */
export function killDaemon(home, signal = 'SIGTERM') {
  try {
    const pid = Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8'));
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Read every event currently stored in the daemon event log.
 *
 * @access public
 * @param {{ scan: (prefix: string) => AsyncIterable<[string, unknown]> }} db - Database client used by the operation.
 * @returns {Promise<Array<unknown>>} Promise that resolves with the list returned by `allEvents`.
 */
export async function allEvents(db) {
  const events = [];
  for await (const [, event] of db.scan('evt:')) events.push(event);
  return events;
}
