/**
 * JOURNEY 1, LIVE — the graph becomes a test ( +  +  +  whole-trail). Runs the real
 * `journeys/spawn-with-model.journey.md` through Melusine's CLI against the real Sumo catalog and
 * a REAL daemon-resident orchestrator that spawns a REAL `claude` session with a chosen model. No
 * mocks, no fake transport (§3f/§5): a missing `claude` binary SKIPS WITH REASON; everything else is
 * the live data trail (spawn → running+model recorded → ended → transcript correlated + dual-source
 * dedupe collapsed), asserted by the journey's own scorer nodes.
 *
 * Only `SUMO_HOME` is isolated (fresh daemon + DB + the global `sumo.yml` that points the harness at
 * the resolved real binary). `CLAUDE_CONFIG_DIR` is inherited so Claude keeps its real auth — an empty
 * config dir would make it "not logged in" and the spawn would crash (the same lesson `session-doc`
 * encodes). `SUMO_DAEMON_MAIN` is pinned to the steering daemon so session-control ops are hosted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveClaudeBin } from '../../harness/test/_live.mjs';
import { runJourneyCli, stopDaemon } from './_melusine-cli.mjs';

const STEERING_DAEMON_MAIN = fileURLToPath(new URL('../../cli/src/daemon-main.mjs', import.meta.url));

// Resolve a real claude binary up front so the test can skip-with-reason when none is usable.
let claudeBin;
let skipReason = false;
try {
  claudeBin = await resolveClaudeBin();
} catch (err) {
  skipReason = `no usable claude binary: ${/** @type {Error} */ (err).message.split('\n')[0]}`;
}

test('Journey 1 (spawn-with-model) runs live through Melusine and the data trail passes', { skip: skipReason, timeout: 300_000 }, /** Verify Journey 1 (spawn-with-model) runs live through Melusine and the data trail passes. */ async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-journey-live-'));
  fs.writeFileSync(path.join(home, 'sumo.yml'), JSON.stringify({ harness: { 'claude-code': { bin: claudeBin } } }, null, 2));

  // Point this process (and the daemon it autostarts) at the isolated, steering-capable home.
  const saved = { SUMO_HOME: process.env.SUMO_HOME, SUMO_DAEMON_MAIN: process.env.SUMO_DAEMON_MAIN, SUMO_IDLE_MS: process.env.SUMO_IDLE_MS, SUMO_INGEST: process.env.SUMO_INGEST };
  process.env.SUMO_HOME = home;
  process.env.SUMO_DAEMON_MAIN = STEERING_DAEMON_MAIN;
  process.env.SUMO_IDLE_MS = '600000';
  process.env.SUMO_INGEST = '0'; // this test exercises session control, not always-on ingestion (isolation)

  try {
    const result = await runJourneyCli('journeys/spawn-with-model.journey.md');
    assert.equal(result.code, 0, `journey CLI failed:\n${result.stderr || result.stdout}`);
    assert.match(result.stderr, /passed: journeys\/spawn-with-model\.journey\.md/);
  } finally {
    stopDaemon(home);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
