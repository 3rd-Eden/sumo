import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactRawValue } from '../src/redaction.mjs';

test('redaction keeps null secret fields and recurses through secret-named objects', /** Verify redaction keeps null secret fields and recurses through secret-named objects. */ () => {
  assert.equal(redactRawValue(null, 'authorization'), null);
  assert.deepEqual(
    redactRawValue({ nested: 'Bearer abcdefghijklmnop' }, 'apiKey'),
    { nested: 'Bearer [REDACTED:token]' }
  );
});
