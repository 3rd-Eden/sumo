/**
 * Always-on transcript ingestion service (Phase 3, scoped). Drives the REAL service against a REAL
 * temp daemon and a temp transcript root seeded with a REAL captured Claude transcript fixture — no
 * mocks (§3f). Covers the bounded-by-design policy: in-scope foreign → one passthrough ses: doc +
 * conversation events; out-of-scope cwd → ignored; an existing native-id doc → no duplicate; recorded
 * correlation → ingest under the known session; and the durable watermark (no re-ingest on restart).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { spawn } from 'node:child_process';

import { watcher, Artifacts, ClaudeArtifacts, CodexArtifacts, OpenCodeArtifacts } from './src/index.mjs';
import { readHead } from './src/ingest-service.mjs';
import { decodeCursorSlug } from './src/adapters/cursor/index.mjs';
import { openTempDb } from './test/_daemon.mjs';
import { resolveClaudeBin } from '../harness/test/_live.mjs';

const FIX_TS_IN_WINDOW = 1782090547000; // between turn.jsonl's tsStart/tsEnd (for the heuristic window)

const DIR = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE = path.join(DIR, '..', 'transcript', 'test', 'fixtures', 'claude-code', 'file', 'turn.jsonl');
const CODEX_FIXTURE = path.join(DIR, '..', 'transcript', 'test', 'fixtures', 'codex', 'file', 'turn.jsonl');
const FIX_NATIVE = 'b06f2b01-de75-4950-b7c7-8011e0d74fc9';
const FIX_CWD = '/tmp/sumo-capture';

/**
 * Resolve after a delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(/** Run the callback. */ (resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a predicate until it returns a truthy value or the timeout expires.
 * @param {() => Promise<unknown>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown|null>}
 */
async function waitFor(fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(100);
  }
}

/**
 * Read all session documents from the daemon.
 * @param {import('sumo/db').SumoDb} db
 * @returns {Promise<object[]>}
 */
async function sesDocs(db) {
  const out = [];
  for await (const [, d] of db.scan('ses:')) out.push(d);
  return out;
}

/**
 * Count assistant message events for a session.
 * @param {import('sumo/db').SumoDb} db
 * @param {string} sessionId
 * @returns {Promise<number>}
 */
async function assistantEvents(db, sessionId) {
  let n = 0;
  for await (const [, v] of db.scan('evt:')) {
    if (v?.sessionId === sessionId && v.type === 'session.message' && v.payload?.role === 'assistant') n++;
  }
  return n;
}
/** Make a temp transcript root and return a helper that drops the fixture into it (firing chokidar add). */
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ingest-root-'));
  /** Implement dropFixture. */ function dropFixture(name = `${FIX_NATIVE}.jsonl`) {
    const dir = path.join(root, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    fs.writeFileSync(dest, fs.readFileSync(FIXTURE));
    return dest;
  }
  return { root, dropFixture };
}

test('in-scope foreign transcript → one passthrough ses: doc (observed) + conversation events', /** Verify in-scope foreign transcript → one passthrough ses: doc (observed) + conversation events. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc.ready;
    dropFixture();
    const doc = await waitFor(/** Run the callback. */ async () => (await sesDocs(db)).find(/** Find a matching item. */ (d) => d.harnessSessionId === FIX_NATIVE));
    assert.ok(doc, 'a ses: doc was created for the foreign session');
    assert.equal(doc.harness, 'claude-code');
    assert.equal(doc.cwd, FIX_CWD, 'recorded the cwd from the transcript signals');
    assert.equal(doc.state, 'observed', 'foreign session is observed, not running/ended');
    assert.equal(doc.ext.foreign, true);
    const got = await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, doc.id)) > 0);
    assert.ok(got, 'the assistant conversation turn was ingested');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('out-of-scope cwd → ignored (no doc, no events)', /** Verify out-of-scope cwd → ignored (no doc, no events). */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return false; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc.ready;
    dropFixture();
    await sleep(1500); // give discovery + (rejected) handling time to run
    const docs = await sesDocs(db);
    assert.equal(docs.length, 0, 'no ses: doc minted for an out-of-project transcript');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('existing native-id doc → no duplicate (ingests under the known session)', /** Verify existing native-id doc → no duplicate (ingests under the known session). */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  await db.put('ses:ses_known', { id: 'ses_known', harness: 'claude-code', harnessSessionId: FIX_NATIVE, cwd: FIX_CWD, state: 'ended', createdAt: 1, updatedAt: 1, ext: {} });
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc.ready;
    dropFixture();
    const got = await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, 'ses_known')) > 0);
    assert.ok(got, 'events ingested under the existing session id');
    const docs = await sesDocs(db);
    assert.equal(docs.length, 1, 'no duplicate doc minted');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recorded event-stream sessions are re-ingested once they are no longer running', /** Verify recorded event-stream sessions are re-ingested once they are no longer running. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  await db.put('ses:ses_stream_ended', {
    id: 'ses_stream_ended',
    harness: 'claude-code',
    harnessSessionId: FIX_NATIVE,
    cwd: FIX_CWD,
    state: 'ended',
    observationSource: 'event-stream',
    createdAt: 1,
    updatedAt: 1,
    ext: {}
  });
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc.ready;
    dropFixture();
    const got = await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, 'ses_stream_ended')) > 0);
    assert.ok(got, 'a no-longer-running event-stream session is re-ingested from disk');
    assert.equal((await sesDocs(db)).length, 1, 'the known session doc is reused');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recorded LIVE-STREAMED (event-stream) session is NOT re-ingested (no double-ingest)', /** Verify recorded LIVE-STREAMED (event-stream) session is NOT re-ingested (no double-ingest). */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  // A Sumo-spawned headless session: its harness read loop is the source; the transcript tail must skip it.
  await db.put('ses:ses_live', { id: 'ses_live', harness: 'claude-code', harnessSessionId: FIX_NATIVE, cwd: FIX_CWD, state: 'running', observationSource: 'event-stream', createdAt: 1, updatedAt: 1, ext: {} });
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc.ready;
    dropFixture();
    await sleep(1500);
    assert.equal(await assistantEvents(db, 'ses_live'), 0, 'live-streamed session is not double-ingested from its transcript');
    assert.equal((await sesDocs(db)).length, 1, 'no foreign duplicate minted');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous correlation → skip, no doc minted', /** Verify ambiguous correlation → skip, no doc minted. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  // Two foreign-shaped docs (no harnessSessionId) sharing the fixture's cwd, in its time window → the
  // heuristic finds 2 candidates → AMBIGUOUS. The service must skip, not guess, and mint nothing.
  for (const n of ['a', 'b']) {
    await db.put(`ses:ses_${n}`, { id: `ses_${n}`, harness: 'claude-code', cwd: FIX_CWD, state: 'ended', createdAt: FIX_TS_IN_WINDOW, updatedAt: FIX_TS_IN_WINDOW, ext: {} });
  }
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc.ready;
    dropFixture();
    await sleep(1500);
    assert.equal((await sesDocs(db)).length, 2, 'no new doc minted on ambiguity');
    assert.equal((await assistantEvents(db, 'ses_a')) + (await assistantEvents(db, 'ses_b')), 0, 'nothing ingested under a guessed session');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no correlation signal (no cwd/nativeId) → skip, no doc minted', /** Verify no correlation signal (no cwd/nativeId) → skip, no doc minted. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root } = tempRoot();
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc.ready;
    // A .jsonl with records carrying neither sessionId nor cwd → signals() empty → unscopeable → skip.
    const dir = path.join(root, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'no-signal.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n');
    await sleep(1500);
    assert.equal((await sesDocs(db)).length, 0, 'no doc minted without a correlation signal');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('foreign Codex transcript without a native id still mints one observed session doc', /** Verify foreign Codex transcript without a native id still mints one observed session doc. */ async () => {
  const { db, cleanup } = await openTempDb();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ingest-codex-root-'));
  const dayDir = path.join(root, '2026', '06', '22');
  fs.mkdirSync(dayDir, { recursive: true });
  const target = path.join(dayDir, 'rollout-no-id.jsonl');
  const codexRows = fs.readFileSync(CODEX_FIXTURE, 'utf8').trim().split('\n').map(/** Map one item. */ (line) => JSON.parse(line));
  if (codexRows[0]?.type === 'session_meta') delete codexRows[0].payload.id;
  fs.writeFileSync(target, codexRows.map(/** Map one item. */ (row) => JSON.stringify(row)).join('\n') + '\n');

  const svc = watcher({
    db,
    adapters: [new CodexArtifacts()],
    /** Implement isInScope. */ isInScope() { return true; },
    /** Implement resolveRoot. */ resolveRoot() { return root; }
  });
  try {
    await svc.ready;
    const doc = await waitFor(/** Run the callback. */ async () => (await sesDocs(db)).find(/** Find a matching item. */ (d) => d.harness === 'codex'));
    assert.ok(doc, 'one observed Codex session doc was minted');
    assert.equal(doc.harnessSessionId, undefined, 'no native id is recorded when the transcript carries none');
    assert.equal(doc.ext.foreign, true);
    const got = await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, doc.id)) > 0);
    assert.ok(got, 'the Codex transcript content was ingested under the observed session');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watcher skips declared non-tail adapters and abort stops an idle service', /** Verify watcher skips declared non-tail adapters and abort stops an idle service. */ async () => {
  const { db, cleanup } = await openTempDb();
  const ac = new AbortController();
  const logs = [];
  const svc = watcher({
    db,
    adapters: [new OpenCodeArtifacts(), new Artifacts(), new ClaudeArtifacts()],
    /** Implement resolveRoot. */ resolveRoot() { return null; },
    signal: ac.signal,
    /** Implement log. */ log(msg) { logs.push(msg); }
  });
  try {
    await svc.ready;
    ac.abort();
    await sleep(50);
    assert.equal((await sesDocs(db)).length, 0);
    assert.deepEqual(logs, []);
  } finally {
    await svc.stop();
    await cleanup();
  }
});

test('stop drains pending debounce and new-directory scans before ingestion starts', /** Verify stop drains pending debounce and new-directory scans before ingestion starts. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root } = tempRoot();
  const existingDir = path.join(root, 'existing');
  fs.mkdirSync(existingDir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(existingDir, `${FIX_NATIVE}.jsonl`));

  const svc = watcher({
    db,
    adapters: [new ClaudeArtifacts()],
    /** Implement isInScope. */ isInScope() { return true; },
    /** Implement resolveRoot. */ resolveRoot() { return root; },
    fromStart: true,
    debounceMs: 1000
  });
  try {
    await svc.ready;
    const freshDir = path.join(root, 'fresh');
    fs.mkdirSync(freshDir, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(freshDir, `${FIX_NATIVE}.jsonl`));
    await sleep(150);
    await svc.stop();
    await sleep(1100);
    assert.equal((await sesDocs(db)).length, 0, 'pending transcript discovery was cancelled before ingestion');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fromStart ingests a pre-existing transcript through the default Claude transcript root', /** Verify fromStart ingests a pre-existing transcript through the default Claude transcript root. */ async () => {
  const { db, cleanup } = await openTempDb();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-claude-config-'));
  const previousClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = base;
  const dir = path.join(base, 'projects', 'captured-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(dir, `${FIX_NATIVE}.jsonl`));

  const svc = watcher({
    db,
    adapters: [new ClaudeArtifacts()],
    /** Implement isInScope. */ isInScope() { return true; },
    fromStart: true,
    debounceMs: 20
  });
  try {
    await svc.ready;
    const doc = await waitFor(/** Run the callback. */ async () => (await sesDocs(db)).find(/** Find a matching item. */ (d) => d.harnessSessionId === FIX_NATIVE));
    assert.ok(doc, 'fromStart consumed the pre-existing captured transcript');
    assert.equal(doc.transcriptPath, path.join(dir, `${FIX_NATIVE}.jsonl`));
    const got = await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, doc.id)) > 0);
    assert.ok(got, 'the pre-existing transcript was tailed through the real acquirer');
  } finally {
    await svc.stop();
    await cleanup();
    if (previousClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfig;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ready scan ignores old files, broken symlinks and non-json siblings; fresh dirs still ingest', /** Verify ready scan ignores old files, broken symlinks and non-json siblings; fresh dirs still ingest. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root } = tempRoot();
  const oldDir = path.join(root, 'old');
  fs.mkdirSync(oldDir, { recursive: true });
  const oldFile = path.join(oldDir, `${FIX_NATIVE}.jsonl`);
  fs.writeFileSync(oldFile, fs.readFileSync(FIXTURE));
  fs.utimesSync(oldFile, new Date(0), new Date(0));
  try { fs.symlinkSync('/definitely/missing/sumo-transcript.jsonl', path.join(root, 'broken.jsonl')); } catch { /* symlink unsupported */ }

  const svc = watcher({
    db,
    adapters: [new ClaudeArtifacts()],
    /** Implement isInScope. */ isInScope() { return true; },
    /** Implement resolveRoot. */ resolveRoot() { return root; },
    debounceMs: 20
  });
  try {
    await svc.ready;
    await sleep(200);
    assert.equal((await sesDocs(db)).length, 0, 'pre-existing archive entries were not replayed');

    const freshDir = path.join(root, 'fresh');
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, 'notes.txt'), 'not a transcript');
    fs.writeFileSync(path.join(freshDir, `${FIX_NATIVE}.jsonl`), fs.readFileSync(FIXTURE));

    const doc = await waitFor(/** Run the callback. */ async () => (await sesDocs(db)).find(/** Find a matching item. */ (d) => d.harnessSessionId === FIX_NATIVE));
    assert.ok(doc, 'a fresh transcript under a new directory is still discovered and ingested');
    assert.equal(doc.harness, 'claude-code');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readHead reads only the transcript head needed for correlation signals', /** Verify readHead reads only the transcript head needed for correlation signals. */ () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-read-head-'));
  const file = path.join(dir, 'large.jsonl');
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ i, cwd: FIX_CWD, sessionId: FIX_NATIVE }));
  fs.writeFileSync(file, lines.join('\n') + '\n');

  try {
    const records = readHead(file, 50);
    assert.equal(records.length, 50);
    assert.equal(records[0].i, 0);
    assert.equal(records.at(-1).i, 49);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readHead handles empty, malformed, partial, missing and capped transcript heads', /** Verify readHead handles empty, malformed, partial, missing and capped transcript heads. */ () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-read-head-edges-'));
  const file = path.join(dir, 'edge.jsonl');
  try {
    fs.writeFileSync(file, '\nnot-json\n' + JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }));
    assert.deepEqual(readHead(file, 10).map(/** Map one item. */ (r) => r.n), [1, 2], 'valid complete and final partial JSON records are kept');
    assert.deepEqual(readHead(file, 1).map(/** Map one item. */ (r) => r.n), [1], 'maxLines caps parsing');
    assert.deepEqual(readHead(path.join(dir, 'missing.jsonl')), [], 'missing files read as no records');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('observed foreign session flips to ended after the transcript goes idle', /** Verify observed foreign session flips to ended after the transcript goes idle. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; }, idleEndMs: 300 });
  try {
    await svc.ready;
    dropFixture();
    const ended = await waitFor(/** Run the callback. */ async () => {
      const d = (await sesDocs(db)).find(/** Find a matching item. */ (x) => x.harnessSessionId === FIX_NATIVE);
      return d && d.state === 'ended' ? d : null;
    });
    assert.ok(ended, 'the observed foreign doc flipped to ended once its transcript went idle');
    assert.equal(ended.ext.foreign, true);
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('idleEndMs:0 keeps observed foreign sessions non-terminal', /** Verify idleEndMs:0 keeps observed foreign sessions non-terminal. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; }, idleEndMs: 0 });
  try {
    await svc.ready;
    dropFixture();
    const doc = await waitFor(/** Run the callback. */ async () => (await sesDocs(db)).find(/** Find a matching item. */ (d) => d.harnessSessionId === FIX_NATIVE));
    assert.ok(doc, 'the captured transcript still mints an observed foreign session');
    await sleep(500);
    const after = await db.get(`ses:${doc.id}`);
    assert.equal(after.state, 'observed');
    assert.equal(after.ext.foreign, true);
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('idle end does not rewrite correlated non-foreign sessions', /** Verify idle end does not rewrite correlated non-foreign sessions. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  await db.put('ses:ses_known_running', {
    id: 'ses_known_running',
    harness: 'claude-code',
    harnessSessionId: FIX_NATIVE,
    cwd: FIX_CWD,
    state: 'running',
    createdAt: 1,
    updatedAt: 1,
    ext: {}
  });
  const svc = watcher({
    db,
    adapters: [new ClaudeArtifacts()],
    /** Implement isInScope. */ isInScope() { return true; },
    /** Implement resolveRoot. */ resolveRoot() { return root; },
    idleEndMs: 200
  });
  try {
    await svc.ready;
    dropFixture();
    const got = await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, 'ses_known_running')) > 0);
    assert.ok(got, 'the known session still ingests transcript content');
    await sleep(500);
    const after = await db.get('ses:ses_known_running');
    assert.equal(after.state, 'running', 'idle-end logic ignores non-foreign correlated sessions');
    assert.equal(after.ext.foreign, undefined);
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('decodeCursorSlug: greedy on-disk decode handles hyphenated dirs + rejects non-paths', /** Verify decodeCursorSlug: greedy on-disk decode handles hyphenated dirs + rejects non-paths. */ () => {
  // Use /tmp directly (realpath → /private/tmp on macOS) so the path contains NO underscores — the
  // Cursor slug encoding collapses both `/` and `_` to `-`, making paths with underscores in segment
  // names inherently ambiguous. Real Cursor project dirs (user home, typical cwds) don't have `_` in
  // their path components; the limitation is documented in 00b (acknowledged, not a silent gap).
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/sumo-slug-'));
  fs.mkdirSync(path.join(base, 'proj-x', 'sub'), { recursive: true });
  // Encode like Cursor: replace every non-alphanumeric char with `-` and strip leading `/`.
  const slug = base.slice(1).replace(/[^a-zA-Z0-9]/g, '-') + '-proj-x-sub';
  try {
    assert.equal(decodeCursorSlug(slug), path.join(base, 'proj-x', 'sub'), 'recovers the hyphenated dir correctly via greedy on-disk verification');
    assert.equal(decodeCursorSlug('1772733554332'), undefined, 'numeric window id is not a path');
    assert.equal(decodeCursorSlug('empty-window'), undefined, 'empty-window is not a path');
    assert.equal(decodeCursorSlug('this-path-does-not-exist-anywhere-xyz'), undefined, 'unresolvable slug → undefined (deleted project)');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ── Live: a real FOREIGN claude session (NOT spawned by Sumo) is auto-ingested by the service ──────
let claudeBin;
let liveSkip = false;
try {
  claudeBin = await resolveClaudeBin();
} catch (err) {
  liveSkip = `requires a real claude binary: ${/** @type {Error} */ (err).message.split('\n')[0]}`;
}

test('LIVE: a foreign claude session (run outside Sumo) is auto-ingested + correlated', { skip: liveSkip, timeout: 120_000 }, /** Verify LIVE: a foreign claude session (run outside Sumo) is auto-ingested + correlated. */ async () => {
  const { db, cleanup } = await openTempDb();
  // A real project dir (the scope marker is irrelevant here — isInScope:true — the point is the live
  // capture of a session Sumo did NOT stream). Claude writes its transcript under the config dir's
  // projects/<encoded-cwd>/; watch ONLY that subdir so the test is isolated from the rest of ~/.claude.
  // realpath: macOS resolves /tmp and /var/folders through a /private symlink, and Claude encodes the
  // RESOLVED cwd into the projects/<encoded-cwd> dir name — so derive the watch dir from the realpath.
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-ingest-proj-')));
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const encDir = path.join(base, 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(encDir, { recursive: true });

  const svc = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return encDir; } });
  try {
    await svc.ready;
    // Run claude DIRECTLY (not via the Sumo harness) — a genuinely foreign session. -p one-shot exits.
    await new Promise(/** Run the callback. */ (resolve, reject) => {
      const child = spawn(claudeBin, ['-p', 'Reply with exactly one word: pong'], { cwd: proj, stdio: 'ignore' });
      const t = setTimeout(/** Run the timer callback. */ () => { child.kill('SIGKILL'); reject(new Error('claude timed out')); }, 90_000);
      child.on('error', /** Run the callback. */ (e) => { clearTimeout(t); reject(e); });
      child.on('close', /** Run the callback. */ () => { clearTimeout(t); resolve(); });
    });

    // The service should have discovered the new transcript and ingested an assistant turn, minting a
    // foreign ses: doc correlated to the session's native id + cwd — WITHOUT Sumo spawning it.
    const doc = await waitFor(/** Run the callback. */ async () => (await sesDocs(db)).find(/** Find a matching item. */ (d) => d.harness === 'claude-code' && d.ext?.foreign), 30_000);
    assert.ok(doc, 'a foreign ses: doc was created for the externally-run claude session');
    assert.ok(doc.harnessSessionId, 'correlated to the native session id');
    assert.equal(fs.realpathSync(doc.cwd), fs.realpathSync(proj), 'recorded the real cwd it ran in');
    const got = await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, doc.id)) > 0, 30_000);
    assert.ok(got, 'the conversation (assistant turn) landed in the DB via the always-on tail');
  } finally {
    await svc.stop();
    await cleanup();
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(encDir, { recursive: true, force: true });
  }
});

test('durable watermark: a second service run does not re-ingest the same content', /** Verify durable watermark: a second service run does not re-ingest the same content. */ async () => {
  const { db, cleanup } = await openTempDb();
  const { root, dropFixture } = tempRoot();
  const svc1 = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  let docId;
  try {
    await svc1.ready;
    dropFixture();
    const doc = await waitFor(/** Run the callback. */ async () => (await sesDocs(db)).find(/** Find a matching item. */ (d) => d.harnessSessionId === FIX_NATIVE));
    assert.ok(doc);
    docId = doc.id;
    await waitFor(/** Run the callback. */ async () => (await assistantEvents(db, docId)) > 0);
  } finally {
    await svc1.stop();
  }
  const firstCount = await assistantEvents(db, docId);

  // Restart the service against the SAME db + root + (now pre-existing) file. ignoreInitial + the stored
  // watermark must prevent re-reading content already ingested.
  const svc2 = watcher({ db, adapters: [new ClaudeArtifacts()], /** Implement isInScope. */ isInScope() { return true; }, /** Implement resolveRoot. */ resolveRoot() { return root; } });
  try {
    await svc2.ready;
    fs.appendFileSync(path.join(root, 'proj', `${FIX_NATIVE}.jsonl`), '\n'); // nudge a change event
    await sleep(1500);
    const after = await assistantEvents(db, docId);
    assert.equal(after, firstCount, 'no duplicate ingestion on restart (watermark held)');
  } finally {
    await svc2.stop();
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
