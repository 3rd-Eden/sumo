import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDegradation } from '../src/degradation.mjs';
import { createDecisions } from '../src/decisions.mjs';
import { createGuards } from '../src/guards.mjs';
import { health } from '../src/health.mjs';
import { createTimers } from '../src/timers.mjs';
import { waitUntil } from 'sumo/util';
import { closeTempDb, openTempDb } from 'sumo/util/testing';

/** Implement config. */ function config(overrides = {}) {
  return {
    guards: {
      maxAgents: 8,
      maxRounds: 7,
      rapidDeathThreshold: 3,
      rate: { windowMs: 60_000, max: 30 },
      ...overrides
    }
  };
}

test('guards reserve, rollback, release and enforce loop/concurrency limits', /** Verify guards reserve, rollback, release and enforce loop/concurrency limits. */ () => {
  const guards = createGuards(config({ maxAgents: 1, maxRounds: 2 }));

  assert.equal(guards.reserve('loop', 'plugin').ok, true);
  assert.equal(guards.reserve('other', 'plugin').code, 'SUMO_MAX_AGENTS');

  guards.release();
  assert.equal(guards.reserve('loop', 'plugin').ok, true);

  guards.release();
  assert.equal(guards.reserve('loop', 'plugin').code, 'SUMO_MAX_ROUNDS');

  guards.rollback('loop');
  assert.equal(guards.reserve('loop', 'plugin').ok, true);

  const snap = guards.snapshot();
  assert.equal(snap.liveCount, 1);
  assert.equal(snap.rounds.get('loop'), 2);

  guards.release();
  guards.release();
  guards.rollback('never-reserved');
  assert.equal(guards.snapshot().liveCount, 0);
});

test('guards report custom guard problems without corrupting spawn accounting', /** Verify guards report custom guard problems without corrupting spawn accounting. */ () => {
  const diagnostics = [];
  const guards = createGuards(config({ maxAgents: 4, maxRounds: 10 }), /** Run the callback. */ (err, meta) => {
    diagnostics.push({ err, meta });
  });

  guards.add('bad-shape', null);
  guards.add('throws', /** Run the callback. */ () => { throw new Error('guard boom'); });
  guards.add('async', /** Run the callback. */ async () => false);
  guards.add('blocker', /** Run the callback. */ () => ({ ok: false, code: 'SUMO_POLICY_BLOCKED', reason: 'blocked by policy' }));

  const blocked = guards.reserve('spawn', 'plugin');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'SUMO_POLICY_BLOCKED');
  assert.match(blocked.reason, /blocked by policy/);
  assert.equal(guards.snapshot().liveCount, 0);
  assert.ok(diagnostics.some(/** Test whether an item matches. */ (d) => d.err?.code === 'SUMO_GUARD_INVALID'));
  assert.ok(diagnostics.some(/** Test whether an item matches. */ (d) => /guard boom/.test(d.err?.message)));
  assert.ok(diagnostics.some(/** Test whether an item matches. */ (d) => d.err?.code === 'SUMO_GUARD_ASYNC'));

  const plainFalse = createGuards(config({ maxAgents: 4, maxRounds: 10 }));
  plainFalse.add('plain-false', /** Run the callback. */ () => false);
  const tripped = plainFalse.reserve('spawn', 'plugin');
  assert.equal(tripped.ok, false);
  assert.equal(tripped.code, 'SUMO_GUARD_TRIPPED');
  assert.match(tripped.reason, /plain-false/);
});

test('guards enforce spawn rate through the shared Result shape', /** Verify guards enforce spawn rate through the shared Result shape. */ () => {
  const guards = createGuards(config({ maxAgents: 8, maxRounds: 10, rate: { windowMs: 60_000, max: 1 } }));

  assert.equal(guards.reserve('first', 'plugin-a').ok, true);
  guards.release();

  const limited = guards.reserve('second', 'plugin-b');
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'SUMO_RATE_LIMITED');
});

test('rapid-death breaker trips and normal endings reset it', /** Verify rapid-death breaker trips and normal endings reset it. */ () => {
  const guards = createGuards(config({ rapidDeathThreshold: 2 }));

  guards.recordRapidDeath('spawn');
  assert.equal(guards.reserve('spawn', 'plugin').ok, true);
  guards.release();

  guards.recordRapidDeath('spawn');
  const open = guards.reserve('spawn', 'plugin');
  assert.equal(open.ok, false);
  assert.equal(open.code, 'SUMO_BREAKER_OPEN');

  guards.recordNormalEnd('spawn');
  assert.equal(guards.reserve('spawn', 'plugin').ok, true);
});

test('degradation tracks hard failures, soft warnings and explicit clear', /** Verify degradation tracks hard failures, soft warnings and explicit clear. */ () => {
  const degradation = createDegradation();

  assert.equal(degradation.degraded('codex'), false);

  degradation.recordFailure('codex');
  assert.equal(degradation.degraded('codex'), false);

  degradation.recordFailure('codex');
  assert.equal(degradation.degraded('codex'), true);

  degradation.clearFailures('codex');
  assert.equal(degradation.degraded('codex'), false);

  degradation.recordWarning('codex');
  degradation.recordWarning('codex');
  assert.equal(degradation.degraded('codex'), false);

  degradation.recordWarning('codex');
  assert.equal(degradation.degraded('codex'), true);
  assert.equal(degradation.snapshot().get('codex').warnings, 3);
});

test('decision modifiers ignore invalid handlers and preserve primitive decisions', /** Verify decision modifiers ignore invalid handlers and preserve primitive decisions. */ async () => {
  const diagnostics = [];
  const decisions = createDecisions(/** Run the callback. */ (err, meta) => diagnostics.push({ err, meta }));
  decisions.register('plugin-a', 'approval', null);
  decisions.register('plugin-b', 'approval', /** Run the callback. */ () => undefined);
  decisions.register('plugin-c', 'approval', /** Run the callback. */ (current) => {
    assert.equal(current, 'allow');
    return 'ignored';
  });

  const resolved = await decisions.resolve('approval', 'allow', { type: 'approval.requested' });
  assert.equal(resolved, 'allow');
  assert.ok(diagnostics.some(/** Test whether an item matches. */ (d) => d.err.code === 'SUMO_MODIFY_INVALID' && d.meta.key === 'plugin-a'));
});

test('health refuses to answer for sessions the orchestrator does not own', /** Verify health refuses to answer for sessions the orchestrator does not own. */ async () => {
  const r = await health({ id: 'ses_missing' }, undefined, { stall: 1_000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUMO_SESSION_UNKNOWN');

  const missingId = await health(undefined, undefined, { stall: 1_000 });
  assert.equal(missingId.reason, "health: '?' is not an owned session");
});

test('health reports process, state, activity and output signals for owned entries', /** Verify health reports process, state, activity and output signals for owned entries. */ async () => {
  const active = await health(
    { id: 'ses_active', /** Implement capture. */ async capture() { return { ok: true, value: 'pane output' }; } },
    { terminal: false, done: false, lastActivityAt: Date.now() },
    { stall: 1_000 }
  );
  assert.equal(active.ok, true);
  assert.deepEqual(active.value.signals, {
    process: true,
    state: 'running',
    activity: true,
    output: true
  });
  assert.equal(active.value.alive, true);

  const done = await health(
    { id: 'ses_done', /** Implement capture. */ async capture() { return { ok: false, code: 'SUMO_CAP_UNSUPPORTED' }; } },
    { terminal: false, done: true, lastActivityAt: Date.now() - 5_000 },
    { stall: 1_000 }
  );
  assert.equal(done.value.alive, false);
  assert.deepEqual(done.value.signals, {
    process: false,
    state: 'done',
    activity: false,
    output: 'unknown'
  });

  const terminal = await health(
    { id: 'ses_terminal' },
    { terminal: true, done: false, lastActivityAt: Date.now() },
    { stall: 1_000 }
  );
  assert.equal(terminal.value.signals.process, false);
  assert.equal(terminal.value.signals.state, 'ended');
  assert.equal(terminal.value.signals.output, 'unknown');
});

test('timers emit idle/stalled events once per epoch and bump re-arms silence detection', /** Verify timers emit idle/stalled events once per epoch and bump re-arms silence detection. */ async () => {
  const ctx = await openTempDb();
  const registry = new Map();
  const errors = [];
  const shutdownTimer = setTimeout(/** Run the timer callback. */ () => {}, 10_000);
  shutdownTimer.unref?.();

  registry.set('ses_done_timer', { done: true, lastActivityAt: Date.now() - 5_000 });
  registry.set('ses_awaiting_timer', { done: false, awaitingNextTurn: true, lastActivityAt: Date.now() - 5_000 });
  registry.set('ses_timer', {
    done: false,
    awaitingNextTurn: false,
    lastActivityAt: Date.now() - 5_000,
    idleFired: false,
    stalledFired: false,
    epoch: 0,
    shutdownTimer
  });

  const timers = createTimers({
    db: ctx.db,
    timeouts: { idle: 1, stall: 1 },
    registry,
    /** Implement onError. */ onError(err) { errors.push(err); }
  });

  try {
    timers.bump('missing-session');
    timers.bump('ses_done_timer');
    timers.start();
    timers.start();

    await waitUntil(/** Run the callback. */ async () => {
      const events = [];
      for await (const [, event] of ctx.db.scan('evt:')) events.push(event);
      return events.some(/** Test whether an item matches. */ (event) => event.type === 'session.idle' && event.sessionId === 'ses_timer')
        && events.some(/** Test whether an item matches. */ (event) => event.type === 'session.stalled' && event.sessionId === 'ses_timer');
    }, 3_000);

    assert.deepEqual(errors, []);
    let events = [];
    for await (const [, event] of ctx.db.scan('evt:')) events.push(event);
    assert.equal(events.filter(/** Select matching items. */ (event) => event.sessionId === 'ses_done_timer').length, 0);
    assert.equal(events.filter(/** Select matching items. */ (event) => event.sessionId === 'ses_awaiting_timer').length, 0);

    const entry = registry.get('ses_timer');
    assert.equal(entry.idleFired, true);
    assert.equal(entry.stalledFired, true);

    timers.bump('ses_timer');
    assert.equal(entry.awaitingNextTurn, false);
    assert.equal(entry.shutdownTimer, undefined);
    assert.equal(entry.epoch, 1);
    assert.equal(entry.idleFired, false);
    assert.equal(entry.stalledFired, false);

    entry.lastActivityAt = Date.now() - 5_000;
    await waitUntil(/** Run the callback. */ async () => {
      events = [];
      for await (const [, event] of ctx.db.scan('evt:')) events.push(event);
      return events.filter(/** Select matching items. */ (event) => event.type === 'session.idle' && event.sessionId === 'ses_timer').length === 2
        && events.filter(/** Select matching items. */ (event) => event.type === 'session.stalled' && event.sessionId === 'ses_timer').length === 2;
    }, 3_000);
  } finally {
    timers.stop();
    timers.stop();
    clearTimeout(shutdownTimer);
    await closeTempDb(ctx);
  }
});
