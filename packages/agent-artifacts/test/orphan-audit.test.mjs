/**
 * Narrow orphan audit (plan §0.5): verify that a hook observation event appended WITHOUT a
 * sessionId (the pre-session.started window, when correlation hasn't happened yet) is NOT
 * permanently stranded. The daemon's `mergeEvent` gap-fill enriches it when the transcript
 * source later appends the same logical event WITH a sessionId under the same dedupe key.
 *
 * This is the live pre-`session.started` window: hook fires before the harness has reported
 * `system:init`, so the Sumo↔native correlation isn't recorded yet. The hook event lands with
 * no sessionId. When the transcript ingestion runs (or the live harness stream processes
 * `system:init`), it re-appends the same dedupe key with the Sumo sessionId, and `mergeEvent`
 * fills the gap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openTempDb, allEvents } from './_daemon.mjs';

test('hook event without sessionId is enriched when transcript event with same dedupe arrives', /** Verify hook event without sessionId is enriched when transcript event with same dedupe arrives. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    const dedupe = 'session:abc-native-session-id-123';

    // First write: hook observation of session.started without a Sumo sessionId.
    // This mirrors what sumo forward does when it runs before the ses: doc exists.
    const seq1 = await db.append({
      dedupe,
      type: 'session.started',
      source: 'hook',
      adapter: 'claude-code',
      payload: { harness: 'claude-code', cwd: '/work' },
      ext: { native: { session_id: 'abc-native-session-id-123' } }
      // no sessionId field — this is the gap
    });

    // Verify: stored event has no sessionId yet.
    const before = (await allEvents(db)).find(/** Find a matching item. */ (e) => e.dedupe === dedupe);
    assert.ok(before, 'event stored after first append');
    assert.equal(before.seq, seq1);
    assert.equal(before.sessionId, undefined, 'no sessionId on initial hook event');

    // Second write: transcript source appends the SAME event with a Sumo sessionId.
    // This is what the harness live stream does when it processes system:init.
    const sumoId = 'ses_01JWTEST0000000000000001';
    const seq2 = await db.append({
      dedupe,
      type: 'session.started',
      source: 'session',
      adapter: 'claude-code',
      sessionId: sumoId,
      payload: { harness: 'claude-code', cwd: '/work' },
      ext: {}
    });

    // Collapse: second write must dedupe onto the first seq (no new event created).
    assert.equal(seq2, seq1, 'deduped onto the original seq — no duplicate event');

    // Enrichment: the stored event now carries the sessionId gap-filled from the second write.
    const after = (await allEvents(db)).find(/** Find a matching item. */ (e) => e.dedupe === dedupe);
    assert.ok(after, 'event still present');
    assert.equal(after.sessionId, sumoId, 'sessionId enriched from transcript source');

    // Source is preserved as the first write (first-writer wins on present fields).
    assert.equal(after.source, 'hook', 'first-writer source preserved');
  } finally {
    await cleanup();
  }
});

test('hook event with sessionId already set is not overwritten by a later append', /** Verify hook event with sessionId already set is not overwritten by a later append. */ async () => {
  const { db, cleanup } = await openTempDb();
  try {
    const dedupe = 'session:already-correlated-native-id';
    const sumoId = 'ses_01JWTEST0000000000000002';

    // First write already has the Sumo sessionId (e.g. correlation happened at hook time).
    const seq1 = await db.append({
      dedupe,
      type: 'session.started',
      source: 'hook',
      adapter: 'claude-code',
      sessionId: sumoId,
      payload: { harness: 'claude-code' },
      ext: {}
    });

    // Second write with a different sessionId — first-writer must win.
    const otherId = 'ses_01JWTEST0000000000000099';
    const seq2 = await db.append({
      dedupe,
      type: 'session.started',
      source: 'session',
      adapter: 'claude-code',
      sessionId: otherId,
      payload: { harness: 'claude-code' },
      ext: {}
    });

    assert.equal(seq2, seq1, 'deduped — no new event');
    const stored = (await allEvents(db)).find(/** Find a matching item. */ (e) => e.dedupe === dedupe);
    assert.equal(stored.sessionId, sumoId, 'original sessionId preserved (first-writer wins)');
  } finally {
    await cleanup();
  }
});
