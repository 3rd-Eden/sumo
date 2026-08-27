import { test } from 'node:test';
import assert from 'node:assert/strict';

import { plugin } from 'sumo/plugin';
import { Copilot } from 'sumo/harness';
import { waitUntil } from 'sumo/util';
import { Orchestrator } from '../src/index.mjs';
import { assertAvailable, liveUnavailableCodeFromText } from '../../harness/test/_live.mjs';
import { closeTempDb, openTempDb } from 'sumo/util/testing';

const LIVE_UNAVAILABLE = new Set(['SUMO_RATE_LIMITED', 'SUMO_AUTH_REQUIRED', 'SUMO_BUDGET_EXHAUSTED', 'SUMO_BACKEND_UNAVAILABLE', 'SUMO_OVERLOADED']);

/**
 * Skip a live Copilot spawn when the real backend reports an external prerequisite failure.
 *
 * @access private
 * @param {{ ok?: boolean, code?: string, reason?: string }} result - Spawn result to inspect.
 * @param {import('node:test').TestContext} t - Test context used to mark the case skipped.
 * @param {string} label - Human-readable test label.
 * @returns {boolean} Whether the caller should return after skipping.
 */
function skipUnavailableSpawn(result, t, label) {
  if (result?.ok) return false;
  const reason = String(result?.reason ?? '');
  const code = typeof result?.code === 'string' ? result.code : liveUnavailableCodeFromText(reason);
  if (LIVE_UNAVAILABLE.has(code)) {
    t.skip(`${label} live prerequisite unavailable: ${code}${reason ? ` - ${reason}` : ''}`);
    return true;
  }
  return false;
}

/**
 * Build a live runtime and orchestrator configured for the real Copilot harness.
 *
 * @access private
 * @param {object} config - Runtime configuration to merge into the Copilot harness slot.
 * @param {Array<Function>} [plugins] - Optional runtime plugins to activate before start.
 * @returns {Promise<{ ctx: Awaited<ReturnType<typeof openTempDb>>, runtime: ReturnType<typeof plugin>, orch: Orchestrator, close: () => Promise<void> }>} Live orchestrator test context.
 */
async function setup(config, plugins = []) {
  const ctx = await openTempDb();
  const runtime = plugin({
    cwd: ctx.home,
    flags: {},
    env: {},
    db: ctx.db,
    config: { harness: { copilot: config } }
  });
  const orch = new Orchestrator({
    runtime,
    db: ctx.db,
    /** Implement listHarnesses. */ listHarnesses() { return runtime.listHarnesses?.() ?? []; },
    /** Implement fallbackHarnesses. */ fallbackHarnesses() { return runtime.harnessFallback?.() ?? []; },
    /** Implement diagnoseFor. */ diagnoseFor(harnessId, output) { return runtime.diagnoseFor?.(harnessId, output) ?? null; }
  });
  for (const entry of plugins) runtime.sumo.use(entry);
  await runtime.start();
  return {
    ctx,
    runtime,
    orch,
    /** Implement close. */ async close() {
      await runtime.stop();
      orch.stop();
      await closeTempDb(ctx);
    }
  };
}

/**
 * Read all surfaced-event records currently stored in the daemon log.
 *
 * @access private
 * @param {Awaited<ReturnType<typeof openTempDb>>} ctx - Temporary daemon context.
 * @returns {Promise<Array<Record<string, unknown>>>} Stored orchestrator surfaced events.
 */
async function surfacedEvents(ctx) {
  const events = [];
  for await (const [, event] of ctx.db.scan('evt:')) {
    if (event.type === 'orchestrator.surfaced') events.push(event);
  }
  return events;
}

test('LIVE copilot: owned prompt, approval, and proof-of-life branches use the real session handle', { timeout: 180_000 }, /** Verify LIVE copilot: owned prompt, approval, and proof-of-life branches use the real session handle. */ async (t) => {
  /** Implement policy. */ function policy(sumo) {
    sumo.modify('prompt', /** Run the callback. */ (_current, event) => (
      event.payload?.prompt === 'manual-review'
        ? { action: 'surface' }
        : { action: 'dismiss', key: 'Escape' }
    ));
    sumo.modify('approval', /** Run the callback. */ (_current, event) => {
      if (event.payload?.command === 'surface-only') return { action: 'surface' };
      if (event.payload?.command === 'allow without request id') return { action: 'allow' };
      return event.payload?.requestId
        ? { action: 'allow' }
        : { action: 'deny', reason: 'synthetic denial' };
    });
  }
  policy.sumo = { name: 'copilot-live-policy' };

  const cfg = await assertAvailable(Copilot, process.env.SUMO_COPILOT_BIN ? { bin: process.env.SUMO_COPILOT_BIN } : {}, t);
  if (!cfg) return;

  const tctx = await setup(cfg, [policy]);
  let sessionId = '';
  try {
    const spawned = await tctx.orch.control('', 'spawn', {
      prompt: 'Reply with exactly: ORCH COPILOT',
      harness: 'copilot',
      rapidDeathMs: 10_000
    });
    if (skipUnavailableSpawn(spawned, t, 'copilot orchestrator')) return;

    assert.equal(spawned.ok, true, JSON.stringify(spawned));
    sessionId = spawned.value.sessionId;
    assert.ok(sessionId?.startsWith('ses_'));

    await waitUntil(/** Run the callback. */ async () => {
      const health = await tctx.orch.health({ id: sessionId });
      return health.ok === true;
    }, 30_000);

    await tctx.ctx.db.append({
      dedupe: `orch-live:proof:${sessionId}`,
      type: 'messenger.proof-of-life-request',
      source: 'messenger',
      payload: { agent: sessionId }
    });
    await waitUntil(/** Run the callback. */ async () => (
      (await surfacedEvents(tctx.ctx)).some(/** Test whether an item matches. */ (event) => event.payload.reason === 'proof-of-life answer')
    ), 30_000);

    await tctx.ctx.db.append({
      dedupe: `orch-live:prompt:${sessionId}`,
      type: 'session.prompt-detected',
      sessionId,
      source: 'session',
      payload: { prompt: 'provider-login' }
    });
    await tctx.ctx.db.append({
      dedupe: `orch-live:prompt-surface:${sessionId}`,
      type: 'session.prompt-detected',
      sessionId,
      source: 'session',
      payload: { prompt: 'manual-review' }
    });
    await waitUntil(/** Run the callback. */ async () => (
      (await surfacedEvents(tctx.ctx)).some(/** Test whether an item matches. */ (event) => event.payload.reason === 'prompt dismiss failed')
    ), 30_000);
    await waitUntil(/** Run the callback. */ async () => (
      (await surfacedEvents(tctx.ctx)).some(/** Test whether an item matches. */ (event) => event.payload.reason === 'prompt needs a human')
    ), 30_000);

    await tctx.ctx.db.append({
      dedupe: `orch-live:approval-missing:${sessionId}`,
      type: 'session.approval-requested',
      sessionId,
      source: 'session',
      payload: { command: 'missing request id path' }
    });
    await tctx.ctx.db.append({
      dedupe: `orch-live:approval-allow-missing:${sessionId}`,
      type: 'session.approval-requested',
      sessionId,
      source: 'session',
      payload: { command: 'allow without request id' }
    });
    await tctx.ctx.db.append({
      dedupe: `orch-live:approval-surface:${sessionId}`,
      type: 'session.approval-requested',
      sessionId,
      source: 'session',
      payload: { command: 'surface-only' }
    });
    await waitUntil(/** Run the callback. */ async () => (
      (await surfacedEvents(tctx.ctx)).some(/** Test whether an item matches. */ (event) => event.payload.reason === 'approval response failed')
    ), 30_000);
    await waitUntil(/** Run the callback. */ async () => (
      (await surfacedEvents(tctx.ctx)).some(/** Test whether an item matches. */ (event) => event.payload.reason === 'approval needs a human')
    ), 30_000);

    const surfaced = await surfacedEvents(tctx.ctx);
    const proof = surfaced.find(/** Find a matching item. */ (event) => event.payload.reason === 'proof-of-life answer');
    assert.equal(proof.payload.agent, sessionId);
    assert.equal(typeof proof.payload.verdict?.ok, 'boolean');

    const promptFailure = surfaced.find(/** Find a matching item. */ (event) => event.payload.reason === 'prompt dismiss failed');
    assert.equal(promptFailure.payload.code, 'SUMO_CAP_UNSUPPORTED');
    assert.ok(surfaced.some(/** Test whether an item matches. */ (event) => event.payload.reason === 'prompt needs a human'));

    const approvalFailures = surfaced.filter(/** Select matching items. */ (event) => event.payload.reason === 'approval response failed');
    assert.ok(approvalFailures.length >= 1);
    assert.ok(approvalFailures.some(/** Test whether an item matches. */ (event) => event.payload.code === 'SUMO_INVALID_ARGUMENT'));
    assert.ok(surfaced.some(/** Test whether an item matches. */ (event) => event.payload.reason === 'approval needs a human'));
  } finally {
    if (sessionId) await tctx.orch.control(sessionId, 'end', { force: true }).catch(/** Handle the expected rejection. */ () => {});
    await tctx.close();
  }
});
