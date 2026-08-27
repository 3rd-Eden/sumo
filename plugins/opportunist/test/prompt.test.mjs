/**
 * Opportunist prompt template tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseTriageBlock, repairPrompt, triagePrompt } from '../prompt.mjs';

test('triage prompt points the child at Sumo event-log context', () => {
  const prompt = triagePrompt({
    findings: [{
      id: 'find_A',
      kind: 'verification',
      sessionId: 'ses_PARENT',
      command: 'npm test',
      snippet: 'Verification command failed: npm test'
    }],
    recentEvents: [
      { seq: 10, type: 'session.tool', payload: { tool: { name: 'commandExecution', input: { command: 'npm test' }, output: '41 !== 42', exitCode: 1, status: 'failed' } } }
    ],
    cwd: '/tmp/project',
    config: { harness: 'codex', tier: 'fast' }
  });

  assert.match(prompt, /node .+packages\/cli\/src\/cli\.mjs events --session ses_PARENT --json/);
  assert.match(prompt, /--type session\.message/);
  assert.match(prompt, /--type session\.tool/);
  assert.match(prompt, /--type session\.reasoning/);
  assert.match(prompt, /node .+packages\/cli\/src\/cli\.mjs opportunist-findings --sessionId ses_PARENT/);
  assert.match(prompt, /Findings JSON/);
  assert.match(prompt, /command:npm test/);
  assert.match(prompt, /41 !== 42/);
});

test('repair prompt includes triage instructions and result contract', () => {
  const prompt = repairPrompt({
    finding: {
      id: 'find_A',
      kind: 'verification',
      sessionId: 'ses_PARENT',
      command: 'npm test',
      snippet: 'Verification command failed: npm test'
    },
    recentEvents: [],
    cwd: '/tmp/project',
    triageInstruction: 'Fix src/legacy.mjs so the failing arithmetic test passes.'
  });

  assert.match(prompt, /Fix src\/legacy\.mjs/);
  assert.match(prompt, /OPPORTUNIST_RESULT/);
  assert.match(prompt, /status: fixed \| triaged \| false-positive \| bypassed/);
});

test('parseTriageBlock accepts strict JSON decisions and rejects invalid repair decisions', () => {
  const parsed = parseTriageBlock([
    'OPPORTUNIST_TRIAGE',
    '{"decisions":[{"id":"find_A","action":"repair","reason":"test is still red","prompt":"Fix the failing test."}]}',
    'END_OPPORTUNIST_TRIAGE'
  ].join('\n'));

  assert.deepEqual(parsed, {
    decisions: [{ id: 'find_A', action: 'repair', reason: 'test is still red', prompt: 'Fix the failing test.' }]
  });

  assert.equal(parseTriageBlock([
    'OPPORTUNIST_TRIAGE',
    '{"decisions":[{"id":"find_A","action":"repair","reason":"test is still red"}]}',
    'END_OPPORTUNIST_TRIAGE'
  ].join('\n')), null);
});
