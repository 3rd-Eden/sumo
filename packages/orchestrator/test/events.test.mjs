import { test } from 'node:test';
import assert from 'node:assert/strict';

import { plugin } from 'sumo/plugin';
import { Orchestrator } from '../src/index.mjs';
import { waitUntil } from 'sumo/util';
import { closeTempDb, openTempDb } from 'sumo/util/testing';

/** Implement setup. */ async function setup(plugins = [], config = {}, runtimeConfig = {}) {
  const ctx = await openTempDb();
  const runtime = plugin({ cwd: ctx.home, flags: {}, env: {}, db: ctx.db, config: runtimeConfig });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    config,
    /** Implement listHarnesses. */ listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    /** Implement fallbackHarnesses. */ fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    /** Implement diagnoseFor. */ diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });
  for (const p of plugins) runtime.sumo.use(p);
  await runtime.start();
  return {
    ctx,
    runtime,
    orch,
    /** Implement close. */ async close() {
      await runtime.stop();
      orch.stop();
      await closeTempDb(ctx);
    }
  };
}

/** Implement eventsOf. */ async function eventsOf(ctx, type) {
  const events = [];
  for await (const [, event] of ctx.db.scan('evt:')) {
    if (event.type === type) events.push(event);
  }
  return events;
}

test('surface writes one daemon event per triggering event ref', /** Verify surface writes one daemon event per triggering event ref. */ async () => {
  const tctx = await setup();
  try {
    const observed = [];
    tctx.orch.on('orchestrator.surfaced', /** Run the callback. */ (event) => observed.push(event));

    const triggering = { type: 'session.idle', sessionId: 'ses_surface', seq: 42, payload: { quiet: true } };

    assert.equal((await tctx.orch.surface(triggering, 'session idle', { route: 'human' })).ok, true);
    assert.equal((await tctx.orch.surface(triggering, 'session idle', { route: 'human' })).ok, true);

    const surfaced = await eventsOf(tctx.ctx, 'orchestrator.surfaced');
    assert.equal(surfaced.length, 1);
    assert.equal(surfaced[0].sessionId, 'ses_surface');
    assert.deepEqual(surfaced[0].payload, {
      reason: 'session idle',
      event: { type: 'session.idle', sessionId: 'ses_surface', payload: { quiet: true } },
      route: 'human'
    });

    assert.equal((await tctx.orch.surface(null, 'operator note', { route: 'queue' })).ok, true);
    const withoutTrigger = (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).find(/** Find a matching item. */ (event) => event.payload.reason === 'operator note');
    assert.equal(withoutTrigger.sessionId, undefined);
    assert.deepEqual(withoutTrigger.payload, { reason: 'operator note', route: 'queue' });
    await waitUntil(/** Run the callback. */ async () => observed.some(/** Test whether an item matches. */ (event) => event.payload.reason === 'operator note'));
  } finally {
    await tctx.close();
  }
});

test('public guard and health facade flow through real orchestrator state', /** Verify public guard and health facade flow through real orchestrator state. */ async () => {
  const tctx = await setup();
  try {
    tctx.orch.guard('block-public-facade-spawn', /** Run the callback. */ () => ({ ok: false, code: 'SUMO_POLICY_BLOCKED', reason: 'blocked by public guard' }));

    const health = await tctx.orch.health({ id: 'ses_missing_public_health' });
    assert.equal(health.ok, false);
    assert.equal(health.code, 'SUMO_SESSION_UNKNOWN');

    const blocked = await tctx.orch.control('', 'spawn', { prompt: 'hello', harness: 'missing-live-harness' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'SUMO_POLICY_BLOCKED');
    assert.match(blocked.reason, /blocked by public guard/);
    assert.equal((await eventsOf(tctx.ctx, 'orchestrator.surfaced')).length, 0, 'public guard blocked before provider selection');
  } finally {
    await tctx.close();
  }
});

test('runtime-delivered idle, prompt, approval and proof-of-life events surface through the daemon', /** Verify runtime-delivered idle, prompt, approval and proof-of-life events surface through the daemon. */ async () => {
  const tctx = await setup();
  try {
    await tctx.ctx.db.append({ dedupe: 'orch:idle', type: 'session.idle', sessionId: 'ses_idle', source: 'session', payload: {} });
    await tctx.ctx.db.append({ dedupe: 'orch:prompt', type: 'session.prompt-detected', sessionId: 'ses_prompt', source: 'session', payload: { prompt: 'provider-login' } });
    await tctx.ctx.db.append({ dedupe: 'orch:approval', type: 'session.approval-requested', sessionId: 'ses_approval', source: 'session', payload: { command: 'cat package.json' } });
    await tctx.ctx.db.append({ dedupe: 'orch:pol', type: 'messenger.proof-of-life-request', source: 'messenger', payload: { agent: 'ses_absent' } });

    await waitUntil(/** Run the callback. */ async () => (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).length === 4);
    const reasons = (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).map(/** Map one item. */ (event) => event.payload.reason).sort();

    assert.deepEqual(reasons, [
      "proof-of-life: 'ses_absent' is not owned here",
      'approval needs a human',
      'prompt needs a human',
      'session idle'
    ].sort());
  } finally {
    await tctx.close();
  }
});

test('policy decisions still require an owned session handle before acting', /** Verify policy decisions still require an owned session handle before acting. */ async () => {
  /** Implement policy. */ function policy(sumo) {
    sumo.modify('prompt', /** Run the callback. */ () => ({ action: 'dismiss', key: 'Escape' }));
    sumo.modify('approval', /** Run the callback. */ () => ({ action: 'allow' }));
  }
  policy.sumo = { name: 'orchestrator-policy' };

  const tctx = await setup([policy]);
  try {
    await tctx.ctx.db.append({ dedupe: 'orch:policy-prompt', type: 'session.prompt-detected', sessionId: 'ses_policy_prompt', source: 'session', payload: { prompt: 'upgrade-banner' } });
    await tctx.ctx.db.append({ dedupe: 'orch:policy-approval', type: 'session.approval-requested', sessionId: 'ses_policy_approval', source: 'session', payload: { command: 'Write' } });

    await waitUntil(/** Run the callback. */ async () => (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).length === 2);
    const surfaced = await eventsOf(tctx.ctx, 'orchestrator.surfaced');

    assert.ok(surfaced.some(/** Test whether an item matches. */ (event) => event.payload.reason === 'no handle to dismiss prompt'));
    assert.ok(surfaced.some(/** Test whether an item matches. */ (event) => event.payload.reason === 'no handle to answer approval'));
  } finally {
    await tctx.close();
  }
});

test('control spawn with a missing requested harness fails through provider selection and rolls back', /** Verify control spawn with a missing requested harness fails through provider selection and rolls back. */ async () => {
  const tctx = await setup();
  try {
    const missing = 'missing-live-harness';
    const result = await tctx.orch.control('', 'spawn', { prompt: 'hello', harness: missing });

    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_NO_HARNESS');
    assert.match(result.reason, /missing-live-harness/);

    const dead = await tctx.orch.control('ses_missing', 'send', { text: 'hello' });
    assert.equal(dead.ok, false);
    assert.equal(dead.code, 'SUMO_SESSION_DEAD');

    await waitUntil(/** Run the callback. */ async () => (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).some(/** Test whether an item matches. */ (event) => event.payload.reason === 'failover to next harness'));
    const failover = (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).find(/** Find a matching item. */ (event) => event.payload.reason === 'failover to next harness');
    assert.equal(failover.payload.from, missing);
    assert.equal(failover.payload.code, 'SUMO_NO_HARNESS');
    assert.match(failover.payload.detail, /missing-live-harness/);
  } finally {
    await tctx.close();
  }
});

test('plugin guards block spawns before provider selection', /** Verify plugin guards block spawns before provider selection. */ async () => {
  /** Implement policy. */ function policy(sumo) {
    sumo.guard('no-spawns', /** Run the callback. */ () => ({ ok: false, code: 'SUMO_POLICY_BLOCKED', reason: 'blocked by guard' }));
  }
  policy.sumo = { name: 'orchestrator-guard-policy' };

  const tctx = await setup([policy]);
  try {
    const result = await tctx.orch.control('', 'spawn', { prompt: 'hello', harness: 'missing-live-harness' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_POLICY_BLOCKED');
    assert.match(result.reason, /blocked by guard/);
    assert.equal((await eventsOf(tctx.ctx, 'orchestrator.surfaced')).length, 0, 'provider selection never ran');
  } finally {
    await tctx.close();
  }
});

test('control uses real harness metadata for fallback and skips degraded requested harnesses', /** Verify control uses real harness metadata for fallback and skips degraded requested harnesses. */ async () => {
  const missingBin = '/nonexistent/sumo-orchestrator-harness';
  const tctx = await setup([], {}, {
    harness: {
      'claude-code': { bin: missingBin },
      codex: { bin: missingBin },
      cursor: { bin: missingBin },
      fallback: ['codex', 'cursor']
    }
  });
  try {
    const first = await tctx.orch.control('', 'resume', { prompt: 'hello', resumeId: 'native-1', harness: 'claude-code' });
    const second = await tctx.orch.control('', 'resume', { prompt: 'hello', resumeId: 'native-2', harness: 'claude-code' });
    assert.equal(first.code, 'SUMO_NO_HARNESS');
    assert.equal(second.code, 'SUMO_NO_HARNESS');

    const third = await tctx.orch.control('', 'spawn', { prompt: 'hello', harness: 'claude-code' });
    assert.equal(third.code, 'SUMO_NO_HARNESS');

    await waitUntil(/** Run the callback. */ async () => (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).length === 2);
    const failovers = (await eventsOf(tctx.ctx, 'orchestrator.surfaced')).map(/** Map one item. */ (event) => event.payload);

    assert.deepEqual(failovers.map(/** Map one item. */ (event) => event.from), ['claude-code', 'cursor']);
    assert.ok(failovers.every(/** Test whether every item matches. */ (event) => event.code === 'SUMO_NO_HARNESS'));
    assert.ok(failovers.every(/** Test whether every item matches. */ (event) => /nonexistent\/sumo-orchestrator-harness/.test(event.detail)));
  } finally {
    await tctx.close();
  }
});

test('control spawn without an explicit harness delegates to real provider selection', /** Verify control spawn without an explicit harness delegates to real provider selection. */ async () => {
  const missingBin = '/nonexistent/sumo-orchestrator-no-default';
  const tctx = await setup([], {}, {
    harness: {
      'claude-code': { bin: missingBin },
      codex: { bin: missingBin },
      copilot: { bin: missingBin },
      cursor: { bin: missingBin }
    }
  });
  try {
    const result = await tctx.orch.control('', 'spawn', { prompt: 'hello' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_NO_HARNESS');
    assert.match(result.reason, /claude-code/);
    assert.match(result.reason, /codex/);
    assert.match(result.reason, /copilot/);
    assert.match(result.reason, /cursor/);
    assert.equal((await eventsOf(tctx.ctx, 'orchestrator.surfaced')).length, 0);
  } finally {
    await tctx.close();
  }
});

test('control resume without an explicit harness does not expand cross-harness failover', /** Verify control resume without an explicit harness does not expand cross-harness failover. */ async () => {
  const missingBin = '/nonexistent/sumo-orchestrator-resume-default';
  const tctx = await setup([], {}, {
    harness: {
      'claude-code': { bin: missingBin },
      codex: { bin: missingBin },
      cursor: { bin: missingBin },
      default: 'claude-code',
      fallback: ['codex', 'cursor']
    }
  });
  try {
    const result = await tctx.orch.control('', 'resume', { prompt: 'hello', resumeId: 'native-resume' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_NO_HARNESS');
    assert.match(result.reason, /claude-code/);
    assert.equal((await eventsOf(tctx.ctx, 'orchestrator.surfaced')).length, 0, 'resume ids stay harness-specific');
  } finally {
    await tctx.close();
  }
});

test('control uses orchestrator-configured fallback when no runtime fallback callback is supplied', /** Verify control uses orchestrator-configured fallback when no runtime fallback callback is supplied. */ async () => {
  const ctx = await openTempDb();
  const missingBin = '/nonexistent/sumo-orchestrator-config-fallback';
  const runtime = plugin({
    cwd: ctx.home,
    flags: {},
    env: {},
    db: ctx.db,
    config: {
      harness: {
        'claude-code': { bin: missingBin },
        codex: { bin: missingBin }
      }
    }
  });
  const orch = new Orchestrator({ runtime, db: ctx.db, config: { fallback: ['codex'] } });
  try {
    await runtime.start();
    const result = await orch.control('', 'spawn', { prompt: 'hello', harness: 'claude-code' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SUMO_NO_HARNESS');

    await waitUntil(/** Run the callback. */ async () => (await eventsOf(ctx, 'orchestrator.surfaced')).length === 2);
    const failovers = (await eventsOf(ctx, 'orchestrator.surfaced')).map(/** Map one item. */ (event) => event.payload);
    assert.deepEqual(failovers.map(/** Map one item. */ (event) => event.from), ['claude-code', 'codex']);
    assert.ok(failovers.every(/** Test whether every item matches. */ (event) => event.code === 'SUMO_NO_HARNESS'));
  } finally {
    await runtime.stop();
    orch.stop();
    await closeTempDb(ctx);
  }
});
