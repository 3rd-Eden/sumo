/**
 * Tail mechanism against a REAL file being appended (§3f): asserts complete lines emit in order and a
 * mid-record partial write is buffered until its newline arrives, then that the acquirer's `tail()`
 * wiring parses appended records into normalized events with the correct dedupe key.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { key } from 'sumo/db';

import { tail } from '../src/tail.mjs';
import { adapters } from '../src/index.mjs';
import { readTranscript, waitUntil, sleep, openTempDb } from './_daemon.mjs';

test('tail: complete lines emit in order; a partial line waits for its newline', /** Verify tail: complete lines emit in order; a partial line waits for its newline. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, '');
  const lines = [];
  const { stop, ready } = tail(file, /** Run the callback. */ (l) => lines.push(l), { fromStart: true });
  try {
    await ready;
    fs.appendFileSync(file, JSON.stringify({ a: 1 }) + '\n' + JSON.stringify({ a: 2 }) + '\n');
    await waitUntil(/** Run the callback. */ () => lines.length >= 2);

    // A write that ends mid-record must NOT be emitted until completed.
    fs.appendFileSync(file, '{"a":3');
    await sleep(120);
    assert.equal(lines.length, 2, 'partial line is buffered, not emitted');

    fs.appendFileSync(file, '}\n' + JSON.stringify({ a: 4 }) + '\n');
    await waitUntil(/** Run the callback. */ () => lines.length >= 4);
    assert.deepEqual(lines.map(/** Map one item. */ (l) => JSON.parse(l).a), [1, 2, 3, 4], 'records arrive complete and in order');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail: a multi-byte UTF-8 char split across two writes is decoded intact (not corrupted)', /** Verify tail: a multi-byte UTF-8 char split across two writes is decoded intact (not corrupted). */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-utf8-'));
  const file = path.join(dir, 'u.jsonl');
  fs.writeFileSync(file, '');
  const lines = [];
  const { stop, ready } = tail(file, /** Run the callback. */ (l) => lines.push(l), { fromStart: true });
  try {
    await ready;
    const bytes = Buffer.from(JSON.stringify({ text: '🎉 done — café' }) + '\n', 'utf8');
    const cut = bytes.indexOf(0xf0) + 2; // mid-way through the 4-byte 🎉 sequence
    fs.appendFileSync(file, bytes.subarray(0, cut));
    await sleep(120);
    fs.appendFileSync(file, bytes.subarray(cut));
    await waitUntil(/** Run the callback. */ () => lines.length >= 1);
    // Without incremental decoding the split emoji would become replacement chars and corrupt the text.
    assert.equal(JSON.parse(lines[0]).text, '🎉 done — café');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail: startOffset resumes from a stored byte and truncation restarts from the top', /** Verify tail: startOffset resumes from a stored byte and truncation restarts from the top. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-resume-'));
  const file = path.join(dir, 'resume.jsonl');
  const firstLine = JSON.stringify({ n: 1 }) + '\n';
  fs.writeFileSync(file, firstLine);
  const lines = [];
  const { stop, ready } = tail(file, /** Run the callback. */ (l) => lines.push(JSON.parse(l).n), { startOffset: Buffer.byteLength(firstLine), /** Implement onProgress. */ onProgress() {} });
  try {
    await ready;
    assert.deepEqual(lines, [], 'resume offset skips already-read content');
    fs.appendFileSync(file, JSON.stringify({ n: 2 }) + '\n');
    await waitUntil(/** Run the callback. */ () => lines.includes(2));

    fs.writeFileSync(file, JSON.stringify({ n: 3 }) + '\n');
    await waitUntil(/** Run the callback. */ () => lines.includes(3));
    assert.deepEqual(lines, [2, 3], 'after truncation the tailer restarts at the new file head');

    stop();
    stop();
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail: fromStart false skips baseline bytes and abort stops later reads', /** Verify tail: fromStart false skips baseline bytes and abort stops later reads. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-abort-'));
  const file = path.join(dir, 'abort.jsonl');
  fs.writeFileSync(file, JSON.stringify({ n: 1 }) + '\n');
  const lines = [];
  const ac = new AbortController();
  const { ready } = tail(file, /** Run the callback. */ (l) => lines.push(JSON.parse(l).n), { fromStart: false, signal: ac.signal });
  try {
    await ready;
    assert.deepEqual(lines, [], 'existing baseline was skipped');
    fs.appendFileSync(file, JSON.stringify({ n: 2 }) + '\n');
    await waitUntil(/** Run the callback. */ () => lines.includes(2));

    ac.abort();
    fs.appendFileSync(file, JSON.stringify({ n: 3 }) + '\n');
    await sleep(120);
    assert.deepEqual(lines, [2], 'abort stopped subsequent reads');
  } finally {
    ac.abort();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail: deleting the watched file is a quiet disappearance, not a crash', /** Verify tail: deleting the watched file is a quiet disappearance, not a crash. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-vanish-'));
  const file = path.join(dir, 'vanish.jsonl');
  fs.writeFileSync(file, JSON.stringify({ n: 1 }) + '\n');
  const lines = [];
  const { stop, ready } = tail(file, /** Run the callback. */ (l) => lines.push(JSON.parse(l).n), { fromStart: true });
  try {
    await ready;
    assert.deepEqual(lines, [1]);
    fs.rmSync(file);
    await sleep(120);
    assert.deepEqual(lines, [1], 'vanishing transcript files stop producing records quietly');
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail: a missing fromStart:false file starts at byte zero when it appears', /** Verify tail: a missing fromStart:false file starts at byte zero when it appears. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-missing-'));
  const file = path.join(dir, 'missing.jsonl');
  const lines = [];
  const { stop, ready } = tail(file, /** Run the callback. */ (l) => lines.push(JSON.parse(l).n), { fromStart: false });
  try {
    await ready;
    fs.writeFileSync(file, JSON.stringify({ n: 1 }) + '\n');
    await waitUntil(/** Run the callback. */ () => lines.includes(1));
    assert.deepEqual(lines, [1]);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tail: abort inside a callback prevents later buffered lines from emitting', /** Verify tail: abort inside a callback prevents later buffered lines from emitting. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-callback-abort-'));
  const file = path.join(dir, 'callback-abort.jsonl');
  fs.writeFileSync(file, JSON.stringify({ n: 1 }) + '\n' + JSON.stringify({ n: 2 }) + '\n');
  const lines = [];
  const ac = new AbortController();
  const { ready } = tail(file, /** Run the callback. */ (l) => {
    lines.push(JSON.parse(l).n);
    ac.abort();
  }, { fromStart: true, signal: ac.signal });
  try {
    await ready;
    assert.deepEqual(lines, [1]);
  } finally {
    ac.abort();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquirer.tail: appended records normalize, with the shared dedupe key (incl. #blockIndex)', /** Verify acquirer.tail: appended records normalize, with the shared dedupe key (incl. #blockIndex). */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-aa-'));
  const file = path.join(dir, 'c.jsonl');
  fs.writeFileSync(file, '');
  const appended = [];
  const db = { /** Implement append. */ async append(e) { return appended.push(e); } };
  const a = new adapters['claude-code']();
  const r = a.tail(file, { db, sessionId: 'ses_T', fromStart: true });
  assert.ok(r.ok, 'tail is supported for claude-code');
  try {
    await r.value.ready;
    for (const rec of readTranscript('claude-code/file/turn.jsonl')) fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    await waitUntil(/** Run the callback. */ () => appended.some(/** Test whether an item matches. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'));

    const asst = appended.find(/** Find a matching item. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant');
    assert.equal(asst.source, 'transcript');
    assert.equal(asst.adapter, 'claude-code');
    // Text/reasoning blocks derive `<message.id>#<blockIndex>` → the key carries the suffix.
    assert.equal(asst.dedupe, 'msg:ses_T:msg_bdrk_01B57AC2GA8qsXxNerPeNSa9#0');
  } finally {
    r.value.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquirer.tail skips non-JSON lines and survives transcriptPath merge failures', /** Verify acquirer.tail skips non-JSON lines and survives transcriptPath merge failures. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-aa-edges-'));
  const file = path.join(dir, 'c.jsonl');
  fs.writeFileSync(file, '');
  const appended = [];
  const db = {
    /** Implement mergeDoc. */ mergeDoc() { throw new Error('merge unavailable'); },
    /** Implement append. */ async append(e) { appended.push(e); }
  };
  const a = new adapters['claude-code']();
  const r = a.tail(file, { db, sessionId: 'ses_T', fromStart: true });
  assert.ok(r.ok);
  try {
    await r.value.ready;
    fs.appendFileSync(file, 'not-json\n');
    fs.appendFileSync(file, JSON.stringify(readTranscript('claude-code/file/turn.jsonl').find(/** Find a matching item. */ (rec) => rec.type === 'assistant')) + '\n');
    await waitUntil(/** Run the callback. */ () => appended.some(/** Test whether an item matches. */ (e) => e.type === 'session.message'));
    assert.equal(appended.filter(/** Select matching items. */ (e) => e.type === 'session.message').length, 1);
  } finally {
    r.value.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquirer.tail serializes appended-record ingestion when db writes are slow', /** Verify acquirer.tail serializes appended-record ingestion when db writes are slow. */ async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-serial-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, '');
  const appended = [];
  let first = true;
  const db = {
    /** Implement append. */ async append(event) {
      if (first) {
        first = false;
        await sleep(120);
      }
      appended.push(`${event.type}:${event.payload?.role ?? event.payload?.kind ?? ''}`);
    }
  };
  const records = readTranscript('claude-code/file/turn.jsonl').filter(/** Select matching items. */ (rec) => rec.type === 'user' || rec.type === 'assistant');
  const r = new adapters['claude-code']().tail(file, { db, sessionId: 'ses_serial', fromStart: true });
  assert.ok(r.ok);
  try {
    await r.value.ready;
    fs.appendFileSync(file, records.map(/** Map one item. */ (record) => JSON.stringify(record)).join('\n') + '\n');
    await waitUntil(/** Run the callback. */ () => appended.some(/** Test whether an item matches. */ (entry) => entry === 'session.message:assistant'));
    assert.ok(
      appended.indexOf('session.message:user') < appended.indexOf('session.message:assistant'),
      'later transcript lines wait behind earlier ingests'
    );
  } finally {
    r.value.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquirer.tail records transcriptPath on the ses: doc via mergeDoc, preserving harnessSessionId', /** Verify acquirer.tail records transcriptPath on the ses: doc via mergeDoc, preserving harnessSessionId. */ async () => {
  const { db, cleanup } = await openTempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-tp-'));
  const file = path.join(dir, 'codex-rollout.jsonl');
  fs.writeFileSync(file, '');
  let handle;
  try {
    // A correlated session already recorded by the harness (it has the native id but, being Codex, no
    // harness-derivable transcript path). The tail is the OWNER that fills it in.
    await db.put(key('ses_T'), { id: 'ses_T', harness: 'codex', state: 'running', harnessSessionId: 'native-codex', ext: {} });

    const a = new adapters.codex();
    const r = a.tail(file, { db, sessionId: 'ses_T', fromStart: true });
    assert.ok(r.ok, 'codex supports tail');
    handle = r.value;
    await handle.ready;
    await waitUntil(/** Run the callback. */ async () => (await db.get(key('ses_T')))?.transcriptPath === file);

    const doc = await db.get(key('ses_T'));
    assert.equal(doc.transcriptPath, file, 'tail recorded the on-disk path it is tailing');
    assert.equal(doc.harnessSessionId, 'native-codex', 'the harness-written native id was NOT clobbered');
    assert.equal(doc.state, 'running', 'untouched field intact');
  } finally {
    handle?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    await cleanup();
  }
});

test('acquirer.tail without a correlated sessionId does not touch any ses: doc', /** Verify acquirer.tail without a correlated sessionId does not touch any ses: doc. */ async () => {
  const { db, cleanup } = await openTempDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-tail-nosid-'));
  const file = path.join(dir, 'c.jsonl');
  fs.writeFileSync(file, '');
  let handle;
  try {
    const a = new adapters['claude-code']();
    const r = a.tail(file, { db, fromStart: true }); // no sessionId → nothing to key a patch on
    assert.ok(r.ok);
    handle = r.value;
    await handle.ready;
    await sleep(50);
    const docs = [];
    for await (const [, d] of db.scan('ses:')) docs.push(d);
    assert.equal(docs.length, 0, 'no ses: doc created or patched without a correlated id');
  } finally {
    handle?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    await cleanup();
  }
});
