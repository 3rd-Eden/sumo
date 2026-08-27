/**
 * Opportunist detector tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectText } from '../detect.mjs';

test('detects plain dismissive language', () => {
  const findings = detectText({
    text: 'The failure is pre-existing.',
    source: 'reasoning',
    sessionId: 'ses_A',
    now: 1
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].phrase, 'pre-existing');
  assert.equal(findings[0].kind, 'dismissive');
  assert.equal(findings[0].sessionId, 'ses_A');
  assert.match(findings[0].snippet, /pre-existing/);
});

test('produces stable ids for identical findings', () => {
  const input = {
    text: 'This is a separate concern that I should not handle in this patch.',
    source: 'message',
    sessionId: 'ses_A',
    now: 1
  };

  assert.equal(detectText(input)[0].id, detectText({ ...input, now: 2 })[0].id);
});

test('produces different ids for different snippets', () => {
  const first = detectText({
    text: 'Auth is a separate concern that I should not handle in this patch.',
    source: 'message',
    sessionId: 'ses_A',
    now: 1
  })[0];
  const second = detectText({
    text: 'Storage is a separate concern that I should not handle in this patch.',
    source: 'message',
    sessionId: 'ses_A',
    now: 1
  })[0];

  assert.notEqual(first.id, second.id);
});

test('filters code fences, inline code, direct quotes, and opportunist meta-discussion', () => {
  const samples = [
    '```text\nThe bug is out of scope.\n```',
    'The literal phrase `out of scope` is in inline code.',
    'The example sentence says "not part of this".',
    'The opportunist detector should flag "not related to my change" phrases carefully.'
  ];

  for (const text of samples) {
    assert.deepEqual(detectText({ text, source: 'reasoning', sessionId: 'ses_A', now: 1 }), []);
  }
});
