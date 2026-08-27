/**
 * Vertical spike: Loop B end-to-end proof — LIVE against the real `claude` subprocess.
 *
 * Proves the six-layer architecture composes against reality (no mocks, CONVENTIONS §3f/§5):
 *  1. Live events land in the daemon log (real harness → real db)
 *  2. ses: doc is written + updated by the harness writer (spec 04)
 *  3. Correlation resolves native → Sumo via the ses: doc (nativeId path)
 *  4. Dual-source dedupe collapses shared-ID events (live stream ↔ the real on-disk transcript)
 *
 * Uses the REAL daemon, REAL adapters, REAL acquirer, REAL harness base, and the REAL `claude`
 * subprocess via the `Claude` adapter + `Pipe` transport. If no usable `claude` binary is found
 * the spike skips with a clear reason — it never mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { ID_REGEXP } from 'sumo/db';
import { adapters, correlate } from 'sumo/agent-artifacts';
import { Claude } from '../packages/harness/src/adapters/claude-code.mjs';

import { openTempDb, allEvents, settle, assertClaudeBin, findTranscript, readJsonl } from './_helpers.mjs';

const PROMPT = 'Say exactly: hello sumo';
const TIMEOUT_MS = 120_000;

test('Loop B: end-to-end wiring + dual-source dedupe, live against real claude', { timeout: TIMEOUT_MS + 30_000 }, /** Verify Loop B: end-to-end wiring + dual-source dedupe, live against real claude. */ async (t) => {
  const bin = await assertClaudeBin(t);
  if (!bin) return;
  const { db, cleanup } = await openTempDb();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sumo-spike-cwd-'));

  try {
    // ── Phase 1: drive the real subprocess to completion ────────────────────────────────────────
    const harness = new Claude({ db, config: { bin, cwd } });
    const session = await harness.run(PROMPT, { cwd });

    const events = [];
    const deadline = setTimeout(/** Run the timer callback. */ () => session.end({ force: true }).catch(/** Handle the expected rejection. */ () => {}), TIMEOUT_MS);
    try {
      for await (const evt of session.join()) events.push(evt);
    } finally {
      clearTimeout(deadline);
    }
    await session.done();
    await settle();

    /** Implement sesDocs. */ async function sesDocs() {
      const docs = [];
      for await (const [, doc] of db.scan('ses:')) docs.push(doc);
      return docs;
    }

    // ── Assertion 1: ses: doc exists with correct schema ────────────────────────────────────────
    await t.test('ses: doc written at spawn with ULID id and correct harness', /** Verify ses: doc written at spawn with ULID id and correct harness. */ async () => {
      const docs = await sesDocs();
      assert.equal(docs.length, 1, 'exactly one ses: doc');
      assert.match(docs[0].id, ID_REGEXP, 'Sumo ULID format');
      assert.equal(docs[0].harness, 'claude-code');
      assert.equal(typeof docs[0].createdAt, 'number');
    });

    // ── Assertion 2: ses: doc updated with the real native session ID ───────────────────────────
    let nativeId;
    let sumoId;
    await t.test('ses: doc carries harnessSessionId from the real init frame', /** Verify ses: doc carries harnessSessionId from the real init frame. */ async () => {
      const docs = await sesDocs();
      nativeId = docs[0].harnessSessionId;
      sumoId = docs[0].id;
      assert.equal(typeof nativeId, 'string', 'native ID recorded');
      assert.ok(nativeId.length > 0);
      assert.match(sumoId, ID_REGEXP, 'Sumo ULID is the registry key');
    });

    // ── Assertion 3: ses: doc state updated to ended on graceful close ──────────────────────────
    await t.test('ses: doc state is ended after graceful close', /** Verify ses: doc state is ended after graceful close. */ async () => {
      const docs = await sesDocs();
      assert.equal(docs[0].state, 'ended');
      assert.equal(typeof docs[0].ext.endedAt, 'number');
    });

    // ── Assertion 4: live events carry the Sumo spine; native id is recorded in ext () ──────
    await t.test('events carry the Sumo ULID (not the native id), native id in ext.nativeSessionId', /** Verify events carry the Sumo ULID (not the native id), native id in ext.nativeSessionId. */ async () => {
      const stored = await allEvents(db);
      const msgEvts = stored.filter(/** Select matching items. */ (e) => e.type === 'session.message' && e.sessionId);
      assert.ok(msgEvts.length > 0, 'at least one session.message with a session id in the log');
      for (const e of msgEvts) {
        assert.equal(e.sessionId, sumoId, 'Sumo ULID stamped on event (the spine)');
        assert.equal(e.ext?.nativeSessionId, nativeId, 'native id preserved in ext (provenance)');
      }
    });

    // ── Assertion 5: correlation resolves native → Sumo via the ses: doc ────────────────────────
    await t.test('correlate resolves native → Sumo via ses: doc', /** Verify correlate resolves native → Sumo via ses: doc. */ async () => {
      const docs = await sesDocs();
      const r = await correlate(db, { harness: 'claude-code', signals: { nativeId } });
      assert.ok(r.ok, `correlation failed: ${JSON.stringify(r)}`);
      assert.equal(r.value.via, 'recorded');
      assert.match(r.value.sumoId, ID_REGEXP);
      assert.equal(r.value.sumoId, docs[0].id);
    });

    // ── Assertion 5b: the harness-recorded transcriptPath is itself a correlation key ───────────
    await t.test('correlate resolves via the harness-recorded transcriptPath alone (no native id)', /** Verify correlate resolves via the harness-recorded transcriptPath alone (no native id). */ async () => {
      const docs = await sesDocs();
      assert.ok(docs[0].transcriptPath, 'harness recorded a transcriptPath on the ses: doc');
      // Pass the path top-level and OMIT signals.nativeId, so only the transcriptPath branch of the
      // recorded OR can match — proving the path is a real, independent correlation key.
      const r = await correlate(db, { harness: 'claude-code', transcriptPath: docs[0].transcriptPath });
      assert.ok(r.ok, `transcriptPath correlation failed: ${JSON.stringify(r)}`);
      assert.equal(r.value.via, 'recorded');
      assert.equal(r.value.sumoId, docs[0].id);
    });

    // ── Phase 2: import the REAL on-disk transcript through the acquirer ────────────────────────
    const transcriptPath = findTranscript(nativeId);
    assert.ok(transcriptPath, `on-disk transcript for ${nativeId} not found under ~/.claude/projects`);
    const fileRecords = readJsonl(transcriptPath);

    const eventsBeforeImport = (await allEvents(db)).length;
    const acquirer = new adapters['claude-code']();
    // The acquirer is handed the CORRELATED Sumo id — so the on-disk source stamps the same spine as
    // the live source (). The dedupe key is unaffected (Claude file records carry their own native
    // sessionId, so this fallback is never used for hashing); only the stamped field aligns.
    const importResult = await acquirer.import(fileRecords, { db, sessionId: sumoId });
    assert.ok(importResult.ok, `import failed: ${JSON.stringify(importResult)}`);

    // ── Assertion 6: shared natural-id events collapse to one seq (dual-source dedupe proof) ─────
    await t.test('shared natural-id events (msg:/call:) collapse to one seq across live ↔ file', /** Verify shared natural-id events (msg:/call:) collapse to one seq across live ↔ file. */ async () => {
      const stored = await allEvents(db);
      // Claude writes the same turns to both the live stream and the on-disk transcript, sharing a
      // natural id (assistant content blocks `msg:<id>#<i>`, tool calls `call:<id>`). Every id-keyed
      // event must therefore appear exactly once — collapsed, not duplicated across the two sources.
      const idKeyed = stored.filter(/** Select matching items. */ (e) => /^(msg|call):/.test(e.dedupe));
      assert.ok(idKeyed.length > 0, 'at least one natural-id event exists');
      const byKey = new Map();
      for (const e of idKeyed) byKey.set(e.dedupe, (byKey.get(e.dedupe) ?? 0) + 1);
      for (const [key, n] of byKey) assert.equal(n, 1, `shared-id event ${key} collapsed to one seq (live+file)`);

      // Prove the merge gap-filled from BOTH sources: the assistant message's stream-side native frame
      // carries session_id; the file-side native record carries cwd. After collapse, both are present.
      const merged = idKeyed.find(/** Find a matching item. */ (e) => e.type === 'session.message' && e.payload?.role === 'assistant');
      assert.ok(merged?.ext?.native, 'a collapsed assistant message with ext.native exists');
      assert.equal(merged.ext.native.session_id ?? merged.ext.native.sessionId, nativeId, 'stream-side native key present');
      assert.ok(merged.ext.native.cwd, 'file-side native key (cwd) gap-filled by the merge');
    });

    // ── Assertion 7: id-less events stay distinct (must NOT falsely collapse) ────────────────────
    await t.test('id-less events stay distinct — no false collapse', /** Verify id-less events stay distinct — no false collapse. */ async () => {
      const stored = await allEvents(db);
      // Every stored event occupies its own seq (the storage key) — a false collapse would show up as
      // two logical events sharing one seq, which cannot happen, so instead assert the inverse holds:
      // distinct logical events keep distinct dedupe keys and all seqs are unique.
      const seqs = stored.map(/** Map one item. */ (e) => e.seq);
      assert.equal(new Set(seqs).size, seqs.length, 'every stored event has a unique seq (nothing over-collapsed)');

      // Id-less events (lifecycle session.ended from the result frame, the synthesized close, user
      // turns with no message id) fall back to a content-hash key anchored to position — so genuinely
      // distinct id-less events from the two sources keep distinct keys instead of colliding.
      const idless = stored.filter(/** Select matching items. */ (e) => e.dedupe.startsWith('sha256:'));
      assert.ok(idless.length >= 2, 'multiple id-less (content-hash) events exist across the two sources');
      assert.equal(new Set(idless.map(/** Map one item. */ (e) => e.dedupe)).size, idless.length, 'id-less events have distinct keys (no false collapse)');
    });

    // ── Assertion 8: provenance from both sources is recorded ───────────────────────────────────
    await t.test('events carry correct source provenance from both the live stream and the import', /** Verify events carry correct source provenance from both the live stream and the import. */ async () => {
      const stored = await allEvents(db);
      assert.ok(stored.filter(/** Select matching items. */ (e) => e.source === 'session').length > 0, 'live-stream events exist');
      assert.ok(stored.filter(/** Select matching items. */ (e) => e.source === 'transcript').length > 0, 'transcript-import events exist');
      assert.ok(stored.length > eventsBeforeImport, 'the import added at least the gap-filled records');
    });

  } finally {
    await cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
