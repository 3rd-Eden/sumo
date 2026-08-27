import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registry } from '../src/engine.mjs';

/** Implement evt. */ function evt(extra = {}) { return ({ action: 'finish', payload: {}, ext: {}, ...extra }); }

// ── STEER: ordering + merge + deny ───────────────────────────────────────────────────────────────

test('before waterfall runs highest priority first and threads merged event', /** Verify before waterfall runs highest priority first and threads merged event. */ async () => {
  const eng = registry();
  const order = [];
  eng.add('steer', 'finish', /** Run the callback. */ () => { order.push('default'); return { event: { a: 1 } }; });
  eng.add('steer', 'finish', /** Run the callback. */ (e) => { order.push('high'); return { event: { b: e.a ? 'saw-a' : 'no-a' } }; }, { priority: 200 });

  const out = await eng.steer('finish', evt());
  assert.deepEqual(order, ['high', 'default']); // 200 before 100
  assert.equal(out.event.b, 'no-a'); // high ran first, before default merged `a`
  assert.equal(out.event.a, 1); // default's merge threaded through
});

test('returning nothing passes the event through unchanged', /** Verify returning nothing passes the event through unchanged. */ async () => {
  const eng = registry();
  eng.add('steer', 'finish', /** Run the callback. */ () => {});
  const out = await eng.steer('finish', evt({ payload: { x: 1 } }));
  assert.deepEqual(out.event.payload, { x: 1 });

  const primitive = registry();
  primitive.add('steer', 'finish', /** Run the callback. */ () => {});
  assert.deepEqual(await primitive.steer('finish', 'primitive-event'), { event: 'primitive-event' });
});

test('{deny} bails immediately and downstream does not run', /** Verify {deny} bails immediately and downstream does not run. */ async () => {
  const eng = registry();
  let ranLower = false;
  eng.add('steer', 'finish', /** Run the callback. */ () => ({ deny: 'run tests first' }), { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { ranLower = true; });
  const out = await eng.steer('finish', evt());
  assert.deepEqual(out, { deny: 'run tests first' });
  assert.equal(ranLower, false);
});

test('deny is sticky even when a wrapper calls previous() then tries to merge', /** Verify deny is sticky even when a wrapper calls previous() then tries to merge. */ async () => {
  const eng = registry();
  eng.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    await previous();
    return { event: { note: 'wrapper' } }; // must NOT un-deny
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => ({ deny: 'blocked downstream' }));
  const out = await eng.steer('finish', evt());
  assert.deepEqual(out, { deny: 'blocked downstream' });
});

// ── STEER: previous() wrapping () ───────────────────────────────────────────────────────────────

test('previous() wraps downstream and merges atop its result', /** Verify previous() wraps downstream and merges atop its result. */ async () => {
  const eng = registry();
  const order = [];
  eng.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    order.push('outer-before');
    const inner = await previous();
    order.push('outer-after');
    return { event: { outer: true, sawInner: inner.event.inner } };
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { order.push('inner'); return { event: { inner: 'yes' } }; });

  const out = await eng.steer('finish', evt());
  assert.deepEqual(order, ['outer-before', 'inner', 'outer-after']);
  assert.equal(out.event.outer, true);
  assert.equal(out.event.sawInner, 'yes');
  assert.equal(out.event.inner, 'yes'); // downstream merge preserved
});

test('previous() is single-shot: a second call returns the memoized result without re-running', /** Verify previous() is single-shot: a second call returns the memoized result without re-running. */ async () => {
  const eng = registry();
  let innerRuns = 0;
  eng.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    const a = await previous();
    const b = await previous();
    return { event: { same: a === b } };
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { innerRuns++; return { event: { n: innerRuns } }; });

  const out = await eng.steer('finish', evt());
  assert.equal(innerRuns, 1);
  assert.equal(out.event.same, true);
});

test('previous() is deterministic: calling it always wraps downstream, even without await', /** Verify previous() is deterministic: calling it always wraps downstream, even without await. */ async () => {
  // New contract: once previous() is called the engine always awaits the downstream subtree (no
  // timing-dependent "fire-and-forget" detection). The handler's return merges atop the subtree.
  const errs = [];
  const eng = registry({ /** Implement onError. */ onError(e) { return errs.push(e); } });
  let innerRan = false;
  eng.add('steer', 'finish', /** Run the callback. */ (_e, { previous }) => {
    previous(); // not awaited — but downstream still runs and is merged
    return { event: { outer: 1 } };
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { innerRan = true; return { event: { inner: 1 } }; });

  const out = await eng.steer('finish', evt());
  assert.equal(innerRan, true); // downstream ran (not dropped)
  assert.equal(out.event.inner, 1); // downstream merge preserved
  assert.equal(out.event.outer, 1); // wrapper merge applied atop
  assert.equal(errs.length, 0); // no diagnostic — the call is deterministic
});

test('nested in-place mutation of a steer event does not leak between handlers', /** Verify nested in-place mutation of a steer event does not leak between handlers. */ async () => {
  const eng = registry();
  eng.add('steer', 'finish', /** Run the callback. */ (e) => { e.payload.nested.v = 999; }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ (e) => ({ event: { saw: e.payload.nested.v } }));
  const out = await eng.steer('finish', evt({ payload: { nested: { v: 1 } } }));
  assert.equal(out.event.saw, 1); // deep clone → upstream nested mutation discarded
});

test('non-cloneable event bags fall back to isolated top-level copies', /** Verify non-cloneable event bags fall back to isolated top-level copies. */ async () => {
  const eng = registry();
  const fn = /** Implement fn. */ () => 'kept by reference';
  eng.add('steer', 'finish', /** Run the callback. */ (e) => {
    e.payload.label = 'mutated';
    e.ext.label = 'mutated';
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ (e) => ({
    event: {
      sawPayloadLabel: e.payload.label,
      sawExtLabel: e.ext.label,
      sameFunction: e.payload.fn === fn
    }
  }));
  const out = await eng.steer('finish', evt({ payload: { label: 'original', fn }, ext: { label: 'original', fn } }));
  assert.equal(out.event.sawPayloadLabel, 'original');
  assert.equal(out.event.sawExtLabel, 'original');
  assert.equal(out.event.sameFunction, true);

  const nullish = registry();
  nullish.add('steer', 'finish', /** Run the callback. */ (e) => ({ event: { payloadWas: e.payload, extWas: e.ext } }));
  const nullishOut = await nullish.steer('finish', evt({ payload: null, ext: undefined }));
  assert.equal(nullishOut.event.payloadWas, null);
  assert.equal(nullishOut.event.extWas, undefined);
});

test('a deny raised inside previous() propagates as the chain outcome', /** Verify a deny raised inside previous() propagates as the chain outcome. */ async () => {
  const eng = registry();
  eng.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    const inner = await previous();
    return inner; // pass through downstream outcome
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => ({ deny: 'inner deny' }));
  const out = await eng.steer('finish', evt());
  assert.deepEqual(out, { deny: 'inner deny' });
});

test('a downstream throw is handled at its own level (fail-open), so previous() resolves not rejects', /** Verify a downstream throw is handled at its own level (fail-open), so previous() resolves not rejects. */ async () => {
  // Errors are handled per-handler: a non-safety downstream throw fail-opens and the chain
  // continues, so previous() resolves to the continued outcome rather than rejecting into the wrapper.
  const errs = [];
  const eng = registry({ /** Implement onError. */ onError(e) { return errs.push(e); } });
  let rejected = false;
  eng.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    try { await previous(); } catch { rejected = true; }
    return { event: { wrapped: true } };
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { throw new Error('downstream boom'); }); // non-safety
  const out = await eng.steer('finish', evt());
  assert.equal(rejected, false); // previous() did not reject
  assert.equal(out.event.wrapped, true);
  assert.equal(errs.length, 1); // the downstream throw was surfaced

  const wrapperErrs = [];
  const wrapperThrowsAfterTakingControl = registry({ /** Implement onError. */ onError(e) { return wrapperErrs.push(e); } });
  wrapperThrowsAfterTakingControl.add('steer', 'finish', /** Run the callback. */ (_e, { previous }) => {
    previous();
    throw new Error('wrapper boom');
  }, { priority: 200 });
  wrapperThrowsAfterTakingControl.add('steer', 'finish', /** Run the callback. */ () => ({ event: { downstream: true } }));
  const recovered = await wrapperThrowsAfterTakingControl.steer('finish', evt());
  assert.equal(recovered.event.downstream, true);
  assert.equal(wrapperErrs.length, 1);
});

test('a downstream {safety:true} throw becomes a sticky deny via previous()', /** Verify a downstream {safety:true} throw becomes a sticky deny via previous(). */ async () => {
  const eng = registry({ /** Implement onError. */ onError() {} });
  eng.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    const inner = await previous();
    return inner; // pass the subtree outcome through
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { throw new Error('safety boom'); }, { safety: true });
  const out = await eng.steer('finish', evt());
  assert.equal(out.deny, 'finish safety hook failed');
});

test('inject context survives auto-continue and sticky deny outcomes', /** Verify inject context survives auto-continue and sticky deny outcomes. */ async () => {
  const eng = registry();
  eng.add('steer', 'finish', /** Run the callback. */ () => ({ inject: 'coach the final answer' }), { priority: 300 });
  eng.add('steer', 'finish', /** Run the callback. */ () => ({ event: { tagged: true } }), { priority: 200 });
  const passed = await eng.steer('finish', evt());
  assert.equal(passed.event.tagged, true);
  assert.equal(passed.inject, 'coach the final answer');

  const denied = registry();
  denied.add('steer', 'finish', /** Run the callback. */ () => ({ inject: 'explain the block' }), { priority: 300 });
  denied.add('steer', 'finish', /** Run the callback. */ () => ({ deny: 'blocked downstream' }), { priority: 200 });
  assert.deepEqual(await denied.steer('finish', evt()), { deny: 'blocked downstream', inject: 'explain the block' });
});

test('a wrapper can provide inject context around downstream results', /** Verify a wrapper can provide inject context around downstream results. */ async () => {
  const eng = registry();
  eng.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    await previous();
    return { inject: 'outer guidance' };
  }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => ({ event: { inner: true }, inject: 'inner guidance' }));
  const out = await eng.steer('finish', evt());
  assert.equal(out.event.inner, true);
  assert.equal(out.inject, 'outer guidance');

  const preserved = registry();
  preserved.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    await previous();
    return { event: { outer: true } };
  }, { priority: 200 });
  preserved.add('steer', 'finish', /** Run the callback. */ () => ({ event: { inner: true }, inject: 'inner guidance' }));
  const preservedOut = await preserved.steer('finish', evt());
  assert.equal(preservedOut.event.inner, true);
  assert.equal(preservedOut.event.outer, true);
  assert.equal(preservedOut.inject, 'inner guidance');

  const denied = registry();
  denied.add('steer', 'finish', /** Run the callback. */ async (_e, { previous }) => {
    await previous();
    return { deny: 'outer deny', inject: 'outer explanation' };
  }, { priority: 200 });
  denied.add('steer', 'finish', /** Run the callback. */ () => ({ event: { inner: true } }));
  assert.deepEqual(await denied.steer('finish', evt()), { deny: 'outer deny', inject: 'outer explanation' });
});

// ── STEER: timeout / error policy () ──────────────────────────────────────────────────────────

test('a steering timeout is fail-open by default (skip, continue the chain)', /** Verify a steering timeout is fail-open by default (skip, continue the chain). */ async () => {
  const errs = [];
  const eng = registry({ /** Implement onError. */ onError(e) { return errs.push(e); } });
  let lowerRan = false;
  eng.add('steer', 'finish', /** Run the callback. */ () => new Promise(/** Run the callback. */ () => {}), { priority: 200, timeout: 20 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { lowerRan = true; return { event: { ok: true } }; });
  const out = await eng.steer('finish', evt());
  assert.equal(lowerRan, true);
  assert.equal(out.event.ok, true);
  assert.equal(errs.length, 1);
});

test('a steering timeout on a {safety:true} handler is fail-closed (deny)', /** Verify a steering timeout on a {safety:true} handler is fail-closed (deny). */ async () => {
  const eng = registry({ /** Implement onError. */ onError() {} });
  eng.add('steer', 'tool', /** Run the callback. */ () => new Promise(/** Run the callback. */ () => {}), { timeout: 20, safety: true });
  const out = await eng.steer('tool', evt({ action: 'tool' }));
  assert.equal(out.deny, 'tool safety hook failed');
});

test('a thrown error in a non-safety steering handler is fail-open', /** Verify a thrown error in a non-safety steering handler is fail-open. */ async () => {
  const errs = [];
  const eng = registry({ /** Implement onError. */ onError(e) { return errs.push(e); } });
  let lowerRan = false;
  eng.add('steer', 'finish', /** Run the callback. */ () => { throw new Error('boom'); }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ () => { lowerRan = true; });
  const out = await eng.steer('finish', evt());
  assert.equal(lowerRan, true);
  assert.ok('event' in out);
  assert.equal(errs.length, 1);
});

test('in-place mutation of a handler argument does not corrupt the threaded event', /** Verify in-place mutation of a handler argument does not corrupt the threaded event. */ async () => {
  const eng = registry();
  eng.add('steer', 'finish', /** Run the callback. */ (e) => { e.payload.injected = 'mutated'; }, { priority: 200 });
  eng.add('steer', 'finish', /** Run the callback. */ (e) => ({ event: { sawInjected: e.payload.injected ?? 'clean' } }));
  const out = await eng.steer('finish', evt({ payload: { x: 1 } }));
  assert.equal(out.event.sawInjected, 'clean'); // mutation discarded
});

// ── OBSERVE: fan-out () ─────────────────────────────────────────────────────────────────────────

test('on fan-out runs all observers and ignores their return values', /** Verify on fan-out runs all observers and ignores their return values. */ async () => {
  const eng = registry();
  const seen = [];
  eng.add('observe', 'test:done', /** Run the callback. */ (e) => { seen.push(['a', e.repo]); return { deny: 'ignored' }; });
  eng.add('observe', 'test:done', /** Run the callback. */ (e) => { seen.push(['b', e.repo]); });
  const result = await eng.fanout('test:done', { repo: 'r1' });
  assert.equal(result, undefined); // returns ignored
  assert.deepEqual(seen.sort(), [['a', 'r1'], ['b', 'r1']]);
});

test('one throwing observer does not stop the others; its error is routed to onError', /** Verify one throwing observer does not stop the others; its error is routed to onError. */ async () => {
  const errs = [];
  const eng = registry({ /** Implement onError. */ onError(e) { return errs.push(e); } });
  let secondRan = false;
  eng.add('observe', 'work', /** Run the callback. */ () => { throw new Error('observer boom'); }, { priority: 200 });
  eng.add('observe', 'work', /** Run the callback. */ () => { secondRan = true; });
  await eng.fanout('work', {});
  assert.equal(secondRan, true);
  assert.equal(errs.length, 1);
  assert.match(String(errs[0].message), /observer boom/);
});

test('a timing-out observer is isolated (fan-out still resolves, others run)', /** Verify a timing-out observer is isolated (fan-out still resolves, others run). */ async () => {
  const errs = [];
  const eng = registry({ /** Implement onError. */ onError(e) { return errs.push(e); } });
  let ran = false;
  eng.add('observe', 'work', /** Run the callback. */ () => new Promise(/** Run the callback. */ () => {}), { timeout: 20 });
  eng.add('observe', 'work', /** Run the callback. */ () => { ran = true; });
  await eng.fanout('work', {});
  assert.equal(ran, true);
  assert.equal(errs.length, 1);
});

test('remove drops one handler or all for a key', /** Verify remove drops one handler or all for a key. */ async () => {
  const eng = registry();
  const seen = [];
  /** Implement a. */ function a() { return seen.push('a'); }
  /** Implement b. */ function b() { return seen.push('b'); }
  eng.add('observe', 'k', a);
  eng.add('observe', 'k', b);
  eng.remove('observe', 'k', a);
  await eng.fanout('k', {});
  assert.deepEqual(seen, ['b']);
  eng.remove('observe', 'k');
  await eng.fanout('k', {});
  assert.deepEqual(seen, ['b']); // nothing new
  eng.remove('observe', 'missing-key');
  await eng.fanout('missing-key', {});
});

test('wildcard observers receive exact events without duplicating fanout of wildcard itself', /** Verify wildcard observers receive exact events without duplicating fanout of wildcard itself. */ async () => {
  const eng = registry();
  const seen = [];
  eng.add('observe', 'work', /** Run the callback. */ (e) => seen.push(['exact', e.id]), { priority: 200 });
  eng.add('observe', '*', /** Run the callback. */ (e) => seen.push(['wild', e.id]));

  await eng.fanout('work', { id: 1 });
  assert.deepEqual(seen, [['exact', 1], ['wild', 1]]);

  seen.length = 0;
  await eng.fanout('*', { id: 2 });
  assert.deepEqual(seen, [['wild', 2]]);
});
