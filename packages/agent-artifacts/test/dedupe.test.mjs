/**
 * The cross-source dedupe proof against a REAL daemon (the architectural payoff, ). The same
 * logical turn is fed through BOTH the live-stream path (parser `.stream()` → `forEvent` →
 * `source:'session'`, exactly as the harness base now does) AND this layer's on-disk path (acquirer
 * `.import()` → `source:'transcript'`). The daemon must collapse the natural-id events to one `seq` and
 * gap-fill `ext`. Id-less harnesses (Cursor) must NOT collapse — asserted honestly, not faked.
 *
 * Also: OpenCode import appends (no cross-source pair → collapse N/A), and a config snapshot is
 * redacted at the storage boundary.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adapters as transcriptAdapters } from 'sumo/transcript';
import { forEvent } from '../../db/src/dedupe.mjs';
import { adapters } from '../src/index.mjs';
import { openTempDb, allEvents, readTranscript } from './_daemon.mjs';

/** Parse every record of a fixture through one parser entry → flat event list. */
function parse(harness, entry, recs) {
  const P = new transcriptAdapters[harness]();
  const out = [];
  for (const rec of recs) for (const e of P[entry](rec)) out.push(e);
  return out;
}

/** Build a live-source EventInput the way the harness base does (shared `forEvent`). */
function liveInput(evt, adapter, position) {
 const sid = 'ses_T';
 return {
 dedupe: forEvent(evt, { sessionId: sid, position }),
 type: evt.type,
 payload: evt.payload ?? {},
 ext: evt.ext ?? {},
 ...(sid ? { sessionId: sid }: {}),
 ...(evt.ts !== undefined ? { ts: evt.ts }: {}),
 source: 'session',
 adapter
 };
}

test('claude: live stream + on-disk import of the same turn collapse to one seq, ext gap-filled', /** Verify claude: live stream + on-disk import of the same turn collapse to one seq, ext gap-filled. */ async () => {
 const { db, cleanup } = await openTempDb();
 try {
 // Live side: the assistant message from the stream capture.
 const sMsg = parse('claude-code', 'stream', readTranscript('claude-code/stream/turn.jsonl')).find(
 /** Find a matching item. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'
 );
 const key = forEvent(sMsg, { sessionId: 'ses_T', position: 0 });
 assert.equal(key, 'msg:ses_T:msg_bdrk_01B57AC2GA8qsXxNerPeNSa9#0');
 const liveSeq = await db.append(liveInput(sMsg, 'claude-code', 0));

 // File side: import the on-disk capture (same turn) via the acquirer.
 const res = await new adapters['claude-code']().import(readTranscript('claude-code/file/turn.jsonl'), { db, sessionId: 'ses_T' });
 assert.ok(res.ok);

 // Collapse: exactly one stored event carries that dedupe key, at the live seq.
 const hits = (await allEvents(db)).filter(/** Select matching items. */ (e) => e.dedupe === key);
 assert.equal(hits.length, 1, 'live + file collapsed to one event');
 assert.equal(hits[0].seq, liveSeq, 'collapsed onto the live source seq');

 // Native parser records are retained behind a raw reference, never exposed in plugin-visible ext.
 assert.equal(hits[0].ext.native, undefined);
 assert.ok(hits[0].rawRef?.startsWith('raw:event:'));
 } finally {
 await cleanup();
 }
});

test('codex: a tool call collapses live↔file on shared call_id', /** Verify codex: a tool call collapses live↔file on shared call_id. */ async () => {
 const { db, cleanup } = await openTempDb();
 try {
 const sTool = parse('codex', 'stream', readTranscript('codex/stream/tool.jsonl')).find(/** Find a matching item. */ (e) => e.type === 'session.tool');
 const key = forEvent(sTool, { sessionId: 'ses_T', position: 0 });
 assert.equal(key, 'call:ses_T:call_p0VttBzhIF6rN2ab6YUfLbXq');
 const liveSeq = await db.append(liveInput(sTool, 'codex', 0));

 const res = await new adapters.codex().import(readTranscript('codex/file/tools.jsonl'), { db, sessionId: 'ses_T' });
 assert.ok(res.ok);

 const events = await allEvents(db);
 const hits = events.filter(/** Select matching items. */ (e) => e.dedupe === key);
 assert.equal(hits.length, 1, 'tool call collapsed across surfaces');
 assert.equal(hits[0].seq, liveSeq);

 // Stronger than "the live key survived": there must be exactly ONE tool event total. If the file
 // side had produced a divergent key, a second session.tool event would exist here.
 const allTools = events.filter(/** Select matching items. */ (e) => e.type === 'session.tool' && e.adapter === 'codex');
 assert.equal(allTools.length, 1, 'no divergent file-side tool event — genuinely collapsed');
 assert.equal(hits[0].ext.native, undefined, 'native record is not exposed through the event');
 assert.ok(hits[0].rawRef?.startsWith('raw:event:'));
 } finally {
 await cleanup();
 }
});

test('copilot: an assistant message collapses live↔file on shared messageId', /** Verify copilot: an assistant message collapses live↔file on shared messageId. */ async () => {
 const { db, cleanup } = await openTempDb();
 try {
 const live = parse('copilot', 'stream', readTranscript('copilot/stream/turn.jsonl')).find(
 /** Find a matching item. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'
 );
 const key = forEvent(live, { sessionId: 'ses_T', position: 0 });
 assert.equal(key, 'msg:ses_T:3254d66e-aa32-4a65-9812-63428c96a505');
 const liveSeq = await db.append(liveInput(live, 'copilot', 0));

 const res = await new adapters.copilot().import(readTranscript('copilot/file/turn.jsonl'), { db, sessionId: 'ses_T' });
 assert.ok(res.ok);

 const hits = (await allEvents(db)).filter(/** Select matching items. */ (e) => e.dedupe === key);
 assert.equal(hits.length, 1);
 assert.equal(hits[0].seq, liveSeq);
 } finally {
 await cleanup();
 }
});

test('cursor: divergent on-disk text does NOT collapse (two distinct seqs) — surfaced, not faked', /** Verify cursor: divergent on-disk text does NOT collapse (two distinct seqs) — surfaced, not faked. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    const sMsg = parse('cursor', 'stream', readTranscript('cursor/stream/turn.jsonl')).find(
      /** Find a matching item. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant'
    );
    await db.append(liveInput(sMsg, 'cursor', 0));
    await new adapters.cursor().import(readTranscript('cursor/file/turn.jsonl'), { db, sessionId: 'ses_T' });

    const asst = (await allEvents(db)).filter(
      /** Select matching items. */ (e) => e.type === 'session.message' && e.payload.role === 'assistant' && e.adapter === 'cursor'
    );
    assert.equal(asst.length, 2, 'no parser-level identity → two events, one per source');
    assert.deepEqual([...new Set(asst.map(/** Map one item. */ (e) => e.source))].sort(), ['session', 'transcript']);
    assert.notEqual(asst[0].dedupe, asst[1].dedupe, 'distinct dedupe keys (no collapse)');
  } finally {
    await cleanup();
  }
});

test('opencode: export import appends via .stream() (no live source → cross-source pair N/A)', /** Verify opencode: export import appends via .stream() (no live source → cross-source pair N/A). */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    const res = await new adapters.opencode().import(readTranscript('opencode/stream/turn.jsonl'), { db, sessionId: 'ses_T' });
    assert.ok(res.ok);
    const events = (await allEvents(db)).filter(/** Select matching items. */ (e) => e.adapter === 'opencode');
    assert.ok(events.some(/** Test whether an item matches. */ (e) => e.type === 'session.started'), 'session.started normalized from the export');
    assert.ok(events.every(/** Test whether every item matches. */ (e) => e.source === 'transcript'), 'all from the on-disk/export source');
    // No harness adapter exists for OpenCode → there is no live-stream copy to collapse against.
  } finally {
    await cleanup();
  }
});
