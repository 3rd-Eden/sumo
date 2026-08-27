import { test } from 'node:test';
import assert from 'node:assert/strict';

import { has, mark, parse } from './_marker.mjs';

test('github markers encode values, round-trip data, and only match their own type', /** Verify github markers encode values, round-trip data, and only match their own type. */ () => {
  const body = [
    'visible text',
    mark('claim', { agent: 'agent "one" & <two>', path: 'src/index.mjs' }),
    mark('release', { agent: 'other' })
  ].join('\n');

  assert.match(body, /&quot;one&quot; &amp; &lt;two&gt;/);
  assert.equal(has(body, 'claim'), true);
  assert.equal(has(body, 'release'), true);
  assert.equal(has(body, 'proof-of-life'), false);
  assert.deepEqual(parse(body, 'claim'), { agent: 'agent "one" & <two>', path: 'src/index.mjs' });
  assert.deepEqual(parse(body, 'release'), { agent: 'other' });
  assert.equal(parse(body, 'proof-of-life'), null);
});

test('github markers support empty payloads and missing bodies', /** Verify github markers support empty payloads and missing bodies. */ () => {
  const body = mark('restart');

  assert.equal(body, '<!-- sumo:restart -->');
  assert.equal(has(body, 'restart'), true);
  assert.deepEqual(parse(body, 'restart'), {});
  assert.equal(has('', 'restart'), false);
  assert.equal(has(undefined, 'restart'), false);
  assert.equal(parse(null, 'restart'), null);
});

test('github marker creation requires a type', /** Verify github marker creation requires a type. */ () => {
  assert.throws(/** Run the callback. */ () => mark('', {}), {
    name: 'SumoError',
    code: 'SUMO_INVALID_ARGUMENT'
  });
});
