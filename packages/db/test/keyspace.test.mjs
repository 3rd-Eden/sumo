import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pad, seq20, idx10, expiresAt13, evtKey, ttlKey, upperBound, prefixRange,
  evtRangeSince, ttlDueRange, PREFIX
} from '../src/keyspace.mjs';

test('keyspace helpers preserve lexical ordering and range boundaries', /** Verify keyspace helpers preserve lexical ordering and range boundaries. */ () => {
  assert.equal(pad(7, 4), '0007');
  assert.equal(pad(1234, 4), '1234');
  assert.ok(seq20(2) > seq20(1));
  assert.ok(seq20(10) > seq20(9)); // would fail without fixed-width padding
  assert.equal(seq20(1).length, 20);
  assert.equal(idx10(1).length, 10);
  assert.equal(expiresAt13(1).length, 13);

  assert.throws(/** Run the callback. */ () => pad(-1, 4));
  assert.throws(/** Run the callback. */ () => pad(1.5, 4));
  assert.throws(/** Run the callback. */ () => pad(99999, 4));

  assert.equal(upperBound('evt:'), 'evt;'); // ':' 0x3A -> ';' 0x3B
  assert.equal(upperBound(''), undefined);
  const { gte, lt } = prefixRange(PREFIX.evt);
  assert.equal(gte, 'evt:');
  assert.equal(lt, 'evt;');

  const events = evtRangeSince(5);
  assert.equal(events.gt, evtKey(5));
  assert.equal(events.lt, 'evt;');
  assert.equal(evtRangeSince(0).gt, evtKey(0));

  const now = 1_000;
  const ttl = ttlDueRange(now);
  const dueNow = ttlKey(now, 'raw:x');
  const dueEarlier = ttlKey(now - 1, 'raw:y');
  const future = ttlKey(now + 1, 'raw:z');
  assert.ok(ttl.gte <= dueEarlier && dueEarlier < ttl.lt);
  assert.ok(ttl.gte <= dueNow && dueNow < ttl.lt);
  assert.ok(!(future < ttl.lt));
});
