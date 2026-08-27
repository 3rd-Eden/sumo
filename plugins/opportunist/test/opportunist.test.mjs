/**
 * Opportunist plugin tests — real plugin runtime + injected isolated daemon.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { plugin } from 'sumo/plugin';
import { waitUntil } from 'sumo/util';
import { allEvents, closeTempDb, openTempDb, sleep } from 'sumo/util/testing';

import opportunistPlugin from '../index.mjs';

const REPO = '/work/test-repo';

process.env.SUMO_INGEST = '0';

/**
 * Spin up an isolated daemon + plugin runtime loaded with opportunist.
 *
 * @param {object} [pluginConfig]
 * @returns {Promise<{ rt: ReturnType<typeof plugin>, db: import('sumo/db').SumoDb, teardown: () => Promise<void> }>}
 */
async function setup(pluginConfig) {
  const ctx = await openTempDb({ prefix: 'sumo-opportunist-test-', idleShutdownMs: 1000 });
  const rt = plugin({ cwd: REPO, db: ctx.db });
  rt.sumo.use(opportunistPlugin, { harness: '__sumo_missing_harness__', ...pluginConfig });
  await rt.start();

  return {
    rt,
    db: ctx.db,
    /** Shut down the runtime and isolated daemon. */
    async teardown() {
      await rt.stop();
      await closeTempDb(ctx);
    }
  };
}

/**
 * Append a session event through the daemon so plugin observers receive it through subscription.
 *
 * @param {import('sumo/db').SumoDb} db
 * @param {string} type
 * @param {Record<string, unknown>} payload
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
async function emitEvent(db, type, payload, sessionId) {
  const seq = await db.append({
    dedupe: `test:opportunist:${type}:${sessionId}:${Date.now()}:${Math.random()}`,
    type,
    source: 'session',
    adapter: 'codex',
    payload,
    sessionId
  });
  await sleep(20);
  return seq;
}

/**
 * Wait until opportunist-findings returns findings matching the predicate.
 *
 * @param {ReturnType<typeof plugin>} rt
 * @param {(findings: Array<Record<string, unknown>>) => boolean} predicate
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function waitForFindings(rt, predicate) {
  return waitUntil(async () => {
    const result = await rt.invoke('opportunist-findings', {});
    assert.equal(result.ok, true);
    const findings = /** @type {{ findings: Array<Record<string, unknown>> }} */ (result.value).findings;
    return predicate(findings) ? findings : false;
  }, { timeoutMs: 2000, intervalMs: 20 });
}

test('session.reasoning records a finding and emits finding-detected without spawning during the active turn', async () => {
  const { rt, db, teardown } = await setup();
  try {
    await emitEvent(db, 'session.started', { harness: 'codex', cwd: REPO, sessionId: 'ses_A' }, 'ses_A');
    const sourceSeq = await emitEvent(db, 'session.reasoning', { text: 'This looks like a separate concern for another change.' }, 'ses_A');

    const findings = await waitForFindings(rt, (items) => items.some((item) => item.sourceEventSeq === sourceSeq));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, 'dismissive');
    assert.equal(findings[0].state, 'open');
    assert.equal(findings[0].phrase, 'separate concern');
    assert.equal(findings[0].sourceEventSeq, sourceSeq);
    assert.equal(findings[0].spawnFailure, undefined);
    assert.ok(findings[0].recentEvents.some((event) => event.type === 'session.started' && event.payload.cwd === REPO));

    const events = await allEvents(db);
    assert.ok(events.some((event) => event.type === 'opportunist.finding-detected' && event.payload.id === findings[0].id));
    assert.equal(events.some((event) => event.type === 'opportunist.repair-inconclusive' && event.payload.id === findings[0].id), false);
  } finally {
    await teardown();
  }
});

test('stable parent turn starts triage once for a duplicate finding id', async () => {
  const { rt, db, teardown } = await setup();
  try {
    await emitEvent(db, 'session.reasoning', { text: 'Auth is out of scope for this change.' }, 'ses_A');
    await waitForFindings(rt, (items) => items.length === 1);
    await emitEvent(db, 'session.turn-completed', { sessionId: 'ses_A' }, 'ses_A');
    await waitForFindings(rt, (items) => items.length === 1 && Boolean(items[0].triageFailure));

    await emitEvent(db, 'session.reasoning', { text: 'Auth is out of scope for this change.' }, 'ses_A');
    await emitEvent(db, 'session.turn-completed', { sessionId: 'ses_A' }, 'ses_A');
    await sleep(100);

    const result = await rt.invoke('opportunist-findings', {});
    assert.equal(result.ok, true);
    assert.equal(result.value.findings.length, 1);

    const events = await allEvents(db);
    const inconclusive = events.filter((event) => event.type === 'opportunist.repair-inconclusive');
    assert.equal(inconclusive.length, 1);
  } finally {
    await teardown();
  }
});

test('enabled:false leaves commands callable and skips event processing', async () => {
  const { rt, db, teardown } = await setup({ enabled: false });
  try {
    await emitEvent(db, 'session.reasoning', { text: 'This is not part of this change.' }, 'ses_A');

    const result = await rt.invoke('opportunist-findings', {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.findings, []);

    const resolve = await rt.invoke('opportunist-resolve', { id: 'missing', status: 'triaged', evidence: 'manual check' });
    assert.equal(resolve.ok, true);
    assert.deepEqual(resolve.value, { ok: false, reason: 'finding not found: missing' });
  } finally {
    await teardown();
  }
});

test('assistant session.message is scanned, user message is ignored, and terminal sessions are not scanned after death', async () => {
  const { rt, db, teardown } = await setup();
  try {
    await emitEvent(db, 'session.message', { role: 'user', text: 'This is out of scope.' }, 'ses_A');
    await sleep(100);
    assert.deepEqual((await rt.invoke('opportunist-findings', {})).value.findings, []);

    await emitEvent(db, 'session.message', { role: 'assistant', text: 'This is out of scope.' }, 'ses_A');
    await waitForFindings(rt, (items) => items.length === 1);

    await emitEvent(db, 'session.dead', { sessionId: 'ses_B' }, 'ses_B');
    await emitEvent(db, 'session.reasoning', { text: 'This is out of scope.' }, 'ses_B');
    await sleep(100);

    const result = await rt.invoke('opportunist-findings', {});
    assert.equal(result.value.findings.length, 1);
    assert.equal(result.value.findings[0].sessionId, 'ses_A');
  } finally {
    await teardown();
  }
});

test('verification failure records a finding and later pass resolves it', async () => {
  const { rt, db, teardown } = await setup();
  try {
    const command = 'node --test plugins/opportunist/test/detect.test.mjs';
    await emitEvent(db, 'session.tool', { tool: { name: 'Bash', input: { command }, exitCode: 1 } }, 'ses_A');
    const findings = await waitForFindings(rt, (items) => items.length === 1);

    assert.equal(findings[0].kind, 'verification');
    assert.equal(findings[0].command, command);
    assert.equal(findings[0].state, 'open');

    await emitEvent(db, 'session.tool', { tool: { name: 'Bash', input: { command }, exitCode: 0 } }, 'ses_A');
    const resolved = await waitForFindings(rt, (items) => items[0]?.state === 'resolved');
    assert.equal(resolved[0].resolutionStatus, 'fixed');
    assert.match(resolved[0].evidence, /green rerun/);
  } finally {
    await teardown();
  }
});

test('opportunist-findings filters and opportunist-resolve records evidence', async () => {
  const { rt, db, teardown } = await setup();
  try {
    await emitEvent(db, 'session.reasoning', { text: 'The formatter failure is unrelated to my change.' }, 'ses_A');
    const findings = await waitForFindings(rt, (items) => items.length === 1);
    const id = findings[0].id;

    const filtered = await rt.invoke('opportunist-findings', { state: 'open', sessionId: 'ses_A' });
    assert.equal(filtered.ok, true);
    assert.equal(filtered.value.findings.length, 1);
    assert.equal(filtered.value.findings[0].id, id);

    const resolved = await rt.invoke('opportunist-resolve', { id, status: 'triaged', evidence: 'Reviewed formatter failure and opened follow-up issue.' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value.state, 'resolved');
    assert.equal(resolved.value.resolutionStatus, 'triaged');
    assert.match(resolved.value.evidence, /formatter/);

    const events = await allEvents(db);
    assert.ok(events.some((event) => event.type === 'opportunist.repair-resolved' && event.payload.id === id));
  } finally {
    await teardown();
  }
});

test('event intake preserves harmless malformed records and recognizes normalized verification failures', async () => {
  const { rt, db, teardown } = await setup();
  try {
    // These are normalized event shapes seen at the plugin boundary; none should invent a finding.
    await db.append({ dedupe: `opportunist:missing-session:${Date.now()}`, type: 'session.reasoning', source: 'session', payload: { text: 'This is out of scope.' } });
    await emitEvent(db, 'session.tool', { tool: null }, 'ses_empty_tool');
    await emitEvent(db, 'session.idle', {}, 'ses_idle');

    // Exercise each supported normalized failure representation through the actual observer path.
    await emitEvent(db, 'session.tool', { tool: { input: 'node --test status-failure.mjs', status: 'failed' } }, 'ses_status');
    await emitEvent(db, 'session.tool', { tool: { input: { cmd: 'npm test' }, output: { exitCode: 1 } } }, 'ses_output_code');
    await emitEvent(db, 'session.tool', { tool: { input: { command: 'pnpm test' }, output: { status: 'error' } } }, 'ses_output_status');
    await emitEvent(db, 'session.tool', { tool: { input: { command: 'node --test text-failure.mjs' }, output: 'AssertionError: expected pass' } }, 'ses_output_text');
    await emitEvent(db, 'session.tool', { tool: { input: { command: 'node --test nested-output.mjs' }, output: { text: 'tests failed' } } }, 'ses_nested_output');
    await emitEvent(db, 'session.tool', { tool: { input: { command: 'node --test clean-output.mjs' }, output: 'all clear' } }, 'ses_clean_output');
    await emitEvent(db, 'session.tool', { tool: { input: {}, output: 'tests failed' } }, 'ses_no_command');
    await db.append({
      dedupe: `opportunist:payload-session:${Date.now()}`,
      type: 'session.tool',
      source: 'session',
      payload: { sessionId: 'ses_payload', tool: { input: { command: 'node --test payload-session.mjs' }, exitCode: 1 } }
    });

    const findings = await waitForFindings(rt, (items) => items.length === 6);
    assert.deepEqual(
      findings.map((finding) => finding.sessionId).sort(),
      ['ses_nested_output', 'ses_output_code', 'ses_output_status', 'ses_output_text', 'ses_payload', 'ses_status']
    );
    assert.equal(findings.some((finding) => finding.sessionId === 'ses_clean_output'), false);
    assert.equal(findings.some((finding) => finding.sessionId === 'ses_no_command'), false);
  } finally {
    await teardown();
  }
});

test('finding queries filter independently by state and session', async () => {
  const { rt, db, teardown } = await setup();
  try {
    await emitEvent(db, 'session.reasoning', { text: 'This is unrelated to my change.' }, 'ses_filter_a');
    await emitEvent(db, 'session.reasoning', { text: 'This is unrelated to my change.' }, 'ses_filter_b');
    const findings = await waitForFindings(rt, (items) => items.length === 2);
    const first = findings.find((finding) => finding.sessionId === 'ses_filter_a');
    assert.ok(first);

    const resolved = await rt.invoke('opportunist-resolve', { id: first.id, status: 'triaged', evidence: 'manual triage' });
    assert.equal(resolved.ok, true);

    const openForA = await rt.invoke('opportunist-findings', { state: 'open', sessionId: 'ses_filter_a' });
    assert.equal(openForA.ok, true);
    assert.deepEqual(openForA.value.findings, []);

    const resolvedForB = await rt.invoke('opportunist-findings', { state: 'resolved', sessionId: 'ses_filter_b' });
    assert.equal(resolvedForB.ok, true);
    assert.deepEqual(resolvedForB.value.findings, []);
  } finally {
    await teardown();
  }
});
