import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { plugin } from '../src/runtime.mjs';
import { waitUntil } from 'sumo/util';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/**
 * The reference `testGate` plugin from spec 03, faithful to the 03a shapes (event data lives in
 * `e.payload`). The pure reference tests below exercise runtime wiring; live backend coverage for
 * `work -> run -> reply` lives in `work-codex.live.test.mjs`.
 */
function testGate(sumo) {
  const store = sumo.store('test-gate');

  sumo.on('test:done', /** Run the callback. */ async (e) => {
    // `store.set` is async (it writes through the daemon). Await it so the runtime's "fan-out
    // completes before the watermark advances" guarantee actually covers the write — otherwise a
    // later `before('finish')` can observe the watermark yet read stale gate state under load.
    await store.set(e.payload.repo, { passed: e.payload.passed });
  });

  sumo.before('finish', /** Run the before hook. */ async (e) => {
    const t = await store.get(e.payload.repo);
    if (!t?.passed) return { deny: 'run tests first' };
  });

  sumo.command('test-status', /** Run the callback. */ ({ repo }) => store.get(repo));

  sumo.destroy(/** Run the callback. */ () => {});
}

test('[reference] testGate runs end-to-end: store + on + before-{deny} + command', /** Verify [reference] testGate runs end-to-end: store + on + before-{deny} + command. */ async () => {
  const rt = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  rt.sumo.use(testGate);
  await rt.start();

  // before('finish') denies until tests have passed for the repo
  const denied = await rt.steer('finish', { payload: { repo: 'repo-A' } });
  assert.deepEqual(denied, { deny: 'run tests first' });

  // an observed test:done updates the gate's store
  const seq = await ctx.db.append({ dedupe: 'uuid:tdA', type: 'test:done', payload: { repo: 'repo-A', passed: true } });
  await waitUntil(/** Run the callback. */ () => rt.watermark() >= seq);

  // now finish passes through (no deny)
  const allowed = await rt.steer('finish', { payload: { repo: 'repo-A' } });
  assert.ok('event' in allowed, 'finish should pass once tests are green');

  // the command reflects the same stored state
  const status = await rt.invoke('test-status', { repo: 'repo-A' });
  assert.deepEqual(status, { ok: true, value: { passed: true } });

  await rt.stop();
});

test('run() with no available harness yields SUMO_NO_HARNESS (no fake, no crash)', /** Verify run() with no available harness yields SUMO_NO_HARNESS (no fake, no crash). */ async () => {
  const rt = plugin({
    cwd: ctx.home,
    flags: {},
    env: {},
    db: ctx.db,
    config: {
      harness: {
        'claude-code': { bin: '/nonexistent/sumo-claude' },
        codex: { bin: '/nonexistent/sumo-codex' },
        copilot: { bin: '/nonexistent/sumo-copilot' },
        cursor: { bin: '/nonexistent/sumo-cursor-agent' }
      }
    }
  });
  let result;
  /** Implement usesRun. */ function usesRun(sumo) {
    sumo.command('go', /** Run the callback. */ async () => { result = await sumo.run('x'); return result; });
  }
  rt.sumo.use(usesRun);
  await rt.start();
  const r = await rt.invoke('go');
  assert.equal(r.ok, true);
  assert.equal(r.value.ok, false);
  assert.equal(r.value.code, 'SUMO_NO_HARNESS');
  assert.match(r.value.reason, /no available harness/);
  await rt.stop();
});
