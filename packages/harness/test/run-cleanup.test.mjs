/**
 * Regression: `Harness.run()` must reap a real coding harness when startup fails after a transport has
 * opened. This uses the real Codex app-server and a deliberately invalid native resume id, which fails
 * during the app-server handshake after the subprocess is alive. No in-test harness subclass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Codex } from '../src/index.mjs';
import { assertAvailable } from './_live.mjs';

/**
 * Wait until a predicate returns true.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
function waitFor(predicate, timeoutMs = 3000) {
  return new Promise(/** Run the callback. */ (resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    /** Implement tick. */ function tick() {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('timeout waiting for condition'));
        return;
      }
      setTimeout(tick, 10);
    }
    tick();
  });
}

test('LIVE codex: run() reaps the app-server when handshake fails after open', { timeout: 30_000 }, /** Verify LIVE codex: run() reaps the app-server when handshake fails after open. */ async (t) => {
  const cfg = await assertAvailable(Codex, process.env.SUMO_CODEX_BIN ? { bin: process.env.SUMO_CODEX_BIN } : {}, t);
  if (!cfg) return;

  const harness = new Codex({ config: cfg });
  await assert.rejects(
    /** Run the callback. */ () => harness.run('this prompt must never reach a model', { resume: 'sumo-bogus-thread-id-for-cleanup-test' }),
    /** Run the callback. */ (err) => err.code === 'SUMO_SPAWN_FAILED' && /thread\/resume failed/.test(err.message)
  );

  await waitFor(/** Run the callback. */ () => harness.transport.health.alive === false, 5_000);
  assert.equal(harness.transport.health.alive, false, 'failed startup killed the real codex app-server');
});
