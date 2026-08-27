/**
 * Spike-specific helpers: temp daemon lifecycle + event readback. The real-`claude` binary
 * resolution and on-disk transcript location are shared with the harness suite (`_live.mjs`) so the
 * no-mock prerequisite logic exists in exactly one place. There is NO mock transport (§3f/§5).
 * @module spike/_helpers
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { open } from 'sumo/db';

export { resolveClaudeBin, assertClaudeBin, findTranscript, readJsonl } from '../packages/harness/test/_live.mjs';

/** Spin up a real daemon on a temp dir. */
export async function openTempDb() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-spike-'));
  const db = await open({ home, idleShutdownMs: 1000 });
  return {
    db,
    home,
    /** Implement cleanup. */ async cleanup() {
      await db.close();
      try { process.kill(Number(fs.readFileSync(path.join(home, 'sumo.pid'), 'utf8')), 'SIGTERM'); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

/** Collect all stored `evt:` documents. */
export async function allEvents(db) {
  const out = [];
  for await (const [, evt] of db.scan('evt:')) out.push(evt);
  return out;
}

/** Let fire-and-forget patches settle. */
export function settle() { return new Promise(/** Run the callback. */ (r) => setTimeout(r, 50)); }
