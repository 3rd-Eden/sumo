/**
 * Shared test helpers: spin up a REAL `sumo/db` daemon on a temp home and tear it down (the same
 * lifecycle the harness integration test uses). Real daemon, no mocks (§3f) — the cross-source
 * collapse and config redaction are only provable against the actual daemon.
 *
 * @module sumo/agent-artifacts/test/_daemon
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { waitUntil } from 'sumo/util';
import { allEvents, closeTempDb, openTempDb as openSharedTempDb, sleep } from 'sumo/util/testing';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIX = path.join(DIR, 'fixtures');
const TRANSCRIPT_FIX = path.join(DIR, '..', '..', 'transcript', 'test', 'fixtures');

/** Read a JSONL fixture from this package's fixtures dir → array of decoded records. */
export function readFix(rel) { return fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n').filter(/** Select matching items. */ (l) => l.trim()).map(/** Map one item. */ (l) => JSON.parse(l)); }

/** Read a JSONL fixture from the `sumo/transcript` fixtures dir (the real on-disk captures). */
export function readTranscript(rel) { return fs.readFileSync(path.join(TRANSCRIPT_FIX, rel), 'utf8').split('\n').filter(/** Select matching items. */ (l) => l.trim()).map(/** Map one item. */ (l) => JSON.parse(l)); }

/** @returns {Promise<{ db: any, home: string, cleanup: () => Promise<void> }>} */
export async function openTempDb() {
  const ctx = await openSharedTempDb({ prefix: 'sumo-aa-db-', idleShutdownMs: 1000 });
  return { ...ctx, cleanup: () => closeTempDb(ctx) };
}

/** Collect every stored `evt:` document from the daemon. */
export { allEvents };

/** @param {number} ms */
export { sleep };

/** Poll `predicate` until true or timeout (for filesystem-watcher latency). */
export { waitUntil };
