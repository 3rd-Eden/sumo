/**
 * DRIVE VERBS, LIVE — cross-process session control on the server kind ( + ). Runs the real
 * `journeys/drive-verbs.journey.md` through Melusine's CLI against the real Sumo catalog and a
 * REAL daemon-resident orchestrator. It spawns a REAL `codex` session and drives it cross-process:
 * cancel the active turn (thread survives), send a follow-up turn on the surviving thread, end the
 * (otherwise immortal) server-kind session, then resume a NEW session from its native id. No mocks, no
 * fake transport (§3f/§5): a missing `codex` binary SKIPS WITH REASON; every verb runs for real and is
 * asserted by the journey's own scorer nodes.
 *
 * Isolation mirrors the Codex whole-trail test: only `SUMO_HOME` is fresh; `~/.codex` auth is inherited;
 * `SUMO_DAEMON_MAIN` is the steering daemon so control ops are hosted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertAvailable, liveUnavailableCodeFromText } from '../../harness/test/_live.mjs';
import { Codex } from '../../harness/src/index.mjs';
import { runJourneyCli, stopDaemon } from './_melusine-cli.mjs';

const STEERING_DAEMON_MAIN = fileURLToPath(new URL('../../cli/src/daemon-main.mjs', import.meta.url));

let codexConfig;
let skipReason = false;
try {
  codexConfig = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {});
} catch (err) {
  skipReason = `codex not available: ${/** @type {Error} */ (err).message.split('\n')[0]}`;
}

test('Drive verbs (cancel/send/end/resume) run live through Melusine and pass', { skip: skipReason, timeout: 420_000 }, /** Verify Drive verbs (cancel/send/end/resume) run live through Melusine and pass. */ async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-journey-drive-'));
  const cwd = fs.mkdtempSync(path.join(home, 'work-'));
  const codexHarnessConfig = { ...codexConfig, sandbox: 'read-only', approvalPolicy: 'on-request' };
  fs.writeFileSync(path.join(home, 'sumo.yml'), JSON.stringify({ harness: { codex: codexHarnessConfig } }, null, 2));

  const saved = { SUMO_HOME: process.env.SUMO_HOME, SUMO_DAEMON_MAIN: process.env.SUMO_DAEMON_MAIN, SUMO_IDLE_MS: process.env.SUMO_IDLE_MS, SUMO_INGEST: process.env.SUMO_INGEST };
  const savedCwd = process.cwd();
  process.env.SUMO_HOME = home;
  process.env.SUMO_DAEMON_MAIN = STEERING_DAEMON_MAIN;
  process.env.SUMO_IDLE_MS = '600000';
  process.env.SUMO_INGEST = '0'; // this test exercises session control, not always-on ingestion (isolation)
  process.chdir(cwd);

  try {
    const result = await runJourneyCli('journeys/drive-verbs.journey.md');
    const failure = result.code === 0 ? '' : (result.stderr || result.stdout);
    const unavailableCode = liveUnavailableCodeFromText(failure);
    if (unavailableCode) {
      t.skip(`codex drive-verbs live prerequisite unavailable: ${unavailableCode}`);
      return;
    }

    assert.equal(result.code, 0, `journey CLI failed:\n${failure}`);
    assert.match(result.stderr, /passed: journeys\/drive-verbs\.journey\.md/);
  } finally {
    stopDaemon(home);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    process.chdir(savedCwd);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
