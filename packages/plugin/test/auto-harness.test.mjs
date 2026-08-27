import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plugin } from '../src/runtime.mjs';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

// A bin that does not exist → the adapter's transport spawn fails fast (ENOENT) instead of launching a
// real, long-lived agent process. That failure still PROVES the harness was auto-registered (a missing
// registration would short-circuit with SUMO_NO_HARNESS before any spawn), without leaking a subprocess
// or blocking on a server-kind handshake.
const NOPE = '/nonexistent/sumo-test-bin';

test('built-in harnesses are auto-registered (no plugins needed)', /** Verify built-in harnesses are auto-registered (no plugins needed). */ async () => {
  const ctx = await openTempDb();
  try {
    const runtime = plugin({
      cwd: process.cwd(),
      db: ctx.db,
      config: {
        harness: {
          'claude-code': {
            bin: NOPE
          },
          codex: {
            bin: NOPE
          },
          copilot: {
            bin: NOPE
          },
          cursor: {
            bin: NOPE
          }
        }
      }
    });
    await runtime.start();

    const ids = runtime.listHarnesses().map(/** Map one item. */ (h) => h.id).sort();
    assert.deepEqual(ids, ['claude-code', 'codex', 'copilot', 'cursor'].sort());

    await runtime.stop();
  } finally {
    await closeTempDb(ctx);
  }
});

test('harness config from config.harness[id] reaches the adapter', /** Verify harness config from config.harness[id] reaches the adapter. */ async () => {
  const ctx = await openTempDb();
  try {
    const runtime = plugin({
      cwd: process.cwd(),
      db: ctx.db,
      config: {
        harness: {
          'claude-code': {
            bin: NOPE
          },
          codex: {
            bin: NOPE
          },
          copilot: {
            bin: NOPE
          },
          cursor: {
            bin: NOPE
          }
        }
      }
    });
    await runtime.start();

    const r = await runtime.invoke('harnesses', { harness: 'claude-code' });
    assert.equal(r.ok, true);
    assert.equal(r.value[0].id, 'claude-code');
    assert.equal(r.value[0].status, 'unavailable');
    assert.deepEqual(r.value[0].providers, ['anthropic']);
    assert.match(r.value[0].reason, /nonexistent\/sumo-test-bin/);

    const all = await runtime.invoke('harnesses', {});
    assert.equal(all.ok, true);
    assert.deepEqual(all.value.map(/** Map one item. */ (row) => row.id).sort(), ['claude-code', 'codex', 'copilot', 'cursor'].sort());
    assert.ok(all.value.every(/** Test whether every item matches. */ (row) => row.status === 'unavailable'));
    assert.ok(all.value.every(/** Test whether every item matches. */ (row) => row.providers?.length > 0));

    const unknown = await runtime.invoke('harnesses', { harness: 'missing-harness' });
    assert.deepEqual(unknown, {
      ok: true,
      value: [
        {
          id: 'missing-harness',
          status: 'unknown',
          reason: "no harness registered with id 'missing-harness'"
        }
      ]
    });

    const models = await runtime.invoke('models', { harness: 'cursor' });
    assert.equal(models.ok, true);
    assert.equal(models.value[0].harness, 'cursor');
    assert.equal(models.value[0].status, 'unavailable');
    assert.deepEqual(models.value[0].providers, ['openai', 'anthropic']);
    assert.deepEqual(models.value[0].models, []);
    assert.deepEqual(models.value[0].tiers, {});

    const allModels = await runtime.invoke('models', {});
    assert.equal(allModels.ok, true);
    assert.deepEqual(allModels.value.map(/** Map one item. */ (row) => row.harness).sort(), ['claude-code', 'codex', 'copilot', 'cursor'].sort());
    assert.ok(allModels.value.every(/** Test whether every item matches. */ (row) => row.status === 'unavailable'));
    assert.ok(allModels.value.every(/** Test whether every item matches. */ (row) => row.providers?.length > 0));

    const unknownModels = await runtime.invoke('models', { harness: 'missing-harness' });
    assert.deepEqual(unknownModels, {
      ok: true,
      value: [
        {
          harness: 'missing-harness',
          status: 'unknown',
          models: [],
          tiers: {},
          reason: "no harness registered with id 'missing-harness'"
        }
      ]
    });

    await runtime.stop();
  } finally {
    await closeTempDb(ctx);
  }
});

test('models capability derives tiers from the real Codex model list', { timeout: 30_000 }, /** Verify models capability derives tiers from the real Codex model list. */ async (t) => {
  const ctx = await openTempDb();
  let runtime;
  try {
    runtime = plugin({
      cwd: process.cwd(),
      db: ctx.db,
      config: {}
    });
    await runtime.start();

    const models = await runtime.invoke('models', { harness: 'codex' });
    assert.equal(models.ok, true);
    assert.equal(models.value[0].harness, 'codex');
    if (models.value[0].status !== 'available') {
      t.skip(`codex model list unavailable: ${models.value[0].reason}`);
      return;
    }
    assert.deepEqual(models.value[0].providers, ['openai']);
    assert.deepEqual(models.value[0].tiers, {
      fast: 'gpt-5.4-mini',
      balanced: 'gpt-5.4',
      powerful: 'gpt-5.5'
    });
    assert.equal(models.value[0].reason, undefined);

  } finally {
    await runtime?.stop();
    await closeTempDb(ctx);
  }
});
