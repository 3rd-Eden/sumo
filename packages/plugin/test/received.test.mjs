import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { toEvent, toSteer, toContext, buildWork } from '../src/received.mjs';
import { openTempDb, closeTempDb } from 'sumo/util/testing';

let ctx;
before(/** Run the before hook. */ async () => { ctx = await openTempDb(); });
after(/** Run the after hook. */ async () => { await closeTempDb(ctx); });

/** Implement record. */ function record(extra = {}) { return ({
  seq: 7,
  ts: 1718800000000,
  type: 'tool.post',
  sessionId: 'ses_abc',
  payload: { tool: { name: 'Bash' } },
  ext: {},
  ...extra
}); }

test('received wrappers preserve plugin event, work, steer, and context contracts', /** Verify received wrappers preserve plugin event, work, steer, and context contracts. */ async () => {
  const e = toEvent(record(), { db: ctx.db, plugin: 'test-gate' });
  const seq = await e.emit('test:done', { repo: 'r1', passed: true });
  assert.equal(typeof seq, 'number');

  // Read it back from the log to prove dedupe/source/provenance were set correctly.
  const stored = await ctx.db.get(`evt:${String(seq).padStart(20, '0')}`);
  assert.equal(stored.type, 'test:done');
  assert.equal(stored.source, 'plugin');
  assert.equal(stored.sessionId, 'ses_abc');
  assert.equal(stored.ext.fromSeq, 7);
  assert.match(stored.dedupe, /^plugin:test-gate:from:7:test:done:/);

  const withoutSession = toEvent(record({ seq: 8, sessionId: undefined, payload: undefined, ext: undefined }), { db: ctx.db, plugin: 'test-gate' });
  const noPayloadSeq = await withoutSession.emit('test:empty');
  const noPayload = await ctx.db.get(`evt:${String(noPayloadSeq).padStart(20, '0')}`);
  assert.equal(noPayload.sessionId, undefined);
  assert.match(noPayload.dedupe, /^plugin:test-gate:from:8:test:empty:/);

  const idempotent = toEvent(record({ seq: 11 }), { db: ctx.db, plugin: 'kb' });
  const a = await idempotent.emit('kb:noted', { id: 1 });
  const b = await idempotent.emit('kb:noted', { id: 1 }); // identical → same seq
  assert.equal(a, b);
  const c = await idempotent.emit('kb:noted', { id: 2 }); // different payload → new seq
  assert.notEqual(a, c);

  await ctx.db.put('raw:ses_abc:0000000001', { native: 'payload' });
  const withRef = toEvent(record({ rawRef: 'raw:ses_abc:0000000001' }), { db: ctx.db, plugin: 'p' });
  assert.deepEqual(await withRef.raw(), { native: 'payload' });

  const missingRef = toEvent(record({ rawRef: 'raw:ses_abc:missing', ext: { fallback: 'ext' } }), { db: ctx.db, plugin: 'p' });
  assert.deepEqual(await missingRef.raw(), { fallback: 'ext' });

  const noRef = toEvent(record({ ext: { only: 'ext' } }), { db: ctx.db, plugin: 'p' });
  assert.deepEqual(await noRef.raw(), { only: 'ext' });

  const nonCloneable = toEvent(record({ payload: { /** Implement fn. */ fn() { return 'kept'; } }, ext: { /** Implement fn. */ fn() { return 'kept'; } } }), { db: ctx.db, plugin: 'p' });
  assert.equal(nonCloneable.payload.fn(), 'kept');
  assert.equal(nonCloneable.ext.fn(), 'kept');

  const withResolver = toEvent(record(), {
    db: ctx.db,
    plugin: 'p',
    /** Implement resolveSession. */ async resolveSession(id) { return ({ id, state: 'working' }); }
  });
  assert.deepEqual(await withResolver.session(), { id: 'ses_abc', state: 'working' });

  const noResolver = toEvent(record(), { db: ctx.db, plugin: 'p' });
  assert.equal(await noResolver.session(), undefined);

  const replies = [];
  const raw = {
    id: 'w1',
    title: 'fix bug',
    ext: { issue: 7 },
    can: { reply: true },
    /** Implement reply. */ reply(text) { replies.push(text); return Promise.resolve(); }
  };
  const work = buildWork(raw, { db: ctx.db, plugin: 'github' });

  // adapter-bound effector survives the decoration
  await work.reply('done');
  assert.deepEqual(replies, ['done']);
  assert.equal(work.can.reply, true);

  // emit appends a derived event through the real daemon client
  const workSeq = await work.emit('pr:opened', { number: 42 });
  const workStored = await ctx.db.get(`evt:${String(workSeq).padStart(20, '0')}`);
  assert.equal(workStored.type, 'pr:opened');
  assert.equal(workStored.source, 'plugin');
  assert.equal(workStored.ext.fromWorkId, 'w1');
  assert.match(workStored.dedupe, /^plugin:github:work:w1:pr:opened:/);

  const idempotentWork = buildWork({ id: 'w2' }, { db: ctx.db, plugin: 'github' });
  const claimA = await idempotentWork.emit('claimed', { who: 'a' });
  const claimB = await idempotentWork.emit('claimed', { who: 'a' });
  assert.equal(claimA, claimB);

  const steer = toSteer({ action: 'tool', payload: { tool: 'rm' }, can: { canDeny: true } });
  assert.equal(steer.action, 'tool');
  assert.equal(steer.can.canDeny, true);
  assert.equal(await steer.raw(), undefined); // default raw

  const native = { native: true };
  const withRaw = toSteer({ action: 'tool', raw: /** Implement raw. */ async () => native });
  assert.deepEqual(await withRaw.raw(), native);

  assert.equal(toContext().surface, 'programmatic');
  const headless = toContext({ surface: 'mcp' });
  const r = await headless.ask('continue?');
  assert.deepEqual(r, { ok: false, code: 'SUMO_NO_INTERACTION', reason: "cannot prompt the user on the 'mcp' surface" });

  const interactive = toContext({ surface: 'cli', /** Implement ask. */ async ask() { return ({ ok: true, value: 'yes' }); } });
  assert.deepEqual(await interactive.ask('continue?'), { ok: true, value: 'yes' });

  const printed = [];
  const warned = [];
  const context = toContext({ surface: 'programmatic', /** Implement print. */ print(t) { return printed.push(t); }, /** Implement warn. */ warn(d) { return warned.push(d); } });
  context.print('hello');
  context.warn({ code: 'X', message: 'y' });
  assert.deepEqual(printed, ['hello']);
  assert.deepEqual(warned, [{ code: 'X', message: 'y' }]);
});
