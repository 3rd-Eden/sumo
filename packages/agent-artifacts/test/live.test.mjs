/**
 * Live Copilot artifact acquisition against the REAL harness, REAL daemon, and REAL Copilot
 * session-state tree. Proves the recorded session doc points at a real `events.jsonl`, correlation
 * resolves via the recorded mapping, and on-disk import collapses onto the live-stream event seq.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { Copilot } from '../../harness/src/index.mjs';
import { assertAvailable, captureCopilotHarnessSession } from '../../harness/test/_live.mjs';
import { adapters } from '../src/index.mjs';
import { correlate } from '../src/correlate.mjs';
import { allEvents } from './_daemon.mjs';

const PROMPT = 'Reply with exactly: HELLO';
const TIMEOUT_MS = 120_000;
const LIVE_UNAVAILABLE = new Set(['SUMO_RATE_LIMITED', 'SUMO_AUTH_REQUIRED', 'SUMO_BUDGET_EXHAUSTED', 'SUMO_BACKEND_UNAVAILABLE', 'SUMO_OVERLOADED']);

/** Implement liveUnavailableCode. */ function liveUnavailableCode(events) {
  return events.find(/** Find a matching item. */ (e) => LIVE_UNAVAILABLE.has(e.ext?.classification?.code ?? e.payload?.sumoCode))?.ext?.classification?.code
    ?? events.find(/** Find a matching item. */ (e) => LIVE_UNAVAILABLE.has(e.payload?.sumoCode))?.payload?.sumoCode
    ?? '';
}

test('LIVE copilot: recorded session-state import correlates and collapses onto the live session event', { timeout: TIMEOUT_MS + 30_000 }, /** Verify LIVE copilot: recorded session-state import correlates and collapses onto the live session event. */ async (t) => {
  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;
  let captured;
  try {
    captured = await captureCopilotHarnessSession(PROMPT, {
      ...cfg,
      /** Implement fileReady. */ fileReady(records) {
        return records.some(/** Test whether an item matches. */ (event) => event.type === 'assistant.message' || event.type === 'session.error');
      }
    });
    const unavailableCode = liveUnavailableCode(captured.liveEvents);
    if (unavailableCode) {
      t.skip(`copilot artifact live prerequisite unavailable: ${unavailableCode}`);
      return;
    }
    const { db, doc, liveEvents, fileEvents, sessionId } = captured;
    assert.equal(doc.harness, 'copilot');
    assert.equal(doc.id, sessionId);
    const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
    assert.equal(doc.transcriptPath, path.join(copilotHome, 'session-state', doc.harnessSessionId, 'events.jsonl'));

    const assistant = liveEvents.find(/** Find a matching item. */ (event) => event.type === 'session.message' && event.payload.role === 'assistant');
    assert.ok(assistant?.dedupe, 'live Copilot run produced an assistant event with dedupe');

    const before = (await allEvents(db)).filter(/** Select matching items. */ (event) => event.dedupe === assistant.dedupe);
    assert.equal(before.length, 1, 'live assistant event stored once before import');
    const liveSeq = before[0].seq;

    const acquirer = new adapters.copilot();
    const corr = await correlate(db, {
      harness: 'copilot',
      transcriptPath: doc.transcriptPath,
      signals: acquirer.signals({ transcriptPath: doc.transcriptPath, records: fileEvents })
    });
    assert.ok(corr.ok, 'recorded correlation succeeded');
    assert.equal(corr.value.via, 'recorded');
    assert.equal(corr.value.sumoId, sessionId);

    const imported = await acquirer.import(fileEvents, { db, sessionId });
    assert.ok(imported.ok, 'real Copilot events.jsonl imported');

    const after = (await allEvents(db)).filter(/** Select matching items. */ (event) => event.dedupe === assistant.dedupe);
    assert.equal(after.length, 1, 'live stream + file import collapsed to one stored event');
    assert.equal(after[0].seq, liveSeq, 'file import collapsed onto the live event seq');
  } finally {
    await captured?.cleanup?.();
  }
});
