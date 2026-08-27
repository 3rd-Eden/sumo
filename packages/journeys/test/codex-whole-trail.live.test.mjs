/**
 * CODEX WHOLE-TRAIL, LIVE — the server-kind companion to Journey 1 ( +  +  + ). Runs
 * the real `journeys/codex-whole-trail.journey.md` through Melusine's CLI against the real Sumo
 * catalog and a REAL daemon-resident orchestrator that spawns a REAL `codex` app-server session with a
 * chosen model, then DRIVES the end (Codex stays alive across turns — it never self-exits). No mocks,
 * no fake transport (§3f/§5): a missing `codex` binary SKIPS WITH REASON; everything else is the live
 * data trail (spawn → running+model recorded → live stream Sumo-keyed with native id → driven end →
 * ended), asserted by the journey's own scorer nodes.
 *
 * Only `SUMO_HOME` is isolated (fresh daemon + DB + the global `sumo.yml` that points the harness at the
 * resolved real binary). Codex auth (`~/.codex`) is inherited — an isolated config would break the
 * handshake, the same lesson the Claude journey encodes for `CLAUDE_CONFIG_DIR`. `SUMO_DAEMON_MAIN` is
 * pinned to the steering daemon so session-control ops are hosted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertAvailable } from '../../harness/test/_live.mjs';
import { Codex } from '../../harness/src/index.mjs';
import { runJourneyCli, stopDaemon } from './_melusine-cli.mjs';

const STEERING_DAEMON_MAIN = fileURLToPath(new URL('../../cli/src/daemon-main.mjs', import.meta.url));

// Check codex is available (binary + auth) before the tests run.
let codexConfig;
let skipReason = false;
try {
  codexConfig = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {});
} catch (err) {
  skipReason = `codex not available: ${/** @type {Error} */ (err).message.split('\n')[0]}`;
}

test('Codex whole-trail runs live through Melusine and the data trail passes', { skip: skipReason, timeout: 300_000 }, /** Verify Codex whole-trail runs live through Melusine and the data trail passes. */ async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-journey-codex-'));
  fs.writeFileSync(path.join(home, 'sumo.yml'), JSON.stringify({ harness: { codex: codexConfig } }, null, 2));

  const saved = { SUMO_HOME: process.env.SUMO_HOME, SUMO_DAEMON_MAIN: process.env.SUMO_DAEMON_MAIN, SUMO_IDLE_MS: process.env.SUMO_IDLE_MS, SUMO_INGEST: process.env.SUMO_INGEST };
  process.env.SUMO_HOME = home;
  process.env.SUMO_DAEMON_MAIN = STEERING_DAEMON_MAIN;
  process.env.SUMO_IDLE_MS = '600000';
  process.env.SUMO_INGEST = '0'; // this test exercises session control, not always-on ingestion (isolation)

  try {
    const result = await runJourneyCli('journeys/codex-whole-trail.journey.md');
    assert.equal(result.code, 0, `journey CLI failed:\n${result.stderr || result.stdout}`);
    assert.match(result.stderr, /passed: journeys\/codex-whole-trail\.journey\.md/);
  } finally {
    stopDaemon(home);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
