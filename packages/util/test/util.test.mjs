import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlainObject, withDefined, defined, idAt, textOf, tsMs, cloneValue, timeoutRace } from '../src/index.mjs';

test('isPlainObject matches Sumo mergeable-object semantics', /** Verify isPlainObject matches Sumo mergeable-object semantics. */ () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});

test('withDefined copies only non-empty defined fields', /** Verify withDefined copies only non-empty defined fields. */ () => {
  const target = { kept: true };
  assert.deepEqual(
    withDefined(target, { a: 1, b: undefined, c: null, d: '', e: false }),
    { kept: true, a: 1, e: false }
  );
  assert.equal(withDefined(target, {}), target);
});

test('shared utility helpers normalize optional fields and transcript-shaped values', /** Verify shared utility helpers normalize optional fields and transcript-shaped values. */ () => {
  assert.deepEqual(defined({ a: 1, b: undefined, c: '', d: false }), { a: 1, d: false });
  assert.equal(idAt('msg', 2), 'msg#2');
  assert.equal(idAt('', 2), undefined);
  assert.equal(textOf('hello'), 'hello');
  assert.equal(textOf([{ text: 'a' }, { text: 'b' }, { nope: true }]), 'ab');
  assert.equal(tsMs('2026-07-02T00:00:00.000Z'), 1782950400000);
  assert.equal(tsMs('nope'), undefined);
});

test('cloneValue and timeoutRace behave predictably', /** Verify cloneValue and timeoutRace behave predictably. */ async () => {
  const source = { nested: { value: 1 } };
  const copy = /** @type {{ nested: { value: number } }} */ (cloneValue(source));
  copy.nested.value = 2;
  assert.equal(source.nested.value, 1);

  await assert.rejects(() => timeoutRace(new Promise(() => {}), 1, 'timed out'), /timed out/);
  assert.equal(await timeoutRace(Promise.resolve('ok'), 100), 'ok');
});
