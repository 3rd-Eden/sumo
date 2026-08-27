/**
 * Correlation against a REAL daemon (). Recorded mapping is the primary path; a cwd/project +
 * time-window heuristic is the foreign-import fallback. The spawn-time `ses:` writer is spec 04
 * (out of scope), so these tests SEED `ses:` docs (`db.put`) to stand in for it — the dependency the
 * plan surfaces. `correlate` is a pure reader of those docs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { correlate, CAP_UNSUPPORTED, AMBIGUOUS } from '../src/index.mjs';
import { openTempDb } from './_daemon.mjs';

/** Seed a session doc (what the spec-04 spawn-time writer will eventually record). */
function seed(db, doc) { return db.put(`ses:${doc.id}`, { state: 'running', createdAt: 0, updatedAt: 0, ext: {}, ...doc }); }

test('recorded (primary): an exact transcriptPath match wins, via:recorded', /** Verify recorded (primary): an exact transcriptPath match wins, via:recorded. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    await seed(db, { id: 'ses_a', harness: 'claude-code', transcriptPath: '/p/a.jsonl', harnessSessionId: 'nat-a', cwd: '/tmp/x' });
    const r = await correlate(db, { harness: 'claude-code', transcriptPath: '/p/a.jsonl' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.via, 'recorded');
    assert.equal(r.value.sumoId, 'ses_a');
  } finally {
    await cleanup();
  }
});

test('recorded (primary): a native-id match resolves, via:recorded', /** Verify recorded (primary): a native-id match resolves, via:recorded. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    await seed(db, { id: 'ses_b', harness: 'codex', harnessSessionId: '019eecde-c391' });
    const r = await correlate(db, { harness: 'codex', signals: { nativeId: '019eecde-c391' } });
    assert.ok(r.ok);
    assert.equal(r.value.via, 'recorded');
    assert.equal(r.value.sumoId, 'ses_b');
    assert.equal(r.value.native.id, '019eecde-c391');
  } finally {
    await cleanup();
  }
});

test('heuristic (foreign import): cwd + time window resolves a single foreign session, via:heuristic', /** Verify heuristic (foreign import): cwd + time window resolves a single foreign session, via:heuristic. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    // A foreign session: no recorded native id. (A spawned one would have a harnessSessionId.)
    await seed(db, { id: 'ses_c', harness: 'codex', cwd: '/tmp/work', createdAt: 5000 });
    // A spawned session at the same cwd must be ignored by the heuristic (it has a recorded id).
    await seed(db, { id: 'ses_spawned', harness: 'codex', cwd: '/tmp/work', createdAt: 5000, harnessSessionId: 'nat-z' });
    const r = await correlate(db, { harness: 'codex', signals: { cwd: '/tmp/work', tsStart: 4000, tsEnd: 6000 } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.via, 'heuristic');
    assert.equal(r.value.sumoId, 'ses_c');
  } finally {
    await cleanup();
  }
});

test('heuristic: Cursor project (from path) resolves a foreign session', /** Verify heuristic: Cursor project (from path) resolves a foreign session. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    await seed(db, { id: 'ses_d', harness: 'cursor', createdAt: 100, ext: { project: 'my-proj' } });
    const r = await correlate(db, { harness: 'cursor', signals: { project: 'my-proj', tsStart: 0, tsEnd: 200 } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.via, 'heuristic');
    assert.equal(r.value.sumoId, 'ses_d');
  } finally {
    await cleanup();
  }
});

test('correlation is harness-scoped: a same-cwd session of another harness is never matched', /** Verify correlation is harness-scoped: a same-cwd session of another harness is never matched. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    // A Claude and a Codex session share the same cwd (common — same project directory).
    await seed(db, { id: 'ses_claude', harness: 'claude-code', cwd: '/tmp/shared', createdAt: 5000 });
    await seed(db, { id: 'ses_codex', harness: 'codex', cwd: '/tmp/shared', createdAt: 5000 });
    const r = await correlate(db, { harness: 'codex', signals: { cwd: '/tmp/shared', tsStart: 4000, tsEnd: 6000 } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.sumoId, 'ses_codex', 'matched the codex session, not the same-cwd claude one');

    // And a Cursor import with only the Claude/Codex sessions present finds nothing (not a mis-match).
    const miss = await correlate(db, { harness: 'cursor', signals: { cwd: '/tmp/shared', tsStart: 4000, tsEnd: 6000 } });
    assert.equal(miss.ok, false);
    assert.equal(miss.code, CAP_UNSUPPORTED);
  } finally {
    await cleanup();
  }
});

test('heuristic: two candidates in the window → SUMO_AMBIGUOUS (never guesses)', /** Verify heuristic: two candidates in the window → SUMO_AMBIGUOUS (never guesses). */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    await seed(db, { id: 'ses_e1', harness: 'codex', cwd: '/tmp/dup', createdAt: 5000 });
    await seed(db, { id: 'ses_e2', harness: 'codex', cwd: '/tmp/dup', createdAt: 5500 });
    const r = await correlate(db, { harness: 'codex', signals: { cwd: '/tmp/dup', tsStart: 4000, tsEnd: 6000 } });
    assert.equal(r.ok, false);
    assert.equal(r.code, AMBIGUOUS);
  } finally {
    await cleanup();
  }
});

test('heuristic honors open-ended time windows and rejects docs outside the window', /** Verify heuristic honors open-ended time windows and rejects docs outside the window. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    await db.put('ses:ses_none', { id: 'ses_none', harness: 'codex', cwd: '/tmp/windowless', state: 'running', updatedAt: 0, ext: {} });
    await seed(db, { id: 'ses_early', harness: 'codex', cwd: '/tmp/windowed', createdAt: 100 });
    await seed(db, { id: 'ses_late', harness: 'codex', cwd: '/tmp/windowed', createdAt: 900 });

    const noTimestamp = await correlate(db, { harness: 'codex', signals: { cwd: '/tmp/windowless', tsStart: 0, tsEnd: 1000 } });
    assert.equal(noTimestamp.ok, false);
    assert.equal(noTimestamp.code, CAP_UNSUPPORTED);

    const afterStart = await correlate(db, { harness: 'codex', signals: { cwd: '/tmp/windowed', tsStart: 500 } });
    assert.ok(afterStart.ok, JSON.stringify(afterStart));
    assert.equal(afterStart.value.sumoId, 'ses_late');

    const beforeEnd = await correlate(db, { harness: 'codex', signals: { cwd: '/tmp/windowed', tsEnd: 500 } });
    assert.ok(beforeEnd.ok, JSON.stringify(beforeEnd));
    assert.equal(beforeEnd.value.sumoId, 'ses_early');
  } finally {
    await cleanup();
  }
});

test('no signal and no recorded match → SUMO_CAP_UNSUPPORTED (diagnostic, not a throw)', /** Verify no signal and no recorded match → SUMO_CAP_UNSUPPORTED (diagnostic, not a throw). */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    const r = await correlate(db, { harness: 'cursor', signals: {} });
    assert.equal(r.ok, false);
    assert.equal(r.code, CAP_UNSUPPORTED);
  } finally {
    await cleanup();
  }
});
