import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, forContent, forEvent, mergeEvent } from '../src/dedupe.mjs';

test('join prefixes the id by source', /** Verify join prefixes the id by source. */ () => {
  assert.equal(join('uuid', 'abc-123'), 'uuid:abc-123');
});

test('forContent is deterministic and position-sensitive', /** Verify forContent is deterministic and position-sensitive. */ () => {
  const base = { sessionId: 'ses_1', kind: 'message', payload: { text: 'ok' }, position: 0 };
  assert.equal(forContent(base), forContent({ ...base }));
  assert.notEqual(forContent(base), forContent({ ...base, position: 1 }));
  // key order in payload must not change the hash (canonical stringify)
  const a = forContent({ ...base, payload: { a: 1, b: 2 } });
  const b = forContent({ ...base, payload: { b: 2, a: 1 } });
  assert.equal(a, b);
  assert.match(forContent(base), /^sha256:[0-9a-f]{64}$/);
});

test('forEvent uses natural ids when present and the shared content hash otherwise', /** Verify forEvent uses natural ids when present and the shared content hash otherwise. */ () => {
  assert.equal(forEvent({ id: 'native-1', type: 'session.message', sessionId: 'ses_a' }), 'msg:ses_a:native-1');
  assert.notEqual(
    forEvent({ id: 'native-1', type: 'session.message', sessionId: 'ses_a' }),
    forEvent({ id: 'native-1', type: 'session.message', sessionId: 'ses_b' }),
    'a native id cannot merge events from independent sessions'
  );
  assert.match(forEvent({ type: 'session.message', sessionId: 'ses_a' }), /^sha256:/);
  assert.equal(
    forEvent({ type: 'session.message' }, { sessionId: 'ses_a', position: 3 }),
    forContent({ sessionId: 'ses_a', kind: 'session.message', payload: {}, position: 3 })
  );
  assert.equal(
    forContent({ kind: 'session.message', position: 4 }),
    forContent({ sessionId: null, kind: 'session.message', payload: null, position: 4 })
  );
});

test('mergeEvent fills gaps, never overwrites present values, deep-merges ext', /** Verify mergeEvent fills gaps, never overwrites present values, deep-merges ext. */ () => {
  const stored = {
    seq: 7, ts: 100, dedupe: 'uuid:abc', type: 'session.tool',
    payload: { name: 'bash' },
    ext: { claude: { permissionMode: 'default' } }
  };
  const incoming = {
    dedupe: 'uuid:abc', type: 'session.tool', ts: 999,
    payload: { name: 'IGNORED', output: 'done' }, // name present on stored -> kept; output filled
    sessionId: 'ses_1', // absent on stored -> filled
    ext: { transcript: { parentUuid: 'p1' } } // different ext key -> unioned
  };
  const merged = mergeEvent(stored, incoming);

  assert.equal(merged.seq, 7); // identity preserved
  assert.equal(merged.ts, 100); // present -> first-writer wins
  assert.equal(merged.payload.name, 'bash'); // present -> not overwritten
  assert.equal(merged.payload.output, 'done'); // gap -> filled
  assert.equal(merged.sessionId, 'ses_1'); // gap -> filled
  assert.deepEqual(merged.ext, { // ext deep-merge union
    claude: { permissionMode: 'default' },
    transcript: { parentUuid: 'p1' }
  });
  // input is not mutated
  assert.equal(stored.payload.output, undefined);
});
