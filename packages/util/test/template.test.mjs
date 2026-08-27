/**
 * Template rendering utility tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderTemplate } from '../src/index.mjs';

test('renderTemplate replaces dotted variables and JSON values', () => {
  const rendered = renderTemplate('id={finding.id}\nitems={items}\nmissing={missing}', {
    finding: { id: 'find_A' },
    items: [{ name: 'one' }]
  });

  assert.match(rendered, /id=find_A/);
  assert.match(rendered, /"name": "one"/);
  assert.match(rendered, /missing=\{missing\}$/);
});

test('renderTemplate resolves literal dotted keys before nested paths', () => {
  const rendered = renderTemplate('bad {missing} {unset} {direct.key} {obj}', {
    unset: undefined,
    'direct.key': 'literal',
    obj: { value: 1 }
  });

  assert.match(rendered, /bad \{missing\} \{unset\} literal/);
  assert.match(rendered, /"value": 1/);
});
