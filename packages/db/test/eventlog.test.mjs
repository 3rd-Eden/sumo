import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLevel } from 'memory-level';
import { createEventLog, recoverSeq } from '../src/eventlog.mjs';
import { metaSeqKey, evtKey } from '../src/keyspace.mjs';

/** Implement freshDb. */ function freshDb() {
  return new MemoryLevel({ valueEncoding: 'json' });
}

test('event log appends, dedupes, scans backlog, serializes concurrency, and recovers seq', /** Verify event log appends, dedupes, scans backlog, serializes concurrency, and recovers seq. */ async () => {
  const db = freshDb();
  const log = createEventLog(db);
  const a = await log.append({ dedupe: 'uuid:a', type: 'session.message', ts: 1 });
  const b = await log.append({ dedupe: 'uuid:b', type: 'session.message', ts: 2 });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(await db.get(metaSeqKey), 2);
  assert.equal((await db.get(evtKey(1))).type, 'session.message');

  const dedupeDb = freshDb();
  const dedupeLog = createEventLog(dedupeDb);
  const first = await dedupeLog.append({
    dedupe: 'uuid:dup', type: 'session.tool', ts: 100,
    payload: { name: 'bash' }, ext: { live: { streamed: true } }
  });
  // a richer second source (e.g. the on-disk transcript) for the SAME logical event
  const second = await dedupeLog.append({
    dedupe: 'uuid:dup', type: 'session.tool', ts: 999,
    payload: { name: 'IGNORED', output: 'done' },
    sessionId: 'ses_1',
    ext: { transcript: { parentUuid: 'p1' } }
  });

  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(second.seq, first.seq); // collapsed to one seq
  assert.equal(await dedupeDb.get(metaSeqKey), 1); // no second event appended

  const stored = await dedupeDb.get(evtKey(first.seq));
  assert.equal(stored.ts, 100); // first-writer wins on present fields
  assert.equal(stored.payload.name, 'bash'); // present -> not overwritten
  assert.equal(stored.payload.output, 'done'); // gap -> filled from the richer source
  assert.equal(stored.sessionId, 'ses_1'); // gap -> filled
  assert.deepEqual(stored.ext, { live: { streamed: true }, transcript: { parentUuid: 'p1' } }); // ext union

  // exactly one event exists in the log
  const seqs = [];
  for await (const e of dedupeLog.backlog(0)) seqs.push(e.seq);
  assert.deepEqual(seqs, [1]);

  const distinctDb = freshDb();
  const distinctLog = createEventLog(distinctDb);
  await distinctLog.append({ dedupe: 'hash:1', type: 'session.message', payload: { text: 'ok' } });
  await distinctLog.append({ dedupe: 'hash:2', type: 'session.message', payload: { text: 'ok' } });
  const out = [];
  for await (const e of distinctLog.backlog(0)) out.push(e.seq);
  assert.deepEqual(out, [1, 2]);

  const backlogDb = freshDb();
  const backlogLog = createEventLog(backlogDb);
  for (let i = 1; i <= 5; i++) await backlogLog.append({ dedupe: `uuid:${i}`, type: 't', ts: i });
  const backlogSeqs = [];
  for await (const e of backlogLog.backlog(2)) backlogSeqs.push(e.seq);
  assert.deepEqual(backlogSeqs, [3, 4, 5]);

  const concurrentDb = freshDb();
  const concurrentLog = createEventLog(concurrentDb);
  const results = await Promise.all(
    Array.from({ length: 20 }, /** Run the callback. */ (_, i) => concurrentLog.append({ dedupe: `uuid:${i}`, type: 't', ts: i }))
  );
  const concurrentSeqs = results.map(/** Map one item. */ (r) => r.seq).sort(/** Compare two items. */ (a, b) => a - b);
  assert.deepEqual(concurrentSeqs, Array.from({ length: 20 }, /** Run the callback. */ (_, i) => i + 1));
  assert.equal(await concurrentDb.get(metaSeqKey), 20);

  const recoveredDb = freshDb();
  const recoveredLog = createEventLog(recoveredDb);
  await recoveredLog.append({ dedupe: 'uuid:a', type: 't' });
  await recoveredLog.append({ dedupe: 'uuid:b', type: 't' });

  // simulate a fresh process attaching to the same db
  assert.equal(await recoverSeq(recoveredDb), 2);
  const log2 = createEventLog(recoveredDb);
  const next = await log2.append({ dedupe: 'uuid:c', type: 't' });
  assert.equal(next.seq, 3);

  const highestKeyDb = freshDb();
  await highestKeyDb.put(evtKey(7), { seq: 7, dedupe: 'uuid:recovered', type: 't', payload: {}, ext: {} });
  assert.equal(await recoverSeq(highestKeyDb), 7);
});
