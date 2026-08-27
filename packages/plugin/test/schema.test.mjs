import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ok,
  fail,
  isResult,
  ErrorSchema,
  DeclSchema,
  DepSchema,
  HandlerSchema,
  STEER_TIMEOUT_MS,
  OBSERVE_TIMEOUT_MS,
  RUNTIME_PLUGIN_ID
} from '../src/schema.mjs';

test('plugin schema helpers validate Results, declarations, handlers and exported constants', /** Verify plugin schema helpers validate Results, declarations, handlers and exported constants. */ () => {
  assert.deepEqual(ok(), { ok: true });
  assert.deepEqual(ok(42), { ok: true, value: 42 });
  assert.deepEqual(fail('SUMO_NO_HARNESS', 'no harness'), { ok: false, code: 'SUMO_NO_HARNESS', reason: 'no harness' });

  assert.equal(isResult(ok(1)), true);
  assert.equal(isResult(fail('X', 'y')), true);
  assert.equal(isResult({ value: 1 }), false);
  assert.equal(isResult(null), false);
  assert.equal(isResult('nope'), false);

  for (const c of ['SUMO_NO_HARNESS', 'SUMO_NO_MESSENGER', 'SUMO_NO_INTERACTION', 'SUMO_CAP_UNSUPPORTED', 'SUMO_PLUGIN_DEP_MISSING']) {
    assert.equal(ErrorSchema.safeParse(c).success, true);
  }
  assert.equal(ErrorSchema.safeParse('SUMO_NOPE').success, false);

  assert.equal(DepSchema.safeParse('sumo-plugin-github').success, true);
  assert.equal(DepSchema.safeParse({ name: 'sumo-plugin-knowledge', version: '^2' }).success, true);
  assert.equal(DepSchema.safeParse({ version: '^2' }).success, false);
  assert.equal(DeclSchema.safeParse({}).success, true);
  assert.equal(DeclSchema.safeParse({ name: 'github', plugins: ['a', { name: 'b', version: '^1' }] }).success, true);

  assert.equal(HandlerSchema.safeParse({ priority: 200 }).success, true);
  assert.equal(HandlerSchema.safeParse({ timeout: 1000, safety: true }).success, true);
  assert.equal(HandlerSchema.safeParse({ timeout: -1 }).success, false);

  assert.equal(STEER_TIMEOUT_MS, 5_000);
  assert.equal(OBSERVE_TIMEOUT_MS, 20_000);
  assert.equal(RUNTIME_PLUGIN_ID, '__sumo_runtime__');
});
