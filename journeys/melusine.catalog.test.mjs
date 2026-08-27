import { test } from 'node:test';
import assert from 'node:assert/strict';

import catalog, { input } from './melusine.catalog.mjs';

function call(options, context = {}) {
  return {
    args: [],
    context,
    meta: {},
    node: { id: 'node', kind: 'process', label: 'Node' },
    previous: [],
    config: { use: 'x', args: [], options, raw: options },
    key: 'x'
  };
}

test('catalog exports Melusine entries directly', () => {
  assert.equal(catalog.start.kind, 'task');
  assert.equal(catalog['session-spawn'].kind, 'task');
  assert.equal(catalog['session-is-running'].kind, 'scorer');
});

test('catalog input uses explicit context references instead of latest-output threading', () => {
  const context = {
    first: { sessionId: 'ses_FIRST' },
    second: { sessionId: 'ses_SECOND' },
    work: { workRef: 'work_123' },
    native: { resumeId: 'codex-native-thread' },
    sentTurn: { sessionId: 'ses_SECOND', turn: { id: 'turn_123' } }
  };

  assert.deepEqual(input(call({ session: 'first' }, context)), { sessionId: 'ses_FIRST' });
  assert.deepEqual(input(call({ session: 'second' }, context)), { sessionId: 'ses_SECOND' });
  assert.deepEqual(input(call({ session: 'second', sessionId: 'ses_PINNED' }, context)), { sessionId: 'ses_PINNED' });
  assert.deepEqual(input(call({ work: 'work' }, context)), { workRef: 'work_123' });
  assert.deepEqual(input(call({ resumeFrom: 'native' }, context)), { resumeId: 'codex-native-thread' });
  assert.deepEqual(input(call({ session: 'second', turn: 'sentTurn', timeoutMs: 1000 }, context)), {
    sessionId: 'ses_SECOND',
    turn: { id: 'turn_123' },
    timeoutMs: 1000
  });
});
