import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EventInput, Event, SessionSchema, ControlRequest, ControlResponse,
  id, ID_REGEXP
} from '../src/schema.mjs';
import { isLockError } from '../src/errors.mjs';
import { SumoError } from 'sumo/error';

test('db schemas validate events, sessions, control messages, ids and lock errors', /** Verify db schemas validate events, sessions, control messages, ids and lock errors. */ () => {
  const parsed = EventInput.parse({ dedupe: 'uuid:abc', type: 'session.tool' });
  assert.deepEqual(parsed.payload, {});
  assert.deepEqual(parsed.ext, {});
  assert.equal(EventInput.safeParse({ type: 'x' }).success, false);
  assert.equal(EventInput.safeParse({ dedupe: 'd' }).success, false);
  assert.equal(Event.safeParse({ dedupe: 'd', type: 't', ts: 1 }).success, false);
  assert.ok(Event.parse({ dedupe: 'd', type: 't', ts: 1, seq: 10 }).seq === 10);

  const doc = SessionSchema.parse({ id: id(), harness: 'claude-code', state: 'working', createdAt: 1, updatedAt: 2 });
  assert.deepEqual(doc.ext, {});
  const a = id();
  const b = id();
  assert.match(a, ID_REGEXP);
  assert.ok(b > a);

  assert.equal(ControlRequest.parse({ id: '1', op: 'append', event: { dedupe: 'd', type: 't' } }).op, 'append');
  assert.equal(ControlRequest.parse({ id: '1a', op: 'put', key: 'k', value: { v: 1 } }).op, 'put');
  assert.equal(ControlRequest.parse({ id: '1b', op: 'del', key: 'k' }).op, 'del');
  assert.equal(ControlRequest.parse({ id: '2', op: 'subscribe' }).since, 0);
  assert.equal(ControlRequest.parse({ id: '3', op: 'search', query: 'q' }).limit, 20);
  assert.equal(ControlRequest.safeParse({ id: '4', op: 'nope' }).success, false);

  assert.ok(ControlResponse.safeParse({ id: '1', ok: true, seq: 5, deduped: false }).success);
  assert.ok(ControlResponse.safeParse({ id: '2', ok: true }).success);
  assert.ok(ControlResponse.safeParse({ id: '3', ok: true, hits: [{ docref: 'r', score: 1.2 }] }).success);
  const errBody = new SumoError({ name: 'db', method: 'start', code: 'SUMO_DB_LOCKED', message: 'x' }).toJSON();
  assert.ok(ControlResponse.safeParse({ id: '4', ok: false, error: errBody }).success);
  assert.ok(ControlResponse.safeParse({ id: null, ok: false, error: errBody }).success);
  assert.ok(ControlResponse.safeParse({ sub: '6', seq: 1 }).success);
  assert.equal(ControlResponse.safeParse({ sub: '6', event: { dedupe: 'd' } }).success, false);

  assert.equal(isLockError({ code: 'LEVEL_LOCKED' }), true);
  assert.equal(isLockError({ code: 'LEVEL_DATABASE_NOT_OPEN', cause: { message: 'database lock is held' } }), true);
  assert.equal(isLockError(new Error('failed to acquire LOCK file')), true);
  assert.equal(isLockError({ cause: { message: 'resource lock unavailable' } }), true);
  assert.equal(isLockError({ code: 'LEVEL_DATABASE_NOT_OPEN', cause: {}, message: 'closed' }), false);
  assert.equal(isLockError({ message: 'closed', cause: {} }), false);
  assert.equal(isLockError({ code: 'LEVEL_DATABASE_NOT_OPEN', cause: { message: 'closed' }, message: 'closed' }), false);
});
