/**
 * Contract pass: the `sumo/transcript` base machinery and output schema through real parser adapters
 * and captured fixtures. No in-test parser subclasses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { Parser, adapters, isResult, CAP_UNSUPPORTED, EventSchema, TYPES } from '../src/index.mjs';
import { raw } from '../src/base/helpers.mjs';
import { findSecrets } from './scrub.mjs';

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIX = path.join(DIR, 'fixtures');

/**
 * Read one captured JSONL fixture.
 * @param {string} rel
 * @returns {any[]}
 */
function read(rel) {
  return fs.readFileSync(path.join(FIX, rel), 'utf8').split('\n').filter(/** Select matching items. */ (line) => line.trim()).map(/** Map one item. */ (line) => JSON.parse(line));
}

test('transcript base schema and real Parser capability contracts hold', /** Verify transcript base schema and real Parser capability contracts hold. */ () => {
  for (const type of TYPES) {
    const e = EventSchema.parse({ type });
    assert.deepEqual(e.payload, {});
    assert.deepEqual(e.ext, {});
  }

  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse({ type: 'session.raw:api_retry' }));
  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse({ type: 'session.raw:message.part.updated' }));

  assert.throws(/** Run the callback. */ () => EventSchema.parse({ type: 'session.todo' }), /known 07 type/);
  assert.throws(/** Run the callback. */ () => EventSchema.parse({ type: 'whatever' }), /known 07 type/);

  const e = EventSchema.parse({ type: 'session.message', payload: { role: 'assistant', text: 'hi' }, id: 'uuid#0' });
  assert.equal(e.id, 'uuid#0');
  assert.deepEqual(e.payload, { role: 'assistant', text: 'hi' });

  const claude = new adapters['claude-code']();
  const events = read('claude-code/stream/turn.jsonl').flatMap(/** Run the callback. */ (frame) => [...claude.stream(frame)]);
  assert.ok(events.length > 0, 'real Claude fixture produced validated normalized events');
  assert.ok(events.some(/** Test whether an item matches. */ (event) => event.type === 'session.message'));

  assert.doesNotThrow(/** Run the callback. */ () => EventSchema.parse({ type: 'session.raw:message.part.delta' }));
  assert.throws(/** Run the callback. */ () => EventSchema.parse({ type: 'session.raw:foo\ninjected' }), /known 07 type/);
  assert.throws(/** Run the callback. */ () => EventSchema.parse({ type: 'session.raw:foo bar' }), /known 07 type/);
  assert.throws(/** Run the callback. */ () => EventSchema.parse({ type: 'session.raw:' }), /known 07 type/);

  const zeroTs = raw('session', 'x', { a: 1 }, { ts: 0 });
  assert.equal(EventSchema.parse(zeroTs).ts, 0);

  assert.equal(findSecrets({ authorization: 'opaque-not-a-known-pattern' }).length, 1);
  assert.equal(findSecrets({ authorization: '[REDACTED]' }).length, 0);
  assert.equal(findSecrets({ note: 'plain text' }).length, 0);

  const opencode = new adapters.opencode();
  const r = opencode.file({});
  assert.ok(isResult(r));
  assert.equal(r.ok, false);
  assert.equal(r.code, CAP_UNSUPPORTED);
  assert.match(r.reason, /opencode/);

  const supported = claude.stream(read('claude-code/stream/turn.jsonl')[0]);
  assert.equal(isResult(supported), false);
  assert.equal(typeof supported[Symbol.iterator], 'function');

  const base = new Parser();
  const unsupported = base.stream({});
  assert.ok(isResult(unsupported));
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, CAP_UNSUPPORTED);
});
