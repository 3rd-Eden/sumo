/**
 * The `modify` decision waterfall: plugins override a default via `sumo.modify`; the orchestrator
 * resolves. Real runtime + real daemon (the modify verb is wired through the runtime's facade extension).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { plugin } from 'sumo/plugin';
import { Orchestrator } from '../src/index.mjs';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** Implement setup. */ function setup(plugins) {
  const runtime = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db });
  const orch = new Orchestrator({ runtime, db: ctx.db });
  for (const p of plugins) runtime.sumo.use(p);
  return { runtime, orch };
}

test('an override changes the default; a no-return passes through', /** Verify an override changes the default; a no-return passes through. */ async () => {
  /** Implement policy. */ function policy(sumo) {
    sumo.modify('approval', /** Run the callback. */ (decision, e) => {
      if (/rm -rf/.test(e.payload?.command ?? '')) return { action: 'deny', reason: 'destructive' };
      // anything else → return nothing → pass-through
    });
  }
  policy.sumo = { name: 'policy' };
  const { runtime, orch } = setup([policy]);
  await runtime.start();

  const denied = await orch.modify('approval', { action: 'surface' }, { payload: { command: 'rm -rf /' } });
  assert.deepEqual(denied, { action: 'deny', reason: 'destructive' });

  const passed = await orch.modify('approval', { action: 'surface' }, { payload: { command: 'ls' } });
  assert.deepEqual(passed, { action: 'surface' }); // unchanged

  await runtime.stop();
  orch.stop();
});

test('multiple overrides apply in priority order; a throwing override is skipped fail-open', /** Verify multiple overrides apply in priority order; a throwing override is skipped fail-open. */ async () => {
  const order = [];
  /** Implement low. */ function low(sumo) {
    sumo.modify('approval', /** Run the callback. */ (d) => { order.push('low'); return { action: 'allow', by: 'low' }; }, { priority: 1 });
  }
  low.sumo = { name: 'low' };
  /** Implement high. */ function high(sumo) {
    sumo.modify('approval', /** Run the callback. */ () => { order.push('high'); throw new Error('boom'); }, { priority: 10 });
  }
  high.sumo = { name: 'high' };
  const { runtime, orch } = setup([low, high]);
  await runtime.start();

  const decision = await orch.modify('approval', { action: 'surface' }, { payload: {} });
  assert.deepEqual(order, ['high', 'low']); // high priority first
  assert.deepEqual(decision, { action: 'allow', by: 'low' }); // high threw → skipped; low still resolved
  assert.ok(orch.diagnostics().some(/** Test whether an item matches. */ (d) => /boom/.test(d.message)), 'throwing override recorded a diagnostic');

  await runtime.stop();
  orch.stop();
});

test('sumo.modify registration rolls back when the plugin activation throws', /** Verify sumo.modify registration rolls back when the plugin activation throws. */ async () => {
  /** Implement bad. */ function bad(sumo) { sumo.modify('approval', /** Run the callback. */ () => ({ action: 'allow' })); throw new Error('activation failed'); }
  bad.sumo = { name: 'bad' };
  const { runtime, orch } = setup([bad]);
  await runtime.start();

  // bad's override was staged then discarded → the default passes through unchanged
  const decision = await orch.modify('approval', { action: 'surface' }, { payload: {} });
  assert.deepEqual(decision, { action: 'surface' });

  await runtime.stop();
  orch.stop();
});
